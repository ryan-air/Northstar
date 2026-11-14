import type {
  AppSnapshot,
  FeedHealth,
  FleetMetrics,
  ScenarioId,
  SignedTelemetryEnvelope,
  VesselState,
  ViewMode,
  WsMessage,
} from '@northstar/contracts';
import {
  IngestValidator,
  ReplayGuard,
  canonicalize,
  verifyEnvelope,
  type JsonValue,
} from '@northstar/core';
import { sha256 } from '@noble/hashes/sha256';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import {
  loadEnv,
  loadFusion,
  loadThresholds,
  REPO_ROOT,
  runtimeDataDir,
  type EnvConfig,
  type ThresholdsConfig,
} from './config.js';
import { configureReplayStore, EVAL_SNAPSHOT_PATH } from './replay/store.js';
import { setAuditCheckpointPath, auditCheckpointsSettled } from './security/auditCheckpoint.js';
import { setAuditLogPath } from './security/auditVerify.js';
import { setOsnmaCachePaths } from './fixtures/loadFixtures.js';
import type { RfLabResult } from '@northstar/contracts';
import { loadGeo, type GeoData } from './geo/loadGeo.js';
import { TrustPipeline } from './engine/pipeline.js';
import { Simulator } from './sim/simulator.js';
import { DeviceRegistry } from './crypto/deviceRegistry.js';
import { AuditLog } from './state/auditLog.js';
import {
  loadOsnmaIcdCache,
  osnmaFixture,
  softwareAttestation,
} from './fixtures/loadFixtures.js';
import { LiveFeedService } from './live/liveFeed.js';
import { HistoricalLab } from './replay/historicalLab.js';
import { EnrolTokenStore } from './security/enrolTokens.js';
import { isLoopbackHost } from './security/adminAuth.js';
import { atOrBefore, labFolderPath, loadLabFolder, type LabFolder } from './lab/labFolder.js';
import { HistoricalRecorder } from './replay/recorder.js';
import { SecurityForensics } from './security/forensics.js';
import { ShoreKeyring } from './security/shoreKeys.js';
import { RevocationLog } from './security/revocationLog.js';
import { writeAuditCheckpoint } from './security/auditCheckpoint.js';
import { OsnmaSidecarClient } from './adapters/osnmaClient.js';
import { bytesToB64 } from '@northstar/core';

type Listener = (msg: WsMessage) => void;

export interface NorthstarAppOptions {
  /** Absolute directory for devices/audit/revocation fixtures (tests use a temp dir). */
  dataDir?: string;
  /** Absolute path for persisted replay-guard state. */
  replayStatePath?: string;
  /** JSONL the Hist Lab reads (tests pass the frozen eval snapshot, P0.2). */
  replayPath?: string;
}

/** Seed files copied into the runtime data dir on first run (P1.5). Tracked files stay untouched. */
const SEED_FILES: Array<[string, string]> = [
  ['data/fixtures/devices.json', 'devices.json'],
  ['data/fixtures/audit.jsonl', 'audit.jsonl'],
  ['data/fixtures/audit.checkpoint.json', 'audit.checkpoint.json'],
  ['data/fixtures/revocation.jsonl', 'revocation.jsonl'],
  ['data/fixtures/revocation.jsonl.head.json', 'revocation.jsonl.head.json'],
  ['data/fixtures/replay-guard.json', 'replay-guard.json'],
  ['data/fixtures/osnma_icd_cache.json', 'osnma_icd_cache.json'],
  ['data/replay/gof_ais.jsonl', 'replay/gof_ais.jsonl'],
  ['data/replay/manifest.json', 'replay/manifest.json'],
];

export function seedRuntimeDataDir(dir: string): string[] {
  const copied: string[] = [];
  mkdirSync(join(dir, 'replay'), { recursive: true });
  for (const [src, dst] of SEED_FILES) {
    const from = join(REPO_ROOT, src);
    const to = join(dir, dst);
    if (!existsSync(to) && existsSync(from)) {
      copyFileSync(from, to);
      copied.push(dst);
    }
  }
  return copied;
}

export class NorthstarApp {
  env: EnvConfig;
  geo: GeoData;
  /** Synthetic fallback if no Digitraffic recording cache yet */
  sim: Simulator;
  /**
   * Injection policy (no override): attacks are injected only into simulated ships, never
   * into historical (recorded) or live vessels. In Hist Lab mode a few synthetic ships run
   * on the Lab clock as attack targets.
   */
  readonly labSimShipIds: Set<string>;
  /** Private lab return (data_lab/), null when absent. */
  labFolder: LabFolder | null = null;
  private labSecondaryIdx = 0;
  lab: HistoricalLab;
  recorder: HistoricalRecorder;
  pipeline: TrustPipeline;
  live: LiveFeedService;
  registry: DeviceRegistry;
  audit: AuditLog;
  replay: ReplayGuard;
  forensics: SecurityForensics;
  shore!: ShoreKeyring;
  revocation!: RevocationLog;
  osnmaClient: OsnmaSidecarClient;
  listeners = new Set<Listener>();
  selectedEntityId: string | null = 'VESSEL-001';
  /** UI offers Live and Lab only; 'both' remains accepted by the API. */
  viewMode: ViewMode = 'lab';
  useHistoricalLab = false;
  private timer: NodeJS.Timeout | null = null;
  private lastOsnmaResult: import('@northstar/contracts').OsnmaResult | null = null;
  private osnmaPoll: NodeJS.Timeout | null = null;
  private readonly dataDir: string | null;
  private readonly replayStatePath: string | null;
  /** Last JCS SHA-256 of signed telemetry (for Cyber console). */
  lastTelemetryHash: {
    ok: boolean;
    hash: string;
    device_id?: string;
    reason?: string;
    at: string;
  } | null = null;
  /** Lab dual-ant IQ / AoA result bound only to full-stack Hist Lab entity. */
  private lastRfLabResult: RfLabResult | null = null;

  readonly thresholds: ThresholdsConfig;
  /** P1.4: Hist Lab ingest gate (now = replay clock). */
  labValidator: IngestValidator;

