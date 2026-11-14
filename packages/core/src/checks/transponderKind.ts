/**
 * Separate non-vessel transponders (test units, base stations, AtoN) from ships so they
 * are reported in their own category instead of as ship false alarms.
 *
 * This only labels the entity; it never changes checks, trust or alerts. A unit is
 * classed non-vessel when:
 *  - its MMSI is not a ship MMSI (ITU-R M.585: AtoN 99…, coast station 00…, SAR aircraft
 *    111…, craft-associated 98…, SART/MOB/EPIRB 97x…), or
 *  - it has stayed within `fixed_radius_m` for at least `fixed_window_s` and every report
 *    in that window is on land.
 * Moving more than `fixed_radius_m` resets the window, so a ship that starts moving is a
 * vessel again (no one-way exemption an attacker could use).
 */
import type { PositionEvent } from '@northstar/contracts';
import { haversineM } from '../geo/haversine.js';
import { isAllocatedMid, parseMmsi } from './identity.js';

export type TransponderKind = 'vessel' | 'non_vessel_transponder';

export interface TransponderKindConfig {
  fixed_window_s: number;
  fixed_radius_m: number;
  min_reports: number;
}

export const DEFAULT_TRANSPONDER_KIND: TransponderKindConfig = {
  fixed_window_s: 1800,
  fixed_radius_m: 100,
  min_reports: 5,
};

export interface TransponderKindState {
  anchor: { lat: number; lon: number; t: number } | null;
  reports: number;
  allOnLand: boolean;
}

export function createTransponderKindState(): TransponderKindState {
  return { anchor: null, reports: 0, allOnLand: true };
}

export interface TransponderKindResult {
  state: TransponderKindState;
  kind: TransponderKind;
  reasons: string[];
}

export function updateTransponderKind(
  prev: TransponderKindState,
  event: PositionEvent,
  onLand: boolean,
  cfg: TransponderKindConfig = DEFAULT_TRANSPONDER_KIND,
): TransponderKindResult {
  const reasons: string[] = [];
  const mmsi = event.labels?.mmsi ?? null;
  const parsed = mmsi != null ? parseMmsi(mmsi) : null;
  if (parsed && parsed.kind !== 'ship' && parsed.kind !== 'invalid') {
    reasons.push(`MMSI type ${parsed.kind.replace(/_/g, ' ')}`);
  }

  const t = Date.parse(event.source_timestamp);
  const { lat, lon } = event.position;
  let state: TransponderKindState;
  if (!prev.anchor || haversineM(prev.anchor.lat, prev.anchor.lon, lat, lon) > cfg.fixed_radius_m) {
    state = { anchor: { lat, lon, t }, reports: 1, allOnLand: onLand };
  } else {
    state = { anchor: prev.anchor, reports: prev.reports + 1, allOnLand: prev.allOnLand && onLand };
  }
  const heldS = state.anchor ? (t - state.anchor.t) / 1000 : 0;
  if (state.allOnLand && state.reports >= cfg.min_reports && heldS >= cfg.fixed_window_s) {
    reasons.push(`fixed on land for ${Math.round(heldS / 60)} min (${state.reports} reports within ${cfg.fixed_radius_m} m)`);
    if (parsed?.mid != null && !isAllocatedMid(parsed.mid)) reasons.push(`MID ${parsed.mid} unallocated`);
  }
  return { state, kind: reasons.length > 0 ? 'non_vessel_transponder' : 'vessel', reasons };
}
