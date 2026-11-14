/**
 * Snapshot Digitraffic /vessels metadata (shipType, reference points A–D, draught,
 * posType, call sign, IMO) for the MMSIs in a frozen dataset, so the harness runs
 * offline and deterministically. Writes data/replay/snapshots/vessel_meta.<name>.json.
 *
 *   npx tsx scripts/eval/fetch-vessel-meta.ts [--name eval-v1]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const i = process.argv.indexOf('--name');
const name = i >= 0 ? process.argv[i + 1]! : 'eval-v1';
const snap = join(ROOT, `data/replay/snapshots/gof_ais.${name}.jsonl`);
const mmsis = new Set<number>();
for (const line of readFileSync(snap, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  mmsis.add((JSON.parse(line) as { mmsi: number }).mmsi);
}
async function main(): Promise<void> {
const res = await fetch('https://meri.digitraffic.fi/api/ais/v1/vessels', {
  headers: { 'Digitraffic-User': 'Northstar/1.0', Accept: 'application/json', 'Accept-Encoding': 'gzip' },
});
if (!res.ok) throw new Error(`vessels HTTP ${res.status}`);
const list = (await res.json()) as Array<Record<string, unknown> & { mmsi: number }>;
const keep = [
  'mmsi', 'name', 'shipType', 'callSign', 'imo', 'destination', 'draught', 'posType',
  'referencePointA', 'referencePointB', 'referencePointC', 'referencePointD', 'timestamp',
];
const out: Record<string, Record<string, unknown>> = {};
for (const v of list) {
  if (!mmsis.has(v.mmsi)) continue;
  out[String(v.mmsi)] = Object.fromEntries(keep.filter((k) => k in v).map((k) => [k, v[k]]));
}
const file = join(ROOT, `data/replay/snapshots/vessel_meta.${name}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      fetched_at: new Date().toISOString(),
      source: 'https://meri.digitraffic.fi/api/ais/v1/vessels',
      licence: 'CC BY 4.0 Fintraffic Digitraffic',
      note: 'Metadata as of fetch time, not as of each report (static data can change).',
      requested_mmsi: mmsis.size,
      matched_mmsi: Object.keys(out).length,
      vessels: out,
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${file}: ${Object.keys(out).length}/${mmsis.size} MMSIs matched`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
