import { describe, expect, it } from 'vitest';
import { PositionEventSchema, CheckResultSchema } from './events.js';
import { trustBandFromScore, coverageBandFromPct } from './api.js';

describe('PositionEventSchema', () => {
  it('accepts a valid normalized event', () => {
    const event = PositionEventSchema.parse({
      entity_id: 'VESSEL-001',
      entity_type: 'vessel',
      position: { lat: 59.95, lon: 24.9 },
      speed_over_ground_knots: 12.4,
      course_over_ground_deg: 87,
      source: 'ais_provider_a',
      source_timestamp: '2026-11-11T10:00:00.000Z',
      ingested_at: '2026-11-11T10:00:02.000Z',
      sequence_number: 1842,
      device_signature_status: 'verified',
      osnma_status: 'unavailable',
      quality: { position_accuracy_m: null, signal_quality_available: false },
    });
    expect(event.entity_id).toBe('VESSEL-001');
    expect(event.position.crs).toBe('EPSG:4326');
  });

  it('rejects out-of-range coordinates', () => {
    expect(() =>
      PositionEventSchema.parse({
        entity_id: 'X',
        position: { lat: 120, lon: 0 },
        source: 'test',
        source_timestamp: '2026-11-11T10:00:00.000Z',
        ingested_at: '2026-11-11T10:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('CheckResultSchema', () => {
  it('allows unavailable with missing_reason', () => {
    const r = CheckResultSchema.parse({
      entity_id: 'VESSEL-001',
      check_id: 'imu',
      status: 'unavailable',
      anomaly_score: null,
      observed_at: '2026-11-11T10:00:00.000Z',
      explanation: 'No IMU stream connected.',
      missing_reason: 'No physical IMU available',
    });
    expect(r.status).toBe('unavailable');
  });
});

describe('bands', () => {
  it('maps trust scores to operational bands', () => {
    expect(trustBandFromScore(90)).toBe('high');
    expect(trustBandFromScore(70)).toBe('caution');
    expect(trustBandFromScore(50)).toBe('suspicious');
    expect(trustBandFromScore(10)).toBe('critical');
  });

  it('maps coverage to high/medium/low', () => {
    expect(coverageBandFromPct(80)).toBe('high');
    expect(coverageBandFromPct(50)).toBe('medium');
    expect(coverageBandFromPct(10)).toBe('low');
  });
});
