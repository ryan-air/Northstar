/**
 * P0.3 — full-pipeline evaluation harness.
 *
 * Runs the real TrustPipeline over the frozen dataset (data/replay/snapshots) and
 * writes data/fixtures/eval_pipeline_metrics.json with, per data split and per config:
 *   - share of events in each trust band
 *   - flag rate per check (warning / fail / warning-or-worse)
 *   - suspicious-or-worse rate by vessel state (SOG < 0.5 kn vs underway; in port vs not)
 *   - vessels ever flagged
 *   - ingest rejections
 * and, from scripts/eval/attacks.ts, per-attack recall, time-to-detection, which check
 * caught it, plus two simple baselines (implied speed > class max; position on land).
 *
 *   npm run eval:pipeline -- [--n 10] [--seed 7] [--no-legacy] [--configs v1,v2]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, PositionEvent } from '@northstar/contracts';
import { haversineM, mpsToKnots } from '@northstar/core';
import { ATTACKS, type AttackSpec } from './eval/attacks.js';
import {
  ROOT,
  SNAPSHOT_MANIFEST,
  inPort,
  isFlagged,
  loadMeta,
  loadRecords,
  makeEngine,
  recordTime,
  recordToEvent,
  rng,
  runEvents,
  splitOf,
  type Engine,
  type RunConfig,
  type SplitId,
} from './eval/lib.js';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1]! : d;
};
const N_PER_ATTACK = Number(opt('--n', '10'));
const SEED = Number(opt('--seed', '7'));
const RUN_LEGACY = !argv.includes('--no-legacy');
const CONFIGS = opt('--configs', 'v1,v2').split(',') as Array<'v1' | 'v2'>;
const OUT_ARG = opt('--out', 'data/fixtures/eval_pipeline_metrics.json');
const OUT = OUT_ARG.startsWith('/') ? OUT_ARG : join(ROOT, OUT_ARG);

const tOf = (e: PositionEvent) => Date.parse(e.source_timestamp);
const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
/** Wilson score 95% interval for k successes out of n, in percent (one decimal). */
function wilson95(k: number, n: number): [number, number] | null {
  if (!(n > 0)) return null;
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const r = (x: number) => Math.round(1000 * Math.min(1, Math.max(0, x))) / 10;
  return [r((c - h) / d), r((c + h) / d)];
}

// ———————————————————————————————————————————— clean-data metrics
interface SplitAcc {
  events: number;
  bands: Record<string, number>;
  checkWarn: Record<string, number>;
  checkFail: Record<string, number>;
  stationary: { n: number; flagged: number };
  underway: { n: number; flagged: number };
  port: { n: number; flagged: number };
  outside: { n: number; flagged: number };
  vessels: Set<string>;
  flaggedVessels: Set<string>;
  criticalStationaryVessels: Set<string>;
  rejected: Record<string, number>;
  baselineSpeed: number;
  baselineLand: number;
}

function newAcc(): SplitAcc {
  return {
    events: 0,
    bands: { high: 0, caution: 0, suspicious: 0, critical: 0 },
    checkWarn: {},
    checkFail: {},
    stationary: { n: 0, flagged: 0 },
    underway: { n: 0, flagged: 0 },
    port: { n: 0, flagged: 0 },
    outside: { n: 0, flagged: 0 },
    vessels: new Set(),
    flaggedVessels: new Set(),
    criticalStationaryVessels: new Set(),
    rejected: {},
    baselineSpeed: 0,
    baselineLand: 0,
  };
}

function classMax(engine: Engine, e: PositionEvent): number {
  const lim = engine.thresholds.vessel_class_limits as Record<string, { max_sog_kn: number }>;
  return (lim[e.vessel_class ?? 'other'] ?? lim.other!).max_sog_kn;
}

/** Baseline A: implied speed between consecutive reports > class max SOG. */
function makeSpeedBaseline(engine: Engine) {
  const last = new Map<string, PositionEvent>();
  return (e: PositionEvent): boolean => {
    const p = last.get(e.entity_id);
    last.set(e.entity_id, e);
    if (!p) return false;
    const dt = (tOf(e) - tOf(p)) / 1000;
    if (!(dt > 0)) return false;
    const kn = mpsToKnots(haversineM(p.position.lat, p.position.lon, e.position.lat, e.position.lon) / dt);
    return kn > classMax(engine, e);
  };
}

/** Baseline B: position inside a land polygon. */
function landBaseline(engine: Engine, e: PositionEvent): boolean {
  return engine.geo.land.query(e.position.lon, e.position.lat, { distance: 'none' }).onLand;
}

