import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLandIndex, type LandIndex, type PolygonFeature } from '@northstar/core';
import { REPO_ROOT } from '../config.js';

interface FC {
  type: 'FeatureCollection';
  /** Set by scripts/geo/build_osm_geo.py when land is cut on a grid. */
  seam_grid_deg?: number;
  features: Array<{
    type: 'Feature';
    id?: string;
    properties?: Record<string, unknown>;
    geometry: PolygonFeature | { type: string; coordinates: unknown };
  }>;
}

export interface GeoData {
  land: LandIndex;
  ports: Array<{ id: string; geometry: PolygonFeature; name?: string }>;
  restricted: Array<{ id: string; geometry: PolygonFeature; name?: string }>;
  landGeoJson: FC;
  portsGeoJson: FC;
  lanesGeoJson: FC;
  restrictedGeoJson: FC;
  /** Which files were actually loaded (v2 files fall back to v1 if absent). */
  datasets: { land: string; ports: string; land_is_fallback: boolean; ports_is_fallback: boolean };
}

export interface LoadGeoOptions {
  land_file?: string;
  ports_file?: string;
  fallback_land_file?: string;
  fallback_ports_file?: string;
}

function pick(preferred: string | undefined, fallback: string): { name: string; fallback: boolean } {
  if (preferred && existsSync(join(REPO_ROOT, 'data/geo', preferred))) {
    return { name: preferred, fallback: false };
  }
  return { name: fallback, fallback: !!preferred };
}

function loadFC(name: string): FC {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'data/geo', name), 'utf8')) as FC;
}

export function loadGeo(opts: LoadGeoOptions = {}): GeoData {
  const landPick = pick(opts.land_file, opts.fallback_land_file ?? 'land.geojson');
  const portsPick = pick(opts.ports_file, opts.fallback_ports_file ?? 'ports.geojson');
  if (landPick.fallback || portsPick.fallback) {
    console.warn(
      `[northstar] geo v2 dataset missing (${[landPick.fallback ? opts.land_file : null, portsPick.fallback ? opts.ports_file : null].filter(Boolean).join(', ')}) — falling back to simplified v1 polygons. Run scripts/geo/build-osm-geo.ts.`,
    );
  }
  const landGeoJson = loadFC(landPick.name);
  const portsGeoJson = loadFC(portsPick.name);
  const lanesGeoJson = loadFC('lanes.geojson');
  const restrictedGeoJson = loadFC('restricted.geojson');

  const landFeatures = landGeoJson.features
    .filter((f) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
    .map((f, i) => ({
      id: String(f.id ?? f.properties?.name ?? `land_${i}`),
      geometry: f.geometry as PolygonFeature,
    }));

  const ports = portsGeoJson.features.map((f, i) => ({
    id: String(f.id ?? `port_${i}`),
    name: String(f.properties?.name ?? ''),
    geometry: f.geometry as PolygonFeature,
  }));

  const restricted = restrictedGeoJson.features.map((f, i) => ({
    id: String(f.id ?? `restricted_${i}`),
    name: String(f.properties?.name ?? ''),
    geometry: f.geometry as PolygonFeature,
  }));

  return {
    land: buildLandIndex(landFeatures, { seamGridDeg: landGeoJson.seam_grid_deg }),
    ports,
    restricted,
    landGeoJson,
    portsGeoJson,
    lanesGeoJson,
    restrictedGeoJson,
    datasets: {
      land: landPick.name,
      ports: portsPick.name,
      land_is_fallback: landPick.fallback,
      ports_is_fallback: portsPick.fallback,
    },
  };
}
