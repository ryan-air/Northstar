/**
 * Display-only simplification of polygon layers for the web map. The checks keep using the
 * full-detail geometry; this only shrinks what the browser downloads.
 */
type Ring = number[][];
type Geometry =
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] }
  | { type: string; coordinates?: unknown };
interface Feature {
  type: 'Feature';
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry: Geometry | null;
}
interface FC {
  type: 'FeatureCollection';
  features: Feature[];
  [k: string]: unknown;
}

function perpDist2(p: number[], a: number[], b: number[]): number {
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0]! + t * dx - p[0]!;
  const y = a[1]! + t * dy - p[1]!;
  return x * x + y * y;
}

/** Iterative Douglas–Peucker on a closed ring; keeps it closed with ≥4 points or returns null. */
export function simplifyRing(ring: Ring, tolDeg: number): Ring | null {
  if (ring.length < 4) return null;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const tol2 = tolDeg * tolDeg;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist2(ring[i]!, ring[s]!, ring[e]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx > 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    if (keep[i]) out.push([Math.round(ring[i]![0]! * 1e5) / 1e5, Math.round(ring[i]![1]! * 1e5) / 1e5]);
  }
  return out.length >= 4 ? out : null;
}

function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0]! + r[i]![0]!) * (r[j]![1]! - r[i]![1]!);
  return Math.abs(a / 2);
}

function simplifyPolygon(rings: Ring[], tolDeg: number, minAreaDeg2: number): Ring[] | null {
  // minAreaDeg2 = 0 means keep every part: fall back to the original ring if it collapses.
  const outer = rings[0] ? (simplifyRing(rings[0], tolDeg) ?? (minAreaDeg2 === 0 ? rings[0] : null)) : null;
  if (!outer || ringArea(outer) < minAreaDeg2) return null;
  const holes = rings
    .slice(1)
    .map((h) => simplifyRing(h, tolDeg))
    .filter((h): h is Ring => !!h && ringArea(h) >= minAreaDeg2);
  return [outer, ...holes];
}

/**
 * Simplify every polygon at `tolDeg` (≈ tolDeg × 111 km, e.g. 0.0003° ≈ 33 m north–south),
 * drop parts smaller than `minAreaDeg2`, strip properties.
 */
export function simplifyForDisplay(fc: FC, tolDeg = 0.0003, minAreaDeg2 = 2e-7): FC {
  const features: Feature[] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') {
      const p = simplifyPolygon(g.coordinates as Ring[], tolDeg, minAreaDeg2);
      if (p) features.push({ type: 'Feature', id: f.id, properties: {}, geometry: { type: 'Polygon', coordinates: p } });
    } else if (g.type === 'MultiPolygon') {
      const ps = (g.coordinates as Ring[][])
        .map((r) => simplifyPolygon(r, tolDeg, minAreaDeg2))
        .filter((p): p is Ring[] => !!p);
      if (ps.length) features.push({ type: 'Feature', id: f.id, properties: {}, geometry: { type: 'MultiPolygon', coordinates: ps } });
    } else {
      features.push(f);
    }
  }
  return { type: 'FeatureCollection', features, display_simplified: { tol_deg: tolDeg, min_area_deg2: minAreaDeg2 } };
}
