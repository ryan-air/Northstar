/**
 * Onboard gateway simulator — signs telemetry and POSTs to Northstar.
 * Follows Hist Lab signed entity; issues/embeds challenge nonces; optional mTLS + PKCS#11.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TelemetryPayload } from '@northstar/contracts';
import {
  loadSoftwareSigner,
  Pkcs11P256Signer,
  type PayloadSigner,
} from './signer.js';
import { mmsiFromIdentity, OnboardTrack } from './onboardTrack.js';

const env = (a: string, b: string) => process.env[a] ?? process.env[b];
const DEVICE_ID = env('NORTHSTAR_DEVICE_ID', 'FLAGSHIP_DEVICE_ID') ?? 'DEV-VESSEL-001';
/** May be overridden after first snapshot if NORTHSTAR_ENTITY_ID is unset. */
let ENTITY_ID = env('NORTHSTAR_ENTITY_ID', 'FLAGSHIP_ENTITY_ID') ?? 'LAB-230685000';
const ENTITY_ID_PINNED = Boolean(env('NORTHSTAR_ENTITY_ID', 'FLAGSHIP_ENTITY_ID'));
let keyId = `${DEVICE_ID}-key-1`;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const DATA_DIR = (process.env.NORTHSTAR_DATA_DIR ?? '.northstar/data').replace(/^~/, process.env.HOME ?? '');
const DATA_DIR_ABS = DATA_DIR.startsWith('/') ? DATA_DIR : join(REPO_ROOT, DATA_DIR);
const RUNTIME_REPLAY = join(DATA_DIR_ABS, 'replay/gof_ais.jsonl');
const REPLAY_PATH =
  process.env.NORTHSTAR_REPLAY_PATH ??
  (existsSync(RUNTIME_REPLAY) ? RUNTIME_REPLAY : join(REPO_ROOT, 'data/replay/gof_ais.jsonl'));
/** P4.1: enrolment token written by the server on first run. */
const LAB_DIR = process.env.NORTHSTAR_LAB_DIR ?? join(REPO_ROOT, 'data_lab');

/** U12 onboard log path when the lab return's vessel matches `mmsi`, else null. */
function findLabOnboardLog(mmsi: number): string | null {
  try {
    const platform = JSON.parse(readFileSync(join(LAB_DIR, 'U0_platform', 'U0_platform.json'), 'utf8')) as { mmsi?: number };
    if (platform.mmsi !== mmsi) return null;
    const dir = join(LAB_DIR, 'U12_onboard_gnss');
    const f = readdirSync(dir).find((n) => /^U12_position_.*\.csv$/.test(n));
    return f ? join(dir, f) : null;
  } catch {
    return null;
  }
}

const ENROL_TOKEN_PATH = process.env.NORTHSTAR_ENROL_TOKEN_PATH ?? join(DATA_DIR_ABS, 'enrol.token');
/** P3.2: legacy wall-clock playhead (independent of the Lab clock). */
const LEGACY_CLOCK = process.env.NORTHSTAR_DEVICE_LEGACY_CLOCK === 'true';

function readEnrolToken(): string | undefined {
  try {
    return process.env.NORTHSTAR_ENROL_TOKEN ?? readFileSync(ENROL_TOKEN_PATH, 'utf8').trim();
  } catch {
    return undefined;
  }
}

async function fetchLabClock(): Promise<{ ready: boolean; sim_time: string; speed: number } | null> {
  try {
    const res = await apiFetch(`${API}/api/lab/clock`);
    if (!res.ok) return null;
    return (await res.json()) as { ready: boolean; sim_time: string; speed: number };
  } catch {
    return null;
  }
}
let MMSI = mmsiFromIdentity(ENTITY_ID, process.env.NORTHSTAR_MMSI);
const GNSS_NOISE_METERS = Number(process.env.NORTHSTAR_GNSS_NOISE_METERS ?? 3);
const defaultKeyDir = existsSync(join(REPO_ROOT, '.northstar/keys'))
  ? join(REPO_ROOT, '.northstar/keys')
  : join(REPO_ROOT, '.flagship/keys');
const KEY_DIR = (env('NORTHSTAR_KEY_DIR', 'FLAGSHIP_KEY_DIR') ?? defaultKeyDir).replace(
  /^~/,
  process.env.HOME ?? '',
);
const API = env('NORTHSTAR_API_URL', 'FLAGSHIP_API_URL') ?? 'http://127.0.0.1:8080';
const SERVER = env('NORTHSTAR_TELEMETRY_URL', 'FLAGSHIP_TELEMETRY_URL') ?? `${API}/api/telemetry`;
const INTERVAL_MS = Number(env('NORTHSTAR_DEVICE_INTERVAL_MS', 'FLAGSHIP_DEVICE_INTERVAL_MS') ?? 2000);
const SIGNER_BACKEND = (process.env.NORTHSTAR_SIGNER_BACKEND ?? 'software').toLowerCase();
const CERT_DIR = env('NORTHSTAR_CERT_DIR', 'FLAGSHIP_CERT_DIR') ?? join(REPO_ROOT, 'certs');
const USE_MTLS =
  process.env.NORTHSTAR_DEVICE_MTLS === 'true' ||
  env('NORTHSTAR_MTLS_ENABLED', 'FLAGSHIP_MTLS_ENABLED') === 'true';