function summarise(acc: SplitAcc) {
  const checks = [...new Set([...Object.keys(acc.checkWarn), ...Object.keys(acc.checkFail)])].sort();
  return {
    events: acc.events,
    trust_band_share_pct: Object.fromEntries(Object.entries(acc.bands).map(([k, v]) => [k, pct(v, acc.events)])),
    suspicious_or_worse_pct: pct(acc.bands.suspicious! + acc.bands.critical!, acc.events),
    flag_rate_per_check_pct: Object.fromEntries(
      checks.map((c) => [
        c,
        {
          warning: pct(acc.checkWarn[c] ?? 0, acc.events),
          fail: pct(acc.checkFail[c] ?? 0, acc.events),
          warning_or_worse: pct((acc.checkWarn[c] ?? 0) + (acc.checkFail[c] ?? 0), acc.events),
          flagged_events: (acc.checkWarn[c] ?? 0) + (acc.checkFail[c] ?? 0),
        },
      ]),
    ),
    by_vessel_state_suspicious_or_worse_pct: {
      stationary_sog_lt_0_5: { events: acc.stationary.n, pct: pct(acc.stationary.flagged, acc.stationary.n) },
      underway: { events: acc.underway.n, pct: pct(acc.underway.flagged, acc.underway.n) },
      inside_port_polygon: { events: acc.port.n, pct: pct(acc.port.flagged, acc.port.n) },
      outside_port_polygon: { events: acc.outside.n, pct: pct(acc.outside.flagged, acc.outside.n) },
    },
    vessels: acc.vessels.size,
    vessels_ever_flagged: acc.flaggedVessels.size,
    vessels_ever_critical_while_stationary: acc.criticalStationaryVessels.size,
    ingest_rejected: acc.rejected,
    baselines_flag_rate_pct: {
      implied_speed_gt_class_max: pct(acc.baselineSpeed, acc.events),
      position_on_land: pct(acc.baselineLand, acc.events),
    },
  };
}

function runClean(cfg: RunConfig, events: PositionEvent[]) {
  const engine = makeEngine(cfg);
  const accs: Record<SplitId, SplitAcc> = { calibration: newAcc(), test: newAcc() };
  // Same metrics with non-vessel transponders (test units, base stations, AtoN) left out.
  const vesselAccs: Record<SplitId, SplitAcc> = { calibration: newAcc(), test: newAcc() };
  const nonVessel: Record<SplitId, Map<string, { events: number; flagged: number; reasons: string[] }>> = {
    calibration: new Map(),
    test: new Map(),
  };
  const speedBase = makeSpeedBaseline(engine);
  runEvents(engine, events, undefined, (p) => {
    const split = splitOf(p.now);
    if (!split) return;
    const acc = accs[split];
    if (!p.accepted) {
      acc.rejected[p.rejectCode!] = (acc.rejected[p.rejectCode!] ?? 0) + 1;
      return;
    }
    const t = p.trust!;
    const isNonVessel = t.transponder_kind === 'non_vessel_transponder';
    if (isNonVessel) {
      const nv = nonVessel[split].get(p.event.entity_id) ?? { events: 0, flagged: 0, reasons: [] };
      nv.events++;
      if (isFlagged(t)) nv.flagged++;
      nv.reasons = t.transponder_kind_reasons ?? [];
      nonVessel[split].set(p.event.entity_id, nv);
    }
    const flagged = isFlagged(t);
    const stationary = (p.event.speed_over_ground_knots ?? 0) < 0.5;
    const port = inPort(engine.geo, p.event.position.lat, p.event.position.lon);
    const sb = speedBase(p.event);
    const lb = landBaseline(engine, p.event);
    for (const a of isNonVessel ? [acc] : [acc, vesselAccs[split]]) {
      a.events++;
      a.bands[t.trust_band] = (a.bands[t.trust_band] ?? 0) + 1;
      for (const c of t.checks) {
        if (c.status === 'warning') a.checkWarn[c.check_id] = (a.checkWarn[c.check_id] ?? 0) + 1;
        if (c.status === 'fail') a.checkFail[c.check_id] = (a.checkFail[c.check_id] ?? 0) + 1;
      }
      const bucket = (b: { n: number; flagged: number }) => {
        b.n++;
        if (flagged) b.flagged++;
      };
      bucket(stationary ? a.stationary : a.underway);
      bucket(port ? a.port : a.outside);
      a.vessels.add(p.event.entity_id);
      if (flagged) a.flaggedVessels.add(p.event.entity_id);
      if (stationary && t.trust_band === 'critical') a.criticalStationaryVessels.add(p.event.entity_id);
      if (sb) a.baselineSpeed++;
      if (lb) a.baselineLand++;
    }
  });
  return {
    config: cfg,
    config_versions: engine.pipeline.configVersions,
    geo_datasets: engine.geo.datasets,
    splits: Object.fromEntries(
      (['calibration', 'test'] as const).map((s) => [
        s,
        {
          ...summarise(accs[s]),
          vessels_only: summarise(vesselAccs[s]),
          non_vessel_transponders: [...nonVessel[s].entries()].map(([entity_id, v]) => ({ entity_id, ...v })),
        },
      ]),
    ),
  };
}

