/**
 * P0.4 — library of labelled, realistic attacks injected into clean recorded tracks.
 *
 * Each attack takes the clean event window (all vessels, time-ordered), a target, and
 * an onset time t0, and returns a modified window in which every attacked event carries
 * labels.attack = <attack id>. Processing order is preserved by `process_ms` so stale /
 * future timestamp attacks are evaluated against the true arrival time.
 */
import type { PositionEvent } from '@northstar/contracts';
import { destination, haversineM, knotsToMps } from '@northstar/core';

export interface AttackContext {
  /** clean window, sorted by time */
  events: PositionEvent[];
  target: string;
  t0: number;
  durationMs: number;
  rand: () => number;
  /** other entity ids active in the window (for clone / area attacks) */
  peers: string[];
  /** all clean events of the target across the whole dataset (for self-replay) */
  targetHistory: PositionEvent[];
}

export interface Injected {
  events: PositionEvent[];
  /** processing time per event (defaults to event time) */
  processMs: number[];
  /** entities under attack (area attacks have several) */
  targets: string[];
  /** expected to be undetectable — recorded as a known limit */
  knownLimit?: boolean;
}

export interface AttackSpec {
  id: string;
  family: string;
  params: Record<string, unknown>;
  /** "ingest" attacks are caught (or not) by validation, not by checks */
  layer: 'detection' | 'ingest';
  inject(ctx: AttackContext): Injected | null;
}

const tOf = (e: PositionEvent) => Date.parse(e.source_timestamp);
const inWindow = (e: PositionEvent, ctx: AttackContext) =>
  tOf(e) >= ctx.t0 && tOf(e) < ctx.t0 + ctx.durationMs;

function relabel(e: PositionEvent, id: string, patch: Partial<PositionEvent>): PositionEvent {
  return { ...e, ...patch, labels: { ...(e.labels ?? {}), attack: id } };
}

function finish(events: PositionEvent[], targets: string[], knownLimit = false): Injected {
  const sorted = [...events].sort((a, b) => tOf(a) - tOf(b));
  return { events: sorted, processMs: sorted.map(tOf), targets, knownLimit };
}

/** Shift positions of matching events by a function of time. */
function shiftTarget(
  ctx: AttackContext,
  id: string,
  offset: (tMs: number) => { m: number; bearing: number },
): Injected {
  const out = ctx.events.map((e) => {
    if (e.entity_id !== ctx.target || !inWindow(e, ctx)) return e;
    const { m, bearing } = offset(tOf(e));
    const p = destination(e.position.lat, e.position.lon, bearing, m);
    return relabel(e, id, { position: { ...e.position, lat: p.lat, lon: p.lon } });
  });
  return finish(out, [ctx.target]);
}

// Inland point well inside the Finnish mainland (≈25 km N of Helsinki).
const INLAND = { lat: 60.42, lon: 24.95 };

