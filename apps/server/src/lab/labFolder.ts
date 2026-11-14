/**
 * Loader for the lab return folder (default ./data_lab, override NORTHSTAR_LAB_DIR).
 * The folder is private and gitignored; nothing here is committed with data.
 *
 * Evidence classes: U0/U1/U3/U4/U6/U7 are recorded lab data; U2 (attestation) and U5
 * (OSNMA) are synthetic and are labelled so (evidence class 'simulated').
 * Raw IQ (*.cu8) is never read here — U1 uses the per-epoch phase table.
 */
import { createPublicKey, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AttestationEvidence,
  GnssDiagnostics,
  OsnmaResult,
  PositionEvent,
  RfLabResult,
} from '@northstar/contracts';
import type { DrSample, TargetObservation } from '@northstar/core';
import type { ReplayRecord } from '../replay/types.js';

export interface LabCapture {
  id: string;
  startMs: number;
  endMs: number;
  result: RfLabResult;
}

export interface LabFolder {
  dir: string;
  mmsi: number;
  entityId: string;
  name: string;
  windowMs: [number, number];
  primaryAis: ReplayRecord[];
  secondaryAis: PositionEvent[];
  gnss: GnssDiagnostics[];
  dr: DrSample[];
  targetObs: TargetObservation[];
  osnma: OsnmaResult[];
  attestation: AttestationEvidence | null;
  captures: LabCapture[];
  /** Interference windows from the receiver's own SEC-SIG flags (not lab labels). */
  receiverEvents: Array<{ kind: 'jamming' | 'spoofing'; startMs: number; endMs: number; maxState: number }>;
  notes: string[];
}

// ———————————————————————————————————— parsing helpers

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]!).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const v = split(l);
    const r: Record<string, string> = {};
    header.forEach((h, i) => (r[h] = (v[i] ?? '').trim()));
    return r;
  });
}