// ———————————————————————————————————————————— attacks
interface Instance {
  target: string;
  t0: number;
}

function pickInstances(events: PositionEvent[], split: SplitId, n: number, seed: number): Instance[] {
  const r = rng(seed);
  const bySplit = events.filter((e) => splitOf(tOf(e)) === split);
  const byEnt = new Map<string, PositionEvent[]>();
  for (const e of bySplit) {
    const l = byEnt.get(e.entity_id) ?? [];
    l.push(e);
    byEnt.set(e.entity_id, l);
  }
  const candidates: Instance[] = [];
  for (const [id, list] of byEnt) {
    for (let i = 3; i < list.length - 5; i += 4) {
      const t0 = tOf(list[i]!);
      const pre = list.filter((e) => tOf(e) >= t0 - 30 * 60_000 && tOf(e) < t0).length;
      const post = list.filter((e) => tOf(e) >= t0 && tOf(e) < t0 + 30 * 60_000);
      const moving = post.filter((e) => (e.speed_over_ground_knots ?? 0) >= 3).length;
      if (pre >= 3 && post.length >= 5 && moving >= post.length * 0.6) candidates.push({ target: id, t0 });
    }
  }
  const out: Instance[] = [];
  const used = new Set<string>();
  while (out.length < n && candidates.length > 0) {
    const k = Math.floor(r() * candidates.length);
    const c = candidates.splice(k, 1)[0]!;
    if (used.has(c.target) && candidates.some((x) => !used.has(x.target))) continue;
    used.add(c.target);
    out.push(c);
  }
  return out;
}

interface AttackOutcome {
  instances: number;
  targets: number;
  detected: number;
  ttd_s: number[];
  caught_by: Record<string, number>;
  pre_attack_flag_rate: number[];
  baseline_speed_detected: number;
  baseline_land_detected: number;
  ingest_rejected: number;
  ingest_attacked: number;
  skipped: number;
}

function newOutcome(): AttackOutcome {
  return {
    instances: 0,
    targets: 0,
    detected: 0,
    ttd_s: [],
    caught_by: {},
    pre_attack_flag_rate: [],
    baseline_speed_detected: 0,
    baseline_land_detected: 0,
    ingest_rejected: 0,
    ingest_attacked: 0,
    skipped: 0,
  };
}

function runAttack(
  cfg: RunConfig,
  spec: AttackSpec,
  inst: Instance,
  all: PositionEvent[],
  historyByEnt: Map<string, PositionEvent[]>,
  seed: number,
  outcome: AttackOutcome,
): void {
  const pre = 30 * 60_000;
  const dur = 30 * 60_000;
  const window = all.filter((e) => tOf(e) >= inst.t0 - pre && tOf(e) < inst.t0 + dur);
  const peers = [...new Set(window.map((e) => e.entity_id))].filter((x) => x !== inst.target);
  const injected = spec.inject({
    events: window,
    target: inst.target,
    t0: inst.t0,
    durationMs: dur,
    rand: rng(seed),
    peers,
    targetHistory: historyByEnt.get(inst.target) ?? [],
  });
  if (!injected) {
    outcome.skipped++;
    return;
  }
  outcome.instances++;
  const engine = makeEngine(cfg);
  const targets = new Set(injected.targets);
  const firstFlag = new Map<string, { t: number; checks: string[] }>();
  const preStats = new Map<string, { n: number; f: number }>();
  const speedBase = makeSpeedBaseline(engine);
  const baseSpeedHit = new Set<string>();
  const baseLandHit = new Set<string>();
  runEvents(
    engine,
    injected.events,
    (_e, i) => injected.processMs[i]!,
    (p) => {
      const e = p.event;
      const attacked = e.labels?.attack === spec.id;
      if (attacked) {
        if (speedBase(e)) baseSpeedHit.add(e.entity_id);
        if (landBaseline(engine, e)) baseLandHit.add(e.entity_id);
      } else {
        speedBase(e);
      }
      if (spec.layer === 'ingest' && attacked) {
        outcome.ingest_attacked++;
        if (!p.accepted) outcome.ingest_rejected++;
      }
      if (!p.accepted || !targets.has(e.entity_id)) return;
      if (!attacked && p.now < inst.t0) {
        const s = preStats.get(e.entity_id) ?? { n: 0, f: 0 };
        s.n++;
        if (isFlagged(p.trust)) s.f++;
        preStats.set(e.entity_id, s);
      }
      if (attacked && isFlagged(p.trust) && !firstFlag.has(e.entity_id)) {
        firstFlag.set(e.entity_id, {
          t: p.now,
          checks: (p.trust!.checks as CheckResult[])
            .filter((c) => c.status === 'warning' || c.status === 'fail')
            .map((c) => c.check_id),
        });
      }
    },
  );
  outcome.targets += targets.size;
  for (const id of targets) {
    const ff = firstFlag.get(id);
    if (ff) {
      outcome.detected++;
      outcome.ttd_s.push(Math.round((ff.t - inst.t0) / 1000));
      for (const c of ff.checks) outcome.caught_by[c] = (outcome.caught_by[c] ?? 0) + 1;
    }
    const s = preStats.get(id);
    if (s && s.n > 0) outcome.pre_attack_flag_rate.push(s.f / s.n);
    if (baseSpeedHit.has(id)) outcome.baseline_speed_detected++;
    if (baseLandHit.has(id)) outcome.baseline_land_detected++;
  }
}