export const ATTACKS: AttackSpec[] = [
  {
    id: 'teleport_inland',
    family: 'teleport',
    params: { to: INLAND },
    layer: 'detection',
    inject: (ctx) => {
      const id = 'teleport_inland';
      const out = ctx.events.map((e) =>
        e.entity_id === ctx.target && inWindow(e, ctx)
          ? relabel(e, id, { position: { ...e.position, lat: INLAND.lat, lon: INLAND.lon } })
          : e,
      );
      return finish(out, [ctx.target]);
    },
  },
  {
    id: 'teleport_open_sea',
    family: 'teleport',
    params: { km: 15, bearing: 180 },
    layer: 'detection',
    inject: (ctx) => shiftTarget(ctx, 'teleport_open_sea', () => ({ m: 15_000, bearing: 180 })),
  },
  ...[100, 300, 500, 1000].map<AttackSpec>((m) => ({
    id: `step_offset_${m}m`,
    family: 'step_offset',
    params: { m },
    layer: 'detection',
    inject: (ctx) => {
      const bearing = Math.floor(ctx.rand() * 360);
      return shiftTarget(ctx, `step_offset_${m}m`, () => ({ m, bearing }));
    },
  })),
  ...[0.2, 0.5, 1, 2].map<AttackSpec>((v) => ({
    id: `drift_${v}mps`,
    family: 'linear_drift',
    params: { mps: v },
    layer: 'detection',
    inject: (ctx) => {
      const bearing = Math.floor(ctx.rand() * 360);
      return shiftTarget(ctx, `drift_${v}mps`, (t) => ({ m: (v * (t - ctx.t0)) / 1000, bearing }));
    },
  })),
  {
    id: 'area_pull',
    family: 'area',
    params: { min_vessels: 4, radius_km: 25 },
    layer: 'detection',
    inject: (ctx) => {
      const id = 'area_pull';
      const pos = lastPositions(ctx.events, ctx.t0);
      const c = pos.get(ctx.target);
      if (!c) return null;
      const group = [...pos.entries()]
        .filter(([, p]) => haversineM(c.lat, c.lon, p.lat, p.lon) <= 25_000)
        .map(([eid]) => eid);
      if (group.length < 4) return null;
      // Pull point: 8 km from the group centre, open water to the south.
      const pull = destination(c.lat, c.lon, 200, 8_000);
      const set = new Set(group);
      const out = ctx.events.map((e) => {
        if (!set.has(e.entity_id) || !inWindow(e, ctx)) return e;
        const j = destination(pull.lat, pull.lon, ctx.rand() * 360, ctx.rand() * 200);
        return relabel(e, id, { position: { ...e.position, lat: j.lat, lon: j.lon } });
      });
      return finish(out, group);
    },
  },
  {
    id: 'coherent_area_offset',
    family: 'area',
    params: { radius_km: 20, offset_m: 3000 },
    layer: 'detection',
    inject: (ctx) => {
      const id = 'coherent_area_offset';
      const pos = lastPositions(ctx.events, ctx.t0);
      const c = pos.get(ctx.target);
      if (!c) return null;
      const group = [...pos.entries()]
        .filter(([, p]) => haversineM(c.lat, c.lon, p.lat, p.lon) <= 20_000)
        .map(([eid]) => eid);
      if (group.length < 4) return null;
      const bearing = Math.floor(ctx.rand() * 360);
      const set = new Set(group);
      const out = ctx.events.map((e) => {
        if (!set.has(e.entity_id) || !inWindow(e, ctx)) return e;
        const p = destination(e.position.lat, e.position.lon, bearing, 3000);
        return relabel(e, id, { position: { ...e.position, lat: p.lat, lon: p.lon } });
      });
      return finish(out, group);
    },
  },
  {
    id: 'self_replay_1h',
    family: 'replay',
    params: { delay_s: 3600 },
    layer: 'detection',
    inject: (ctx) => {
      const id = 'self_replay_1h';
      const hist = ctx.targetHistory;
      let replaced = 0;
      const out = ctx.events.map((e) => {
        if (e.entity_id !== ctx.target || !inWindow(e, ctx)) return e;
        const old = interpolate(hist, tOf(e) - 3_600_000);
        if (!old) return e;
        replaced++;
        return relabel(e, id, {
          position: { ...e.position, lat: old.lat, lon: old.lon },
          speed_over_ground_knots: old.sog,
          course_over_ground_deg: old.cog,
          heading_deg: old.heading,
        });
      });
      return replaced > 0 ? finish(out, [ctx.target]) : null;
    },
  },
  {
    id: 'mmsi_clone',
    family: 'identity',
    params: { second_vessel: 'peer track re-labelled with target MMSI' },
    layer: 'detection',
    inject: (ctx) => {
      const id = 'mmsi_clone';
      const pos = lastPositions(ctx.events, ctx.t0);
      const c = pos.get(ctx.target);
      if (!c) return null;
      // A second transmitter far enough away that alternation is physically impossible.
      const clone = ctx.peers.find((p) => {
        const q = pos.get(p);
        return q && haversineM(c.lat, c.lon, q.lat, q.lon) > 10_000;
      });
      if (!clone) return null;
      const target = ctx.events.find((e) => e.entity_id === ctx.target)!;
      const out = ctx.events.map((e) =>
        e.entity_id === clone && inWindow(e, ctx)
          ? relabel(e, id, {
              entity_id: ctx.target,
              name: target.name,
              vessel_class: target.vessel_class,
              labels: { ...(e.labels ?? {}), mmsi: target.labels?.mmsi, attack: id },
            })
          : e,
      );
      return finish(out, [ctx.target]);
    },
  },
  {
    id: 'consistent_fake_track',
    family: 'kinematic_fake',
    params: { turn_deg_per_min: 2, note: 'smooth, self-consistent SOG/COG — expected undetected' },
    layer: 'detection',
    inject: (ctx) => {
      const id = 'consistent_fake_track';
      const tgt = ctx.events.filter((e) => e.entity_id === ctx.target);
      const start = [...tgt].reverse().find((e) => tOf(e) < ctx.t0) ?? tgt[0];
      if (!start) return null;
      const sog = Math.max(6, start.speed_over_ground_knots ?? 8);
      let cog = start.course_over_ground_deg ?? 90;
      let lat = start.position.lat;
      let lon = start.position.lon;
      let tPrev = tOf(start);
      const out = ctx.events.map((e) => {
        if (e.entity_id !== ctx.target || !inWindow(e, ctx)) return e;
        const dt = (tOf(e) - tPrev) / 1000;
        tPrev = tOf(e);
        cog = (cog + (2 * dt) / 60 + 360) % 360;
        const p = destination(lat, lon, cog, knotsToMps(sog) * dt);
        lat = p.lat;
        lon = p.lon;
        return relabel(e, id, {
          position: { ...e.position, lat, lon },
          speed_over_ground_knots: sog,
          course_over_ground_deg: cog,
          heading_deg: Math.round(cog),
          rot_deg_min: 2,
        });
      });
      return { ...finish(out, [ctx.target], true) };
    },
  },
  {
    id: 'stale_timestamp',
    family: 'bad_timestamp',
    params: { shift_s: -900 },
    layer: 'ingest',
    inject: (ctx) => timeShift(ctx, 'stale_timestamp', -900_000),
  },
  {
    id: 'future_timestamp',
    family: 'bad_timestamp',
    params: { shift_s: 600 },
    layer: 'ingest',
    inject: (ctx) => timeShift(ctx, 'future_timestamp', 600_000),
  },
  {
    id: 'duplicates',
    family: 'duplicate',
    params: { copies: 3 },
    layer: 'ingest',
    inject: (ctx) => {
      const out: PositionEvent[] = [];
      const proc: number[] = [];
      for (const e of ctx.events) {
        out.push(e);
        proc.push(tOf(e));
        if (e.entity_id === ctx.target && inWindow(e, ctx)) {
          for (let k = 1; k <= 3; k++) {
            out.push(relabel(e, 'duplicates', {}));
            proc.push(tOf(e) + k * 15_000); // re-polled 15 s later each time
          }
        }
      }
      const order = out.map((_, i) => i).sort((a, b) => proc[a]! - proc[b]!);
      return { events: order.map((i) => out[i]!), processMs: order.map((i) => proc[i]!), targets: [ctx.target] };
    },
  },
];

