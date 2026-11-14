import { describe, expect, it } from 'vitest';
import { simplifyForDisplay, simplifyRing } from './displaySimplify.js';

describe('display simplification', () => {
  it('removes near-collinear points and keeps rings closed', () => {
    const ring = [[0, 0], [0.5, 0.00001], [1, 0], [1, 1], [0, 1], [0, 0]];
    const s = simplifyRing(ring, 0.001)!;
    expect(s).toEqual([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  });

  it('drops tiny parts unless minArea is 0', () => {
    const tiny = { type: 'Polygon', coordinates: [[[0, 0], [1e-4, 0], [1e-4, 1e-4], [0, 0]]] };
    const fc = { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: { a: 1 }, geometry: tiny }] };
    expect(simplifyForDisplay(fc, 0.0003, 2e-7).features).toHaveLength(0);
    expect(simplifyForDisplay(fc, 0.0003, 0).features).toHaveLength(1);
  });
});
