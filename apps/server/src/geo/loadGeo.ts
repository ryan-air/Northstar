import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLandIndex, type LandIndex, type PolygonFeature } from '@northstar/core';
import { REPO_ROOT } from '../config.js';

interface FC {
  type: 'FeatureCollection';
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
}

function loadFC(name: string): FC {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'data/geo', name), 'utf8')) as FC;
}

export function loadGeo(): GeoData {
  const landGeoJson = loadFC('land.geojson');
  const portsGeoJson = loadFC('ports.geojson');
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
    land: buildLandIndex(landFeatures),
    ports,
    restricted,
    landGeoJson,
    portsGeoJson,
    lanesGeoJson,
    restrictedGeoJson,
  };
}
