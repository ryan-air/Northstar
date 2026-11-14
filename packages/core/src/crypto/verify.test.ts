import { describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  generateP256KeyPair,
  signPayload,
  verifyEnvelope,
  tamperPayload,
  bytesToB64,
} from './verify.js';
import { ReplayGuard } from './replayGuard.js';
import type { TelemetryPayload } from '@northstar/contracts';
import { canonicalize } from './canonical.js';
import { sha256 } from '@noble/hashes/sha256';

function hashPayload(p: TelemetryPayload): string {
  const bytes = new TextEncoder().encode(canonicalize(p as never));
  return Buffer.from(sha256(bytes)).toString('hex');
}

describe('Ed25519 signed telemetry', () => {
  const basePayload = (): TelemetryPayload => ({
    v: 1,
    device_id: 'DEV-001',
    entity_id: 'VESSEL-001',
    sequence_number: 10,
    timestamp: '2026-11-11T10:00:00.000Z',
    firmware_version: '1.0.0',
    position: { lat: 59.95, lon: 24.9, crs: 'EPSG:4326' },
    speed_over_ground_knots: 12,
    course_over_ground_deg: 90,
  });

  it('accepts a valid signed message', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const payload = basePayload();
    const signature = await signPayload(payload, privateKey);
    const result = await verifyEnvelope(
      { payload, signature, public_key_id: 'k1', assurance_level: 'software' },
      publicKey,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a modified signed message', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const payload = basePayload();
    const signature = await signPayload(payload, privateKey);
    const tampered = tamperPayload(payload, {
      position: { lat: 60.5, lon: 24.9, crs: 'EPSG:4326' },
    });
    const result = await verifyEnvelope(
      { payload: tampered, signature, public_key_id: 'k1', assurance_level: 'software' },
      publicKey,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects replayed old sequence', () => {
    const guard = new ReplayGuard({
      freshnessWindowS: 60,
      maxClockSkewS: 30,
      duplicateCacheSize: 100,
    });
    const now = new Date('2026-11-11T10:00:05.000Z');
    const p = basePayload();
    const h = hashPayload(p);
    expect(
      guard.check({
        deviceId: 'DEV-001',
        sequence: 10,
        timestamp: p.timestamp,
        payloadHash: h,
        now,
      }).accept,
    ).toBe(true);
    const replay = guard.check({
      deviceId: 'DEV-001',
      sequence: 10,
      timestamp: p.timestamp,
      payloadHash: h,
      now,
    });
    expect(replay.accept).toBe(false);
  });

  it('exports public key as base64', async () => {
    const { publicKey } = await generateKeyPair();
    expect(bytesToB64(publicKey).length).toBeGreaterThan(40);
  });

  it('accepts ECDSA P-256 signed payload', async () => {
    const { publicKey, privateKey } = generateP256KeyPair();
    const payload = basePayload();
    const signature = await signPayload(payload, privateKey, 'ecdsa-p256');
    const result = await verifyEnvelope(
      {
        payload,
        signature,
        public_key_id: 'k-p256',
        assurance_level: 'hardware',
        signature_alg: 'ecdsa-p256',
      },
      publicKey,
    );
    expect(result.ok).toBe(true);
  });
});
