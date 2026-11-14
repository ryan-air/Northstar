import { describe, expect, it } from 'vitest';
import type { PositionEvent } from '@northstar/contracts';
import { accuracyFromPosAcc, decodeAisRot } from './adapters/digitraffic.js';
import { aisStreamObservationTime } from './adapters/aisstream.js';
import { TrustPipeline, interpolateAis } from './engine/pipeline.js';
import { loadFusion, loadThresholds } from './config.js';
import { loadGeo } from './geo/loadGeo.js';
import { dedupRecords } from './replay/store.js';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
function ev(tS: number, lat: number, lon: number, extra: Partial<PositionEvent> = {}): PositionEvent {
  const ts = new Date(T0 + tS * 1000).toISOString();
  return {
    schema_version: 1,
    entity_id: 'LAB-230000001',
    entity_type: 'vessel',
    vessel_class: 'cargo',
    position: { lat, lon, crs: 'EPSG:4326' },
    source: 'ais_provider_a',
    provider_id: 'digitraffic_historical',
    source_timestamp: ts,
    ingested_at: ts,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
    speed_over_ground_knots: 12,
    course_over_ground_deg: 90,
    labels: { live: false, simulated: false, fixture: false, mmsi: 230000001 },
    ...extra,
  };
}

describe('adapters (P1.2 / P3.4)', () => {
  it('decodes AIS ROT and posAcc', () => {
    expect(decodeAisRot(-128)).toBeNull();
    expect(decodeAisRot(127)).toBeNull();
    expect(decodeAisRot(0)).toBe(0);
    expect(decodeAisRot(10)!).toBeCloseTo((10 / 4.733) ** 2, 5);
    expect(decodeAisRot(-10)!).toBeLessThan(0);
    expect(accuracyFromPosAcc(true)).toBe(10);
    expect(accuracyFromPosAcc(false)).toBe(50);
    expect(accuracyFromPosAcc(undefined)).toBeNull();
  });

  it('AISStream observation time uses time_utc + the AIS second, not receive time', () => {
    const recv = Date.parse('2026-11-12T10:00:30.000Z');
    const r = aisStreamObservationTime('2026-11-12 10:00:05.123456 +0000 UTC', 58, recv);
    expect(r.from).toBe('ais_second');
    expect(new Date(r.ms).toISOString()).toBe('2026-11-12T09:59:58.000Z');
    expect(aisStreamObservationTime(undefined, undefined, recv)).toEqual({ ms: recv, from: 'receive_time' });
  });

  it('dedups recorded rows on (MMSI, AIS timestamp) on read', () => {
    const r = (ts: number) => ({ mmsi: 1, lat: 0, lon: 0, sog: 0, cog: 0, heading: 0, timestamp_external_ms: ts, captured_at: 'x', source: 's', provider_id: 'p' });
    expect(dedupRecords([r(1), r(1), r(2)])).toHaveLength(2);
  });
});

describe('pipeline v2 state (P3.1 / P3.2)', () => {
  const geo = loadGeo();

  it('a device event is never the "previous" point for an AIS event (and vice versa)', () => {
    const p = new TrustPipeline(loadFusion('v2'), loadThresholds('v2'), geo);
    p.process(ev(0, 59.9, 24.0), new Date(T0).toISOString());
    // Device report 30 km away (e.g. onboard GNSS, or a clock-shifted copy).
    p.process(
      ev(10, 60.2, 24.0, { source: 'device_telemetry', provider_id: 'device_gateway', device_signature_status: 'verified' }),
      new Date(T0 + 10_000).toISOString(),
    );
    const next = p.process(ev(60, 59.9, 24.0066), new Date(T0 + 60_000).toISOString());
    const kin = next.trust.checks.find((c) => c.check_id === 'kinematics')!;
    expect(kin.hard_alert).toBe(false);
    expect(kin.status).toBe('pass');
  });

  it('v1 (shared state) does mix sources — kept selectable for comparison', () => {
    const p = new TrustPipeline(loadFusion('v1'), loadThresholds('v1'), geo);
    p.process(ev(0, 59.9, 24.0), new Date(T0).toISOString());
    p.process(
      ev(10, 60.2, 24.0, { source: 'device_telemetry', provider_id: 'device_gateway' }),
      new Date(T0 + 10_000).toISOString(),
    );
    const next = p.process(ev(60, 59.9, 24.0066), new Date(T0 + 60_000).toISOString());
    expect(next.trust.checks.find((c) => c.check_id === 'kinematics')!.hard_alert).toBe(true);
  });

  it('interpolates AIS between bracketing samples within ±180 s', () => {
    const h = [ev(0, 60, 24), ev(100, 60, 24.01)];
    const mid = interpolateAis(h, T0 + 50_000, 180)!;
    expect(mid.position.lon).toBeCloseTo(24.005, 6);
    expect(mid.interpolated).toBe(true);
    expect(interpolateAis(h, T0 + 1_000_000, 180)).toBeNull();
  });

  it('signed_vs_ais compares at observation_time, not wall-clock arrival', () => {
    const p = new TrustPipeline(loadFusion('v2'), loadThresholds('v2'), geo);
    p.process(ev(0, 59.9, 24.0), new Date(T0).toISOString());
    p.process(ev(60, 59.9, 24.0066), new Date(T0 + 60_000).toISOString());
    // Signed report arrives much later (wall clock) but refers to t = 30 s.
    const s = p.process(
      ev(3600, 59.9, 24.0033, {
        source: 'device_telemetry',
        provider_id: 'device_gateway',
        device_signature_status: 'verified',
        observation_time: new Date(T0 + 30_000).toISOString(),
      }),
      new Date(T0 + 3_600_000).toISOString(),
    );
    const sva = s.trust.checks.find((c) => c.check_id === 'signed_vs_ais')!;
    expect(sva.status).toBe('pass');
    expect(Number(sva.evidence?.distance_m)).toBeLessThan(50);
  });
});
