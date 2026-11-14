import RBush from 'rbush';
import { pointInPolygon, type PolygonFeature, type LonLat } from './pointInPolygon.js';
import { haversineM } from './haversine.js';

export interface LandItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  feature: PolygonFeature;
  id: string;
}

export interface LandIndex {
  query(lon: number, lat: number): { onLand: boolean; inlandDepthM: number; featureId: string | null };
  size(): number;
}

function bboxOf(feature: PolygonFeature): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const rings: LonLat[][] =
    feature.type === 'Polygon'
      ? (feature.coordinates as LonLat[][])
      : (feature.coordinates as LonLat[][][]).flat();
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function nearestVertexDistM(lon: number, lat: number, feature: PolygonFeature): number {
  let min = Infinity;
  const rings: LonLat[][] =
    feature.type === 'Polygon'
      ? (feature.coordinates as LonLat[][])
      : (feature.coordinates as LonLat[][][]).flat();
  for (const ring of rings) {
    for (const [x, y] of ring) {
      const d = haversineM(lat, lon, y, x);
      if (d < min) min = d;
    }
  }
  return Number.isFinite(min) ? min : 0;
}

export function buildLandIndex(
  features: Array<{ id: string; geometry: PolygonFeature }>,
): LandIndex {
  const tree = new RBush<LandItem>();
  const items: LandItem[] = features.map((f) => {
    const b = bboxOf(f.geometry);
    return { ...b, feature: f.geometry, id: f.id };
  });
  tree.load(items);

  return {
    size: () => items.length,
    query(lon, lat) {
      const hits = tree.search({ minX: lon, minY: lat, maxX: lon, maxY: lat });
      for (const hit of hits) {
        if (pointInPolygon(lon, lat, hit.feature)) {
          return {
            onLand: true,
            inlandDepthM: nearestVertexDistM(lon, lat, hit.feature),
            featureId: hit.id,
          };
        }
      }
      // Not on land — distance to nearest land vertex among nearby candidates
      const pad = 0.5; // degrees ~ search neighborhood
      const near = tree.search({
        minX: lon - pad,
        minY: lat - pad,
        maxX: lon + pad,
        maxY: lat + pad,
      });
      let shore = Infinity;
      for (const hit of near) {
        const d = nearestVertexDistM(lon, lat, hit.feature);
        if (d < shore) shore = d;
      }
      return {
        onLand: false,
        inlandDepthM: 0,
        featureId: null,
      };
    },
  };
}
