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

export interface LandQueryOptions {
  /**
   * 'vertex' (default, v1): distance to the nearest polygon vertex — overestimates
   * inland depth on long straight coast segments.
   * 'edge' (v2): true point-to-segment distance to the polygon boundary.
   */
  distance?: 'vertex' | 'edge';
}

export interface LandIndex {
  query(
    lon: number,
    lat: number,
    opts?: LandQueryOptions,
  ): { onLand: boolean; inlandDepthM: number; featureId: string | null; shoreDistM?: number };
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

/**
 * Point-to-segment distance (m) to the polygon boundary, using a local
 * equirectangular projection around the query point (accurate to <0.5% at the
 * sub-10-km scales this is used for).
 */
export function nearestEdgeDistM(lon: number, lat: number, feature: PolygonFeature): number {
  const rings: LonLat[][] =
    feature.type === 'Polygon'
      ? (feature.coordinates as LonLat[][])
      : (feature.coordinates as LonLat[][][]).flat();
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  let min = Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [x1, y1] = ring[i - 1]!;
      const [x2, y2] = ring[i]!;
      const ax = (x1 - lon) * mPerDegLon;
      const ay = (y1 - lat) * mPerDegLat;
      const bx = (x2 - lon) * mPerDegLon;
      const by = (y2 - lat) * mPerDegLat;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = Math.hypot(px, py);
      if (d < min) min = d;
    }
  }
  return Number.isFinite(min) ? min : 0;
}

export interface BuildLandIndexOptions {
  /**
   * When land was cut on a regular grid (to keep polygons small), edges lying on grid
   * lines are artificial seams, not coastline. They are excluded from shore distance,
   * which is then measured against a global coastline-segment index.
   */
  seamGridDeg?: number;
}

interface SegItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function onGridLine(v: number, grid: number): boolean {
  const k = Math.round(v / grid);
  return Math.abs(v - k * grid) < 1e-7;
}

function segDistM(lon: number, lat: number, s: SegItem): number {
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ax = (s.x1 - lon) * mPerDegLon;
  const ay = (s.y1 - lat) * mPerDegLat;
  const bx = (s.x2 - lon) * mPerDegLon;
  const by = (s.y2 - lat) * mPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function buildLandIndex(
  features: Array<{ id: string; geometry: PolygonFeature }>,
  opts: BuildLandIndexOptions = {},
): LandIndex {
  const tree = new RBush<LandItem>();
  const items: LandItem[] = features.map((f) => {
    const b = bboxOf(f.geometry);
    return { ...b, feature: f.geometry, id: f.id };
  });
  tree.load(items);

  // Optional coastline-segment index (grid-cut land): seams excluded.
  let segTree: RBush<SegItem> | null = null;
  if (opts.seamGridDeg) {
    const g = opts.seamGridDeg;
    const segs: SegItem[] = [];
    for (const f of features) {
      const rings: LonLat[][] =
        f.geometry.type === 'Polygon'
          ? (f.geometry.coordinates as LonLat[][])
          : (f.geometry.coordinates as LonLat[][][]).flat();
      for (const ring of rings) {
        for (let i = 1; i < ring.length; i++) {
          const [x1, y1] = ring[i - 1]!;
          const [x2, y2] = ring[i]!;
          const seam =
            (onGridLine(x1, g) && onGridLine(x2, g) && Math.abs(x1 - x2) < 1e-7) ||
            (onGridLine(y1, g) && onGridLine(y2, g) && Math.abs(y1 - y2) < 1e-7);
          if (seam) continue;
          segs.push({
            minX: Math.min(x1, x2),
            minY: Math.min(y1, y2),
            maxX: Math.max(x1, x2),
            maxY: Math.max(y1, y2),
            x1,
            y1,
            x2,
            y2,
          });
        }
      }
    }
    segTree = new RBush<SegItem>();
    segTree.load(segs);
  }
  const coastDistM = (lon: number, lat: number): number => {
    if (!segTree) return Infinity;
    // Expanding search: 0.01° (~0.6–1.1 km) up to 0.32°.
    for (let pad = 0.01; pad <= 0.32; pad *= 2) {
      const near = segTree.search({ minX: lon - pad, minY: lat - pad / 2, maxX: lon + pad, maxY: lat + pad / 2 });
      if (near.length === 0) continue;
      let best = Infinity;
      for (const sgm of near) best = Math.min(best, segDistM(lon, lat, sgm));
      // Only trust the result if it is inside the searched box's inscribed radius.
      if (best <= pad * 0.5 * 111_320 * 0.95) return best;
    }
    return Infinity;
  };

  return {
    size: () => items.length,
    query(lon, lat, qopts = {}) {
      const distFn =
        qopts.distance === 'edge'
          ? segTree
            ? (x: number, y: number) => coastDistM(x, y)
            : nearestEdgeDistM
          : nearestVertexDistM;
      const hits = tree.search({ minX: lon, minY: lat, maxX: lon, maxY: lat });
      for (const hit of hits) {
        if (pointInPolygon(lon, lat, hit.feature)) {
          return {
            onLand: true,
            inlandDepthM: (distFn as (x: number, y: number, f: PolygonFeature) => number)(lon, lat, hit.feature),
            featureId: hit.id,
          };
        }
      }
      if (qopts.distance === 'edge') {
        // v2: report distance to shore for water points (edge distance, small pad only).
        let shore = segTree ? coastDistM(lon, lat) : Infinity;
        if (!segTree) {
          const pad = 0.05;
          const near = tree.search({ minX: lon - pad, minY: lat - pad, maxX: lon + pad, maxY: lat + pad });
          for (const hit of near) shore = Math.min(shore, nearestEdgeDistM(lon, lat, hit.feature));
        }
        return {
          onLand: false,
          inlandDepthM: 0,
          featureId: null,
          shoreDistM: Number.isFinite(shore) ? shore : undefined,
        };
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