  constructor(opts: NorthstarAppOptions = {}) {
    this.env = loadEnv();
    const fusion = loadFusion();
    const thresholds = loadThresholds();
    this.thresholds = thresholds;
    this.geo = loadGeo(thresholds.geographic);
    // P1.5: mutable runtime state lives in NORTHSTAR_DATA_DIR (default .northstar/data).
    const runtimeDir = opts.dataDir ?? runtimeDataDir();
    if (!opts.dataDir && runtimeDir) {
      const copied = seedRuntimeDataDir(runtimeDir);
      if (copied.length > 0) console.log(`[northstar] seeded ${runtimeDir}: ${copied.join(', ')}`);
    }
    this.dataDir = runtimeDir;
    if (runtimeDir) {
      setAuditCheckpointPath(join(runtimeDir, 'audit.checkpoint.json'));
      setAuditLogPath(join(runtimeDir, 'audit.jsonl'));
      setOsnmaCachePaths([
        join(runtimeDir, 'osnma_icd_cache.json'),
        join(REPO_ROOT, 'data/fixtures/osnma_icd_cache.json'),
      ]);
    }
    const runtimeReplay = runtimeDir ? join(runtimeDir, 'replay/gof_ais.jsonl') : null;
    const readPath =
      opts.replayPath ??
      process.env.NORTHSTAR_REPLAY_PATH ??
      (runtimeReplay && existsSync(runtimeReplay)
        ? runtimeReplay
        : opts.dataDir && existsSync(EVAL_SNAPSHOT_PATH)
          ? EVAL_SNAPSHOT_PATH
          : undefined);
    configureReplayStore({
      ...(readPath ? { read: readPath } : {}),
      ...(runtimeReplay && !opts.dataDir
        ? { append: runtimeReplay, manifest: join(runtimeDir!, 'replay/manifest.json') }
        : {}),
    });
    const v = thresholds.validation;
    this.labValidator = new IngestValidator({
      staleAfterMs: (v?.lab_stale_after_s ?? 120) * 1000,
      maxFutureSkewMs: (v?.max_future_skew_s ?? 30) * 1000,
    });
    this.replayStatePath =
      opts.replayStatePath ??
      (this.dataDir
        ? join(this.dataDir, 'replay-guard.json')
        : join(REPO_ROOT, 'data/fixtures/replay-guard.json'));
    this.pipeline = new TrustPipeline(fusion, thresholds, this.geo);
    this.live = new LiveFeedService(
      fusion,
      thresholds,
      this.geo,
      this.env.aisstreamKey,
    );
    this.sim = new Simulator(this.env.seed);
    const nSim = Math.max(0, Number(process.env.NORTHSTAR_LAB_SIM_SHIPS ?? 3) || 0);
    this.labSimShipIds = new Set(this.sim.vessels.slice(0, nSim).map((v) => v.def.entity_id));
    this.lab = new HistoricalLab();
    this.recorder = new HistoricalRecorder();
    const devicesPath = this.dataDir
      ? join(this.dataDir, 'devices.json')
      : 'data/fixtures/devices.json';
    const auditPath = this.dataDir
      ? join(this.dataDir, 'audit.jsonl')
      : 'data/fixtures/audit.jsonl';
    this.registry = new DeviceRegistry(devicesPath);
    this.audit = new AuditLog(auditPath);
    this.forensics = new SecurityForensics();
    this.osnmaClient = new OsnmaSidecarClient(this.env.osnmaUrl);
    this.replay = new ReplayGuard({
      freshnessWindowS: thresholds.crypto.freshness_window_s,
      maxClockSkewS: thresholds.crypto.max_clock_skew_s,
      duplicateCacheSize: thresholds.crypto.duplicate_cache_size,
      persistPath: this.replayStatePath,
    });
  }

