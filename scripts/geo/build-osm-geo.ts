/**
 * P2.1 — build data/geo/land_osm_gof.geojson and data/geo/ports_v2.geojson from OSM.
 *
 * NOT run automatically: needs ~1 GB download and GDAL. Steps:
 *  1. Download land-polygons-split-4326.zip from
 *     https://osmdata.openstreetmap.de/data/land-polygons.html (ODbL) and unzip it
 *     somewhere outside the repo, e.g. ~/osm/land-polygons-split-4326/land_polygons.shp
 *  2. npx tsx scripts/geo/build-osm-geo.ts --land ~/osm/land-polygons-split-4326/land_polygons.shp
 *
 * Land: ogr2ogr clip to lon 22–31 E, lat 59–61 N, simplify ≤ 10 m (≈0.00009° lat;
 * we use 0.00008° to stay under 10 m at 60 N in both axes), islands kept.
 * Ports: Overpass API query for landuse=port, harbour=*, man_made=pier|quay polygons in
 * the same bbox; the script then checks that every required port is present and exits
 * non-zero if any is missing, so a partial file is never installed silently.
 * Writes data/geo/osm_provenance.json (source URL, download date, licence, tolerance).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const BBOX = { minLon: 22, minLat: 59, maxLon: 31, maxLat: 61 };
const TOL_DEG = 0.00008;
const REQUIRED_PORTS = [
  'Helsinki', 'Tallinn', 'Kotka', 'Hamina', 'Primorsk', 'Ust-Luga', 'Sillamäe',
  'Vuosaari', 'Sköldvik', 'Kilpilahti', 'Mussalo', 'Hanko', 'Inkoo', 'Loviisa', 'Muuga',
  'Paldiski', 'Kunda', 'Vysotsk', 'Saint Petersburg', 'Kronstadt',
];

const argv = process.argv.slice(2);
const landShp = argv.includes('--land') ? argv[argv.indexOf('--land') + 1] : undefined;

async function main(): Promise<void> {
  if (!landShp || !existsSync(landShp)) {
    console.error('Pass --land <path to land_polygons.shp> (see header for download).');
    process.exit(2);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'osm-geo-'));
  const landOut = join(ROOT, 'data/geo/land_osm_gof.geojson');
  execFileSync('ogr2ogr', [
    '-f', 'GeoJSON', '-t_srs', 'EPSG:4326',
    '-clipsrc', String(BBOX.minLon), String(BBOX.minLat), String(BBOX.maxLon), String(BBOX.maxLat),
    '-simplify', String(TOL_DEG),
    '-lco', 'COORDINATE_PRECISION=6',
    join(tmp, 'land.geojson'), landShp,
  ], { stdio: 'inherit' });
  writeFileSync(landOut, readFileSync(join(tmp, 'land.geojson')));

  const q = `[out:json][timeout:180];
(
  way["landuse"="port"](${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon});
  relation["landuse"="port"](${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon});
  way["harbour"](${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon});
  way["man_made"~"^(pier|quay)$"](${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon});
);
out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: q }),
    headers: { 'User-Agent': 'northstar-geo-build/1.0' },
  });
  if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
  const osm = (await res.json()) as {
    elements: Array<{ type: string; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }>;
  };
  const features = osm.elements
    .filter((e) => e.type === 'way' && e.geometry && e.geometry.length >= 4)
    .map((e) => {
      const ring = e.geometry!.map((g) => [g.lon, g.lat]);
      const [f, l] = [ring[0]!, ring[ring.length - 1]!];
      if (f[0] !== l[0] || f[1] !== l[1]) ring.push(f);
      return {
        type: 'Feature',
        id: `osm_way_${e.id}`,
        properties: { name: e.tags?.name ?? e.tags?.['name:en'] ?? '', ...e.tags },
        geometry: { type: 'Polygon', coordinates: [ring] },
      };
    });
  const names = features.map((f) => String(f.properties.name).toLowerCase()).join('|');
  const missing = REQUIRED_PORTS.filter((p) => !names.includes(p.toLowerCase()));
  const portsOut = join(ROOT, 'data/geo/ports_v2.geojson');
  writeFileSync(portsOut, JSON.stringify({ type: 'FeatureCollection', features }));
  writeFileSync(
    join(ROOT, 'data/geo/osm_provenance.json'),
    JSON.stringify(
      {
        land: { source: 'https://osmdata.openstreetmap.de/data/land-polygons.html', file: landShp, mtime: statSync(landShp).mtime },
        ports: { source: 'https://overpass-api.de (OSM)', query: q },
        built_at: new Date().toISOString(),
        licence: 'ODbL 1.0 — © OpenStreetMap contributors',
        bbox: BBOX,
        simplify_tolerance_deg: TOL_DEG,
        simplify_tolerance_m_approx: 9,
        ports_missing_by_name: missing,
      },
      null,
      2,
    ),
  );
  if (missing.length) {
    console.error(`Ports not found by name (check manually / add by area): ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`wrote ${landOut} and ${portsOut}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
