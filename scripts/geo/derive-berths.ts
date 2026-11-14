/**
 * Derive observed berthing areas from AIS: where ships actually lie moored. Fills gaps in
 * OSM port coverage (few landuse=port areas, nothing at Kunda) with data, not hand-drawing.
 *
 *   npx tsx scripts/geo/derive-berths.ts [--snapshot data/replay/snapshots/gof_ais.eval-v1.jsonl]
 *        [--day 2026-11-12] [--cell 0.002] [--min-vessels 2] [--out data/geo/berths_ais.geojson]
 *
 * Uses ONLY the calibration day by default, so the held-out evaluation is not tuned on itself.
 * A cell (default 0.002° ≈ 220 m N–S × 110 m E–W at 60° N) becomes a berth cell when at least
 * `min-vessels` distinct MMSIs report there with SOG < 0.3 kn and nav status moored (5) or
 * at anchor (1) or SOG = 0. Neighbouring cells are grouped; each group is one feature.
 *
 * Not wired into the geographic check yet. On eval-v1 (60 km around Helsinki) it finds only
 * ~15 areas, all near Helsinki/Tallinn and already covered by OSM quays. Re-run it on the
 * whole-gulf stream recording (npm run record:stream) to cover Kotka, Hamina, Kunda etc.:
 *   npx tsx scripts/geo/derive-berths.ts --snapshot .northstar/data/replay/gof_ais_stream.jsonl --day <date>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const abs = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));
const SNAP = abs(arg('snapshot', 'data/replay/snapshots/gof_ais.eval-v1.jsonl'));
const DAY = arg('day', '2026-11-12');
const CELL = Number(arg('cell', '0.002'));
const MIN_V = Number(arg('min-vessels', '2'));
const OUT = abs(arg('out', 'data/geo/berths_ais.geojson'));

interface Row {
  mmsi: number;
  lat: number;
  lon: number;
  sog: number | null;
  navStat?: number | null;
  timestamp_external_ms: number | null;
}

function main(): void {
  const cells = new Map<string, Set<number>>();
  let used = 0;
  for (const line of readFileSync(SNAP, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Row;
    if (r.timestamp_external_ms == null) continue;
    if (new Date(r.timestamp_external_ms).toISOString().slice(0, 10) !== DAY) continue;
    const still = typeof r.sog === 'number' && r.sog < 0.3;
    const moored = r.navStat === 5 || r.navStat === 1 || r.sog === 0;
    if (!still || !moored) continue;
    if (String(r.mmsi).startsWith('99') || String(r.mmsi).startsWith('00')) continue; // AtoN / base stations
    const k = `${Math.floor(r.lon / CELL)},${Math.floor(r.lat / CELL)}`;
    const s = cells.get(k) ?? new Set<number>();
    s.add(r.mmsi);
    cells.set(k, s);
    used++;
  }
  const berth = new Set([...cells].filter(([, s]) => s.size >= MIN_V).map(([k]) => k));
  // group 8-connected cells
  const seen = new Set<string>();
  const features: unknown[] = [];
  for (const start of berth) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop()!;
      group.push(k);
      const [x, y] = k.split(',').map(Number) as [number, number];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const n = `${x + dx},${y + dy}`;
          if (berth.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
    }
    const vessels = new Set<number>();
    const polys = group.map((k) => {
      cells.get(k)!.forEach((m) => vessels.add(m));
      const [x, y] = k.split(',').map(Number) as [number, number];
      const r = (v: number) => Math.round(v * 1e6) / 1e6;
      const [x0, y0, x1, y1] = [r(x * CELL), r(y * CELL), r((x + 1) * CELL), r((y + 1) * CELL)];
      return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
    });
    features.push({
      type: 'Feature',
      id: `ais_berth_${features.length}`,
      properties: { name: '', source: 'ais_observed_berth', cells: group.length, vessels: vessels.size, day: DAY },
      geometry: { type: 'MultiPolygon', coordinates: polys },
    });
  }
  writeFileSync(
    OUT,
    JSON.stringify({
      type: 'FeatureCollection',
      provenance: {
        method: 'cells with ≥N distinct moored/anchored vessels (SOG<0.3 kn)',
        snapshot: SNAP.replace(ROOT + '/', ''),
        day: DAY,
        cell_deg: CELL,
        min_vessels: MIN_V,
        licence: 'derived from Digitraffic AIS, CC BY 4.0',
      },
      features,
    }),
  );
  console.log(`[berths] ${used} still reports on ${DAY} → ${berth.size} cells in ${features.length} areas → ${OUT}`);
}

main();