const readCsv = (p: string) => (existsSync(p) ? parseCsv(readFileSync(p, 'utf8')) : []);
const num = (s: string | undefined): number | null => {
  if (s == null || s === '') return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const sec = (ms: number) => Math.floor(ms / 1000);

// ———————————————————————————————————— sections

function loadPrimary(dir: string, mmsi: number, refs: Record<string, number> | undefined): ReplayRecord[] {
  const p = join(dir, 'U0_platform', `U0_primary_ais_trial_vessel_${dateTag(dir)}.jsonl`);
  const file = existsSync(p) ? p : findFile(join(dir, 'U0_platform'), /^U0_primary_ais.*\.jsonl$/);
  if (!file) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ReplayRecord)
    .filter((r) => r.mmsi === mmsi && Number.isFinite(r.lat) && Number.isFinite(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180)
    .map((r) => ({
      ...r,
      source: 'lab_primary_ais',
      provider_id: 'lab_u0',
      ...(refs
        ? { referencePointA: refs.A, referencePointB: refs.B, referencePointC: refs.C, referencePointD: refs.D }
        : {}),
    }))
    .sort((a, b) => (a.timestamp_external_ms ?? 0) - (b.timestamp_external_ms ?? 0));
}

function loadSecondary(dir: string, mmsi: number, entityId: string): PositionEvent[] {
  const f = findFile(join(dir, 'U6_ais_secondary'), /^U6_secondary_ais.*\.csv$/);
  if (!f) return [];
  const out: PositionEvent[] = [];
  for (const r of readCsv(f)) {
    if (Number(r.mmsi) !== mmsi) continue;
    const lat = num(r.lat);
    const lon = num(r.lon);
    const ts = Date.parse(r.timestamp_utc ?? '');
    // AIS 'position not available' sentinels (lat 91 / lon 181) are not positions.
    if (lat == null || lon == null || Number.isNaN(ts) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const sog = num(r.sog);
    const cog = num(r.cog);
    const hdg = num(r.heading);
    out.push({
      entity_id: entityId,
      entity_type: 'vessel',
      position: { lat, lon },
      speed_over_ground_knots: sog != null && sog < 102.3 ? sog : null,
      course_over_ground_deg: cog != null && cog < 360 ? cog : null,
      heading_deg: hdg != null && hdg < 360 ? hdg : null,
      source: 'ais_provider_b',
      provider_id: `lab_u6:${r.station_id ?? ''}`,
      source_timestamp: new Date(ts).toISOString(),
      ingested_at: new Date(Date.parse(r.received_at_utc ?? '') || ts).toISOString(),
      device_signature_status: 'missing',
      osnma_status: 'unavailable',
      quality: { position_accuracy_m: r.pos_acc === '1' ? 10 : 50, signal_quality_available: true },
      labels: { mmsi },
    } as PositionEvent);
  }
  return out.sort((a, b) => a.source_timestamp.localeCompare(b.source_timestamp));
}

function loadGnss(dir: string, entityId: string): GnssDiagnostics[] {
  const d = join(dir, 'U3_gnss');
  const bySec = new Map<number, { cno: number[]; used: number; agc?: number; jamInd?: number; jam?: number; spf?: number; pdop?: number }>();
  const get = (s: number) => {
    let v = bySec.get(s);
    if (!v) bySec.set(s, (v = { cno: [], used: 0 }));
    return v;
  };
  const navsat = findFile(d, /^U3_navsat_.*\.csv$/);
  if (navsat) {
    // Large file: stream line by line without building row objects.
    const text = readFileSync(navsat, 'utf8');
    const lines = text.split('\n');
    const h = lines[0]!.split(',');
    const iUtc = h.indexOf('utc');
    const iCno = h.indexOf('cno_dbhz');
    const iUsed = h.indexOf('svUsed');
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i]!.split(',');
      if (f.length < h.length) continue;
      const s = sec(Date.parse(f[iUtc]!));
      if (Number.isNaN(s)) continue;
      const v = get(s);
      if (f[iUsed] === '1') {
        v.used++;
        const c = Number(f[iCno]);
        if (c > 0) v.cno.push(c);
      }
    }
  }
  for (const r of readCsv(findFile(d, /^U3_monrf_.*\.csv$/) ?? '')) {
    if (r.blockId !== '0') continue;
    const v = get(sec(Date.parse(r.utc!)));
    v.agc = num(r.agcCnt) ?? undefined;
    v.jamInd = num(r.jamInd) ?? undefined;
  }
  for (const r of readCsv(findFile(d, /^U3_secsig_.*\.csv$/) ?? '')) {
    const v = get(sec(Date.parse(r.utc!)));
    v.jam = num(r.jammingState) ?? undefined;
    v.spf = num(r.spoofingState) ?? undefined;
  }
  for (const r of readCsv(findFile(d, /^U3_navpvt_.*\.csv$/) ?? '')) {
    const v = get(sec(Date.parse(r.utc!)));
    v.pdop = num(r.pDOP) ?? undefined;
  }
  return [...bySec.entries()]
    .filter(([s]) => Number.isFinite(s))
    .sort((a, b) => a[0] - b[0])
    .map(([s, v]) => ({
      entity_id: entityId,
      device_id: 'lab_gnss_receiver',
      observed_at: new Date(s * 1000).toISOString(),
      satellite_count: v.used,
      c_n0_dbhz: v.cno.length ? v.cno : null,
      hdop: null,
      pdop: v.pdop ?? null,
      agc: v.agc ?? null,
      // UBX-SEC-SIG: jammingState 2 = warning, 3 = critical; spoofingState 2 = indicated, 3 = affirmed.
      interference_indicator:
        (v.spf ?? 0) >= 2 ? 'suspected_spoofing' : (v.jam ?? 0) >= 2 ? 'suspected_jamming' : v.spf == null && v.jam == null ? 'unknown' : 'none',
      labels: { simulated: false, fixture: false, recorded: true },
      missing_inputs: [],
    }));
}

