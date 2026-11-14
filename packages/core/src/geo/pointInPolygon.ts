export type LonLat = [number, number]; // [lon, lat]

/** Ray-casting point-in-ring. Ring is closed or open GeoJSON-style [lon,lat][]. */
export function pointInRing(lon: number, lat: number, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export interface PolygonFeature {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: LonLat[][] | LonLat[][][];
  properties?: Record<string, unknown>;
}

export function pointInPolygon(lon: number, lat: number, feature: PolygonFeature): boolean {
  if (feature.type === 'Polygon') {
    const rings = feature.coordinates as LonLat[][];
    if (!rings[0] || !pointInRing(lon, lat, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lon, lat, rings[h]!)) return false; // hole
    }
    return true;
  }
  const polys = feature.coordinates as LonLat[][][];
  return polys.some((rings) => {
    if (!rings[0] || !pointInRing(lon, lat, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lon, lat, rings[h]!)) return false;
    }
    return true;
  });
}

/** Approximate distance from point to polygon exterior in metres (grid search near edge). */
export function approxDistanceToPolygonM(
  lon: number,
  lat: number,
  feature: PolygonFeature,
  inside: boolean,
): number {
  // Sample ring vertices and return min haversine distance; sign by inside.
  const { haversineM } = requireHaversine();
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
  if (!Number.isFinite(min)) return inside ? 0 : Infinity;
  return inside ? min : min;
}

function requireHaversine(): { haversineM: typeof import('./haversine.js').haversineM } {
  // Local import to avoid circular issues at module init in some bundlers.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { haversineM: (a, b, c, d) => {
    const R = 6371000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const φ1 = toRad(a);
    const φ2 = toRad(c);
    const Δφ = toRad(c - a);
    const Δλ = toRad(d - b);
    const x =
      Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }};
}
