import {
  PositionEventSchema,
  type PositionEvent,
} from '@northstar/contracts';

export type ValidationOutcome =
  | { ok: true; event: PositionEvent }
  | { ok: false; reason: string; code: ValidationCode };

export type ValidationCode =
  | 'schema'
  | 'stale'
  | 'future'
  | 'duplicate'
  | 'out_of_order'
  | 'malformed_units'
  | 'sentinel';

export interface ValidateOptions {
  now?: Date;
  staleAfterMs?: number;
  maxFutureSkewMs?: number;
  lastSequence?: number | null;
  seenHashes?: Set<string>;
  eventHash?: string;
}

export function validatePositionEvent(
  raw: unknown,
  opts: ValidateOptions = {},
): ValidationOutcome {
  const parsed = PositionEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message, code: 'schema' };
  }
  const event = parsed.data;
  const now = opts.now ?? new Date();
  const sourceTs = Date.parse(event.source_timestamp);
  if (Number.isNaN(sourceTs)) {
    return { ok: false, reason: 'Invalid source_timestamp', code: 'schema' };
  }

  const staleAfter = opts.staleAfterMs ?? 120_000;
  const maxFuture = opts.maxFutureSkewMs ?? 30_000;
  const age = now.getTime() - sourceTs;
  if (age > staleAfter) {
    return {
      ok: false,
      reason: `Source timestamp stale by ${Math.round(age / 1000)}s`,
      code: 'stale',
    };
  }
  if (sourceTs - now.getTime() > maxFuture) {
    return {
      ok: false,
      reason: 'Source timestamp too far in the future (clock skew)',
      code: 'future',
    };
  }

  if (
    event.speed_over_ground_knots != null &&
    (event.speed_over_ground_knots < 0 || event.speed_over_ground_knots > 100)
  ) {
    return { ok: false, reason: 'Implausible SOG units/range', code: 'malformed_units' };
  }

  if (opts.eventHash && opts.seenHashes?.has(opts.eventHash)) {
    return { ok: false, reason: 'Duplicate event hash', code: 'duplicate' };
  }

  if (
    event.sequence_number != null &&
    opts.lastSequence != null &&
    event.sequence_number < opts.lastSequence
  ) {
    return {
      ok: false,
      reason: `Out-of-order sequence ${event.sequence_number} < ${opts.lastSequence}`,
      code: 'out_of_order',
    };
  }

  return { ok: true, event };
}

/**
 * AIS "not available" sentinels (ITU-R M.1371). Position sentinels reject the report;
 * kinematic sentinels only null the field.
 */
export const AIS_SENTINELS = {
  lat: 91,
  lon: 181,
  sog_kn: 102.3,
  cog_deg: 360,
  heading_deg: 511,
  /** AIS UTC-second values 60–63 mean "not available / manual / dead reckoning / inoperative". */
  utc_second_min_unavailable: 60,
} as const;

export function normalizeAisSentinels(
  event: PositionEvent,
): { ok: true; event: PositionEvent; nulled: string[] } | { ok: false; reason: string; code: 'sentinel' } {
  const { lat, lon } = event.position;
  if (lat >= AIS_SENTINELS.lat || lat <= -AIS_SENTINELS.lat || lon >= AIS_SENTINELS.lon || lon <= -AIS_SENTINELS.lon) {
    return { ok: false, reason: `Position sentinel (${lat}, ${lon}) = not available`, code: 'sentinel' };
  }
  if (lat === 0 && lon === 0) {
    return { ok: false, reason: 'Null Island (0,0) position — receiver default, not a fix', code: 'sentinel' };
  }
  const nulled: string[] = [];
  const out: PositionEvent = { ...event };
  if (out.speed_over_ground_knots != null && out.speed_over_ground_knots >= 102.25) {
    out.speed_over_ground_knots = null;
    nulled.push('sog');
  }
  if (out.course_over_ground_deg != null && out.course_over_ground_deg >= AIS_SENTINELS.cog_deg) {
    out.course_over_ground_deg = null;
    nulled.push('cog');
  }
  if (out.heading_deg != null && out.heading_deg >= 360) {
    out.heading_deg = null;
    nulled.push('heading');
  }
  if (out.ais_utc_second != null && out.ais_utc_second >= AIS_SENTINELS.utc_second_min_unavailable) {
    out.ais_utc_second = null;
    nulled.push('ais_utc_second');
  }
  return { ok: true, event: out, nulled };
}

function preNullSentinels(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : null);
  const sog = num('speed_over_ground_knots');
  if (sog != null && sog >= 102.25) r.speed_over_ground_knots = null;
  const cog = num('course_over_ground_deg');
  if (cog != null && cog >= 360) r.course_over_ground_deg = null;
  const hdg = num('heading_deg');
  if (hdg != null && hdg >= 360) r.heading_deg = null;
  const sec = num('ais_utc_second');
  if (sec != null && sec >= 60) r.ais_utc_second = null;
  return r;
}

export interface IngestValidatorOptions {
  staleAfterMs: number;
  maxFutureSkewMs: number;
}

/**
 * Stateful ingest gate used by every ingest path (live, AISStream, Hist Lab).
 * Rejects schema errors, sentinels, stale/future timestamps, duplicates (same
 * entity + source_timestamp) and out-of-order reports. Rejections are counted and
 * returned so callers can log them to forensics — they never reach the pipeline.
 */
export class IngestValidator {
  private lastTs = new Map<string, number>();
  readonly rejected: Record<ValidationCode, number> = {
    schema: 0,
    stale: 0,
    future: 0,
    duplicate: 0,
    out_of_order: 0,
    malformed_units: 0,
    sentinel: 0,
  };
  accepted = 0;

  constructor(private opts: IngestValidatorOptions) {}

  validate(raw: unknown, now: Date): ValidationOutcome {
    // Null kinematic sentinels BEFORE schema bounds (heading 511 / COG 360 / SOG 102.3
    // would otherwise be rejected as schema errors instead of "not available").
    const pre = preNullSentinels(raw);
    const parsed = PositionEventSchema.safeParse(pre);
    if (!parsed.success) {
      // Position sentinels (91/181) fail the schema bounds; report them as sentinels.
      const r = raw as { position?: { lat?: number; lon?: number } } | null;
      const lat = r?.position?.lat;
      const lon = r?.position?.lon;
      if (lat === 91 || lon === 181) return this.reject('sentinel', `Position sentinel (${lat}, ${lon})`);
      return this.reject('schema', parsed.error.message);
    }
    const s = normalizeAisSentinels(parsed.data);
    if (!s.ok) return this.reject('sentinel', s.reason);
    const base = validatePositionEvent(s.event, {
      now,
      staleAfterMs: this.opts.staleAfterMs,
      maxFutureSkewMs: this.opts.maxFutureSkewMs,
    });
    if (!base.ok) return this.reject(base.code, base.reason);
    const ts = Date.parse(s.event.source_timestamp);
    const last = this.lastTs.get(s.event.entity_id);
    if (last != null && ts === last) return this.reject('duplicate', 'Same entity and source_timestamp already processed');
    if (last != null && ts < last) return this.reject('out_of_order', `source_timestamp older than last accepted by ${Math.round((last - ts) / 1000)}s`);
    this.lastTs.set(s.event.entity_id, ts);
    this.accepted += 1;
    return { ok: true, event: s.event };
  }

  forget(entityId: string): void {
    this.lastTs.delete(entityId);
  }

  reset(): void {
    this.lastTs.clear();
  }

  private reject(code: ValidationCode, reason: string): ValidationOutcome {
    this.rejected[code] += 1;
    return { ok: false, code, reason };
  }
}
