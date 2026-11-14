import { describe, expect, it } from 'vitest';
import { DigitrafficAdapter } from './digitraffic.js';

describe('DigitrafficAdapter', () => {
  it(
    'polls live Finnish AIS for Gulf of Finland',
    async () => {
      const adapter = new DigitrafficAdapter({
        latitude: 59.95,
        longitude: 24.9,
        radiusKm: 60,
        maxVessels: 40,
      });
      const result = await adapter.poll();
      // Allow offline CI without network — still assert shape when reachable
      if (!result.ok) {
        expect(result.reason).toBeTruthy();
        return;
      }
      expect(result.vesselCount).toBeGreaterThan(0);
      expect(result.events[0]?.entity_id.startsWith('LIVE-')).toBe(true);
      expect(result.events[0]?.labels?.live).toBe(true);
      expect(result.events[0]?.labels?.simulated).toBe(false);
      expect(adapter.status).toMatch(/ok|degraded/);
    },
    30_000,
  );
});