type Mode = 'normal' | 'tamper' | 'replay';

let mode: Mode = 'normal';
let sequence = 1;
let lastEnvelope: unknown = null;
let signer: PayloadSigner | null = null;
let onboardTrack: OnboardTrack | null = null;

function buildHttpsAgent(): https.Agent | undefined {
  if (!USE_MTLS) return undefined;
  const ca = join(CERT_DIR, 'ca.crt');
  const cert = join(CERT_DIR, 'client.crt');
  const key = join(CERT_DIR, 'client.key');
  if (!existsSync(ca) || !existsSync(cert) || !existsSync(key)) {
    console.warn('[device-sim] mTLS requested but certs missing — run npm run gen-certs');
    return undefined;
  }
  return new https.Agent({
    ca: readFileSync(ca),
    cert: readFileSync(cert),
    key: readFileSync(key),
    rejectUnauthorized: true,
  });
}

const mtlsAgent = buildHttpsAgent();

/** Fetch that attaches client certs when mTLS agent is configured (HTTPS only). */
function apiFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  if (!mtlsAgent || !url.startsWith('https:')) {
    return fetch(url, init).then(async (r) => ({
      ok: r.ok,
      status: r.status,
      json: () => r.json(),
    }));
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: init?.method ?? 'GET',
        headers: init?.headers,
        agent: mtlsAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => (text ? JSON.parse(text) : {}),
          });
        });
      },
    );
    req.on('error', reject);
    if (init?.body) req.write(init.body);
    req.end();
  });
}

async function refreshSigner(): Promise<void> {
  try {
    if (SIGNER_BACKEND === 'pkcs11') {
      signer = Pkcs11P256Signer.fromEnv(keyId);
      console.log(`[device-sim] PKCS#11 P-256 signer ready (${signer.keyId})`);
      return;
    }
  } catch (e) {
    console.warn(
      `[device-sim] PKCS#11 unavailable (${e instanceof Error ? e.message : e}) — falling back to software`,
    );
  }
  signer = await loadSoftwareSigner(KEY_DIR, DEVICE_ID, keyId);
}

async function refreshDeviceMeta(): Promise<void> {
  try {
    const res = await apiFetch(`${API}/api/devices`);
    if (!res.ok) return;
    const list = (await res.json()) as Array<{
      device_id: string;
      key_id: string;
      entity_id: string;
      revoked_at?: string | null;
    }>;
    const d = list.find((x) => x.device_id === DEVICE_ID);
    if (d && !d.revoked_at) {
      keyId = d.key_id;
      if (signer) signer.keyId = keyId;
    }
  } catch {
    /* ignore */
  }
}

async function enrolDevice(): Promise<void> {
  if (!signer) throw new Error('signer unavailable for enrollment');
  const enrolToken = readEnrolToken();
  const res = await apiFetch(`${API}/api/devices/enrol`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(enrolToken ? { 'x-northstar-enrol-token': enrolToken } : {}),
    },
    body: JSON.stringify({
      device_id: DEVICE_ID,
      entity_id: ENTITY_ID,
      public_key_b64: signer.publicKeyB64(),
    }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(
      `public-key enrollment failed (${res.status}): ${errBody.detail ?? errBody.error ?? 'unknown'}`,
    );
  }
  const response = (await res.json()) as {
    enrollment?: { key_id?: string };
  };
  if (response.enrollment?.key_id) {
    keyId = response.enrollment.key_id;
    signer.keyId = keyId;
  }
}

