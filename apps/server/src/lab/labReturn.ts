/**
 * Loader for an imported lab return (scripts/lab/import_lab_return.py → data/lab/<id>/).
 *
 * Read-only: parses the normalised files and validates every row against the contracts.
 * Rows that fail validation are counted and dropped, never coerced. Nothing here is wired
 * into the Lab tick by default; select a return with NORTHSTAR_LAB_RETURN=<id>.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GnssDiagnosticsSchema, ImuSampleSchema } from '@northstar/contracts';
import type { GnssDiagnostics, ImuSample } from '@northstar/contracts';
import type { ReplayRecord } from '../replay/types.js';

export interface OnboardFix {
  observation_time: string;
  lat: number;
  lon: number;
  sog_kn: number | null;
  cog_deg: number | null;
  heading_deg: number | null;
  h_acc_m: number | null;
}

export interface LabReturnItem {
  unlocks: string;
  passing: number;
  of: number;
  ready: boolean;
}

export interface LabReturn {
  id: string;
  dir: string;
  vesselMmsi: string | null;
  window: [string | null, string | null];
  items: Record<string, LabReturnItem>;
  issues: string[];
  secretsFound: number;
  secondaryAis: ReplayRecord[];
  gnss: GnssDiagnostics[];
  imu: ImuSample[];
  onboard: OnboardFix[];
  rejected: Record<string, number>;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      out.push(null);
    }
  }
  return out;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function validSecondary(r: unknown): r is ReplayRecord {
  const x = r as Partial<ReplayRecord> | null;
  return (
    !!x &&
    Number.isInteger(x.mmsi) &&
    finite(x.lat) &&
    finite(x.lon) &&
    Math.abs(x.lat) <= 90 &&
    Math.abs(x.lon) <= 180 &&
    finite(x.timestamp_external_ms) &&
    typeof x.captured_at === 'string' &&
    !Number.isNaN(Date.parse(x.captured_at))
  );
}

function validOnboard(r: unknown): r is OnboardFix {
  const x = r as Partial<OnboardFix> | null;
  return (
    !!x &&
    typeof x.observation_time === 'string' &&
    !Number.isNaN(Date.parse(x.observation_time)) &&
    finite(x.lat) &&
    finite(x.lon) &&
    Math.abs(x.lat) <= 90 &&
    Math.abs(x.lon) <= 180
  );
}

/** Return ids under `labRoot` that have a readiness.json, newest name last. */
export function listLabReturns(labRoot: string): string[] {
  if (!existsSync(labRoot)) return [];
  return readdirSync(labRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(labRoot, d.name, 'readiness.json')))
    .map((d) => d.name)
    .sort();
}

export function loadLabReturn(labRoot: string, id: string): LabReturn | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || id.includes('..')) return null;
  const dir = join(labRoot, id);
  const readinessPath = join(dir, 'readiness.json');
  if (!existsSync(readinessPath)) return null;
  const rep = JSON.parse(readFileSync(readinessPath, 'utf8')) as {
    vessel_mmsi?: string | null;
    window?: [string | null, string | null];
    items?: Record<string, LabReturnItem>;
    cross_check_issues?: string[];
    secrets_found?: unknown[];
  };
  const rejected: Record<string, number> = {};
  const keep = <T>(name: string, rows: unknown[], ok: (r: unknown) => T | null): T[] => {
    const out: T[] = [];
    for (const r of rows) {
      const v = ok(r);
      if (v) out.push(v);
      else rejected[name] = (rejected[name] ?? 0) + 1;
    }
    return out;
  };
  const secondaryAis = keep('ais_secondary', readJsonl(join(dir, 'ais_secondary.jsonl')), (r) =>
    validSecondary(r) ? { ...r, source: 'lab_secondary' } : null,
  ).sort((a, b) => (a.timestamp_external_ms ?? 0) - (b.timestamp_external_ms ?? 0));
  const gnss = keep('gnss', readJsonl(join(dir, 'gnss_recorded.jsonl')), (r) => {
    const p = GnssDiagnosticsSchema.safeParse(r);
    return p.success ? p.data : null;
  }).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const imu = keep('imu', readJsonl(join(dir, 'imu.jsonl')), (r) => {
    const p = ImuSampleSchema.safeParse(r);
    return p.success ? p.data : null;
  }).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const onboard = keep('onboard', readJsonl(join(dir, 'onboard_track.jsonl')), (r) =>
    validOnboard(r) ? r : null,
  ).sort((a, b) => a.observation_time.localeCompare(b.observation_time));
  return {
    id,
    dir,
    vesselMmsi: rep.vessel_mmsi ?? null,
    window: rep.window ?? [null, null],
    items: rep.items ?? {},
    issues: rep.cross_check_issues ?? [],
    secretsFound: rep.secrets_found?.length ?? 0,
    secondaryAis,
    gnss,
    imu,
    onboard,
    rejected,
  };
}

/** Latest sample at or before `iso` within `maxAgeMs` (binary search on a sorted series). */
export function sampleAt<T>(series: T[], timeOf: (t: T) => string, iso: string, maxAgeMs: number): T | null {
  const target = Date.parse(iso);
  let lo = 0;
  let hi = series.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(timeOf(series[mid]!)) <= target) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  const s = series[best]!;
  return target - Date.parse(timeOf(s)) <= maxAgeMs ? s : null;
}

/** Summary safe to expose over the API (no raw rows). */
export function labReturnSummary(r: LabReturn) {
  return {
    id: r.id,
    vessel_mmsi: r.vesselMmsi,
    window: r.window,
    items: r.items,
    issues: r.issues,
    secrets_found: r.secretsFound,
    counts: {
      secondary_ais: r.secondaryAis.length,
      gnss_snapshots: r.gnss.length,
      imu_samples: r.imu.length,
      onboard_fixes: r.onboard.length,
    },
    rejected: r.rejected,
  };
}
