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
  ReplayGuard,
  canonicalize,
  verifyEnvelope,
  type JsonValue,
} from '@northstar/core';
import { sha256 } from '@noble/hashes/sha256';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadEnv,
  loadFusion,
  loadThresholds,
  REPO_ROOT,
  type EnvConfig,
} from './config.js';
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
}

export class NorthstarApp {
  env: EnvConfig;
  geo: GeoData;
  /** Synthetic fallback if no Digitraffic recording cache yet */
  sim: Simulator;
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
  viewMode: ViewMode = 'both';
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

  constructor(opts: NorthstarAppOptions = {}) {
    this.env = loadEnv();
    this.geo = loadGeo();
    const fusion = loadFusion();
    const thresholds = loadThresholds();
    this.dataDir = opts.dataDir ?? null;
    this.replayStatePath =
      opts.replayStatePath ??
      (opts.dataDir
        ? join(opts.dataDir, 'replay-guard.json')
        : join(REPO_ROOT, 'data/fixtures/replay-guard.json'));
    this.pipeline = new TrustPipeline(fusion, thresholds, this.geo);
    this.live = new LiveFeedService(
      fusion,
      thresholds,
      this.geo,
      this.env.aisstreamKey,
    );
    this.sim = new Simulator(this.env.seed);
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

    const hist = await this.lab.init();
    this.useHistoricalLab = hist.ok;
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
            reason: 'ICD protocol demo bound to full-stack Hist Lab vessel only',
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
      this.lastOsnmaResult = r;
      this.attachOsnmaToLabFleet();
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
      return {
        id: this.lab.scenario.id,
        targetId: this.lab.scenario.targetId,
        osnmaFail: this.lab.scenario.osnmaFail,
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

  tick(): void {
    const batch = this.useHistoricalLab ? this.lab.tick(1) : this.sim.tick(1);
    const { aisA, aisB, imu, gnss, simTimeIso } = batch;
    const scenario = this.activeScenario();

    for (const e of aisB) this.pipeline.ingestSecondary(e);
    for (const g of gnss) this.pipeline.setGnss(g);
    for (const i of imu) this.pipeline.setImu(i);

    // OSNMA protocol demo for Hist Lab / synthetic lab only (never LIVE-*)
    if (scenario.osnmaFail || scenario.id === 'osnma_failure') {
      this.lastOsnmaResult = osnmaFixture('failed', simTimeIso);
    } else if (this.lastOsnmaResult) {
      // Keep ICD/sidecar result; refresh timestamp only
      this.lastOsnmaResult = { ...this.lastOsnmaResult, observed_at: simTimeIso };
    } else {
      this.lastOsnmaResult = osnmaFixture('authenticated', simTimeIso);
    }
    this.attachOsnmaToLabFleet(aisA.map((e) => e.entity_id));
    // Re-bind full-stack RF/AoA each tick (only signed Lab entity)
    if (this.lastRfLabResult) {
      const fsId = this.fullstackEntityId();
      if (fsId && !fsId.startsWith('LIVE-')) {
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

  setScenario(id: ScenarioId, entityId?: string): void {
    const target =
      entityId ??
      this.lab.signedEntityId ??
      this.selectedEntityId ??
      'VESSEL-001';
    if (this.useHistoricalLab) this.lab.setScenario(id, target);
    this.sim.setScenario(id, target);
    const at = new Date(this.activeScenario().simTimeMs).toISOString();
    if (id === 'reset') {
      this.pipeline.reset();
      // Preserve sequence counters across scenario reset (persistPath); only clear hash cache.
      this.replay.reset(undefined, { clearSequences: false });
      this.lastOsnmaResult =
        loadOsnmaIcdCache(at) ?? osnmaFixture('authenticated', at);
      this.attachOsnmaToLabFleet();
      void this.seedAttestation();
      this.loadRfLabResult('nominal');
      this.audit.append('scenario_reset', {});
    } else if (id === 'osnma_failure') {
      void this.runOsnmaVerify('failure').catch(() => {
        this.lastOsnmaResult = osnmaFixture('failed', at);
        this.attachOsnmaToLabFleet();
      });
      this.audit.append('scenario_set', { scenario: id, entity_id: target });
    } else if (id === 'osnma_auth') {
      void this.runOsnmaVerify('configuration_1').catch(() => {
        this.lastOsnmaResult =
          loadOsnmaIcdCache(at) ?? osnmaFixture('authenticated', at);
        this.attachOsnmaToLabFleet();
      });
      this.audit.append('scenario_set', { scenario: id, entity_id: target });
    } else if (id === 'rf_aoa_spoof_cluster') {
      this.loadRfLabResult('spoof');
      this.audit.append('scenario_set', { scenario: id, entity_id: target });
    } else {
      this.loadRfLabResult('nominal');
      this.audit.append('scenario_set', { scenario: id, entity_id: target });
    }
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
  }

  /** Bind Manavi dual-ant AoA JSON to full-stack Lab entity only — never LIVE-*. */
  loadRfLabResult(kind: 'nominal' | 'spoof' = 'nominal'): void {
    const name =
      kind === 'spoof' ? 'capture01_spoof_cluster.json' : 'capture01_nominal.json';
    const path = join(REPO_ROOT, 'data/rf/results', name);
    if (!existsSync(path)) {
      this.lastRfLabResult = null;
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as RfLabResult;
      const entityId =
        this.lab.signedEntityId ?? this.selectedEntityId ?? 'VESSEL-001';
      if (entityId.startsWith('LIVE-')) return;
      this.lastRfLabResult = {
        ...raw,
        entity_id: entityId,
        observed_at: raw.observed_at ?? new Date().toISOString(),
      };
      this.pipeline.setRfLab(entityId, this.lastRfLabResult);
    } catch {
      this.lastRfLabResult = null;
    }
  }

  applyRfLabResult(result: RfLabResult): void {
    const entityId =
      result.entity_id && !result.entity_id.startsWith('LIVE-')
        ? result.entity_id
        : (this.lab.signedEntityId ?? this.selectedEntityId ?? 'VESSEL-001');
    if (entityId.startsWith('LIVE-')) return;
    this.lastRfLabResult = { ...result, entity_id: entityId };
    this.pipeline.setRfLab(entityId, this.lastRfLabResult);
    this.broadcast({ type: 'snapshot', payload: this.snapshot() });
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

    const envelopeWithAlg: SignedTelemetryEnvelope = {
      ...envelope,
      signature_alg:
        envelope.signature_alg ??
        (device.signature_alg as SignedTelemetryEnvelope['signature_alg']) ??
        'ed25519',
      assurance_level: envelope.assurance_level ?? device.assurance_level ?? 'software',
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
    this.broadcast({ type: 'vessel_update', payload: vessel });
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
      ? 'LAB · Digitraffic historical replay'
      : 'LAB · synthetic';

    return {
      data_mode: this.useHistoricalLab ? 'replay' : this.env.dataMode,
      monitoring_label: liveOk
        ? this.viewMode === 'lab'
          ? labLabel
          : this.viewMode === 'live'
            ? 'LIVE AIS · Digitraffic'
            : `LIVE + ${this.useHistoricalLab ? 'HIST LAB' : 'SYN LAB'}`
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
    };
  }

  getOsnmaDemoStatus() {
    return this.lastOsnmaResult;
  }
}
