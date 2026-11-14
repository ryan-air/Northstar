/**
 * Adversarial probes — the three attacks from the audit, plus kinematics evasions.
 * Tests mutate only a temporary dataDir (never data/fixtures).
 */
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bytesToB64,
  checkKinematics,
  generateKeyPair,
  signPayload,
  type KinematicsState,
} from '@northstar/core';
import type { PositionEvent, TelemetryPayload } from '@northstar/contracts';
import { NorthstarApp } from './app.js';
import { REPO_ROOT } from './config.js';

describe('adversarial attacks (isolated fixtures)', () => {
  let app: NorthstarApp;
  let dataDir: string;

  beforeAll(async () => {
    process.env.NORTHSTAR_CHALLENGE_REQUIRED = 'true';
    process.env.VITEST = 'true';
    dataDir = mkdtempSync(join(tmpdir(), 'northstar-attacks-'));
    const src = join(REPO_ROOT, 'data/fixtures');
    // Seed only static fixtures — empty mutable logs
    for (const f of ['gnss_nominal.json', 'gnss_spoofish.json', 'gnss_jamming.json', 'osnma_demo.json']) {
      const p = join(src, f);
      if (existsSync(p)) cpSync(p, join(dataDir, f));
    }
    writeFileSync(join(dataDir, 'devices.json'), '[]');
    writeFileSync(join(dataDir, 'audit.jsonl'), '');
    writeFileSync(join(dataDir, 'revocation.jsonl'), '');
    app = new NorthstarApp({ dataDir });
    await app.init();
    for (let i = 0; i < 3; i++) app.tick();
  });

  afterAll(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function enrollDevice(deviceId: string, entityId: string) {
    const { privateKey, publicKey } = await generateKeyPair();
    await app.registry.enroll({
      device_id: deviceId,
      entity_id: entityId,
      public_key_b64: bytesToB64(publicKey),
    });
    return { privateKey, publicKey, keyId: app.registry.get(deviceId)!.key_id };
  }

  async function ingestOk(
    deviceId: string,
    privateKey: Uint8Array,
    keyId: string,
    payload: TelemetryPayload,
  ) {
    const { nonce } = app.forensics.issueChallenge(deviceId);
    const withChallenge = { ...payload, challenge_nonce: nonce };
    const signature = await signPayload(withChallenge, privateKey);
    return app.ingestSigned({
      payload: withChallenge,
      signature,
      public_key_id: keyId,
      assurance_level: 'software',
      signature_alg: 'ed25519',
    });
  }

  it('forged zero-filled signature does not move victim track or trust', async () => {
    const victim =
      app.lab.signedEntityId ?? app.pipeline.getVessels()[0]?.entity_id ?? 'VESSEL-001';
    for (let i = 0; i < 2; i++) app.tick();
    const before = app.pipeline.getVessels().find((v) => v.entity_id === victim);
    expect(before).toBeTruthy();
    const trustBefore = before!.trust.trust_score;
    const posBefore = { ...before!.position };

    const { keyId } = await enrollDevice('DEV-ATTACK-VICTIM', victim);
    const { nonce } = app.forensics.issueChallenge('DEV-ATTACK-VICTIM');
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-ATTACK-VICTIM',
      entity_id: victim,
      sequence_number: 1,
      timestamp: new Date().toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 60.17, lon: 24.94, crs: 'EPSG:4326' },
      speed_over_ground_knots: 12,
      course_over_ground_deg: 90,
      challenge_nonce: nonce,
    };
    const forged = await app.ingestSigned({
      payload,
      signature: bytesToB64(new Uint8Array(64)),
      public_key_id: keyId,
      assurance_level: 'software',
      signature_alg: 'ed25519',
    });
    expect(forged.ok).toBe(false);
    expect(forged.vessel).toBeUndefined();

    const after = app.pipeline.getVessels().find((v) => v.entity_id === victim)!;
    expect(after.position.lat).toBe(posBefore.lat);
    expect(after.position.lon).toBe(posBefore.lon);
    expect(after.trust.trust_score).toBe(trustBefore);
    expect(app.forensics.list(5).some((e) => e.kind === 'signature_failed')).toBe(true);
  });

  it('rejects device signing for a different entity (binding)', async () => {
    const victim =
      app.lab.signedEntityId ?? app.pipeline.getVessels()[0]?.entity_id ?? 'LAB-A';
    const other =
      app.pipeline.getVessels().find((v) => v.entity_id !== victim)?.entity_id ?? 'LAB-B';
    const { privateKey, keyId } = await enrollDevice('DEV-BOUND-A', other);
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-BOUND-A',
      entity_id: victim, // claim victim while enrolled for other
      sequence_number: 1,
      timestamp: new Date().toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
    };
    const result = await ingestOk('DEV-BOUND-A', privateKey, keyId, payload);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('binding_mismatch');
  });

  it('rejects one key used under a different device_id', async () => {
    const entity =
      app.lab.signedEntityId ?? app.pipeline.getVessels()[0]?.entity_id ?? 'VESSEL-001';
    const { privateKey, keyId } = await enrollDevice('DEV-KEY-OWNER', entity);
    const { nonce } = app.forensics.issueChallenge('DEV-KEY-OWNER');
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-IMPERSONATOR', // not the enrolled device id
      entity_id: entity,
      sequence_number: 1,
      timestamp: new Date().toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
      challenge_nonce: nonce,
    };
    const signature = await signPayload(payload, privateKey);
    const result = await app.ingestSigned({
      payload,
      signature,
      public_key_id: keyId,
      assurance_level: 'software',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('binding_mismatch');
  });

  it('nonce spam does not starve the real device (multiple outstanding)', async () => {
    const entity =
      app.lab.signedEntityId ?? app.pipeline.getVessels()[0]?.entity_id ?? 'VESSEL-001';
    const { privateKey, keyId } = await enrollDevice('DEV-NONCE', entity);
    const first = app.forensics.issueChallenge('DEV-NONCE');
    for (let i = 0; i < 5; i++) app.forensics.issueChallenge('DEV-NONCE');
    // First nonce must still be valid
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-NONCE',
      entity_id: entity,
      sequence_number: 42,
      timestamp: new Date().toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
      challenge_nonce: first.nonce,
    };
    const signature = await signPayload(payload, privateKey);
    const result = await app.ingestSigned({
      payload,
      signature,
      public_key_id: keyId,
      assurance_level: 'software',
    });
    expect(result.ok).toBe(true);
  });

  it('scenario reset does not clear persisted sequence counters', async () => {
    const entity =
      app.lab.signedEntityId ?? app.pipeline.getVessels()[0]?.entity_id ?? 'VESSEL-001';
    const { privateKey, keyId } = await enrollDevice('DEV-REPLAY', entity);
    const ok = await ingestOk('DEV-REPLAY', privateKey, keyId, {
      v: 1,
      device_id: 'DEV-REPLAY',
      entity_id: entity,
      sequence_number: 500,
      timestamp: new Date().toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
    });
    expect(ok.ok).toBe(true);
    app.setScenario('reset');
    const replay = await ingestOk('DEV-REPLAY', privateKey, keyId, {
      v: 1,
      device_id: 'DEV-REPLAY',
      entity_id: entity,
      sequence_number: 500,
      timestamp: new Date().toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.91, lon: 25.01, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
    });
    expect(replay.ok).toBe(false);
  });

  it('kinematics applies reachability after silence gap > max_dt_s', () => {
    const prev: PositionEvent = {
      schema_version: 1,
      entity_id: 'T',
      entity_type: 'vessel',
      vessel_class: 'cargo',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
      source: 'ais_provider_a',
      provider_id: 'test',
      source_timestamp: '2026-01-01T00:00:00.000Z',
      ingested_at: '2026-01-01T00:00:00.000Z',
      device_signature_status: 'missing',
      osnma_status: 'unavailable',
      quality: { position_accuracy_m: 10, signal_quality_available: true },
    };
    const cur: PositionEvent = {
      ...prev,
      // ~50km north — unreachable in 180s at cargo speeds
      position: { lat: 60.35, lon: 25.0, crs: 'EPSG:4326' },
      source_timestamp: '2026-01-01T00:03:00.000Z',
      ingested_at: '2026-01-01T00:03:00.000Z',
    };
    const state: KinematicsState = { cusum: 0 };
    const { result } = checkKinematics(
      cur,
      prev,
      state,
      {
        min_dt_s: 0.5,
        max_dt_s: 120,
        uncertain_dt_skip: true,
        drift_cusum_threshold: 4,
        drift_cusum_slack_m: 20,
        vessel_class_limits: {
          cargo: { max_sog_kn: 28, max_accel_kn_s: 0.15, max_rot_deg_min: 20, max_jump_m: 800 },
          tanker: { max_sog_kn: 22, max_accel_kn_s: 0.1, max_rot_deg_min: 15, max_jump_m: 800 },
          passenger: { max_sog_kn: 32, max_accel_kn_s: 0.2, max_rot_deg_min: 25, max_jump_m: 800 },
          fishing: { max_sog_kn: 18, max_accel_kn_s: 0.25, max_rot_deg_min: 40, max_jump_m: 600 },
          tug: { max_sog_kn: 16, max_accel_kn_s: 0.3, max_rot_deg_min: 45, max_jump_m: 500 },
          pleasure: { max_sog_kn: 40, max_accel_kn_s: 0.4, max_rot_deg_min: 50, max_jump_m: 500 },
          other: { max_sog_kn: 30, max_accel_kn_s: 0.25, max_rot_deg_min: 30, max_jump_m: 800 },
        },
      },
      cur.ingested_at,
    );
    expect(result.hard_alert || result.status === 'fail').toBe(true);
  });

  it('revocation head detects deleted line', async () => {
    const entity =
      app.lab.signedEntityId ?? app.pipeline.getVessels()[0]?.entity_id ?? 'VESSEL-001';
    const { keyId } = await enrollDevice('DEV-DEL-REV', entity);
    await app.revokeDevice('DEV-DEL-REV');
    const path = join(dataDir, 'revocation.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // Truncate last line → head mismatch on next recover
    writeFileSync(path, lines.slice(0, -1).join('\n') + (lines.length > 1 ? '\n' : ''));
    const { RevocationLog } = await import('./security/revocationLog.js');
    let threw = false;
    try {
      const log = new RevocationLog(app.shore, path);
      await log.ready();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    void keyId;
  });
});
