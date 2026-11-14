/**
 * P5.3 — CI gates. Fails (exit 1) if harness FPR or recall moves past the fixed
 * tolerances in config/eval_gates.json. Reads data/fixtures/eval_pipeline_metrics.json
 * (or --metrics <path>).
 *
 *   npm run eval:gates
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const mPath = argv.includes('--metrics') ? argv[argv.indexOf('--metrics') + 1]! : 'data/fixtures/eval_pipeline_metrics.json';
const metrics = JSON.parse(readFileSync(mPath.startsWith('/') ? mPath : join(ROOT, mPath), 'utf8'));
const gates = JSON.parse(readFileSync(join(ROOT, 'config/eval_gates.json'), 'utf8')) as {
  config: string;
  split: string;
  max: Record<string, number>;
  min_recall_pct: Record<string, number>;
};

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

const failures: string[] = [];
const report: string[] = [];
const clean = metrics.clean?.[gates.config]?.splits?.[gates.split];
if (!clean) failures.push(`no clean metrics for ${gates.config}/${gates.split}`);
for (const [path, limit] of Object.entries(gates.max)) {
  const v = get(clean, path);
  if (typeof v !== 'number') {
    failures.push(`${path}: missing`);
    continue;
  }
  report.push(`${v <= limit ? 'ok  ' : 'FAIL'} ${path} = ${v} (max ${limit})`);
  if (v > limit) failures.push(`${path} = ${v} > ${limit}`);
}
const attacks = metrics.attacks?.[gates.config]?.[gates.split]?.attacks ?? {};
for (const [id, min] of Object.entries(gates.min_recall_pct)) {
  const v = attacks[id]?.recall_pct;
  if (typeof v !== 'number') {
    failures.push(`${id}: recall missing`);
    continue;
  }
  report.push(`${v >= min ? 'ok  ' : 'FAIL'} recall ${id} = ${v}% (min ${min}%)`);
  if (v < min) failures.push(`recall ${id} = ${v}% < ${min}%`);
}
console.log(report.join('\n'));
if (failures.length) {
  console.error(`\n${failures.length} gate(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nall eval gates passed');
