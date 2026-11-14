/**
 * False-positive / false-negative metrics on recorded Digitraffic AIS.
 * Writes data/fixtures/eval_metrics.json
 *
 *   npx tsx scripts/eval-real-ais.ts
 */
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKinematics, type KinematicsState } from '../packages/core/src/checks/kinematics.js';
import type { PositionEvent } from '../packages/contracts/src/events.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPLAY = join(ROOT, 'data/replay/gof_ais.jsonl');
const OUT = join(ROOT, 'data/fixtures/eval_metrics.json');

const kinConfig = {
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
      const arr = byMmsi.get(s.mmsi) ?? [];
      if (arr.length < 40) {
        arr.push(s);
        byMmsi.set(s.mmsi, arr);
      }
      n += 1;
      if (n > 80_000) break;
    } catch {
      /* skip */
    }
  }

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (const [mmsi, samples] of byMmsi) {
    if (samples.length < 5) continue;
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

  const metrics = {
    generated_at: new Date().toISOString(),
    source: 'data/replay/gof_ais.jsonl',
    vessels_sampled: byMmsi.size,
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
