import { describe, expect, it } from 'vitest';
import { validatePositionEvent } from './validate.js';

const base = {
  entity_id: 'VESSEL-001',
  position: { lat: 59.9, lon: 25.0 },
  source: 'test',
  source_timestamp: '2026-11-11T10:00:00.000Z',
  ingested_at: '2026-11-11T10:00:01.000Z',
};

describe('validatePositionEvent', () => {
  it('accepts valid event', () => {
    const r = validatePositionEvent(base, { now: new Date('2026-11-11T10:00:05.000Z') });
    expect(r.ok).toBe(true);
  });

  it('rejects malformed coordinates', () => {
    const r = validatePositionEvent(
      { ...base, position: { lat: 999, lon: 0 } },
      { now: new Date('2026-11-11T10:00:05.000Z') },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('schema');
  });

  it('rejects stale', () => {
    const r = validatePositionEvent(base, {
      now: new Date('2026-11-11T10:05:00.000Z'),
      staleAfterMs: 60_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('stale');
  });

  it('rejects out of order sequence', () => {
    const r = validatePositionEvent(
      { ...base, sequence_number: 5 },
      { now: new Date('2026-11-11T10:00:05.000Z'), lastSequence: 10 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('out_of_order');
  });
});
