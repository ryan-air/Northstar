/**
 * False-positive / false-negative metrics on recorded Digitraffic AIS (kinematics only).
 * Writes data/fixtures/eval_metrics.json
 *
 *   npx tsx scripts/eval-real-ais.ts [--thresholds v1|v2] [--src <jsonl>]
 *
 * P5.1: now deduplicates on (MMSI, AIS timestamp), reads thresholds from config
 * (default v2), and reports `fail` and `warning-or-worse` separately. The original
 * fields (confusion / false_positive_rate / false_negative_rate — fail-or-hard only)
 * are kept with the same meaning. For full-pipeline numbers use npm run eval:pipeline.
 */
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKinematics, type KinematicsConfig, type KinematicsState } from '../packages/core/src/checks/kinematics.js';
import { loadThresholds } from '../apps/server/src/config.js';
import type { PositionEvent } from '../packages/contracts/src/events.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1]! : d);
// Default: the frozen eval snapshot (P0.2), never the growing live recording.
const REPLAY = join(ROOT, arg('--src', 'data/replay/snapshots/gof_ais.eval-v1.jsonl'));
const OUT = join(ROOT, 'data/fixtures/eval_metrics.json');
const THRESHOLDS = loadThresholds(arg('--thresholds', 'v2'));
const kinConfig: KinematicsConfig = {
  ...(THRESHOLDS.kinematics as KinematicsConfig),
  vessel_class_limits: THRESHOLDS.vessel_class_limits as KinematicsConfig['vessel_class_limits'],
};

/** Hard-coded config used before P5.1 — kept for reference only, no longer read. */
export const LEGACY_KIN_CONFIG = {
  min_dt_s: 0.5,
  max_dt_s: 120,
  uncertain_dt_skip: true,
  drift_cusum_threshold: 4,
  drift_cusum_slack_m: 20,
  vessel_class_limits: {
    cargo: { max_sog_kn: 28, max_accel_kn_s: 0.15, max_rot_deg_min: 20, max_jump_m: 800 },
    tanker: { max_sog_kn: 22, max_accel_kn_s: 0.1, max_rot_deg_min: 15, max_jump_m: 800 },
    passenger: { max_sog_kn: 32, max_accel_kn_s: 0.2, max_rot_deg_min: 25, max_jump_m: 800 },
    fishing: { max_sog_kn: 18, max_accel_kn_s: 0.25, max_rot_deg_min: 40, max_jump_m: 600 },
    tug: { max_sog_kn: 16, max_accel_kn_s: 0.3, max_rot_deg_min: 45, max_jump_m: 500 },
    pleasure: { max_sog_kn: 40, max_accel_kn_s: 0.4, max_rot_deg_min: 50, max_jump_m: 500 },
    other: { max_sog_kn: 30, max_accel_kn_s: 0.25, max_rot_deg_min: 30, max_jump_m: 800 },
  },
} as const;

function toEvent(mmsi: number, s: {
  lat: number;
  lon: number;
  sog?: number | null;
  cog?: number | null;
  captured_at?: string;
  timestamp_external_ms?: number;
}): PositionEvent {
  const ts = s.timestamp_external_ms
    ? new Date(s.timestamp_external_ms).toISOString()
    : (s.captured_at ?? new Date().toISOString());
  return {
    schema_version: 1,
    entity_id: `LAB-${mmsi}`,
    entity_type: 'vessel',
    vessel_class: 'other',
    position: { lat: s.lat, lon: s.lon, crs: 'EPSG:4326' },
    speed_over_ground_knots: typeof s.sog === 'number' ? s.sog : null,
    course_over_ground_deg: typeof s.cog === 'number' ? s.cog : null,
    source: 'ais_provider_a',
    provider_id: 'digitraffic_historical',
    source_timestamp: ts,
    ingested_at: ts,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 50, signal_quality_available: false },
  };
}

