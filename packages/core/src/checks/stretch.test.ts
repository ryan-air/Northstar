import { describe, expect, it } from 'vitest';
import { checkGnssDiagnostics } from './gnssDiagnostics.js';
import { checkImuConsistency } from './imu.js';
import { checkOsnma } from './osnma.js';
import { checkAttestation } from './attestation.js';
import { checkAisCrossFeed } from './neighbors.js';
import type { PositionEvent } from '@northstar/contracts';

const cfg = {
  min_satellites: 4,
  min_c_n0_dbhz: 25,
  max_hdop: 5,
  jamming_agc_delta: 20,
};

const imuCfg = {
  accel_noise_mps2: 0.05,
  gyro_noise_rads: 0.002,
  bias_random_walk: 0.0001,
  residual_fail_sigma: 5,
  residual_warn_sigma: 3,
};

describe('stretch layers honest unavailable', () => {
  it('GNSS diagnostics unavailable without raw data', () => {
    const r = checkGnssDiagnostics('VESSEL-001', null, cfg, '2026-11-11T10:00:00.000Z');
    expect(r.status).toBe('unavailable');
    expect(r.anomaly_score).toBeNull();
    expect(r.missing_reason).toMatch(/raw/i);
  });

  it('IMU unavailable without stream', () => {
    const { result } = checkImuConsistency(
      {
        schema_version: 1,
        entity_id: 'VESSEL-001',
        entity_type: 'vessel',
        position: { lat: 59.9, lon: 25, crs: 'EPSG:4326' },
        source: 't',
        source_timestamp: '2026-11-11T10:00:00.000Z',
        ingested_at: '2026-11-11T10:00:00.000Z',
        device_signature_status: 'missing',
        osnma_status: 'unavailable',
        quality: { position_accuracy_m: null, signal_quality_available: false },
      },
      null,
      null,
      null,
      imuCfg,
      '2026-11-11T10:00:00.000Z',
    );
    expect(result.status).toBe('unavailable');
  });

  it('OSNMA not_connected is unavailable not failure', () => {
    const r = checkOsnma('VESSEL-001', null, '2026-11-11T10:00:00.000Z');
    expect(r.status).toBe('unavailable');
  });

  it('OSNMA protocol demo authenticated is pass with test-vector label', () => {
    const r = checkOsnma(
      'VESSEL-001',
      {
        status: 'authenticated',
        observed_at: '2026-11-11T10:00:00.000Z',
        mode: 'protocol_verification_demo',
        reason: null,
      },
      '2026-11-11T10:00:00.000Z',
    );
    expect(r.status).toBe('pass');
    expect(r.explanation).toMatch(/ICD test vector/i);
    expect(r.explanation).toMatch(/not PVT/i);
  });

  it('attestation without hardware evidence is unavailable', () => {
    const r = checkAttestation('VESSEL-001', null, '2026-11-11T10:00:00.000Z');
    expect(r.status).toBe('unavailable');
  });

  it('software attestation evidence is pass with software assurance', () => {
    const r = checkAttestation(
      'VESSEL-001',
      {
        device_id: 'DEV-VESSEL-001',
        assurance_level: 'software',
        provider: 'software_key_store',
        verified: true,
        observed_at: '2026-11-11T10:00:00.000Z',
        reason: 'Software-protected local key file',
      },
      '2026-11-11T10:00:00.000Z',
    );
    expect(r.status).toBe('pass');
    expect(r.explanation).toMatch(/software/i);
  });

  it('AIS cross-feed unavailable without second source', () => {
    const primary = {
      schema_version: 1,
      entity_id: 'VESSEL-001',
      entity_type: 'vessel',
      position: { lat: 59.9, lon: 25, crs: 'EPSG:4326' },
      source: 'ais_a',
      source_timestamp: '2026-11-11T10:00:00.000Z',
      ingested_at: '2026-11-11T10:00:00.000Z',
      device_signature_status: 'missing',
      osnma_status: 'unavailable',
      quality: { position_accuracy_m: null, signal_quality_available: false },
    } satisfies PositionEvent;
    const r = checkAisCrossFeed(primary, null, '2026-11-11T10:00:00.000Z');
    expect(r.status).toBe('unavailable');
  });
});
