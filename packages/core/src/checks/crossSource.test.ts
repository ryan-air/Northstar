import { describe, expect, it } from 'vitest';
import type { PositionEvent } from '@northstar/contracts';
import { checkFleetCoherence, type FleetDisplacement } from './fleetCoherence.js';
import { checkSignedVsAis } from './signedVsAis.js';

const now = '2026-11-11T10:00:00.000Z';

function event(source: string, lat: number, lon: number): PositionEvent {
  return {
    schema_version: 1,
    entity_id: 'VESSEL-001',
    entity_type: 'vessel',
    position: { lat, lon, crs: 'EPSG:4326' },
    source,
    source_timestamp: now,
    ingested_at: now,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
  };
}

describe('cross-source checks', () => {
  it('fails a large signed telemetry versus AIS disagreement', () => {
    const result = checkSignedVsAis(
      event('device_telemetry', 60.0, 25.0),
      event('ais_provider_a', 60.03, 25.0),
      now,
    );
    expect(result.status).toBe('fail');
    expect(result.anomaly_score).toBe(1);
  });

  it('flags four coherent fleet offsets', () => {
    const displacements: FleetDisplacement[] = Array.from({ length: 4 }, (_, i) => ({
      entity_id: `VESSEL-${i}`,
      prev_lat: 59.5 + i * 0.02,
      prev_lon: 24.5,
      lat: 59.5 + i * 0.02,
      lon: 24.53,
      dist_m: 1700,
      d_lat: 0,
      d_lon: 0.03,
    }));
    const result = checkFleetCoherence('VESSEL-0', displacements, now);
    expect(result.status).toBe('fail');
    expect(result.explanation).toMatch(/coherent large offset/i);
  });
});