function receiverEvents(dir: string): LabFolder['receiverEvents'] {
  const rows = readCsv(findFile(join(dir, 'U3_gnss'), /^U3_secsig_.*\.csv$/) ?? '');
  const out: LabFolder['receiverEvents'] = [];
  for (const kind of ['jamming', 'spoofing'] as const) {
    const key = kind === 'jamming' ? 'jammingState' : 'spoofingState';
    let cur: { startMs: number; endMs: number; maxState: number } | null = null;
    for (const r of rows) {
      const t = Date.parse(r.utc!);
      const s = num(r[key]) ?? 0;
      if (s >= 2) {
        if (cur && t - cur.endMs <= 30_000) {
          cur.endMs = t;
          cur.maxState = Math.max(cur.maxState, s);
        } else {
          if (cur) out.push({ kind, ...cur });
          cur = { startMs: t, endMs: t, maxState: s };
        }
      }
    }
    if (cur) out.push({ kind, ...cur });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

function loadDr(dir: string): DrSample[] {
  const d = join(dir, 'U4_imu_dr');
  const heading = new Map<number, number>();
  const speed = new Map<number, number>();
  const hdt = findFile(d, /^U4_heading_rot_.*\.nmea$/);
  if (hdt) {
    for (const line of readFileSync(hdt, 'utf8').split('\n')) {
      const [t, s] = line.split('\t');
      if (!t || !s?.startsWith('$HEHDT')) continue;
      const h = Number(s.split(',')[1]);
      if (Number.isFinite(h)) heading.set(sec(Date.parse(t)), h);
    }
  }
  const vbw = findFile(d, /^U4_speedlog_.*\.nmea$/);
  if (vbw) {
    for (const line of readFileSync(vbw, 'utf8').split('\n')) {
      const [t, s] = line.split('\t');
      if (!t || !s?.includes('VBW')) continue;
      const f = s.split(',');
      // $--VBW,water_long,water_trans,A,ground_long,ground_trans,A — prefer ground speed.
      const g = f[6]?.startsWith('A') && f[4] ? Number(f[4]) : NaN;
      const w = f[3] === 'A' && f[1] ? Number(f[1]) : NaN;
      const v = Number.isFinite(g) ? g : w;
      if (Number.isFinite(v)) speed.set(sec(Date.parse(t)), v);
    }
  }
  const secs = [...new Set([...heading.keys(), ...speed.keys()])].sort((a, b) => a - b);
  return secs.map((s) => ({ t: s * 1000, heading_deg: heading.get(s) ?? null, speed_kn: speed.get(s) ?? null }));
}

function loadTargetObs(dir: string, mmsi: number): TargetObservation[] {
  const f = findFile(join(dir, 'U7_neighbours'), /^U7_observations_.*\.csv$/);
  if (!f) return [];
  return readCsv(f)
    .filter((r) => Number(r.associated_mmsi) === mmsi)
    // Only observations that do not come from the vessel's own AIS (radar, SAR, …).
    .filter((r) => !/ais|digitraffic/i.test(r.provider_id ?? ''))
    .map((r) => ({
      observed_at: new Date(Date.parse(r.time_utc!)).toISOString(),
      lat: Number(r.lat),
      lon: Number(r.lon),
      accuracy_m: num(r.accuracy_m) ?? 100,
      provider_id: r.provider_id!,
    }))
    .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon))
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

function loadOsnma(dir: string, startMs: number): OsnmaResult[] {
  const f = findFile(join(dir, 'U5_osnma'), /^U5_auth_summary_.*\.csv$/);
  if (!f) return [];
  const warmupEnd = startMs + 5 * 60_000; // OSNMA needs minutes of nav data before tags verify
  return readCsv(f).map((r) => {
    const t = Date.parse(r.time_utc!);
    const gal = num(r.galileo_used) ?? 0;
    const auth = num(r.galileo_used_and_authenticated) ?? 0;
    const frac = num(r.fraction_of_fix_authenticated) ?? 0;
    const status: OsnmaResult['status'] =
      gal === 0 ? 'unavailable' : auth > 0 ? 'authenticated' : t < warmupEnd ? 'pending' : 'failed';
    return {
      status,
      observed_at: new Date(t).toISOString(),
      reason:
        status === 'failed'
          ? `No Galileo satellite in the fix is OSNMA-authenticated (${gal} used).`
          : status === 'authenticated'
            ? `${auth}/${gal} Galileo satellites authenticated; ${(frac * 100).toFixed(0)}% of the fix.`
            : null,
      mode: 'synthetic' as const,
      public_key_id: 'synthetic',
    };
  });
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function loadAttestation(dir: string, notes: string[]): AttestationEvidence | null {
  const f = join(dir, 'U2_attestation', 'U2_enrolment_bundle.json');
  if (!existsSync(f)) return null;
  const b = JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>;
  let chainOk = false;
  let sigOk = false;
  try {
    const leaf = new X509Certificate(b.attestation_cert_pem!);
    const mid = new X509Certificate(b.intermediate_cert_pem!);
    const root = new X509Certificate(b.root_cert_pem!);
    chainOk = leaf.verify(mid.publicKey) && mid.verify(root.publicKey) && root.verify(root.publicKey);
  } catch (e) {
    notes.push(`U2 chain parse error: ${(e as Error).message}`);
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(b.attested_public_key_hex!, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    const msg = Buffer.concat([Buffer.from(b.nonce_hex!, 'hex'), Buffer.from(b.device_id!, 'utf8')]);
    sigOk = cryptoVerify(null, msg, key, Buffer.from(b.signature_hex!, 'hex'));
  } catch (e) {
    notes.push(`U2 signature check error: ${(e as Error).message}`);
  }
  return {
    device_id: b.device_id ?? 'unknown',
    assurance_level: 'hardware',
    provider: 'PIV attestation (synthetic root)',
    verified: chainOk && sigOk,
    observed_at: new Date(Date.parse(b.enrolled_at ?? '') || Date.now()).toISOString(),
    reason: `chain ${chainOk ? 'verifies' : 'does NOT verify'} to the synthetic root; enrolment signature ${sigOk ? 'valid' : 'INVALID'}. Not a vendor (Yubico) root.`,
    synthetic: true,
  };
}

function loadCaptures(dir: string, entityId: string): LabCapture[] {
  const d = join(dir, 'U1_rf');
  const caps = readCsv(findFile(d, /^U1_captures\.csv$/) ?? '');
  const epochs = readCsv(findFile(d, /^U1_epochs\.csv$/) ?? '');
  const groups = new Map<string, number[]>();
  for (const e of epochs) {
    const k = `${e.capture_id}|${e.epoch_utc}|${e.element_pair}`;
    const ph = num(e.phase_diff_deg);
    if (ph == null) continue;
    const g = groups.get(k) ?? [];
    g.push((ph * Math.PI) / 180);
    groups.set(k, g);
  }
  // Mean resultant length R of the inter-element phase differences across satellites, per
  // epoch and element pair. Genuine signals arrive from many directions (low R); a single
  // transmitter makes every satellite's phase difference identical (R → 1).
  const rBy = new Map<string, number[]>();
  for (const [k, ph] of groups) {
    if (ph.length < 3) continue;
    const c = ph.reduce((s, x) => s + Math.cos(x), 0) / ph.length;
    const s = ph.reduce((s2, x) => s2 + Math.sin(x), 0) / ph.length;
    const cap = k.split('|')[0]!;
    const l = rBy.get(cap) ?? [];
    l.push(Math.hypot(c, s));
    rBy.set(cap, l);
  }
  const out: LabCapture[] = [];
  for (const c of caps) {
    const rs = rBy.get(c.capture_id!) ?? [];
    if (rs.length === 0) continue;
    const r = rs.reduce((a, b) => a + b, 0) / rs.length;
    const status: RfLabResult['status'] = r >= 0.9 ? 'fail' : r <= 0.6 ? 'pass' : 'warning';
    const startMs = Date.parse(c.start_utc!);
    const endMs = Date.parse(c.end_utc!);
    out.push({
      id: c.capture_id!,
      startMs,
      endMs,
      result: {
        v: 1,
        layout_id: c.capture_id!,
        entity_id: entityId,
        observed_at: new Date(startMs).toISOString(),
        mode: 'lab_iq_recorded',
        antennas: num(c.channels) ?? 4,
        sample_rate_hz: num(c.sample_rate_hz) ?? 2.4e6,
        center_freq_hz: num(c.center_freq_hz) ?? 1_575_420_000,
        fc_note: 'L1/E1, GPS-timestamped buffers',
        status,
        aoa_status: status,
        reason:
          status === 'fail'
            ? `All tracked satellites show the same inter-element phase (R=${r.toFixed(2)}): signals from one direction.`
            : status === 'pass'
              ? `Phase differences vary across satellites (R=${r.toFixed(2)}): signals from many directions.`
              : `Partial clustering of phase differences (R=${r.toFixed(2)}).`,
        spoof_overlay: null,
        metrics: { epochs_pairs: rs.length, sats_tracked: num(c.sats_tracked), element_pairs: num(c.element_pairs) },
        aoa: {
          method: 'multi_element_phase_interferometry',
          cluster_score: Math.round(r * 1000) / 1000,
          coherence: Math.round(r * 1000) / 1000,
          directions_deg: [],
        },
      } as RfLabResult,
    });
  }
  return out;
}

function findFile(d: string, re: RegExp): string | null {
  if (!existsSync(d)) return null;
  const f = readdirSync(d).find((n) => re.test(n));
  return f ? join(d, f) : null;
}

function dateTag(dir: string): string {
  const f = findFile(join(dir, 'U0_platform'), /^U0_primary_ais.*_(\d{8})\.jsonl$/);
  return f?.match(/_(\d{8})\.jsonl$/)?.[1] ?? '';
}

export function labFolderPath(repoRoot: string): string {
  return process.env.NORTHSTAR_LAB_DIR ?? join(repoRoot, 'data_lab');
}

export function loadLabFolder(dir: string): LabFolder | null {
  const platformPath = join(dir, 'U0_platform', 'U0_platform.json');
  if (!existsSync(platformPath)) return null;
  const platform = JSON.parse(readFileSync(platformPath, 'utf8')) as {
    vessel_name?: string;
    mmsi: number;
    recording_start_utc: string;
    recording_end_utc: string;
    dimensions?: { ais_ref?: Record<string, number> };
  };
  const mmsi = platform.mmsi;
  const entityId = `LAB-${mmsi}`;
  const notes: string[] = [];
  const startMs = Date.parse(platform.recording_start_utc);
  const endMs = Date.parse(platform.recording_end_utc);
  return {
    dir,
    mmsi,
    entityId,
    name: platform.vessel_name ?? entityId,
    windowMs: [startMs, endMs],
    primaryAis: loadPrimary(dir, mmsi, platform.dimensions?.ais_ref),
    secondaryAis: loadSecondary(dir, mmsi, entityId),
    gnss: loadGnss(dir, entityId),
    dr: loadDr(dir),
    targetObs: loadTargetObs(dir, mmsi),
    osnma: loadOsnma(dir, startMs),
    attestation: loadAttestation(dir, notes),
    captures: loadCaptures(dir, entityId),
    receiverEvents: receiverEvents(dir),
    notes,
  };
}

/** Latest element at or before t (ms) within maxAgeMs, from a series sorted by time. */
export function atOrBefore<T>(xs: T[], timeOf: (x: T) => number, t: number, maxAgeMs: number): T | null {
  let lo = 0;
  let hi = xs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeOf(xs[mid]!) <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  const x = xs[best]!;
  return t - timeOf(x) <= maxAgeMs ? x : null;
}