  async init(): Promise<void> {
    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Shore keyring + revocation + audit checkpoints
    this.shore = await ShoreKeyring.loadOrCreate(
      this.env.shoreKeyDir.replace(/^~/, process.env.HOME ?? ''),
    );
    const revocationPath = this.dataDir
      ? join(this.dataDir, 'revocation.jsonl')
      : 'data/fixtures/revocation.jsonl';
    this.revocation = new RevocationLog(this.shore, revocationPath);
    await this.revocation.ready();
    this.audit.onAppend = (entry) => {
      void writeAuditCheckpoint(
        this.shore,
        { seq: entry.seq, tip_hash: entry.hash, entry_count: entry.seq },
        this.env.auditMirrorPath,
      );
    };
    // Anchor current tip if log already has entries
    const tip = this.audit.tip;
    if (tip.seq > 0) {
      await writeAuditCheckpoint(
        this.shore,
        { seq: tip.seq, tip_hash: tip.hash, entry_count: tip.seq },
        this.env.auditMirrorPath,
      );
    }

    // Role split: shore must not treat device private keys as its own signing material
    if (this.env.role === 'shore') {
      const shoreDir = this.env.shoreKeyDir.replace(/^~/, process.env.HOME ?? '');
      try {
        const shoreFiles = existsSync(shoreDir) ? readdirSync(shoreDir) : [];
        const leaked = shoreFiles.filter(
          (f) => f.endsWith('.ed25519') && !f.startsWith('shore') && !f.endsWith('.pub'),
        );
        if (leaked.length > 0) {
          throw new Error(
            `NORTHSTAR_ROLE=shore: device private key(s) found in shore key dir: ${leaked.join(', ')}. Move device keys to NORTHSTAR_KEY_DIR.`,
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('NORTHSTAR_ROLE')) throw e;
      }
      console.log(
        `[northstar] role=shore — verify-only for devices; shore keys in ${shoreDir}; device keys for device-sim in ${this.env.keyDir}`,
      );
    }

    // Shore does not generate or hold device private keys.
    // device-sim generates its own keypair and enrolls the public key via /api/devices/enrol.
    if (this.env.role === 'shore') {
      console.log(
        '[northstar] device private keys are device-side only — enroll public keys via POST /api/devices/enrol',
      );
    }

    // Prefer real ICD cache; fixture only as fallback (not live SIS)
    const bootIso = new Date().toISOString();
    this.lastOsnmaResult =
      loadOsnmaIcdCache(bootIso) ?? osnmaFixture('authenticated', bootIso);

    // Private lab return (gitignored data_lab/): its vessel becomes the full-stack Lab ship.
    try {
      this.labFolder = loadLabFolder(labFolderPath(REPO_ROOT));
    } catch (e) {
      console.warn(`[northstar] lab folder could not be loaded: ${(e as Error).message}`);
      this.labFolder = null;
    }
    if (this.labFolder) {
      this.lab.setLabTrack(this.labFolder.primaryAis);
      console.log(
        `[northstar] lab return loaded: ${this.labFolder.entityId} (${this.labFolder.primaryAis.length} AIS reports; U2/U5 synthetic)`,
      );
    }

    const hist = await this.lab.init();
    this.useHistoricalLab = hist.ok;
    if (this.labFolder && this.useHistoricalLab) this.applyLabStatic();
    this.reseedLabShips(this.lab.simTimeMs);
    if (hist.ok && this.lab.signedEntityId) {
      this.selectedEntityId = this.lab.signedEntityId;
      const bound = this.registry.bindEntity('DEV-VESSEL-001', this.lab.signedEntityId);
      this.audit.append('device_bound_historical', {
        device_id: 'DEV-VESSEL-001',
        entity_id: this.lab.signedEntityId,
        rebound: !!bound,
      });
    }
    this.syncLabOsnmaStatus();

    // Software attestation for fleet entities (honest assurance=software — not hardware-backed)
    await this.seedAttestation();

    this.live.setOnUpdate(() => {
      this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    });
    this.live.setOnReject((r) => {
      this.forensics.push(
        'ingest_rejected',
        `Ingest rejected (${r.feed}): ${r.code} — ${r.reason}`,
        { feed: r.feed, code: r.code, entity_id: r.entity_id },
        'warning',
      );
    });
    this.audit.append('lab_source', {
      historical: hist.ok,
      reason: hist.reason,
      vessel_count: hist.vesselCount,
      signed_entity_id: this.lab.signedEntityId,
    });

    // Pull sidecar / auto-warm ICD verify if cache thin
    void this.refreshOsnmaFromSidecar().then(() => this.maybeAutoWarmOsnma());

    // Full-stack RF/AoA on signed Hist Lab entity only
    this.loadRfLabResult('nominal');
  }

  /** Mirror protocol OSNMA onto Hist Lab event field + all LAB pipeline entities. */
  private syncLabOsnmaStatus(): void {
    const r = this.lastOsnmaResult;
    if (this.useHistoricalLab) {
      this.lab.protocolOsnmaStatus =
        r?.status === 'authenticated' ||
        r?.status === 'failed' ||
        r?.status === 'pending'
          ? r.status
          : 'unavailable';
    }
  }

  /**
   * Attach protocol-demo OSNMA. Default scope=fullstack: only the instrumented Hist Lab vessel.
   * lab_fleet: all non-LIVE lab entities (legacy demo). Never LIVE-*.
   */
  private attachOsnmaToLabFleet(entityIds?: string[]): void {
    const r = this.lastOsnmaResult;
    if (!r) return;
    this.syncLabOsnmaStatus();
    const fullstackId = this.fullstackEntityId();
    if (this.env.osnmaScope === 'fullstack') {
      const allLab =
        entityIds ??
        (this.useHistoricalLab
          ? this.lab.vessels.map((v) => v.track.entity_id)
          : this.sim.vessels.map((v) => v.def.entity_id));
      for (const id of allLab) {
        if (id.startsWith('LIVE-')) continue;
        if (fullstackId && id === fullstackId) {
          this.pipeline.setOsnma(id, r);
        } else {
          this.pipeline.setOsnma(id, {
            status: 'unavailable',
            observed_at: r.observed_at,
            reason: 'ICD test-vector result is bound to the full-stack Lab vessel only',
            mode: 'not_connected',
          });
        }
      }
      return;
    }
    const ids =
      entityIds ??
      (this.useHistoricalLab
        ? this.lab.vessels.map((v) => v.track.entity_id)
        : this.sim.vessels.map((v) => v.def.entity_id));
    for (const id of ids) {
      if (id.startsWith('LIVE-')) continue;
      this.pipeline.setOsnma(id, r);
    }
  }

  private async maybeAutoWarmOsnma(): Promise<void> {
    const cached = loadOsnmaIcdCache();
    if (cached?.status === 'authenticated') return;
    if (this.osnmaClient.status !== 'ok') return;
    try {
      await this.runOsnmaVerify('configuration_1');
    } catch {
      /* sidecar may still be starting */
    }
  }

  async refreshOsnmaFromSidecar(): Promise<void> {
    const ok = await this.osnmaClient.health();
    if (!ok) return;
    const r = await this.osnmaClient.result();
    if (r && (r.status === 'authenticated' || r.status === 'failed' || r.status === 'pending')) {
      this.lastOsnmaResult = r;
      this.attachOsnmaToLabFleet();
      if (r.status === 'authenticated') {
        this.forensics.push(
          'osnma_verified',
          'OSNMA ICD/protocol verification: navigation data authenticated',
          { status: r.status, public_key_id: r.public_key_id },
          'info',
        );
      }
    }
  }

  async runOsnmaVerify(scenario: 'configuration_1' | 'failure' = 'configuration_1') {
    try {
      const r = await this.osnmaClient.verify(scenario, scenario === 'configuration_1');
      if (scenario === 'failure') {
        // Failure test vector = injected attack → a simulated ship only.
        const picked = this.pickSimTarget(this.selectedEntityId);
        this.simOverrides.osnma = { target: picked.target, result: r };
        this.pipeline.setOsnma(picked.target, r);
      } else {
        this.lastOsnmaResult = r;
        this.attachOsnmaToLabFleet();
      }
      if (r.status === 'authenticated') {
        this.forensics.push(
          'osnma_verified',
          'OSNMAlib verified ICD test vector (TESLA/MAC + KROOT)',
          { scenario, ...(typeof r === 'object' ? { status: r.status } : {}) },
          'info',
        );
        this.audit.append('osnma_verified', { scenario, status: r.status });
      } else {
        this.forensics.push(
          'osnma_failed',
          r.reason ?? 'OSNMA verification failed',
          { scenario, status: r.status },
          'critical',
        );
        this.audit.append('osnma_failed', { scenario, status: r.status, reason: r.reason });
      }
      this.broadcast({ type: 'snapshot', payload: this.snapshot() });
      return r;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.forensics.push('osnma_failed', reason, { scenario }, 'warning');
      throw e;
    }
  }

  /**
   * Rotate requires the device to supply a new public key — shore never generates
   * or writes device private keys.
   */
  async rotateDevice(deviceId: string, newPublicKeyB64?: string) {
    const prev = this.registry.get(deviceId);
    const oldKeyId = prev?.key_id;
    if (!newPublicKeyB64) {
      throw new Error('rotate requires new_public_key_b64 from the device');
    }
    const { enrollment } = await this.registry.rotate(deviceId, newPublicKeyB64);
    if (oldKeyId) {
      await this.revocation.append({
        action: 'rotate_invalidate',
        device_id: deviceId,
        key_id: oldKeyId,
      });
    }
    this.audit.append('key_rotated', {
      device_id: deviceId,
      key_id: enrollment.key_id,
      invalidated_key_id: oldKeyId,
    });
    this.forensics.push(
      'key_rotated',
      `Rotated Ed25519 key for ${deviceId} → ${enrollment.key_id}`,
      { device_id: deviceId, key_id: enrollment.key_id, public_key_prefix: enrollment.public_key.slice(0, 16) },
      'warning',
    );
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    return { enrollment, private_key_written: false };
  }

  async revokeDevice(deviceId: string) {
    const enrollment = this.registry.revoke(deviceId);
    if (enrollment) {
      await this.revocation.append({
        action: 'revoke',
        device_id: deviceId,
        key_id: enrollment.key_id,
      });
    }
    this.audit.append('key_revoked', { device_id: deviceId, key_id: enrollment?.key_id });
    this.forensics.push(
      'key_revoked',
      `Revoked device ${deviceId} — signatures must fail`,
      { device_id: deviceId, revoked_at: enrollment?.revoked_at },
      'critical',
    );
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    return enrollment;
  }

  private async seedAttestation(): Promise<void> {
    const attest = await softwareAttestation('DEV-VESSEL-001');
    const signedEntityId = this.fullstackEntityId();
    if (this.useHistoricalLab) {
      for (const v of this.lab.vessels) {
        this.pipeline.setAttestation(
          v.track.entity_id,
          signedEntityId && v.track.entity_id === signedEntityId ? attest : null,
        );
      }
    } else {
      for (const v of this.sim.vessels) {
        this.pipeline.setAttestation(
          v.def.entity_id,
          signedEntityId && v.def.entity_id === signedEntityId ? attest : null,
        );
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.live.start(12_000);
    // Keep growing historical cache from Digitraffic
    this.recorder.start(15_000);
    this.osnmaPoll = setInterval(() => void this.refreshOsnmaFromSidecar(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.live.stop();
    this.recorder.stop();
    if (this.osnmaPoll) clearInterval(this.osnmaPoll);
    this.osnmaPoll = null;
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn({ type: 'snapshot', payload: this.snapshot() });
    return () => this.listeners.delete(fn);
  }

  private broadcast(msg: WsMessage): void {
    for (const fn of this.listeners) fn(msg);
  }

  private activeScenario(): { id: ScenarioId; targetId: string; osnmaFail: boolean; tickCount: number; simTimeMs: number } {
    if (this.useHistoricalLab) {
      const simActive = this.sim.scenario.id !== 'normal';
      return {
        id: simActive ? this.sim.scenario.id : this.lab.scenario.id,
        targetId: simActive ? this.sim.scenario.targetId : this.lab.scenario.targetId,
        osnmaFail: simActive ? false : this.lab.scenario.osnmaFail,
        tickCount: this.lab.tickCount,
        simTimeMs: this.lab.simTimeMs,
      };
    }
    return {
      id: this.sim.scenario.id,
      targetId: this.sim.scenario.targetId,
      osnmaFail: this.sim.scenario.osnmaFail,
      tickCount: this.sim.tickCount,
      simTimeMs: this.sim.simTimeMs,
    };
  }

  /** Hist Lab rejections by code (P1.4 / P3.5). */
  labRejections(): Record<string, number> {
    return { ...this.labValidator.rejected };
  }

  tick(): void {
    const labPrevMs = this.lab.simTimeMs;
    const batch = this.useHistoricalLab ? this.lab.tick(1) : this.sim.tick(1);
    const { simTimeIso } = batch;
    const aisB = [...batch.aisB];
    const imu = [...batch.imu];
    const gnss = [...batch.gnss];
    const incomingA = [...batch.aisA];
    if (this.useHistoricalLab && this.labSimShipIds.size > 0) {
      // Synthetic attack-target ships on the Lab clock (labelled simulated).
      const dtS = (this.lab.simTimeMs - labPrevMs) / 1000;
      const wrappedNow = 'wrapped' in batch && batch.wrapped;
      if (wrappedNow || !(dtS > 0)) {
        for (const id of this.labSimShipIds) this.pipeline.removeEntity(id);
        this.sim.simTimeMs = this.lab.simTimeMs;
      } else {
        this.sim.simTimeMs = labPrevMs;
        const sb = this.sim.tick(dtS);
        const keep = <T extends { entity_id: string }>(xs: T[]) => xs.filter((x) => this.labSimShipIds.has(x.entity_id));
        incomingA.push(...keep(sb.aisA));
        aisB.push(...keep(sb.aisB));
        imu.push(...keep(sb.imu));
        gnss.push(...keep(sb.gnss));
      }
    }
    const scenario = this.activeScenario();
    if ('wrapped' in batch && batch.wrapped) {
      // P3.3: timeline looped — clear Lab entities and hard-alert state so the jump
      // back to the start is not scored as a teleport.
      for (const v of this.lab.vessels) this.pipeline.removeEntity(v.track.entity_id);
      this.labValidator.reset();
      this.attachOsnmaToLabFleet();
      void this.seedAttestation();
      this.audit.append('lab_timeline_wrapped', { wraps: this.lab.wraps });
      this.reseedLabShips(this.lab.simTimeMs);
    }
    // P1.4: validate every Lab event against the replay clock; rejects go to forensics only.
    const nowDate = new Date(simTimeIso);
    const aisA: typeof batch.aisA = [];
    for (const e of incomingA) {
      const out = this.labValidator.validate(e, nowDate);
      if (out.ok) {
        aisA.push(out.event);
      } else {
        this.forensics.push(
          'ingest_rejected',
          `Lab ingest rejected: ${out.code} — ${out.reason}`,
          { feed: 'hist_lab', code: out.code, entity_id: e.entity_id },
          'warning',
        );
      }
    }

    for (const e of aisB) this.pipeline.ingestSecondary(e);
    for (const g of gnss) this.pipeline.setGnss(g);
    for (const i of imu) this.pipeline.setImu(i);
    if ('wrapped' in batch && batch.wrapped && this.labFolder) {
      this.labSecondaryIdx = 0;
      this.applyLabStatic();
    }
    this.applyLabTick(Date.parse(simTimeIso));

    // OSNMA protocol demo for Hist Lab / synthetic lab only (never LIVE-*)
    // OSNMA failure is an injected attack: it goes to a simulated ship only (below).
    const simOsnmaFail = this.sim.scenario.id === 'osnma_failure';
    if (this.lastOsnmaResult) {
      // Keep ICD/sidecar result; refresh timestamp only
      this.lastOsnmaResult = { ...this.lastOsnmaResult, observed_at: simTimeIso };
    } else {
      this.lastOsnmaResult = osnmaFixture('authenticated', simTimeIso);
    }
    this.attachOsnmaToLabFleet(aisA.map((e) => e.entity_id));
    if (simOsnmaFail) this.pipeline.setOsnma(this.sim.scenario.targetId, osnmaFixture('failed', simTimeIso));
    this.applyLabOsnma(Date.parse(simTimeIso));
    if (this.simOverrides.osnma) {
      const o = this.simOverrides.osnma;
      this.pipeline.setOsnma(o.target, { ...o.result, observed_at: simTimeIso });
    }
    // Re-bind full-stack RF/AoA each tick (only signed Lab entity, demo evidence)
    if (this.lastRfLabResult) {
      const fsId = this.fullstackEntityId();
      if (fsId && !fsId.startsWith('LIVE-') && fsId !== this.simOverrides.rf?.target && fsId !== this.labFolder?.entityId) {
        this.pipeline.setRfLab(fsId, this.lastRfLabResult);
      }
    }

    for (const e of aisA) {
      const state = this.pipeline.process(e, simTimeIso);
      this.broadcast({ type: 'vessel_update', payload: { ...state, origin: 'lab' } });
    }

    this.broadcast({
      type: 'tick',
      payload: { sim_time: simTimeIso, last_update: new Date().toISOString() },
    });

    if (scenario.tickCount % 2 === 0) {
      this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    }
  }

  /** Lab evidence that does not change per tick: DR series, radar/SAR obs, attestation. */
  private applyLabStatic(): void {
    const lab = this.labFolder;
    if (!lab) return;
    this.pipeline.setDrSeries(lab.entityId, lab.dr);
    this.pipeline.setTargetObservations(lab.entityId, lab.targetObs);
    // The device-sim signs the lab's independent onboard receiver log for this vessel.
    this.pipeline.setOnboardIndependent(lab.entityId, lab.hasOnboardLog);
    if (lab.attestation) this.pipeline.setAttestation(lab.entityId, lab.attestation);
  }

  /** Per-tick lab evidence at the Lab clock: GNSS diagnostics, secondary AIS, RF captures. */
  private applyLabTick(tMs: number): void {
    const lab = this.labFolder;
    if (!lab || !this.useHistoricalLab) return;
    const g = atOrBefore(lab.gnss, (x) => Date.parse(x.observed_at), tMs, 10_000);
    if (g) this.pipeline.setGnss(g);
    while (
      this.labSecondaryIdx < lab.secondaryAis.length &&
      Date.parse(lab.secondaryAis[this.labSecondaryIdx]!.source_timestamp) <= tMs
    ) {
      this.pipeline.ingestSecondary(lab.secondaryAis[this.labSecondaryIdx]!);
      this.labSecondaryIdx++;
    }
    for (const alert of this.pipeline.checkSilence(lab.entityId, new Date(tMs).toISOString())) {
      this.broadcast({ type: 'alert', payload: alert });
    }
    const cap = lab.captures.find((c) => tMs >= c.startMs - 60_000 && tMs <= c.endMs + 60_000);
    if (cap) this.pipeline.setRfLab(lab.entityId, cap.result);
    else if (lab.captures.length > 0) {
      // Outside a capture: unavailable, but say when the captures were and what they showed.
      const hm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
      const list = lab.captures.map((c) => `${c.id} ${hm(c.startMs)} UTC (${c.result.status})`).join(', ');
      const c0 = lab.captures[0]!.result;
      this.pipeline.setRfLab(lab.entityId, {
        ...c0,
        observed_at: new Date(tMs).toISOString(),
        status: 'unavailable',
        aoa_status: 'unavailable',
        reason: `No RF capture at this time. Recorded captures: ${list}.`,
      });
    } else this.pipeline.setRfLab(lab.entityId, null);
    if (lab.attestation) this.pipeline.setAttestation(lab.entityId, lab.attestation);
  }

  /** Synthetic OSNMA (U5) for the lab vessel, after the fleet-wide OSNMA binding. */
  private applyLabOsnma(tMs: number): void {
    const lab = this.labFolder;
    if (!lab || !this.useHistoricalLab) return;
    const o = atOrBefore(lab.osnma, (x) => Date.parse(x.observed_at), tMs, 10_000);
    this.pipeline.setOsnma(
      lab.entityId,
      o ?? { status: 'unavailable', observed_at: new Date(tMs).toISOString(), reason: 'outside lab recording window', mode: 'synthetic' },
    );
  }

  /**
   * Re-place each recorded Lab ship at its latest real report from the last 20 min (processed
   * at that report's own time), so after a start, wrap or jump the map is not empty until
   * every ship happens to report again. Nothing is interpolated or invented.
   */
  private reseedLabShips(tMs: number): void {
    if (!this.useHistoricalLab) return;
    for (const e of this.lab.lastReportsBefore(tMs, 20 * 60_000)) {
      this.pipeline.process(e, e.source_timestamp);
    }
  }

  /**
   * Reset only the Lab: stop any injected attack, move the Lab clock back to its start,
   * simulated ships back to their route starts, recorded ships to their starting reports.
   * Live ships, replay protection, OSNMA and the audit chain are untouched (unlike the
   * 'reset' scenario, which wipes everything).
   */
  resetLab(): { ok: boolean; sim_time: string } {
    this.clearSimOverrides();
    if (this.useHistoricalLab) {
      this.lab.setScenario('normal');
      this.lab.resetPlayheads();
    }
    this.sim.reset();
    this.sim.simTimeMs = this.useHistoricalLab ? this.lab.simTimeMs : this.sim.simTimeMs;
    const labIds = this.useHistoricalLab ? this.lab.vessels.map((v) => v.track.entity_id) : [];
    for (const id of [...labIds, ...this.sim.vessels.map((v) => v.def.entity_id)]) this.pipeline.removeEntity(id);
    this.labValidator.reset();
    this.labSecondaryIdx = 0;
    if (this.labFolder && this.useHistoricalLab) this.applyLabStatic();
    this.attachOsnmaToLabFleet();
    void this.seedAttestation();
    this.reseedLabShips(this.lab.simTimeMs);
    const at = new Date(this.activeScenario().simTimeMs).toISOString();
    this.audit.append('lab_reset', { sim_time: at });
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    return { ok: true, sim_time: at };
  }

  /** Lab-return events for the UI: receiver-flagged windows, RF captures, recording window. */
  labEvents(): {
    entity_id: string;
    name: string;
    window: [string, string];
    events: Array<{ kind: string; start: string; end: string; detail: string }>;
  } | null {
    const lab = this.labFolder;
    if (!lab || !this.useHistoricalLab) return null;
    const iso = (ms: number) => new Date(ms).toISOString();
    const events = [
      ...lab.receiverEvents.map((e) => ({
        kind: e.kind,
        start: iso(e.startMs),
        end: iso(e.endMs),
        detail: e.kind === 'spoofing' ? (e.maxState >= 3 ? 'receiver: spoofing affirmed' : 'receiver: spoofing indicated') : e.maxState >= 3 ? 'receiver: jamming critical' : 'receiver: jamming warning',
      })),
      ...lab.captures.map((c) => ({
        kind: 'rf_capture',
        start: iso(c.startMs),
        end: iso(c.endMs),
        detail: `RF capture ${c.id}: ${c.result.status}`,
      })),
    ].sort((a, b) => a.start.localeCompare(b.start));
    return { entity_id: lab.entityId, name: lab.name, window: [iso(lab.windowMs[0]), iso(lab.windowMs[1])], events };
  }

  /**
   * Jump the Hist Lab clock (e.g. to a lab event). Lab and simulated ships are cleared first
   * so the jump is not scored as a teleport; lab inputs are re-synced to the new time.
   */
  seekLab(tMs: number): { ok: boolean; sim_time?: string } {
    if (!this.useHistoricalLab) return { ok: false };
    const t = this.lab.seek(tMs);
    for (const v of this.lab.vessels) this.pipeline.removeEntity(v.track.entity_id);
    for (const id of this.labSimShipIds) this.pipeline.removeEntity(id);
    this.labValidator.reset();
    this.sim.simTimeMs = t;
    if (this.labFolder) {
      const sec = this.labFolder.secondaryAis;
      let i = 0;
      while (i < sec.length && Date.parse(sec[i]!.source_timestamp) <= t) i++;
      this.labSecondaryIdx = i;
      this.applyLabStatic();
    }
    this.attachOsnmaToLabFleet();
    void this.seedAttestation();
    this.reseedLabShips(t);
    this.audit.append('lab_seek', { sim_time: new Date(t).toISOString() });
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    return { ok: true, sim_time: new Date(t).toISOString() };
  }

  /** Attacks always go to simulated ships only; kept as a method for the API/status. */
  injectionPolicyActive(): true {
    return true;
  }

  /** Simulated ships that may receive injected attacks in the current mode. */
  simulatedShipIds(): string[] {
    return this.useHistoricalLab ? [...this.labSimShipIds] : this.sim.vessels.map((v) => v.def.entity_id);
  }

  /** Requested ship if it is simulated, otherwise the first simulated ship. */
  private pickSimTarget(requested?: string | null): { target: string; retargeted_from?: string } {
    const sims = this.simulatedShipIds();
    const target = requested && sims.includes(requested) ? requested : (sims[0] ?? 'VESSEL-001');
    return requested && requested !== target ? { target, retargeted_from: requested } : { target };
  }

  /** Injected evidence on simulated ships (re-applied every tick, cleared on scenario change). */
  private simOverrides: {
    rf?: { target: string; result: RfLabResult };
    osnma?: { target: string; result: import('@northstar/contracts').OsnmaResult };
  } = {};

  private clearSimOverrides(): void {
    if (this.simOverrides.rf) this.pipeline.setRfLab(this.simOverrides.rf.target, null);
    this.simOverrides = {};
  }

  private bindSimRf(target: string, result: RfLabResult | null): void {
    if (!result) return;
    const r = { ...result, entity_id: target, observed_at: result.observed_at ?? new Date().toISOString() };
    this.simOverrides.rf = { target, result: r };
    this.pipeline.setRfLab(target, r);
  }

  setScenario(
    id: ScenarioId,
    entityId?: string,
  ): { target: string; retargeted_from?: string; policy: 'simulated_only' } {
    // Position/sensor/evidence injections → simulated ships only. signed_tamper /
    // signed_replay attack the simulated device channel (forged envelopes are rejected
    // fail-closed and never enter the data), so they keep their target.
    const INJECTIONS: ScenarioId[] = [
      'sudden_spoof', 'gradual_drift', 'ais_disagreement', 'gnss_jamming', 'imu_disagreement',
      'stale_clock_skew', 'osnma_failure', 'rf_aoa_spoof_cluster',
    ];
    if (INJECTIONS.includes(id)) {
      const picked = this.pickSimTarget(entityId ?? this.selectedEntityId);
      this.clearSimOverrides();
      if (this.useHistoricalLab) this.lab.setScenario('normal');
      this.sim.setScenario(id, picked.target);
      if (id === 'rf_aoa_spoof_cluster') this.bindSimRf(picked.target, this.readRfResult('spoof'));
      this.audit.append('scenario_set', { scenario: id, entity_id: picked.target, policy: 'simulated_only', ...picked });
      this.broadcast({ type: 'snapshot', payload: this.snapshot() });
      return { ...picked, policy: 'simulated_only' };
    }
    this.clearSimOverrides();
    // 'normal' after an attack: clear only the simulated ships so the target recovers at
    // once (no clock jump, live and recorded ships untouched — unlike 'reset').
    if (id === 'normal' && this.sim.scenario.id !== 'normal') {
      for (const s of this.simulatedShipIds()) this.pipeline.removeEntity(s);
    }
    const target =
      entityId ??
      this.lab.signedEntityId ??
      this.selectedEntityId ??
      'VESSEL-001';
    if (this.useHistoricalLab) {
      this.sim.setScenario(id === 'reset' ? 'reset' : 'normal');
      this.lab.setScenario(id, target);
    } else {
      this.sim.setScenario(id, target); // synthetic fleet: every ship is simulated
    }
    const at = new Date(this.activeScenario().simTimeMs).toISOString();
    if (id === 'reset') {
      this.pipeline.reset();
      this.labValidator.reset();
      this.labSecondaryIdx = 0;
      if (this.labFolder && this.useHistoricalLab) this.applyLabStatic();
      // Preserve sequence counters across scenario reset (persistPath); only clear hash cache.
      this.replay.reset(undefined, { clearSequences: false });
      this.lastOsnmaResult =
        loadOsnmaIcdCache(at) ?? osnmaFixture('authenticated', at);
      this.attachOsnmaToLabFleet();
      void this.seedAttestation();
      this.loadRfLabResult('nominal');
      this.audit.append('scenario_reset', {});
    } else if (id === 'osnma_auth') {
      void this.runOsnmaVerify('configuration_1').catch(() => {
        this.lastOsnmaResult =
          loadOsnmaIcdCache(at) ?? osnmaFixture('authenticated', at);
        this.attachOsnmaToLabFleet();
      });
      this.audit.append('scenario_set', { scenario: id, entity_id: target });
    } else {
      this.loadRfLabResult('nominal');
      this.audit.append('scenario_set', { scenario: id, entity_id: target });
    }
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    return { target, policy: 'simulated_only' };
  }

  private readRfResult(kind: 'nominal' | 'spoof'): RfLabResult | null {
    const path = join(REPO_ROOT, 'data/rf/results', kind === 'spoof' ? 'capture01_spoof_cluster.json' : 'capture01_nominal.json');
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as RfLabResult;
    } catch {
      return null;
    }
  }

  /**
   * Nominal: bind the Manavi dual-ant AoA demo capture to the full-stack Lab entity (demo
   * evidence, never LIVE-*). Spoof: an injected attack → a simulated ship only.
   */
  loadRfLabResult(kind: 'nominal' | 'spoof' = 'nominal'): { target: string | null; retargeted_from?: string } {
    if (kind === 'spoof') {
      const picked = this.pickSimTarget(this.selectedEntityId);
      this.bindSimRf(picked.target, this.readRfResult('spoof'));
      this.broadcast({ type: 'snapshot', payload: this.snapshot() });
      return picked;
    }
    const raw = this.readRfResult('nominal');
    if (!raw) {
      this.lastRfLabResult = null;
      return { target: null };
    }
    const entityId = this.lab.signedEntityId ?? this.selectedEntityId ?? 'VESSEL-001';
    if (entityId.startsWith('LIVE-')) return { target: null };
    this.lastRfLabResult = {
      ...raw,
      entity_id: entityId,
      observed_at: raw.observed_at ?? new Date().toISOString(),
    };
    this.pipeline.setRfLab(entityId, this.lastRfLabResult);
    return { target: entityId };
  }

  /** Externally posted RF/AoA result: injected evidence → a simulated ship only. */
  applyRfLabResult(result: RfLabResult): { target: string; retargeted_from?: string; result: RfLabResult } {
    const picked = this.pickSimTarget(result.entity_id ?? this.selectedEntityId);
    this.bindSimRf(picked.target, result);
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    return { ...picked, result: this.simOverrides.rf!.result };
  }

  getRfLabResult() {
    return this.lastRfLabResult;
  }

  fullstackEntityId(): string | null {
    return this.lab.signedEntityId ?? (this.useHistoricalLab ? null : 'VESSEL-001');
  }

  async ingestSigned(
    envelope: SignedTelemetryEnvelope,
    now = new Date(),
  ): Promise<{ ok: boolean; reason?: string; vessel?: VesselState; forensics_id?: string }> {
    // Authenticate by public key id only — never fall back to payload.device_id.
    const device = this.registry.getByKeyId(envelope.public_key_id);
    const crlHit =
      this.revocation.isKeyRevoked(envelope.public_key_id) ||
      (device
        ? this.revocation.isDeviceRevoked(device.device_id)
        : this.revocation.isDeviceRevoked(envelope.payload.device_id));
    if (!device || device.revoked_at || crlHit) {
      this.audit.append('signature_rejected', {
        reason: crlHit ? 'revocation_list' : 'untrusted_key',
        device_id: envelope.payload.device_id,
      });
      const ev = this.forensics.push(
        'untrusted_key',
        crlHit
          ? `Rejected telemetry — key/device on shore-signed revocation list`
          : device?.revoked_at
            ? `Rejected telemetry — device ${envelope.payload.device_id} is revoked`
            : `Rejected telemetry — unknown/untrusted key ${envelope.public_key_id}`,
        {
          device_id: envelope.payload.device_id,
          entity_id: envelope.payload.entity_id,
          public_key_id: envelope.public_key_id,
          revoked_at: device?.revoked_at ?? null,
          revocation_list: crlHit,
        },
        'critical',
      );
      return {
        ok: false,
        reason: crlHit ? 'revocation_list' : 'untrusted_key',
        forensics_id: ev.id,
      };
    }

    // Bind device ↔ vessel ↔ key: payload claims must match the enrolled device.
    if (
      envelope.payload.device_id !== device.device_id ||
      envelope.payload.entity_id !== device.entity_id
    ) {
      this.audit.append('binding_rejected', {
        device_id: device.device_id,
        payload_device_id: envelope.payload.device_id,
        payload_entity_id: envelope.payload.entity_id,
        enrolled_entity_id: device.entity_id,
      });
      const ev = this.forensics.push(
        'untrusted_key',
        `Rejected telemetry — device/entity binding mismatch (enrolled ${device.device_id}@${device.entity_id}, payload ${envelope.payload.device_id}@${envelope.payload.entity_id})`,
        {
          device_id: device.device_id,
          entity_id: device.entity_id,
          payload_device_id: envelope.payload.device_id,
          payload_entity_id: envelope.payload.entity_id,
          public_key_id: envelope.public_key_id,
        },
        'critical',
      );
      return { ok: false, reason: 'binding_mismatch', forensics_id: ev.id };
    }

    const pk = this.registry.getPublicKey(device.device_id);
    if (!pk) return { ok: false, reason: 'untrusted_key' };

    // Peek challenge before verify; consume only after signature succeeds.
    const challengePeek = this.forensics.peekChallengeNonce(
      device.device_id,
      envelope.payload.challenge_nonce,
      this.env.challengeRequired,
    );
    if (!challengePeek.ok) {
      this.audit.append('challenge_rejected', {
        device_id: device.device_id,
        reason: challengePeek.reason,
      });
      return { ok: false, reason: challengePeek.reason };
    }

    // P4.3: the algorithm is bound to the enrolment. An envelope claiming a different
    // algorithm is rejected; assurance_level comes from the registry only (the
    // envelope's claim is logged, never trusted).
    const enrolledAlg = (device.signature_alg ?? 'ed25519') as SignedTelemetryEnvelope['signature_alg'];
    if (envelope.signature_alg && envelope.signature_alg !== enrolledAlg) {
      this.audit.append('signature_alg_mismatch', {
        device_id: device.device_id,
        envelope_alg: envelope.signature_alg,
        enrolled_alg: enrolledAlg,
      });
      const ev = this.forensics.push(
        'signature_failed',
        `Rejected telemetry — signature_alg ${envelope.signature_alg} ≠ enrolled ${enrolledAlg}`,
        {
          device_id: device.device_id,
          entity_id: device.entity_id,
          envelope_alg: envelope.signature_alg,
          enrolled_alg: enrolledAlg,
        },
        'critical',
      );
      return { ok: false, reason: 'signature_alg_mismatch', forensics_id: ev.id };
    }
    if (envelope.assurance_level && envelope.assurance_level !== device.assurance_level) {
      this.audit.append('assurance_claim_ignored', {
        device_id: device.device_id,
        claimed: envelope.assurance_level,
        enrolled: device.assurance_level,
      });
    }
    const envelopeWithAlg: SignedTelemetryEnvelope = {
      ...envelope,
      signature_alg: enrolledAlg,
      assurance_level: device.assurance_level ?? 'software',
    };
    const verified = await verifyEnvelope(envelopeWithAlg, pk);
    if (!verified.ok) {
      this.audit.append('signature_failed', {
        device_id: envelope.payload.device_id,
        reason: verified.reason,
      });
      const failHash = Buffer.from(
        sha256(
          new TextEncoder().encode(
            canonicalize(envelope.payload as unknown as JsonValue),
          ),
        ),
      ).toString('hex');
      this.lastTelemetryHash = {
        ok: false,
        hash: failHash,
        device_id: envelope.payload.device_id,
        reason: verified.reason,
        at: new Date().toISOString(),
      };
      const ev = this.forensics.push(
        'signature_failed',
        `Ed25519 verify failed: ${verified.reason}`,
        {
          device_id: envelope.payload.device_id,
          entity_id: envelope.payload.entity_id,
          public_key_id: envelope.public_key_id,
          reason: verified.reason,
          signature_prefix: envelope.signature.slice(0, 24),
          payload_hash: failHash,
          canonical_hint: 'payload is JCS-canonicalized before verify',
          track_updated: false,
        },
        'critical',
      );
      // Forensics only — rejected telemetry must never update vessel track or trust.
      return { ok: false, reason: verified.reason, forensics_id: ev.id };
    }

    // Signature OK — now consume the challenge nonce.
    const challengeConsume = this.forensics.consumeChallengeNonce(
      device.device_id,
      envelope.payload.challenge_nonce,
      this.env.challengeRequired,
    );
    if (!challengeConsume.ok) {
      this.audit.append('challenge_rejected', {
        device_id: device.device_id,
        reason: challengeConsume.reason,
      });
      return { ok: false, reason: challengeConsume.reason };
    }

    const payloadHash = Buffer.from(
      sha256(new TextEncoder().encode(canonicalize(verified.payload as unknown as JsonValue))),
    ).toString('hex');

    // Replay guard keyed on authenticated device id (not payload claim).
    const replay = this.replay.check({
      deviceId: device.device_id,
      sequence: verified.payload.sequence_number,
      timestamp: verified.payload.timestamp,
      payloadHash,
      now,
    });
    if (!replay.accept) {
      this.audit.append('replay_rejected', {
        device_id: device.device_id,
        reason: replay.reason,
        detail: replay.detail,
      });
      const ev = this.forensics.push(
        'replay_rejected',
        `Replay/freshness guard: ${replay.reason} — ${replay.detail}`,
        {
          device_id: device.device_id,
          entity_id: verified.payload.entity_id,
          reason: replay.reason,
          detail: replay.detail,
          sequence: verified.payload.sequence_number,
          payload_hash_prefix: payloadHash.slice(0, 16),
          track_updated: false,
        },
        'critical',
      );
      // Forensics only — do not process into pipeline.
      return { ok: false, reason: replay.reason, forensics_id: ev.id };
    }

    this.audit.append('signature_verified', {
      device_id: verified.payload.device_id,
      sequence: verified.payload.sequence_number,
    });
    this.lastTelemetryHash = {
      ok: true,
      hash: payloadHash,
      device_id: verified.payload.device_id,
      at: new Date().toISOString(),
    };
    this.forensics.push(
      'signature_verified',
      `Ed25519 OK · seq ${verified.payload.sequence_number} · ${verified.payload.device_id}`,
      {
        device_id: verified.payload.device_id,
        entity_id: verified.payload.entity_id,
        sequence: verified.payload.sequence_number,
        key_id: envelope.public_key_id,
        payload_hash: payloadHash,
        payload_hash_prefix: payloadHash.slice(0, 16),
        public_key_prefix: bytesToB64(pk).slice(0, 16),
      },
      'info',
    );

    const nowIso = now.toISOString();
    const position = verified.payload.position;

    const event = {
      schema_version: 1 as const,
      entity_id: verified.payload.entity_id,
      entity_type: 'vessel' as const,
      vessel_class: verified.payload.vessel_class,
      position,
      speed_over_ground_knots: verified.payload.speed_over_ground_knots,
      course_over_ground_deg: verified.payload.course_over_ground_deg,
      heading_deg: verified.payload.heading_deg,
      source: 'device_telemetry',
      provider_id: 'device_gateway',
      device_id: verified.payload.device_id,
      source_timestamp: verified.payload.timestamp,
      // P3.2: the time the position refers to (replay clock) — used for kinematics/alignment.
      ...(verified.payload.observation_time
        ? { observation_time: verified.payload.observation_time }
        : {}),
      ingested_at: nowIso,
      sequence_number: verified.payload.sequence_number,
      device_signature_status: 'verified' as const,
      osnma_status: verified.payload.osnma_status ?? 'unavailable',
      quality: {
        position_accuracy_m: 8,
        signal_quality_available: true,
      },
      labels: {
        simulated: !this.useHistoricalLab,
        live: false,
        fixture: false,
      },
    };
    const vessel = this.pipeline.process(event, nowIso);
    this.broadcast({
      type: 'vessel_update',
      payload: { ...vessel, origin: vessel.entity_id.startsWith('LIVE-') ? 'live' : 'lab' },
    });
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    return { ok: true, vessel };
  }

  metrics(): FleetMetrics {
    const vessels = [...this.labVessels(), ...this.liveVessels()];
    const highRisk = vessels.filter(
      (v) => v.trust.trust_band === 'suspicious' || v.trust.trust_band === 'critical',
    ).length;
    const alerts = this.pipeline.getAlerts().filter((a) => a.severity !== 'info');
    const avgCov =
      vessels.length === 0
        ? 0
        : vessels.reduce((s, v) => s + v.trust.evidence_coverage, 0) / vessels.length;
    return {
      vessels_monitored: vessels.length,
      high_risk_vessels: highRisk,
      active_alerts: alerts.length,
      average_evidence_coverage: Math.round(avgCov * 10) / 10,
    };
  }

  feedHealth(): FeedHealth {
    const liveSt = this.live.digitraffic.status;
    const aisLive =
      liveSt === 'ok'
        ? 'ok'
        : liveSt === 'degraded'
          ? 'degraded'
          : liveSt === 'connecting'
            ? 'connecting'
            : liveSt === 'down'
              ? 'down'
              : 'unavailable';
    return {
      ais_a: 'ok',
      ais_b: 'unavailable',
      ais_live: aisLive,
      device_telemetry: 'ok',
      osnma:
        this.lastOsnmaResult?.status === 'authenticated'
          ? this.osnmaClient.status === 'ok' || loadOsnmaIcdCache()
            ? 'ok'
            : 'demo'
          : this.lastOsnmaResult
            ? 'demo'
            : 'unavailable',
      rf_lab: this.lastRfLabResult
        ? this.lastRfLabResult.aoa_status === 'pass'
          ? 'ok'
          : 'demo'
        : 'unavailable',
      imu: 'simulated',
      gnss_raw: 'simulated',
    };
  }

  private labVessels(): VesselState[] {
    return this.pipeline
      .getVessels()
      .filter((v) => !v.entity_id.startsWith('LIVE-'))
      .map((v) => ({ ...v, origin: 'lab' as const }));
  }

  private liveVessels(): VesselState[] {
    return this.live.getVessels().map((v) => ({ ...v, origin: 'live' as const }));
  }

  snapshot(): AppSnapshot {
    const scenario = this.activeScenario();
    const simTime = new Date(scenario.simTimeMs).toISOString();
    const liveStatus = this.live.status();
    const liveOk =
      liveStatus.digitraffic.status === 'ok' || liveStatus.digitraffic.status === 'degraded';
    const lab = this.labVessels();
    const live = this.liveVessels();
    const vessels =
      this.viewMode === 'live' ? live : this.viewMode === 'lab' ? lab : [...lab, ...live];
    const labStatus = this.useHistoricalLab
      ? this.lab.status()
      : {
          mode: 'synthetic_fallback' as const,
          source: 'synthetic_gof_routes',
          vessel_count: this.sim.vessels.length,
          signed_entity_id: 'VESSEL-001',
          note: 'No Digitraffic recording cache — using synthetic Gulf of Finland routes.',
          manifest: null,
        };

    const labLabel = this.useHistoricalLab
      ? 'LAB · recorded + simulated ships'
      : 'LAB · synthetic';

    return {
      data_mode: this.useHistoricalLab ? 'replay' : this.env.dataMode,
      monitoring_label: liveOk
        ? this.viewMode === 'lab'
          ? labLabel
          : this.viewMode === 'live'
            ? 'LIVE AIS · Digitraffic'
            : 'LIVE + LAB'
        : labLabel,
      view_mode: this.viewMode,
      sim_time: simTime,
      last_update: new Date().toISOString(),
      active_scenario: scenario.id,
      metrics: this.metrics(),
      feed_health: this.feedHealth(),
      vessels: vessels.map((v) => ({
        ...v,
        track: v.track.slice(-50),
      })),
      live: liveStatus,
      live_vessels: live.map((v) => ({
        ...v,
        track: v.track.slice(-50),
      })),
      lab: {
        mode: labStatus.mode,
        source: labStatus.source,
        vessel_count: labStatus.vessel_count,
        signed_entity_id: labStatus.signed_entity_id,
        fullstack_entity_id: this.fullstackEntityId(),
        speed: 'speed' in labStatus ? labStatus.speed : undefined,
        note: labStatus.note,
        osnma_protocol_status:
          'osnma_protocol_status' in labStatus
            ? String(labStatus.osnma_protocol_status)
            : this.lastOsnmaResult?.status,
        rf_aoa_status: this.lastRfLabResult?.aoa_status ?? null,
        rf_summary: this.lastRfLabResult
          ? {
              layout_id: this.lastRfLabResult.layout_id,
              antennas: this.lastRfLabResult.antennas,
              aoa_status: this.lastRfLabResult.aoa_status,
              directions_deg: this.lastRfLabResult.aoa?.directions_deg ?? [],
              cluster_score: this.lastRfLabResult.aoa?.cluster_score,
              spoof_overlay: this.lastRfLabResult.spoof_overlay ?? null,
              fc_note: this.lastRfLabResult.fc_note ?? null,
              center_freq_hz: this.lastRfLabResult.center_freq_hz,
            }
          : null,
        manifest: (labStatus.manifest ?? null) as Record<string, unknown> | null,
        recorder: {
          status: this.recorder.status,
          last_poll_at: this.recorder.lastPollAt,
          last_count: this.recorder.lastCount,
          last_error: this.recorder.lastError,
        },
      },
      alerts: this.pipeline.getAlerts(),
      timeline: this.pipeline.getTimeline(),
      selected_entity_id: this.selectedEntityId,
      injection: {
        policy: 'simulated_only' as const,
        simulated_ships: this.simulatedShipIds(),
        lab_vessel_id: this.labFolder && this.useHistoricalLab ? this.labFolder.entityId : null,
      },
    };
  }

  private enrolTokenValue: string | null = null;

  /** Path of the enrolment token (P4.1). Generated on first use; device-sim reads it. */
  enrolTokenPath(): string {
    return (
      process.env.NORTHSTAR_ENROL_TOKEN_PATH ??
      (this.dataDir ? join(this.dataDir, 'enrol.token') : join(REPO_ROOT, '.northstar/enrol.token'))
    );
  }

  enrolToken(): string {
    if (this.enrolTokenValue) return this.enrolTokenValue;
    const p = this.enrolTokenPath();
    if (existsSync(p)) {
      this.enrolTokenValue = readFileSync(p, 'utf8').trim();
    } else {
      this.enrolTokenValue = randomBytes(24).toString('base64url');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, this.enrolTokenValue + '\n');
      try {
        chmodSync(p, 0o600);
      } catch {
        /* best effort */
      }
    }
    return this.enrolTokenValue;
  }

  /** One-time per-vessel enrolment tokens (hashed, in the runtime data dir). */
  private enrolTokens: EnrolTokenStore | null = null;
  private enrolTokenStore(): EnrolTokenStore {
    return (this.enrolTokens ??= new EnrolTokenStore(
      this.dataDir ? join(this.dataDir, 'enrol_tokens.json') : join(REPO_ROOT, '.northstar/enrol_tokens.json'),
    ));
  }

  issueEnrolToken(entityId: string, ttlS: number, issuedBy: string): { token: string; expires_at: string } {
    const r = this.enrolTokenStore().issue(entityId, ttlS, issuedBy);
    this.audit.append('enrol_token_issued', { entity_id: entityId, expires_at: r.expires_at, issued_by: issuedBy });
    return r;
  }

  /** The shared enrol token is accepted only on loopback binds (or when explicitly allowed). */
  sharedEnrolTokenAllowed(): boolean {
    return isLoopbackHost(this.env.host) || process.env.NORTHSTAR_ALLOW_SHARED_ENROL_TOKEN === 'true';
  }

  private tokenMatches(candidate: string | undefined): boolean {
    if (!candidate || !this.sharedEnrolTokenAllowed()) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.enrolToken());
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * P4.1 enrolment policy. Requires the admin bearer OR the enrolment token, and refuses
   * to add a second active device to a vessel unless an admin sends replace: true.
   */
  async enrolDevice(
    body: { device_id?: string; entity_id?: string; public_key_b64?: string; replace?: boolean },
    auth: { admin: boolean; enrolToken?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const oneTime =
      !auth.admin && !this.tokenMatches(auth.enrolToken) && !!body.entity_id &&
      this.enrolTokenStore().consume(auth.enrolToken, body.entity_id);
    if (!auth.admin && !this.tokenMatches(auth.enrolToken) && !oneTime) {
      this.forensics.push(
        'enrolment_rejected',
        'Enrolment rejected — no admin bearer or valid X-Northstar-Enrol-Token',
        { device_id: body?.device_id, entity_id: body?.entity_id },
        'critical',
      );
      this.audit.append('enrolment_rejected', { reason: 'unauthenticated', device_id: body?.device_id });
      return { status: 401, body: { error: 'enrolment_authorization_required' } };
    }
    if (!body?.device_id || !body.entity_id || !body.public_key_b64) {
      return { status: 400, body: { error: 'device_id, entity_id and public_key_b64 are required' } };
    }
    const existing = this.registry.get(body.device_id);
    if (existing) {
      if (existing.entity_id !== body.entity_id || existing.public_key !== body.public_key_b64) {
        return {
          status: 409,
          body: {
            error: 'device_already_enrolled',
            detail:
              'Local device key/entity does not match the enrolled record. Clear the runtime devices.json (NORTHSTAR_DATA_DIR) or enrol a new device_id — do not share .northstar/ keys across machines.',
            enrolled: { device_id: existing.device_id, entity_id: existing.entity_id, key_id: existing.key_id },
          },
        };
      }
      return { status: 200, body: { ok: true, enrollment: existing, existing: true } };
    }
    const others = this.registry.activeForEntity(body.entity_id);
    if (others.length > 0 && !(auth.admin && body.replace === true)) {
      this.forensics.push(
        'enrolment_rejected',
        `Enrolment rejected — ${body.entity_id} already has an active device (${others.map((d) => d.device_id).join(', ')})`,
        { device_id: body.device_id, entity_id: body.entity_id },
        'critical',
      );
      this.audit.append('enrolment_rejected', {
        reason: 'entity_has_active_device',
        device_id: body.device_id,
        entity_id: body.entity_id,
      });
      return {
        status: 409,
        body: {
          error: 'entity_has_active_device',
          detail: 'Revoke the existing device or have an admin re-enrol with replace: true.',
        },
      };
    }
    if (others.length > 0) {
      for (const d of others) await this.revokeDevice(d.device_id);
    }
    const { enrollment } = await this.registry.enroll({
      device_id: body.device_id,
      entity_id: body.entity_id,
      public_key_b64: body.public_key_b64,
    });
    this.audit.append('device_enrolled', {
      device_id: enrollment.device_id,
      entity_id: enrollment.entity_id,
      key_id: enrollment.key_id,
      private_key_issued: false,
      replaced: others.map((d) => d.device_id),
    });
    return { status: 200, body: { ok: true, enrollment, existing: false } };
  }

  /** P3.2: replay clock shared with the device-sim. */
  labClock(): { ready: boolean; sim_time: string; speed: number; timeline: string; entity_id: string | null } {
    return {
      ready: this.useHistoricalLab,
      sim_time: new Date(this.activeScenario().simTimeMs).toISOString(),
      speed: this.useHistoricalLab ? this.lab.speed : 1,
      timeline: this.useHistoricalLab
        ? this.lab.legacyPlayhead
          ? 'legacy_per_vessel_playhead'
          : 'shared_absolute_clock'
        : 'synthetic',
      entity_id: this.fullstackEntityId(),
    };
  }

  /** P4.4: wait for queued audit checkpoint writes. */
  async auditSettled(): Promise<void> {
    await auditCheckpointsSettled();
  }

  getOsnmaDemoStatus() {
    return this.lastOsnmaResult;
  }
}
