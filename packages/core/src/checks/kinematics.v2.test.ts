import { describe, expect, it } from 'vitest';
import { checkKinematics, type KinematicsConfig, type KinematicsState } from './kinematics.js';
import { destination } from '../geo/haversine.js';
import type { PositionEvent } from '@northstar/contracts';
import t1 from '../../../../config/thresholds.v1.json';
import t2 from '../../../../config/thresholds.v2.json';

const cfg = (t: typeof t1 | typeof t2): KinematicsConfig => ({
  ...(t.kinematics as KinematicsConfig),
  vessel_class_limits: t.vessel_class_limits as KinematicsConfig['vessel_class_limits'],
});
const V1 = cfg(t1);
const V2 = cfg(t2);

function ev(lat: number, lon: number, tS: number, extra: Partial<PositionEvent> = {}): PositionEvent {
  const ts = new Date(Date.UTC(2026, 10, 12, 10, 0, 0) + tS * 1000).toISOString();
  return {
    schema_version: 1,
    entity_id: 'V',
    entity_type: 'vessel',
    vessel_class: 'cargo',
    position: { lat, lon, crs: 'EPSG:4326' },
    source: 'ais',
    source_timestamp: ts,
    ingested_at: ts,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
    speed_over_ground_knots: 0.1,
    course_over_ground_deg: 0,
    ...extra,
  };
}

/** Moored vessel: ±8 m GPS jitter and random COG (as real AIS does at SOG≈0). */
function mooredTrack(n: number, dt: number): PositionEvent[] {
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const p = destination(60.16, 24.95, r() * 360, r() * 8);
    return ev(p.lat, p.lon, i * dt, { course_over_ground_deg: Math.floor(r() * 360), speed_over_ground_knots: r() * 0.3 });
  });
}

function run(track: PositionEvent[], c: KinematicsConfig) {
  let st: KinematicsState = { cusum: 0 };
  let flagged = 0;
  for (let i = 1; i < track.length; i++) {
    const r = checkKinematics(track[i]!, track[i - 1]!, st, c, track[i]!.source_timestamp);
    st = r.state;
    if (r.result.status !== 'pass') flagged++;
  }
  return { flagged, cusum: st.cusum };
}

describe('kinematics v2 (P2.2)', () => {
  it('moored jitter with random COG is not flagged in v2 (v1 flags it)', () => {
    const track = mooredTrack(60, 120);
    expect(run(track, V2).flagged).toBe(0);
    expect(run(track, V1).flagged).toBeGreaterThan(0);
  });

  it('teleport still hard-fails in v2', () => {
    const a = ev(59.95, 24.9, 0, { speed_over_ground_knots: 12, course_over_ground_deg: 90 });
    const b = ev(60.3, 24.9, 60, { speed_over_ground_knots: 12, course_over_ground_deg: 90 });
    const r = checkKinematics(b, a, { cusum: 0 }, V2, b.source_timestamp);
    expect(r.result.hard_alert).toBe(true);
  });

  it('CUSUM resets after a long gap', () => {
    const a = ev(59.95, 24.9, 0, { speed_over_ground_knots: 12, course_over_ground_deg: 90 });
    const b = ev(59.95, 24.95, 3600, { speed_over_ground_knots: 12, course_over_ground_deg: 90 });
    const r = checkKinematics(b, a, { cusum: 3.9 }, V2, b.source_timestamp);
    expect(r.state.cusum).toBe(0);
    expect(r.result.evidence?.cusum_reset).toBeTruthy();
  });

  it('uses the AIS ROT field for turn rate when present', () => {
    const a = ev(59.95, 24.9, 0, { speed_over_ground_knots: 12, course_over_ground_deg: 90 });
    const b = ev(59.95, 24.9032, 10, { speed_over_ground_knots: 12, course_over_ground_deg: 150, rot_deg_min: 3 });
    const r = checkKinematics(b, a, { cusum: 0 }, V2, b.source_timestamp);
    expect(r.result.evidence?.rot_source).toBe('ais_rot');
    expect(r.result.evidence?.rot_deg_min).toBe(3);
  });
});

describe('realistic drift (P5.2) — honest limits', () => {
  // Underway at 12 kn due east, 60 s reports, with a spoofed northward drift.
  function drifting(mps: number, n = 30): PositionEvent[] {
    const out: PositionEvent[] = [];
    for (let i = 0; i < n; i++) {
      const truth = destination(59.9, 24.0, 90, 12 * 0.514444 * 60 * i);
      const off = destination(truth.lat, truth.lon, 0, mps * 60 * i);
      out.push(ev(off.lat, off.lon, i * 60, { speed_over_ground_knots: 12, course_over_ground_deg: 90 }));
    }
    return out;
  }

  it('2 m/s drift is detected by v2 within 30 min', () => {
    expect(run(drifting(2), V2).flagged).toBeGreaterThan(0);
  });

  it('0.2 m/s drift is NOT detected by AIS kinematics alone (documented limit)', () => {
    // If this starts failing, the detector got more sensitive — re-check the FPR first.
    expect(run(drifting(0.2), V2).flagged).toBe(0);
  });
});