function timeShift(ctx: AttackContext, id: string, shiftMs: number): Injected {
  const events: PositionEvent[] = [];
  const proc: number[] = [];
  for (const e of ctx.events) {
    if (e.entity_id === ctx.target && inWindow(e, ctx)) {
      events.push(relabel(e, id, { source_timestamp: new Date(tOf(e) + shiftMs).toISOString() }));
    } else {
      events.push(e);
    }
    proc.push(tOf(e)); // arrives at its true time
  }
  return { events, processMs: proc, targets: [ctx.target] };
}

function lastPositions(events: PositionEvent[], beforeMs: number): Map<string, { lat: number; lon: number }> {
  const m = new Map<string, { lat: number; lon: number }>();
  for (const e of events) {
    if (tOf(e) >= beforeMs) break;
    if (beforeMs - tOf(e) > 15 * 60_000) continue;
    m.set(e.entity_id, { lat: e.position.lat, lon: e.position.lon });
  }
  return m;
}

function interpolate(
  hist: PositionEvent[],
  tMs: number,
): { lat: number; lon: number; sog: number | null; cog: number | null; heading: number | null } | null {
  let a: PositionEvent | null = null;
  let b: PositionEvent | null = null;
  for (const h of hist) {
    const t = tOf(h);
    if (t <= tMs) a = h;
    if (t >= tMs) {
      b = h;
      break;
    }
  }
  if (!a || !b) return null;
  const ta = tOf(a);
  const tb = tOf(b);
  if (tb - ta > 10 * 60_000) return null;
  const u = tb === ta ? 0 : (tMs - ta) / (tb - ta);
  return {
    lat: a.position.lat + (b.position.lat - a.position.lat) * u,
    lon: a.position.lon + (b.position.lon - a.position.lon) * u,
    sog: b.speed_over_ground_knots ?? null,
    cog: b.course_over_ground_deg ?? null,
    heading: b.heading_deg ?? null,
  };
}
