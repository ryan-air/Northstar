import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Documents which attack classes Northstar currently covers in software vs what
 * commercial RF detectors typically cover. This is a capability checklist — not
 * a claim of superior live RF performance.
 */
describe('detector capability comparison baseline', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const comparison = readFileSync(join(root, 'COMPARISON.md'), 'utf8');

  it('documents commercial peers and non-claims', () => {
    expect(comparison).toMatch(/Septentrio AIM\+/);
    expect(comparison).toMatch(/A-Shield|ANavS/);
    expect(comparison).toMatch(/DIDI GNSS/);
    expect(comparison).toMatch(/Do not pitch/i);
    expect(comparison).toMatch(/not a claim that Northstar beats/i);
  });

  it('lists Northstar strengths that are actually implemented', () => {
    // These are the areas where our sim/crypto stack is real software, not RF hardware
    const implemented = [
      'Kinematic / jump / drift',
      'Land / geo plausibility',
      'Signed device telemetry',
      'Explainable per-layer UI',
    ];
    for (const row of implemented) {
      expect(comparison).toContain(row);
    }
  });

  it('keeps RF/OSNMA live as non-fielded for Northstar', () => {
    expect(comparison).toMatch(/Simulated fixtures|Protocol-demo|Not yet/);
  });
});
