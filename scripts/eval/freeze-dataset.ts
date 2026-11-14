/**
 * P0.2 — freeze the evaluation dataset.
 *
 * Reads the (growing) recording, removes re-polled duplicates on
 * (MMSI, timestamp_external_ms), and writes an immutable snapshot plus a manifest
 * with row count, SHA-256 and time span. Refuses to overwrite an existing snapshot
 * unless --force is passed, so the eval set cannot drift silently.
 *
 *   npx tsx scripts/eval/freeze-dataset.ts [--src data/replay/gof_ais.jsonl] [--name eval-v1] [--force]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const src = resolve(ROOT, arg('--src', 'data/replay/gof_ais.jsonl')!);
const name = arg('--name', 'eval-v1')!;
const force = process.argv.includes('--force');
const outDir = join(ROOT, 'data/replay/snapshots');
const outFile = join(outDir, `gof_ais.${name}.jsonl`);
const manFile = join(outDir, `gof_ais.${name}.manifest.json`);

if (existsSync(outFile) && !force) {
  console.error(`${outFile} exists — snapshots are immutable. Use --name eval-v2 or --force.`);
  process.exit(1);
}

const raw = readFileSync(src, 'utf8');
const srcSha = createHash('sha256').update(raw).digest('hex');
const seen = new Set<string>();
const kept: string[] = [];
let total = 0;
let malformed = 0;
let dup = 0;
let tMin = Infinity;
let tMax = -Infinity;
const mmsis = new Set<number>();
const perDay: Record<string, number> = {};
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  total++;
  let r: { mmsi: number; timestamp_external_ms: number | null; captured_at: string };
  try {
    r = JSON.parse(line);
  } catch {
    malformed++;
    continue;
  }
  const key = `${r.mmsi}:${r.timestamp_external_ms ?? `cap:${r.captured_at}`}`;
  if (seen.has(key)) {
    dup++;
    continue;
  }
  seen.add(key);
  kept.push(JSON.stringify(r));
  mmsis.add(r.mmsi);
  const t = r.timestamp_external_ms ?? Date.parse(r.captured_at);
  if (Number.isFinite(t)) {
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
    const day = new Date(t).toISOString().slice(0, 10);
    perDay[day] = (perDay[day] ?? 0) + 1;
  }
}
const body = kept.join('\n') + '\n';
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, body);
const manifest = {
  name: `gof_ais.${name}`,
  frozen_at: new Date().toISOString(),
  source_file: src.replace(ROOT + '/', ''),
  source_rows: total,
  source_sha256: srcSha,
  malformed_rows_dropped: malformed,
  duplicate_rows_dropped: dup,
  dedup_key: '(mmsi, timestamp_external_ms)',
  rows: kept.length,
  unique_mmsi: mmsis.size,
  sha256: createHash('sha256').update(body).digest('hex'),
  time_span: { start: new Date(tMin).toISOString(), end: new Date(tMax).toISOString() },
  rows_per_utc_day: perDay,
  splits: {
    calibration: { utc_days: ['2026-11-12'], purpose: 'threshold tuning only' },
    test: { utc_days: ['2026-11-13', '2026-11-14'], purpose: 'held out — report only' },
  },
  licence: 'CC BY 4.0 Fintraffic Digitraffic',
  note: 'Immutable. Harness and e2e tests read this file, never the live recording.',
};
writeFileSync(manFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
