import { describe, expect, it } from 'vitest';
import type { PositionEvent } from '@northstar/contracts';
import { buildLandIndex, nearestEdgeDistM } from '../geo/landIndex.js';
import { checkGeographic } from './geo.js';
import { checkFleetCoherenceV2, DEFAULT_FLEET_COHERENCE_V2 } from './fleetCoherenceV2.js';
import { checkIdentity, createIdentityState, DEFAULT_IDENTITY, parseMmsi } from './identity.js';
import { destination } from '../geo/haversine.js';
import type { FleetDisplacement } from './fleetCoherence.js';

// A square "island" 0.02° × 0.02° (≈1.1 km N-S, ≈1.1 km·cos(lat) E-W) at 60N 25E.
const square = {
  type: 'Polygon' as const,
  coordinates: [[[25, 60], [25.02, 60], [25.02, 60.02], [25, 60.02], [25, 60]]] as [number, number][][],
};
const land = buildLandIndex([{ id: 'sq', geometry: square }]);
const T = '2026-11-12T10:00:00.000Z';
function ev(lat: number, lon: number, extra: Partial<PositionEvent> = {}): PositionEvent {
  return {
    schema_version: 1,
    entity_id: 'LIVE-230000001',
    entity_type: 'vessel',
    position: { lat, lon, crs: 'EPSG:4326' },
    source: 'ais',
    source_timestamp: T,
    ingested_at: T,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
    ...extra,
  };
}
const geoV1 = { shore_buffer_m: 150, port_buffer_m: 400, warning_inland_m: 80, fail_inland_m: 300 };
const geoV2 = { ...geoV1, distance_mode: 'edge' as const, use_hull_tolerance: true, default_hull_offset_m: 30 };
const ctx = { land, ports: [], restricted: [] };

describe('geographic v2 (P2.1)', () => {
  it('edge distance is ≤ vertex distance at mid-edge', () => {
    // 20 m inside the southern edge, half-way along it: vertex distance ≈ 560 m.
    const lat = 60 + 20 / 111_320;
    const edge = nearestEdgeDistM(25.01, lat, square);
    expect(edge).toBeGreaterThan(15);
    expect(edge).toBeLessThan(25);
    expect(land.query(25.01, lat).inlandDepthM).toBeGreaterThan(400);
  });

  it('vessel alongside (inside polygon by < accuracy + hull) passes in v2, flagged in v1', () => {
    const lat = 60 + 25 / 111_320;
    const e = ev(lat, 25.01, { dimensions_m: { a: 100, b: 20, c: 10, d: 10 } });
    expect(checkGeographic(e, ctx, geoV2, T).status).toBe('pass');
    expect(checkGeographic(e, ctx, geoV1, T).status).not.toBe('pass');
  });

  it('inland teleport is still a hard fail in v2', () => {
    const r = checkGeographic(ev(60.01, 25.01), ctx, geoV2, T);
    expect(r.status).toBe('fail');
    expect(r.hard_alert).toBe(true);
  });
});

function disp(id: string, lat: number, lon: number, opts: { sog: number; cog: number; dt: number; jump?: { m: number; brg: number } }): FleetDisplacement {
  const moved = destination(lat, lon, opts.cog, opts.sog * 0.514444 * opts.dt);
  const to = opts.jump ? destination(moved.lat, moved.lon, opts.jump.brg, opts.jump.m) : moved;
  return {
    entity_id: id,
    prev_lat: lat,
    prev_lon: lon,
    lat: to.lat,
    lon: to.lon,
    dist_m: 0,
    d_lat: to.lat - lat,
    d_lon: to.lon - lon,
    dt_s: opts.dt,
    from_sog_kn: opts.sog,
    from_cog_deg: opts.cog,
    to_sog_kn: opts.sog,
  };
}

describe('fleet coherence v2 (P2.3)', () => {
  it('fast normal lane traffic produces no flag', () => {
    const d = Array.from({ length: 10 }, (_, i) => disp(`V${i}`, 59.8 + i * 0.01, 24.5, { sog: 20, cog: 80, dt: 180 }));
    expect(checkFleetCoherenceV2('V0', d, T, DEFAULT_FLEET_COHERENCE_V2).status).toBe('pass');
  });

  it('coherent area offset flags members, bystanders pass with context', () => {
    const shifted = Array.from({ length: 5 }, (_, i) =>
      disp(`S${i}`, 59.8 + i * 0.01, 24.5, { sog: 10, cog: 90, dt: 60, jump: { m: 3000, brg: 45 } }),
    );
    const normal = Array.from({ length: 5 }, (_, i) => disp(`N${i}`, 59.6 + i * 0.01, 25.5, { sog: 10, cog: 90, dt: 60 }));
    const all = [...shifted, ...normal];
    const member = checkFleetCoherenceV2('S0', all, T);
    expect(member.status).toBe('fail');
    const bystander = checkFleetCoherenceV2('N0', all, T);
    expect(bystander.status).toBe('pass');
    expect(bystander.evidence?.area_pattern).toBe(true);
  });
});

describe('identity (P6.1)', () => {
  it('parses MMSI kinds and flags unallocated MIDs', () => {
    expect(parseMmsi(230123456)).toMatchObject({ kind: 'ship', mid: 230, valid_mid: true });
    expect(parseMmsi(299999999)).toMatchObject({ kind: 'ship', mid: 299, valid_mid: false });
    expect(parseMmsi('992301234')).toMatchObject({ kind: 'aid_to_navigation', mid: 230 });
    expect(parseMmsi(12345)).toMatchObject({ kind: 'invalid' });
    const r = checkIdentity(ev(60, 25, { labels: { mmsi: 299999999 } }), createIdentityState(), DEFAULT_IDENTITY, T);
    expect(r.result.status).toBe('warning');
  });

  it('flags the same MMSI alternating between two distant places', () => {
    let st = createIdentityState();
    let last = null as ReturnType<typeof checkIdentity> | null;
    const at = (i: number, lat: number) =>
      ev(lat, 25, { labels: { mmsi: 230000001 }, source_timestamp: new Date(Date.parse(T) + i * 30_000).toISOString() });
    [60, 60.0005, 60.3, 60.001, 60.3005, 60.0015].forEach((lat, i) => {
      last = checkIdentity(at(i, lat), st, DEFAULT_IDENTITY, T);
      st = last.state;
    });
    expect(last!.result.status).toBe('fail');
  });

  it('flags a name/IMO change within 24 h', () => {
    let st = createIdentityState();
    st = checkIdentity(ev(60, 25, { name: 'ALPHA', labels: { mmsi: 230000001, imo: 9000001 } }), st, DEFAULT_IDENTITY, T).state;
    const r = checkIdentity(
      ev(60, 25.0001, { name: 'BRAVO', labels: { mmsi: 230000001, imo: 9000002 }, source_timestamp: '2026-11-12T12:00:00.000Z' }),
      st,
      DEFAULT_IDENTITY,
      T,
    );
    expect(r.result.status).toBe('warning');
    expect(String(r.result.explanation)).toMatch(/IMO/);
  });
});