async function fetchChallenge(): Promise<string | null> {
  if (!signer || signer.alg !== 'ed25519') return null;
  try {
    const request = {
      device_id: DEVICE_ID,
      timestamp: new Date().toISOString(),
    };
    const signature = await signer.signJson(request);
    const issued = await apiFetch(`${API}/api/challenge/${DEVICE_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, signature }),
    });
    if (!issued.ok) return null;
    const body = (await issued.json()) as { nonce?: string | null };
    return body.nonce ?? null;
  } catch {
    return null;
  }
}

async function fetchSnapshot(): Promise<{
  active_scenario: string;
  osnma_status?: string;
  signed_entity_id?: string | null;
} | null> {
  try {
    const res = await apiFetch(`${API}/api/snapshot`);
    if (!res.ok) return null;
    const s = (await res.json()) as {
      active_scenario: string;
      lab?: {
        osnma_protocol_status?: string;
        signed_entity_id?: string | null;
        fullstack_entity_id?: string | null;
      };
    };
    return {
      active_scenario: s.active_scenario,
      osnma_status: s.lab?.osnma_protocol_status,
      signed_entity_id: s.lab?.fullstack_entity_id ?? s.lab?.signed_entity_id ?? null,
    };
  } catch {
    return null;
  }
}

async function tick(): Promise<void> {
  await refreshDeviceMeta();
  if (!signer) await refreshSigner();
  if (!signer) {
    console.warn(`[device-sim] No signer yet; waiting for key at ${KEY_DIR}/${DEVICE_ID}.ed25519`);
    return;
  }
  if (!onboardTrack) return;

  const snap = await fetchSnapshot();
  const scenario = snap?.active_scenario ?? 'normal';
  mode =
    scenario === 'signed_tamper' ? 'tamper' : scenario === 'signed_replay' ? 'replay' : 'normal';

  if (mode === 'replay' && lastEnvelope) {
    const res = await apiFetch(SERVER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lastEnvelope),
    });
    console.log(`[device-sim] replay POST → ${res.status}`);
    return;
  }

  // P3.2: sample the onboard track at the Lab's replay time so signed and AIS
  // positions refer to the same instant. `timestamp` stays wall-clock (freshness/replay
  // protection unchanged); observation_time carries the replay instant.
  let observationTime: string | undefined;
  let vessel = onboardTrack.position();
  if (!LEGACY_CLOCK) {
    const clock = await fetchLabClock();
    const replayMs = clock?.ready ? Date.parse(clock.sim_time) : NaN;
    if (Number.isFinite(replayMs) && onboardTrack.covers(replayMs)) {
      vessel = onboardTrack.positionAt(replayMs);
      observationTime = new Date(replayMs).toISOString();
    } else if (clock?.ready) {
      console.warn('[device-sim] Lab clock outside onboard track span — skipping tick');
      return;
    }
  }

  const challenge = await fetchChallenge();
  if (!challenge) {
    console.warn('[device-sim] no challenge nonce — skipping tick (challenge required)');
    return;
  }
  const osnma =
    snap?.osnma_status === 'authenticated' ||
    snap?.osnma_status === 'failed' ||
    snap?.osnma_status === 'pending'
      ? (snap.osnma_status as TelemetryPayload['osnma_status'])
      : 'unavailable';

  const payload: TelemetryPayload = {
    v: 1,
    device_id: DEVICE_ID,
    entity_id: ENTITY_ID,
    sequence_number: sequence++,
    timestamp: new Date().toISOString(),
    ...(observationTime ? { observation_time: observationTime } : {}),
    firmware_version: '1.0.0',
    position: { lat: vessel.lat, lon: vessel.lon, crs: 'EPSG:4326' },
    speed_over_ground_knots: vessel.sog,
    course_over_ground_deg: vessel.cog,
    heading_deg: vessel.heading ?? undefined,
    vessel_class: 'other',
    osnma_status: osnma,
    challenge_nonce: challenge,
  };

  const signature = await signer.sign(payload);
  let bodyPayload = payload;
  if (mode === 'tamper') {
    bodyPayload = {
      ...payload,
      position: { lat: 60.35, lon: 24.95, crs: 'EPSG:4326' },
    };
  }

  const envelope = {
    payload: bodyPayload,
    signature,
    public_key_id: keyId,
    assurance_level: signer.assurance,
    signature_alg: signer.alg,
  };
  lastEnvelope = { ...envelope, payload };

  const res = await apiFetch(SERVER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  console.log(
    `[device-sim] ${mode} ${ENTITY_ID} key=${keyId} alg=${signer.alg} seq=${payload.sequence_number} → ${res.status} +challenge`,
  );
}

async function start(): Promise<void> {
  await refreshSigner();
  if (!ENTITY_ID_PINNED) {
    for (let i = 0; i < 30; i++) {
      const snap = await fetchSnapshot();
      if (snap?.signed_entity_id) {
        ENTITY_ID = snap.signed_entity_id;
        MMSI = mmsiFromIdentity(ENTITY_ID, process.env.NORTHSTAR_MMSI);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await enrolDevice();
  // Lab return (private, gitignored): if its vessel is ours, sign the independent onboard
  // receiver log (U12) instead of a noisy copy of the AIS track.
  const labOnboard = findLabOnboardLog(MMSI);
  onboardTrack = labOnboard
    ? OnboardTrack.loadCsv(labOnboard, MMSI)
    : await OnboardTrack.load({
        path: REPLAY_PATH,
        mmsi: MMSI,
        noiseMeters: GNSS_NOISE_METERS,
      });
  if (labOnboard) console.log(`[device-sim] signing the lab onboard receiver log for MMSI ${MMSI}`);
  console.log(
    `[device-sim] ${DEVICE_ID}@${ENTITY_ID} using onboard MMSI ${MMSI}; posting to ${SERVER} every ${INTERVAL_MS}ms (gnss_noise=${GNSS_NOISE_METERS}m, mtls=${!!mtlsAgent}, backend=${SIGNER_BACKEND})`,
  );
  await tick();
  setInterval(() => {
    tick().catch((e) => console.error(e));
  }, INTERVAL_MS);
}

start().catch((e) => {
  console.error(`[device-sim] startup failed: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
