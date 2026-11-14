/**
 * Shared harness plumbing (P0.3/P0.4): load the frozen dataset, turn recorded rows into
 * PositionEvents, and run the REAL TrustPipeline (apps/server) over them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PositionEvent, TrustAssessment } from '@northstar/contracts';
import { IngestValidator, pointInPolygon } from '@northstar/core';
import { TrustPipeline } from '../../apps/server/src/engine/pipeline.js';
import { loadFusion, loadThresholds, type ThresholdsConfig } from '../../apps/server/src/config.js';
import { loadGeo, type GeoData } from '../../apps/server/src/geo/loadGeo.js';
import { shipTypeToClass } from '../../apps/server/src/replay/store.js';
import type { ReplayRecord } from '../../apps/server/src/replay/types.js';

export const ROOT = resolve(import.meta.dirname, '../..');
export const SNAPSHOT = join(ROOT, 'data/replay/snapshots/gof_ais.eval-v1.jsonl');
export const SNAPSHOT_MANIFEST = join(ROOT, 'data/replay/snapshots/gof_ais.eval-v1.manifest.json');
export const META = join(ROOT, 'data/replay/snapshots/vessel_meta.eval-v1.json');

export type SplitId = 'calibration' | 'test';
export const SPLITS: Record<SplitId, string[]> = {
  calibration: ['2026-11-12'],
  test: ['2026-11-13', '2026-11-14'],
};

export function splitOf(tMs: number): SplitId | null {
  const day = new Date(tMs).toISOString().slice(0, 10);
  if (SPLITS.calibration.includes(day)) return 'calibration';
  if (SPLITS.test.includes(day)) return 'test';
  return null;
}

export function loadRecords(path = SNAPSHOT): ReplayRecord[] {
  const out: ReplayRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ReplayRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

type Meta = Record<string, Partial<{
  name: string; shipType: number; callSign: string; imo: number; posType: number;
  referencePointA: number; referencePointB: number; referencePointC: number; referencePointD: number;
}>>;

export function loadMeta(): Meta {
  if (!existsSync(META)) return {};
  return (JSON.parse(readFileSync(META, 'utf8')) as { vessels: Meta }).vessels;
}

export function recordTime(r: ReplayRecord): number {
  return r.timestamp_external_ms ?? Date.parse(r.captured_at);
}

/** Recorded row → PositionEvent, mirroring the live Digitraffic adapter's mapping. */
export function recordToEvent(r: ReplayRecord, meta: Meta): PositionEvent {
  const m = meta[String(r.mmsi)] ?? {};
  const t = new Date(recordTime(r)).toISOString();
  const shipType = r.shipType ?? m.shipType;
  const ra = r.referencePointA ?? m.referencePointA;
  const rb = r.referencePointB ?? m.referencePointB;
  const rc = r.referencePointC ?? m.referencePointC;
  const rd = r.referencePointD ?? m.referencePointD;
  const dims =
    [ra, rb, rc, rd].every((x) => typeof x === 'number' && x >= 0) && ra! + rb! + rc! + rd! > 0
      ? { a: ra!, b: rb!, c: rc!, d: rd! }
      : null;
  return {
    schema_version: 1,
    entity_id: `REC-${r.mmsi}`,
    entity_type: 'vessel',
    vessel_class: shipTypeToClass(shipType) as PositionEvent['vessel_class'],
    name: r.name ?? m.name ?? `MMSI ${r.mmsi}`,
    position: { lat: r.lat, lon: r.lon, crs: 'EPSG:4326' },
    speed_over_ground_knots: typeof r.sog === 'number' ? r.sog : null,
    course_over_ground_deg: typeof r.cog === 'number' ? r.cog : null,
    heading_deg: typeof r.heading === 'number' ? r.heading : null,
    source: 'ais',
    provider_id: 'digitraffic',
    upstream_lineage: ['digitraffic', 'fintraffic', 'eval_snapshot'],
    source_timestamp: t,
    ingested_at: t,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: {
      position_accuracy_m: r.posAcc === true ? 10 : r.posAcc === false ? 50 : null,
      signal_quality_available: false,
    },
    nav_status: typeof r.navStat === 'number' && r.navStat >= 0 && r.navStat <= 15 ? r.navStat : null,
    raim: typeof r.raim === 'boolean' ? r.raim : null,
    epfd_type: typeof (r.posType ?? m.posType) === 'number' ? (r.posType ?? m.posType)! : null,
    dimensions_m: dims,
    labels: {
      live: false,
      simulated: false,
      fixture: false,
      mmsi: r.mmsi,
      call_sign: r.callSign ?? m.callSign,
      imo: r.imo ?? m.imo,
    },
  };
}

export interface RunConfig {
  label: string;
  fusion: 'v1' | 'v2';
  thresholds: 'v1' | 'v2';
  /** Apply the ingest validator (dedup/sentinels/order). Legacy reproduction = false. */
  validate: boolean;
}

export interface Engine {
  pipeline: TrustPipeline;
  thresholds: ThresholdsConfig;
  geo: GeoData;
  validator: IngestValidator | null;
}

const geoCache = new Map<string, GeoData>();

export function makeEngine(cfg: RunConfig): Engine {
  const fusion = loadFusion(cfg.fusion);
  const thresholds = loadThresholds(cfg.thresholds);
  const key = JSON.stringify(thresholds.geographic);
  let geo = geoCache.get(key);
  if (!geo) {
    geo = loadGeo(thresholds.geographic);
    geoCache.set(key, geo);
  }
  return {
    pipeline: new TrustPipeline(fusion, thresholds, geo),
    thresholds,
    geo,
    validator: cfg.validate
      ? new IngestValidator({
          staleAfterMs: (thresholds.validation?.ais_stale_after_s ?? 600) * 1000,
          maxFutureSkewMs: (thresholds.validation?.max_future_skew_s ?? 30) * 1000,
        })
      : null,
  };
}

export interface Processed {
  event: PositionEvent;
  /** Processing time (original report time; validator "now"). */
  now: number;
  accepted: boolean;
  rejectCode?: string;
  trust?: TrustAssessment;
}

/**
 * Feed events (already in processing order) through validator + pipeline.
 * `nowOf` gives the processing clock per event (defaults to its own timestamp).
 */
export function runEvents(
  engine: Engine,
  events: PositionEvent[],
  nowOf: (e: PositionEvent, i: number) => number = (e) => Date.parse(e.source_timestamp),
  onEach?: (p: Processed) => void,
): void {
  events.forEach((e, i) => {
    const now = nowOf(e, i);
    let ev = e;
    if (engine.validator) {
      const out = engine.validator.validate(e, new Date(now));
      if (!out.ok) {
        onEach?.({ event: e, now, accepted: false, rejectCode: out.code });
        return;
      }
      ev = out.event;
    }
    const state = engine.pipeline.process(ev, new Date(now).toISOString());
    onEach?.({ event: ev, now, accepted: true, trust: state.trust });
  });
}

export function isFlagged(t: TrustAssessment | undefined): boolean {
  return !!t && (t.trust_band === 'suspicious' || t.trust_band === 'critical');
}

export function inPort(geo: GeoData, lat: number, lon: number): boolean {
  return geo.ports.some((p) => pointInPolygon(lon, lat, p.geometry));
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
