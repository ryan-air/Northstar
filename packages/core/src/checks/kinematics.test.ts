import { describe, expect, it } from 'vitest';
import { checkKinematics, type KinematicsConfig } from './kinematics.js';
import type { PositionEvent } from '@northstar/contracts';
import thresholds from '../../../../config/thresholds.v1.json';

const config: KinematicsConfig = {
  ...thresholds.kinematics,
  vessel_class_limits: thresholds.vessel_class_limits as KinematicsConfig['vessel_class_limits'],
};

function ev(
  partial: Partial<PositionEvent> & Pick<PositionEvent, 'position' | 'source_timestamp'>,
): PositionEvent {
  return {
    schema_version: 1,
    entity_id: 'VESSEL-001',
    entity_type: 'vessel',
    vessel_class: 'cargo',
    source: 'test',
    ingested_at: partial.source_timestamp,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
    speed_over_ground_knots: 12,
    course_over_ground_deg: 90,
    ...partial,
  };
}

describe('kinematics', () => {
  it('passes normal track', () => {
    const a = ev({
      position: { lat: 59.95, lon: 24.9, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:00.000Z',
    });
    const b = ev({
      // ~0.003° lon ≈ 167 m in 30 s ≈ 10.8 kn — within cargo limits
      position: { lat: 59.9502, lon: 24.903, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:30.000Z',
      speed_over_ground_knots: 12.2,
      course_over_ground_deg: 90,
    });
    const { result } = checkKinematics(b, a, { cusum: 0 }, config, b.source_timestamp);
    expect(result.status).toBe('pass');
    expect(result.hard_alert).toBe(false);
  });

  it('detects impossible jump', () => {
    const a = ev({
      position: { lat: 59.95, lon: 24.9, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:00.000Z',
    });
    const b = ev({
      position: { lat: 60.2, lon: 25.5, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:05.000Z',
      speed_over_ground_knots: 12,
    });
    const { result } = checkKinematics(b, a, { cusum: 0 }, config, b.source_timestamp);
    expect(result.status).toBe('fail');
    expect(result.hard_alert).toBe(true);
  });

  it('skips displacement speed when dt unreliable', () => {
    const a = ev({
      position: { lat: 59.95, lon: 24.9, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:00.000Z',
    });
    const b = ev({
      position: { lat: 60.2, lon: 25.5, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:00.100Z',
    });
    const { result } = checkKinematics(b, a, { cusum: 0 }, config, b.source_timestamp);
    expect(result.explanation).toMatch(/skipped|outside reliable/i);
  });

  it('hard-fails an unreachable jump after a reporting gap', () => {
    const a = ev({
      position: { lat: 59.95, lon: 24.9, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:00.000Z',
    });
    const b = ev({
      position: { lat: 60.25, lon: 24.9, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:10:00.000Z',
    });
    const { result } = checkKinematics(b, a, { cusum: 0 }, config, b.source_timestamp);
    expect(result.status).toBe('fail');
    expect(result.hard_alert).toBe(true);
    expect(result.explanation).toMatch(/reporting gap|maximum reachable/i);
  });

  it('detects reported course inconsistent with meaningful displacement', () => {
    const a = ev({
      position: { lat: 59.95, lon: 24.9, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:00.000Z',
    });
    const b = ev({
      position: { lat: 59.951, lon: 24.9, crs: 'EPSG:4326' },
      source_timestamp: '2026-11-11T10:00:30.000Z',
      course_over_ground_deg: 90,
      speed_over_ground_knots: 7,
    });
    const { result } = checkKinematics(b, a, { cusum: 0 }, config, b.source_timestamp);
    expect(result.status).toBe('warning');
    expect(result.explanation).toMatch(/reported course differs/i);
  });
});
