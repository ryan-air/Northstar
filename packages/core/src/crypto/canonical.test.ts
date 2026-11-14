import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical.js';

describe('JCS canonicalize', () => {
  it('sorts object keys', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('is stable for nested structures', () => {
    const a = canonicalize({
      v: 1,
      position: { lon: -122.4, lat: 37.8 },
      device_id: 'd1',
    });
    const b = canonicalize({
      device_id: 'd1',
      position: { lat: 37.8, lon: -122.4 },
      v: 1,
    });
    expect(a).toBe(b);
  });
});
