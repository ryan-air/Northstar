import { describe, expect, it } from 'vitest';
import type { PositionEvent } from '@northstar/contracts';
import { TrustPipeline } from './pipeline.js';
import { loadFusion, loadThresholds } from '../config.js';
import { loadGeo } from '../geo/loadGeo.js';

const t2 = loadThresholds('v2');
const geo = loadGeo(t2.geographic);

function ev(source: string, tIso: string, extra: Partial<PositionEvent> = {}): PositionEvent {
  return {
    entity_id: 'LAB-1',
    entity_type: 'vessel',
    position: { lat: 59.7, lon: 24.7 },
    speed_over_ground_knots: 10,
    course_over_ground_deg: 0,
    source,
    source_timestamp: tIso,
    ingested_at: tIso,
    device_signature_status: source === 'device_telemetry' ? 'valid' : 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
    labels: { mmsi: 230000001 },
    ...extra,
  } as PositionEvent;
}

describe('one assessment per vessel across sources', () => {
  it('a device report refreshes device checks without discarding the AIS-based checks', () => {
    const p = new TrustPipeline(loadFusion('v2'), t2, geo);
    p.setTargetObservations('LAB-1', [
      { observed_at: '2030-01-01T00:00:00.000Z', lat: 59.7, lon: 24.7, accuracy_m: 50, provider_id: 'radar' },
    ]);
    const ais = p.process(ev('ais', '2030-01-01T00:00:00.000Z'), '2030-01-01T00:00:00.000Z');
    expect(ais.trust.checks.find((c) => c.check_id === 'neighbors')?.status).toBe('pass');
    // A device report with a wall-clock timestamp far from the replay clock.
    const dev = p.process(ev('device_telemetry', new Date().toISOString(), { device_id: 'D1' }), new Date().toISOString());
    const byId = Object.fromEntries(dev.trust.checks.map((c) => [c.check_id, c]));
    expect(byId.neighbors?.status).toBe('pass'); // kept from the AIS report
    expect(byId.ais_cross_feed?.explanation).not.toMatch(/s from this one/); // no wall-clock vs replay comparison
  });
});
