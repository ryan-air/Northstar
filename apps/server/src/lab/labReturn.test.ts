import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCheckEvidence } from '@northstar/core';
import { labReturnSummary, listLabReturns, loadLabReturn, sampleAt } from './labReturn.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'lab-'));
  const d = join(root, 'lab_t');
  mkdirSync(d);
  writeFileSync(
    join(d, 'readiness.json'),
    JSON.stringify({ vessel_mmsi: '230123456', window: ['2027-03-01T08:00:00Z', null], items: {}, secrets_found: [] }),
  );
  writeFileSync(
    join(d, 'ais_secondary.jsonl'),
    [
      { mmsi: 230123456, lat: 60.1, lon: 24.9, sog: 10, cog: 90, heading: null, timestamp_external_ms: 2, captured_at: '2027-03-01T08:00:02Z', source: 'x', provider_id: 'st1' },
      { mmsi: 230123456, lat: 95, lon: 24.9, timestamp_external_ms: 1, captured_at: '2027-03-01T08:00:01Z' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\nnot json\n',
  );
  const g = (t: string) => ({
    entity_id: 'LAB-230123456', observed_at: t, satellite_count: 9, c_n0_dbhz: [40], hdop: null,
    interference_indicator: 'none', labels: { simulated: false, fixture: false, recorded: true }, missing_inputs: [],
  });
  writeFileSync(join(d, 'gnss_recorded.jsonl'), [g('2027-03-01T08:00:01.000Z'), g('2027-03-01T08:00:00.000Z')].map((r) => JSON.stringify(r)).join('\n'));
  return root;
}

describe('lab return loader', () => {
  it('loads, validates and sorts; drops bad rows', () => {
    const root = fixture();
    expect(listLabReturns(root)).toEqual(['lab_t']);
    const r = loadLabReturn(root, 'lab_t')!;
    expect(r.secondaryAis).toHaveLength(1);
    expect(r.secondaryAis[0]!.source).toBe('lab_secondary');
    expect(r.rejected.ais_secondary).toBe(2);
    expect(r.gnss.map((x) => x.observed_at)).toEqual(['2027-03-01T08:00:00.000Z', '2027-03-01T08:00:01.000Z']);
    expect(labReturnSummary(r).counts.gnss_snapshots).toBe(2);
  });

  it('rejects path traversal ids', () => {
    expect(loadLabReturn(fixture(), '../etc')).toBeNull();
  });

  it('sampleAt respects max age', () => {
    const s = [{ t: '2027-03-01T08:00:00Z' }, { t: '2027-03-01T08:00:10Z' }];
    expect(sampleAt(s, (x) => x.t, '2027-03-01T08:00:11Z', 2000)?.t).toBe('2027-03-01T08:00:10Z');
    expect(sampleAt(s, (x) => x.t, '2027-03-01T08:00:15Z', 2000)).toBeNull();
    expect(sampleAt(s, (x) => x.t, '2027-03-01T07:59:59Z', 2000)).toBeNull();
  });

  it('recorded lab GNSS is classed recorded, not live', () => {
    const r = loadLabReturn(fixture(), 'lab_t')!;
    const event = { entity_id: 'LAB-1', source: 'ais', labels: {} } as never;
    expect(classifyCheckEvidence('gnss_diagnostics', { event, gnss: r.gnss[0]! })).toBe('recorded');
  });
});
