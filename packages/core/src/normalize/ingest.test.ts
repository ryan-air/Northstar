import { describe, expect, it } from 'vitest';
import { IngestValidator, normalizeAisSentinels } from './validate.js';
import type { PositionEvent } from '@northstar/contracts';

const NOW = new Date('2026-11-12T10:00:00.000Z');
function ev(p: Partial<PositionEvent> & { tOff?: number } = {}): PositionEvent {
  const { tOff = -10_000, ...rest } = p;
  const ts = new Date(NOW.getTime() + tOff).toISOString();
  return {
    schema_version: 1,
    entity_id: 'LIVE-230000000',
    entity_type: 'vessel',
    position: { lat: 60, lon: 25, crs: 'EPSG:4326' },
    source: 'ais',
    source_timestamp: ts,
    ingested_at: ts,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
    speed_over_ground_knots: 10,
    course_over_ground_deg: 90,
    heading_deg: 90,
    ...rest,
  };
}
const mk = () => new IngestValidator({ staleAfterMs: 600_000, maxFutureSkewMs: 30_000 });

describe('ingest validation (P1.4)', () => {
  it('accepts a normal report', () => {
    expect(mk().validate(ev(), NOW).ok).toBe(true);
  });
  it('rejects stale and future reports', () => {
    const v = mk();
    expect(v.validate(ev({ tOff: -900_000 }), NOW)).toMatchObject({ ok: false, code: 'stale' });
    expect(v.validate(ev({ tOff: 120_000 }), NOW)).toMatchObject({ ok: false, code: 'future' });
    expect(v.rejected.stale).toBe(1);
    expect(v.rejected.future).toBe(1);
  });
  it('rejects a re-polled duplicate and an out-of-order report', () => {
    const v = mk();
    expect(v.validate(ev({ tOff: -5000 }), NOW).ok).toBe(true);
    expect(v.validate(ev({ tOff: -5000 }), NOW)).toMatchObject({ ok: false, code: 'duplicate' });
    expect(v.validate(ev({ tOff: -9000 }), NOW)).toMatchObject({ ok: false, code: 'out_of_order' });
  });
  it('rejects position sentinels (91/181, Null Island)', () => {
    const v = mk();
    expect(v.validate(ev({ position: { lat: 91, lon: 181, crs: 'EPSG:4326' } }), NOW)).toMatchObject({ ok: false, code: 'sentinel' });
    expect(v.validate(ev({ position: { lat: 0, lon: 0, crs: 'EPSG:4326' } }), NOW)).toMatchObject({ ok: false, code: 'sentinel' });
  });
  it('nulls kinematic sentinels instead of rejecting (heading 511, COG 360, SOG 102.3, UTC sec 61)', () => {
    const out = mk().validate(
      ev({ heading_deg: 511 as number, course_over_ground_deg: 360, speed_over_ground_knots: 102.3, ais_utc_second: 61 as number }),
      NOW,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.event.heading_deg).toBeNull();
      expect(out.event.course_over_ground_deg).toBeNull();
      expect(out.event.speed_over_ground_knots).toBeNull();
      expect(out.event.ais_utc_second).toBeNull();
    }
  });
  it('normalizeAisSentinels leaves valid fields alone', () => {
    const r = normalizeAisSentinels(ev());
    expect(r.ok && r.nulled.length === 0).toBe(true);
  });
});
