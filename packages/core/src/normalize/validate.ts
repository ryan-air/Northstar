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
  | 'malformed_units';

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