function summariseAttack(spec: AttackSpec, o: AttackOutcome) {
  const med = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const mean = (xs: number[]) => (xs.length ? Math.round((1000 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 10 : null);
  return {
    family: spec.family,
    params: spec.params,
    layer: spec.layer,
    instances: o.instances,
    skipped_no_suitable_window: o.skipped,
    targets: o.targets,
    recall_pct: spec.layer === 'ingest' ? pct(o.ingest_rejected, o.ingest_attacked) : pct(o.detected, o.targets),
    /** Wilson 95% interval on recall (small n: read the range, not the point estimate). */
    recall_ci95_pct:
      spec.layer === 'ingest' ? wilson95(o.ingest_rejected, o.ingest_attacked) : wilson95(o.detected, o.targets),
    recall_basis:
      spec.layer === 'ingest'
        ? 'share of attacked reports rejected at ingest'
        : 'share of attacked vessels whose trust reached suspicious/critical on an attacked report',
    median_time_to_detection_s: med(o.ttd_s),
    caught_by_check: o.caught_by,
    pre_attack_flag_rate_pct: mean(o.pre_attack_flag_rate),
    baselines_recall_pct: {
      implied_speed_gt_class_max: pct(o.baseline_speed_detected, o.targets),
      position_on_land: pct(o.baseline_land_detected, o.targets),
    },
  };
}

// ———————————————————————————————————————————— main
function main(): void {
  const t0 = Date.now();
  const manifest = JSON.parse(readFileSync(SNAPSHOT_MANIFEST, 'utf8')) as Record<string, unknown>;
  const meta = loadMeta();
  const records = loadRecords();
  const events = records
    .map((r) => recordToEvent(r, meta))
    .sort((a, b) => tOf(a) - tOf(b));
  const historyByEnt = new Map<string, PositionEvent[]>();
  for (const e of events) {
    const l = historyByEnt.get(e.entity_id) ?? [];
    l.push(e);
    historyByEnt.set(e.entity_id, l);
  }

  const clean: Record<string, unknown> = {};
  if (RUN_LEGACY) {
    // Legacy reproduction: raw recording rows within the snapshot span, duplicates kept,
    // no ingest validation, v1 configs — approximates what the audit measured.
    const src = join(ROOT, String(manifest.source_file));
    const endMs = Date.parse((manifest.time_span as { end: string }).end);
    const raw = loadRecords(src)
      .filter((r) => recordTime(r) <= endMs)
      .map((r) => recordToEvent(r, meta));
    // Process in capture order (how polls arrived), with the poll capture time as the clock.
    const capture = loadRecords(src).filter((r) => recordTime(r) <= endMs).map((r) => Date.parse(r.captured_at));
    const order = raw.map((_, i) => i).sort((a, b) => capture[a]! - capture[b]!);
    const rawOrdered = order.map((i) => raw[i]!);
    const capOrdered = order.map((i) => capture[i]!);
    const engine = makeEngine({ label: 'legacy_v1_raw', fusion: 'v1', thresholds: 'v1', validate: false });
    const accs: Record<SplitId, SplitAcc> = { calibration: newAcc(), test: newAcc() };
    runEvents(engine, rawOrdered, (_e, i) => capOrdered[i]!, (p) => {
      const split = splitOf(tOf(p.event));
      if (!split || !p.trust) return;
      const acc = accs[split];
      acc.events++;
      acc.bands[p.trust.trust_band] = (acc.bands[p.trust.trust_band] ?? 0) + 1;
      for (const c of p.trust.checks) {
        if (c.status === 'warning') acc.checkWarn[c.check_id] = (acc.checkWarn[c.check_id] ?? 0) + 1;
        if (c.status === 'fail') acc.checkFail[c.check_id] = (acc.checkFail[c.check_id] ?? 0) + 1;
      }
      const flagged = isFlagged(p.trust);
      acc.vessels.add(p.event.entity_id);
      if (flagged) acc.flaggedVessels.add(p.event.entity_id);
      const stationary = (p.event.speed_over_ground_knots ?? 0) < 0.5;
      (stationary ? acc.stationary : acc.underway).n++;
      if (flagged) (stationary ? acc.stationary : acc.underway).flagged++;
      if (stationary && p.trust.trust_band === 'critical') acc.criticalStationaryVessels.add(p.event.entity_id);
    });
    const combined = newAcc();
    for (const a of Object.values(accs)) {
      combined.events += a.events;
      for (const [k, v] of Object.entries(a.bands)) combined.bands[k] = (combined.bands[k] ?? 0) + v;
      for (const [k, v] of Object.entries(a.checkWarn)) combined.checkWarn[k] = (combined.checkWarn[k] ?? 0) + v;
      for (const [k, v] of Object.entries(a.checkFail)) combined.checkFail[k] = (combined.checkFail[k] ?? 0) + v;
      a.vessels.forEach((v) => combined.vessels.add(v));
      a.flaggedVessels.forEach((v) => combined.flaggedVessels.add(v));
      combined.stationary.n += a.stationary.n;
      combined.stationary.flagged += a.stationary.flagged;
      combined.underway.n += a.underway.n;
      combined.underway.flagged += a.underway.flagged;
    }
    clean.legacy_v1_raw = {
      note: 'Raw recording (re-polled duplicates kept), no ingest validation, v1 configs, capture-time clock. Audit-baseline reproduction attempt.',
      rows: rawOrdered.length,
      splits: { calibration: summarise(accs.calibration), test: summarise(accs.test), all: summarise(combined) },
    };
    console.log(`[eval] legacy_v1_raw done (${rawOrdered.length} rows)`);
  }
  for (const c of CONFIGS) {
    const cfg: RunConfig = { label: c, fusion: c, thresholds: c, validate: true };
    clean[c] = runClean(cfg, events);
    console.log(`[eval] clean ${c} done`);
  }

  const attacks: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const c of CONFIGS) {
    const cfg: RunConfig = { label: c, fusion: c, thresholds: c, validate: true };
    attacks[c] = {};
    for (const split of ['calibration', 'test'] as SplitId[]) {
      const instances = pickInstances(events, split, N_PER_ATTACK, SEED + (split === 'test' ? 1000 : 0));
      const bySpec: Record<string, unknown> = {};
      ATTACKS.forEach((spec, si) => {
        const o = newOutcome();
        instances.forEach((inst, ii) => runAttack(cfg, spec, inst, events, historyByEnt, SEED * 31 + si * 997 + ii, o));
        bySpec[spec.id] = summariseAttack(spec, o);
      });
      attacks[c]![split] = { instances_selected: instances.length, attacks: bySpec };
      console.log(`[eval] attacks ${c}/${split} done (${instances.length} instances × ${ATTACKS.length})`);
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    generator: 'scripts/eval-pipeline.ts (P0.3/P0.4)',
    dataset: {
      file: 'data/replay/snapshots/gof_ais.eval-v1.jsonl',
      sha256: manifest.sha256,
      rows: manifest.rows,
      time_span: manifest.time_span,
      rows_per_utc_day: manifest.rows_per_utc_day,
      splits: manifest.splits,
    },
    definitions: {
      flagged: 'trust_band ∈ {suspicious, critical} (trust < 65)',
      warning_level: 'check status === "warning"',
      attack_window: '30 min clean context before onset, 30 min attack after onset; all vessels in the window are processed',
      attacks_per_variant_per_split: N_PER_ATTACK,
      seed: SEED,
    },
    clean,
    attacks,
    runtime_s: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`[eval] wrote ${OUT} in ${out.runtime_s}s`);
}

main();
