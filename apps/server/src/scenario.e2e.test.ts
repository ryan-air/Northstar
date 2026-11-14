import { mkdtempSync, cpSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { NorthstarApp } from './app.js';
import { signPayload, generateKeyPair, bytesToB64, generateP256KeyPair } from '@northstar/core';
import type { TelemetryPayload } from '@northstar/contracts';
import { REPO_ROOT } from './config.js';

describe('scenario e2e (in-process, isolated fixtures)', () => {
  let app: NorthstarApp;
  let dataDir: string;

  beforeAll(async () => {
    process.env.NORTHSTAR_CHALLENGE_REQUIRED = 'true';
    process.env.NORTHSTAR_OSNMA_SCOPE = 'fullstack';
    process.env.VITEST = 'true';
    dataDir = mkdtempSync(join(tmpdir(), 'northstar-e2e-'));
    const src = join(REPO_ROOT, 'data/fixtures');
    for (const f of [
      'gnss_nominal.json',
      'gnss_spoofish.json',
      'gnss_jamming.json',
      'osnma_demo.json',
      'osnma_icd_cache.json',
    ]) {
      const p = join(src, f);
      if (existsSync(p)) cpSync(p, join(dataDir, f));
    }
    writeFileSync(join(dataDir, 'devices.json'), '[]');
    writeFileSync(join(dataDir, 'audit.jsonl'), '');
    writeFileSync(join(dataDir, 'revocation.jsonl'), '');
    app = new NorthstarApp({ dataDir });
    await app.init();
  });

  afterAll(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function ingestWithChallenge(
    deviceId: string,
    privateKey: Uint8Array,
    keyId: string,
    payload: TelemetryPayload,
    opts?: { alg?: 'ed25519' | 'ecdsa-p256'; assurance?: 'software' | 'hardware' },
  ) {
    const { nonce } = app.forensics.issueChallenge(deviceId);
    const withChallenge = { ...payload, challenge_nonce: nonce };
    const signature = await signPayload(
      withChallenge,
      privateKey,
      opts?.alg ?? 'ed25519',
    );
    return app.ingestSigned(
      {
        payload: withChallenge,
        signature,
        public_key_id: keyId,
        assurance_level: opts?.assurance ?? 'software',
        signature_alg: opts?.alg ?? 'ed25519',
      },
      new Date(app.sim.simTimeMs + 1000),
    );
  }

  it('normal ticks produce vessels without false critical alerts immediately', () => {
    for (let i = 0; i < 5; i++) app.tick();
    const vessels = app.pipeline.getVessels();
    expect(vessels.length).toBeGreaterThanOrEqual(10);
    const critical = vessels.filter((v) => v.trust.trust_band === 'critical');
    expect(critical.length).toBeLessThan(3);
    if (app.useHistoricalLab) {
      expect(app.lab.signedEntityId?.startsWith('LAB-')).toBe(true);
    }
  });

  it('sudden spoof lowers target trust and raises geographic/kinematic evidence', () => {
    app.setScenario('reset');
    for (let i = 0; i < 3; i++) app.tick();
    const historical = app.lab.signedEntityId ?? undefined;
    // Injection policy: a request to attack a historical vessel is redirected to a simulated ship.
    const applied = app.setScenario('sudden_spoof', historical);
    const target = applied.target;
    if (app.useHistoricalLab) {
      expect(applied.policy).toBe('simulated_only');
      expect(app.simulatedShipIds()).toContain(target);
      if (historical) expect(applied.retargeted_from).toBe(historical);
    }
    for (let i = 0; i < 3; i++) app.tick();
    if (historical && app.useHistoricalLab) {
      const h = app.pipeline.getVessels().find((x) => x.entity_id === historical);
      expect(h?.trust.checks.find((c) => c.check_id === 'geographic')?.status).not.toBe('fail');
    }
    const v = app.pipeline.getVessels().find((x) => x.entity_id === target);
    expect(v).toBeTruthy();
    expect(v!.trust.trust_score).toBeLessThan(65);
    const geo = v!.trust.checks.find((c) => c.check_id === 'geographic');
    const kin = v!.trust.checks.find((c) => c.check_id === 'kinematics');
    expect(
      geo?.status === 'fail' ||
        geo?.status === 'warning' ||
        kin?.status === 'fail' ||
        kin?.hard_alert,
    ).toBe(true);
  });

  it('injected attacks never target live or historical vessels', () => {
    for (const id of ['LIVE-230000001', app.lab.signedEntityId ?? 'LAB-0']) {
      for (const sc of ['gradual_drift', 'osnma_failure', 'rf_aoa_spoof_cluster'] as const) {
        const r = app.setScenario(sc, id);
        if (app.useHistoricalLab) {
          expect(r.target).not.toBe(id);
          expect(app.simulatedShipIds()).toContain(r.target);
        }
      }
    }
    app.setScenario('normal');
  });

  it('OSNMA protocol demo binds only to fullstack Hist Lab vessel by default', () => {
    for (let i = 0; i < 4; i++) app.tick();
    const fsId = app.fullstackEntityId();
    expect(fsId).toBeTruthy();
    const fullstack = app.pipeline.getVessels().find((v) => v.entity_id === fsId);
    expect(fullstack).toBeTruthy();
    const osnma = fullstack!.trust.checks.find((c) => c.check_id === 'osnma');
    expect(osnma).toBeTruthy();
    expect(['pass', 'pending', 'fail']).toContain(osnma!.status);

    const otherLab = app.pipeline
      .getVessels()
      .filter(
        (v) =>
          v.entity_id !== fsId &&
          !v.entity_id.startsWith('LIVE-') &&
          (v.entity_id.startsWith('LAB-') || !v.entity_id.startsWith('LIVE-')),
      );
    for (const v of otherLab.slice(0, 5)) {
      const o = v.trust.checks.find((c) => c.check_id === 'osnma');
      expect(o?.status).toBe('unavailable');
      expect(o?.missing_reason ?? '').toMatch(/full-stack/i);
    }
  });

  it('LIVE vessels never receive ICD OSNMA (stay unavailable/unsupported)', () => {
    for (let i = 0; i < 2; i++) app.tick();
    const live = app.pipeline.getVessels().filter((v) => v.entity_id.startsWith('LIVE-'));
    for (const v of live) {
      const osnma = v.trust.checks.find((c) => c.check_id === 'osnma');
      expect(osnma?.status === 'pass').toBe(false);
      expect(['unavailable', 'unsupported', undefined]).toContain(osnma?.status);
    }
  });

  it('rejects ingest without challenge when required', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    await app.registry.enroll({
      device_id: 'DEV-NO-CHALLENGE',
      entity_id: app.lab.signedEntityId ?? 'VESSEL-001',
      public_key_b64: bytesToB64(publicKey),
    });
    const enrolled = app.registry.get('DEV-NO-CHALLENGE')!;
    const target = app.lab.signedEntityId ?? 'VESSEL-001';
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-NO-CHALLENGE',
      entity_id: target,
      sequence_number: 1,
      timestamp: new Date(app.sim.simTimeMs).toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
    };
    const signature = await signPayload(payload, privateKey);
    const bad = await app.ingestSigned({
      payload,
      signature,
      public_key_id: enrolled.key_id,
      assurance_level: 'software',
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('challenge_required');
  });

  it('accepts valid signature with challenge, rejects tamper, rejects replay', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const pub = bytesToB64(publicKey);
    await app.registry.enroll({
      device_id: 'DEV-TEST',
      entity_id: app.lab.signedEntityId ?? 'VESSEL-001',
      public_key_b64: pub,
    });
    const enrolled = app.registry.get('DEV-TEST')!;
    const target = app.lab.signedEntityId ?? 'VESSEL-001';
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-TEST',
      entity_id: target,
      sequence_number: 100,
      timestamp: new Date(app.sim.simTimeMs).toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
    };
    const ok = await ingestWithChallenge('DEV-TEST', privateKey, enrolled.key_id, payload);
    expect(ok.ok).toBe(true);

    const { nonce } = app.forensics.issueChallenge('DEV-TEST');
    const signedBody = {
      ...payload,
      sequence_number: 101,
      challenge_nonce: nonce,
    };
    const signature = await signPayload(signedBody, privateKey);
    const bad = await app.ingestSigned(
      {
        payload: {
          ...signedBody,
          position: { lat: 60.5, lon: 25.0, crs: 'EPSG:4326' },
        },
        signature,
        public_key_id: enrolled.key_id,
        assurance_level: 'software',
      },
      new Date(app.sim.simTimeMs + 2000),
    );
    expect(bad.ok).toBe(false);
    // Tamper must not update the track
    expect(bad.vessel).toBeUndefined();

    const replay = await ingestWithChallenge('DEV-TEST', privateKey, enrolled.key_id, {
      ...payload,
      sequence_number: 100,
    });
    expect(replay.ok).toBe(false);
  });

  it('revocation list blocks key even if registry revived', async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    await app.registry.enroll({
      device_id: 'DEV-REV',
      entity_id: app.lab.signedEntityId ?? 'VESSEL-001',
      public_key_b64: bytesToB64(publicKey),
    });
    const enrolled = app.registry.get('DEV-REV')!;
    await app.revokeDevice('DEV-REV');
    // Tamper registry back to active
    enrolled.revoked_at = null;
    const target = app.lab.signedEntityId ?? 'VESSEL-001';
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-REV',
      entity_id: target,
      sequence_number: 200,
      timestamp: new Date(app.sim.simTimeMs).toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
    };
    const result = await ingestWithChallenge('DEV-REV', privateKey, enrolled.key_id, payload);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('revocation_list');
  });

  it('accepts ECDSA P-256 signed telemetry', async () => {
    const { privateKey, publicKey } = generateP256KeyPair();
    await app.registry.enroll({
      device_id: 'DEV-P256',
      entity_id: app.lab.signedEntityId ?? 'VESSEL-001',
      public_key_b64: bytesToB64(publicKey),
      signature_alg: 'ecdsa-p256',
      assurance_level: 'hardware',
    });
    const enrolled = app.registry.get('DEV-P256')!;
    const target = app.lab.signedEntityId ?? 'VESSEL-001';
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-P256',
      entity_id: target,
      sequence_number: 300,
      timestamp: new Date(app.sim.simTimeMs).toISOString(),
      firmware_version: '1.0.0',
      position: { lat: 59.9, lon: 25.0, crs: 'EPSG:4326' },
      speed_over_ground_knots: 10,
      course_over_ground_deg: 90,
    };
    const ok = await ingestWithChallenge('DEV-P256', privateKey, enrolled.key_id, payload, {
      alg: 'ecdsa-p256',
      assurance: 'hardware',
    });
    expect(ok.ok).toBe(true);
  });
});
