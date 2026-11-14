import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('cybersecurity hackathon surfaces', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

  it('documents threat model adversaries in server module', () => {
    const src = readFileSync(join(root, 'apps/server/src/security/threatModel.ts'), 'utf8');
    expect(src).toMatch(/telemetry_tamper/);
    expect(src).toMatch(/replay/);
    expect(src).toMatch(/osnma_nav/);
    expect(src).toMatch(/audit_tamper/);
  });

  it('ships OSNMA sidecar ICD verification runner', () => {
    const src = readFileSync(join(root, 'sidecars/osnma/runner.py'), 'utf8');
    expect(src).toMatch(/ICDTestVectors/);
    expect(src).toMatch(/configuration_1/);
    expect(src).toMatch(/Tag AUTHENTICATED/);
  });
});