async function main() {
  const byMmsi = new Map<number, Array<ReturnType<typeof Object.assign>>>();
  const rl = createInterface({ input: createReadStream(REPLAY), crlfDelay: Infinity });
  let n = 0;
  let dupDropped = 0;
  const seen = new Set<string>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as {
        mmsi: number;
        lat: number;
        lon: number;
        sog?: number;
        cog?: number;
        captured_at?: string;
        timestamp_external_ms?: number;
      };
      if (!Number.isFinite(s.mmsi) || !Number.isFinite(s.lat)) continue;
      const key = `${s.mmsi}:${s.timestamp_external_ms ?? `cap:${s.captured_at}`}`;
      if (seen.has(key)) {
        dupDropped += 1;
        continue;
      }
      seen.add(key);
      const arr = byMmsi.get(s.mmsi) ?? [];
      arr.push(s);
      byMmsi.set(s.mmsi, arr);
      n += 1;
    } catch {
      /* skip */
    }
  }

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let warnOrWorse = 0;
  let warnOnly = 0;
  let failOnly = 0;

  for (const [mmsi, unsorted] of byMmsi) {
    if (unsorted.length < 5) continue;
    const t = (x: { timestamp_external_ms?: number; captured_at?: string }) =>
      x.timestamp_external_ms ?? Date.parse(x.captured_at ?? '');
    const samples = [...unsorted].sort((a, b) => t(a) - t(b));
    let state: KinematicsState = { cusum: 0 };
    let prev: PositionEvent | null = null;
    for (let i = 0; i < samples.length; i++) {
      const cur = toEvent(mmsi, samples[i]!);
      const { result, state: next } = checkKinematics(
        cur,
        prev,
        state,
        kinConfig as never,
        cur.ingested_at,
      );
      state = next;
      const flagged = result.status === 'fail' || !!result.hard_alert;
      // Nominal samples are negatives
      if (flagged) fp += 1;
      else tn += 1;
      if (result.status === 'warning') warnOnly += 1;
      if (result.status === 'fail') failOnly += 1;
      if (result.status === 'warning' || result.status === 'fail') warnOrWorse += 1;
      prev = cur;
    }

    // Inject a teleport as a positive
    const last = samples[samples.length - 1]!;
    const spoof = toEvent(mmsi, {
      ...last,
      lat: 60.32,
      lon: 24.95,
      timestamp_external_ms:
        (last.timestamp_external_ms ?? Date.parse(last.captured_at ?? '')) + 30_000,
    });
    const prevEv = toEvent(mmsi, last);
    const { result } = checkKinematics(
      spoof,
      prevEv,
      { cusum: 0 },
      kinConfig as never,
      spoof.ingested_at,
    );
    if (result.status === 'fail' || result.hard_alert) tp += 1;
    else fn += 1;
  }

  const nominal = fp + tn;
  const metrics = {
    generated_at: new Date().toISOString(),
    source: REPLAY.replace(ROOT + '/', ''),
    thresholds_version: THRESHOLDS.version,
    rows_used: n,
    duplicate_rows_dropped: dupDropped,
    vessels_sampled: byMmsi.size,
    nominal_events: nominal,
    kinematics_rate_pct: {
      warning: nominal ? Math.round((1000 * warnOnly) / nominal) / 10 : null,
      fail: nominal ? Math.round((1000 * failOnly) / nominal) / 10 : null,
      warning_or_worse: nominal ? Math.round((1000 * warnOrWorse) / nominal) / 10 : null,
    },
    superseded_note:
      'Pre-P5.1 runs (FPR 0.29%) counted only fail/hard on the first 40 raw rows per vessel with duplicates and a hard-coded config; warnings were not counted. See EVALUATION.md.',
    confusion: { tp, fp, tn, fn },
    false_positive_rate: fp + tn > 0 ? fp / (fp + tn) : null,
    false_negative_rate: tp + fn > 0 ? fn / (tp + fn) : null,
    note: 'FP/TN from nominal consecutive AIS pairs; TP/FN from inland teleport injection.',
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
