import { describe, expect, it } from 'vitest';
import type { PositionEvent } from '@northstar/contracts';
import { destination } from '../geo/haversine.js';
import { checkDrSeries, type DrSample } from './drSeries.js';
import { checkAisCrossFeed, checkTargetObservation, type NeighborsConfig } from './neighbors.js';
import { checkKinematics, type KinematicsConfig, type KinematicsState } from './kinematics.js';
import { classifyCheckEvidence } from '../fusion/evidenceClass.js';
import t2 from '../../../../config/thresholds.v2.json';

const T0 = Date.parse('2030-01-01T00:00:00Z');
function ev(lat: number, lon: number, tS: number, extra: Partial<PositionEvent> = {}): PositionEvent {
  const ts = new Date(T0 + tS * 1000).toISOString();
  return {
    entity_id: 'V1',
    entity_type: 'vessel',
    vessel_class: 'cargo',
    position: { lat, lon },
    speed_over_ground_knots: 20,
    course_over_ground_deg: 0,
    heading_deg: 0,
    source: 'ais',
    source_timestamp: ts,
    ingested_at: ts,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
    ...extra,
  } as PositionEvent;
}

// Due north at 20 kn, 1 Hz heading/speed series for 30 min.
const series: DrSample[] = Array.from({ length: 1800 }, (_, i) => ({ t: T0 + i * 1000, heading_deg: 0, speed_kn: 20 }));
const along = (s: number) => destination(60, 25, 0, 20 * 0.514444 * s);

describe('GNSS-independent dead reckoning (heading + speed log)', () => {
  it('anchors, then passes on a consistent fix and fails on a displaced one', () => {
    const a = checkDrSeries(ev(60, 25, 0), series, null, 'x');
    expect(a.result.status).toBe('pending');
    const p1 = along(120);
    const ok = checkDrSeries(ev(p1.lat, p1.lon, 120), series, a.anchor, 'x');
    expect(ok.result.status).toBe('pass');
    expect(ok.anchor!.t).toBe(T0 + 120_000);
    const p2 = along(240);
    const bad = checkDrSeries(ev(p2.lat + 0.05, p2.lon, 240), series, ok.anchor, 'x');
    expect(bad.result.status).toBe('fail');
    expect(bad.anchor).toEqual(ok.anchor); // a failing fix never becomes the anchor
    expect(bad.result.evidence_class).toBe('recorded');
  });

  it('keeps the trusted anchor across a series gap and refuses a contradicted first fix', () => {
    const gappy = series.filter((s) => s.t < T0 + 100_000 || s.t > T0 + 400_000);
    const a = checkDrSeries(ev(60, 25, 0), gappy, null, 'x').anchor;
    const p = along(500);
    const r = checkDrSeries(ev(p.lat, p.lon, 500), gappy, a, 'x');
    expect(r.result.status).toBe('unavailable');
    expect(r.anchor).toEqual(a);
    const refused = checkDrSeries(ev(60, 25, 0), series, null, 'x', undefined, false);
    expect(refused.result.status).toBe('pending');
    expect(refused.anchor).toBeNull();
  });
});

const ncfg = t2.neighbors as NeighborsConfig;

describe('independent observation of the vessel (radar / SAR)', () => {
  const obs = (lat: number, lon: number, tS: number) => ({
    observed_at: new Date(T0 + tS * 1000).toISOString(),
    lat,
    lon,
    accuracy_m: 50,
    provider_id: 'radar',
  });
  it('passes when close, fails when far, null when stale', () => {
    expect(checkTargetObservation(ev(60, 25, 100), [obs(60.0003, 25, 98)], ncfg, 'x')!.status).toBe('pass');
    const far = checkTargetObservation(ev(60, 25, 100), [obs(60.3, 25, 99)], ncfg, 'x')!;
    expect(far.status).toBe('fail');
    expect(far.hard_alert).toBe(true);
    expect(checkTargetObservation(ev(60, 25, 1000), [obs(60, 25, 100)], ncfg, 'x')).toBeNull();
  });
});

describe('AIS cross-feed freshness (v2)', () => {
  it('does not compare a secondary report older than the limit', () => {
    const p = ev(60, 25, 300);
    const s = ev(60.5, 25, 0, { source: 'ais_b', provider_id: 'b' });
    expect(checkAisCrossFeed(p, s, 'x', 500).status).toBe('fail'); // v1 behaviour unchanged
    expect(checkAisCrossFeed(p, s, 'x', 500, 90).status).toBe('unavailable');
  });
});

describe('kinematics v2 additions', () => {
  const cfg: KinematicsConfig = {
    ...(t2.kinematics as unknown as KinematicsConfig),
    vessel_class_limits: t2.vessel_class_limits as KinematicsConfig['vessel_class_limits'],
  };
  const st = { cusum: 0 } as KinematicsState;
  it('skips heading/COG turn rate across interpolated points', () => {
    const a = ev(60, 25, 0, { heading_deg: 0, course_over_ground_deg: 0, interpolated: true });
    const p = along(8);
    const b = ev(p.lat, p.lon, 8, { heading_deg: 90, course_over_ground_deg: 90 });
    const r = checkKinematics(b, a, st, cfg, 'x');
    expect(r.result.evidence?.rot_source).toBe('skipped_interpolated');
  });
});

describe('evidence classes for lab inputs', () => {
  const event = ev(60, 25, 0, { labels: {} });
  it('labels synthetic OSNMA / attestation as simulated and recorded RF as recorded', () => {
    expect(classifyCheckEvidence('osnma', { event, osnma: { status: 'authenticated', observed_at: event.source_timestamp, reason: null, mode: 'synthetic' } })).toBe('simulated');
    expect(classifyCheckEvidence('attestation', { event, attestation: { device_id: 'd', assurance_level: 'hardware', provider: 'p', verified: true, observed_at: event.source_timestamp, reason: null, synthetic: true } })).toBe('simulated');
    const rf = { layout_id: 'c', observed_at: event.source_timestamp, mode: 'lab_iq_recorded', antennas: 4, sample_rate_hz: 1, center_freq_hz: 1, status: 'pass', aoa_status: 'pass', reason: null } as never;
    expect(classifyCheckEvidence('rf_lab', { event, rfLab: rf })).toBe('recorded');
  });
});
