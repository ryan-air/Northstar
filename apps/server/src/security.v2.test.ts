/**
 * P4.1 / P4.3 / P4.4 / P3.3 / P3.5 / P5.2 — security fixes and Lab correctness, run
 * against an isolated temp data dir and the frozen eval snapshot.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToB64, generateKeyPair, generateP256KeyPair, signPayload } from '@northstar/core';
import type { TelemetryPayload } from '@northstar/contracts';
import { NorthstarApp } from './app.js';
import { EVAL_SNAPSHOT_PATH } from './replay/store.js';

// The recorded snapshot is private data kept off the public repo; Lab-replay tests skip
// without it (security tests below still run on the synthetic fleet).
const HAS_PRIVATE_REPLAY = existsSync(EVAL_SNAPSHOT_PATH);
const itReplay = HAS_PRIVATE_REPLAY ? it : it.skip;

describe('security + lab v2', () => {
  let app: NorthstarApp;
  let dataDir: string;

  beforeAll(async () => {
    process.env.NORTHSTAR_CHALLENGE_REQUIRED = 'true';
    process.env.VITEST = 'true';
    dataDir = mkdtempSync(join(tmpdir(), 'northstar-v2-'));
    writeFileSync(join(dataDir, 'devices.json'), '[]');
    writeFileSync(join(dataDir, 'audit.jsonl'), '');
    writeFileSync(join(dataDir, 'revocation.jsonl'), '');
    app = new NorthstarApp({ dataDir, replayPath: EVAL_SNAPSHOT_PATH });
    await app.init();
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  itReplay('uses v2 configs by default and reads the frozen snapshot', () => {
    expect(app.pipeline.configVersions).toEqual({ fusion: 'fusion.v2', thresholds: 'thresholds.v2' });
    expect(app.useHistoricalLab).toBe(true);
  });

  it('P4.1: unauthenticated enrolment is rejected (401)', async () => {
    const { publicKey } = await generateKeyPair();
    const r = await app.enrolDevice(
      { device_id: 'DEV-ATTACKER', entity_id: app.fullstackEntityId()!, public_key_b64: bytesToB64(publicKey) },
      { admin: false },
    );
    expect(r.status).toBe(401);
  });

  it('P4.1: attacker with the enrol token cannot add a device to a vessel that has one (409)', async () => {
    const victim = app.fullstackEntityId()!;
    const token = app.enrolToken();
    const a = await generateKeyPair();
    const ok = await app.enrolDevice(
      { device_id: 'DEV-LEGIT', entity_id: victim, public_key_b64: bytesToB64(a.publicKey) },
      { admin: false, enrolToken: token },
    );
    expect(ok.status).toBe(200);
    const b = await generateKeyPair();
    const evil = await app.enrolDevice(
      { device_id: 'DEV-EVIL', entity_id: victim, public_key_b64: bytesToB64(b.publicKey) },
      { admin: false, enrolToken: token },
    );
    expect(evil.status).toBe(409);
    // Even claiming replace: true without admin is refused.
    const evil2 = await app.enrolDevice(
      { device_id: 'DEV-EVIL', entity_id: victim, public_key_b64: bytesToB64(b.publicKey), replace: true },
      { admin: false, enrolToken: token },
    );
    expect(evil2.status).toBe(409);
    // An admin can replace (old device revoked).
    const adm = await app.enrolDevice(
      { device_id: 'DEV-NEW', entity_id: victim, public_key_b64: bytesToB64(b.publicKey), replace: true },
      { admin: true },
    );
    expect(adm.status).toBe(200);
    expect(app.registry.get('DEV-LEGIT')?.revoked_at).toBeTruthy();
  });

  it('P4.3: envelope with a signature_alg different from the enrolment is rejected', async () => {
    const { privateKey, publicKey } = generateP256KeyPair();
    await app.registry.enroll({
      device_id: 'DEV-ALG',
      entity_id: 'LAB-ALG-TEST',
      public_key_b64: bytesToB64(publicKey),
      signature_alg: 'ecdsa-p256',
      assurance_level: 'software',
    });
    const enrolled = app.registry.get('DEV-ALG')!;
    const { nonce } = app.forensics.issueChallenge('DEV-ALG');
    const payload: TelemetryPayload = {
      v: 1,
      device_id: 'DEV-ALG',
      entity_id: 'LAB-ALG-TEST',
      sequence_number: 1,
      timestamp: new Date().toISOString(),
      firmware_version: '1',
      position: { lat: 59.9, lon: 25, crs: 'EPSG:4326' },
      speed_over_ground_knots: 5,
      course_over_ground_deg: 90,
      challenge_nonce: nonce,
    };
    const signature = await signPayload(payload, privateKey, 'ecdsa-p256');
    const r = await app.ingestSigned({
      payload,
      signature,
      public_key_id: enrolled.key_id,
      assurance_level: 'hardware',
      signature_alg: 'ed25519',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature_alg_mismatch');
  });

  it('P4.4: 100 concurrent appends leave checkpoint seq equal to the chain tip', async () => {
    for (let i = 0; i < 100; i++) app.audit.append('stress', { i });
    await app.auditSettled();
    const cp = JSON.parse(readFileSync(join(dataDir, 'audit.checkpoint.json'), 'utf8')) as { seq: number; tip_hash: string };
    expect(cp.seq).toBe(app.audit.tip.seq);
    expect(cp.tip_hash).toBe(app.audit.tip.hash);
  });

  itReplay('P5.2: ≥200 normal ticks with 0 critical Lab vessels', () => {
    app.setScenario('reset');
    // Until the OSM coastline/ports (P2.1) are installed, the simplified v1 polygons put
    // some berths "inland" (e.g. Vuosaari is missing). Those — and only those — are
    // tolerated while the fallback is active; once data/geo/land_osm_gof.geojson exists
    // this test becomes strict automatically.
    const fallback = app.geo.datasets.land_is_fallback || app.geo.datasets.ports_is_fallback;
    let maxCritical = 0;
    const geoOnly = new Set<string>();
    for (let i = 0; i < 200; i++) {
      app.tick();
      const crit = app.pipeline.getVessels().filter((v) => {
        if (v.entity_id.startsWith('LIVE-') || v.trust.trust_band !== 'critical') return false;
        const failing = v.trust.checks.filter((c) => c.status === 'fail' || c.status === 'warning');
        if (fallback && failing.length > 0 && failing.every((c) => c.check_id === 'geographic')) {
          geoOnly.add(v.entity_id);
          return false;
        }
        return true;
      });
      maxCritical = Math.max(maxCritical, crit.length);
    }
    expect(app.pipeline.getVessels().length).toBeGreaterThan(5);
    expect(maxCritical).toBe(0);
    if (!fallback) expect(geoOnly.size).toBe(0);
  });

  it('P0.5: every check result in the snapshot carries evidence_class; verified coverage reported', () => {
    for (let i = 0; i < 3; i++) app.tick();
    const vs = app.snapshot().vessels;
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) {
      for (const c of v.trust.checks) expect(c.evidence_class).toBeTruthy();
      expect(v.trust.verified_evidence_coverage).toBeLessThanOrEqual(v.trust.evidence_coverage);
    }
  });

  itReplay('P3.5: stale_clock_skew makes ingest reject the target (counter rises)', () => {
    const before = app.labRejections().stale ?? 0;
    // Injection policy: stale clock goes to a simulated ship (reports every tick), never
    // to the historical full-stack vessel.
    const applied = app.setScenario('stale_clock_skew', app.fullstackEntityId()!);
    expect(app.simulatedShipIds()).toContain(applied.target);
    for (let i = 0; i < 20 && (app.labRejections().stale ?? 0) <= before; i++) app.tick();
    expect((app.labRejections().stale ?? 0)).toBeGreaterThan(before);
    const fs = app.forensics.list(50).find((e) => e.kind === 'ingest_rejected');
    expect(fs?.explanation).toMatch(/stale/);
    app.setScenario('reset');
  });

  itReplay('P3.3: timeline wrap clears Lab state — no teleport hard alerts on the jump back', () => {
    app.setScenario('reset');
    // Jump the clock to just before the end of the timeline, then tick across the wrap.
    (app.lab as unknown as { seekShared(t: number): void }).seekShared(app.lab.timelineEndMs - 4_000);
    const wrapsBefore = app.lab.wraps;
    for (let i = 0; i < 6; i++) app.tick();
    expect(app.lab.wraps).toBe(wrapsBefore + 1);
    const hard = app.pipeline
      .getVessels()
      .filter((v) => v.trust.hard_alerts.some((k) => k.startsWith('kinematics')));
    expect(hard).toHaveLength(0);
  });
});
