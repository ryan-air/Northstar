/**
 * Alerts that do not need a new position report: receiver jamming/spoofing flags, and a
 * vessel whose AIS has gone quiet while an independent sensor (radar/SAR) still tracks it
 * moving. Evaluated on a clock, not per report, because jamming usually *stops* reports.
 *
 * AIS silence alone is not suspicious (reporting gaps are common); it needs corroboration.
 */
import type { GnssDiagnostics } from '@northstar/contracts';
import { haversineM } from '../geo/haversine.js';
import type { TargetObservation } from './neighbors.js';

export type SilenceKind = 'gnss_jamming' | 'gnss_spoofing_flag' | 'ais_silent_while_tracked';

export interface SilenceConfig {
  /** GNSS diagnostics older than this are ignored (s). */
  gnss_max_age_s: number;
  /** AIS is "silent" after max(this, silent_factor × typical interval) without a report (s). */
  silent_after_s: number;
  silent_factor: number;
  /** Independent observation must be this fresh (s). */
  obs_max_age_s: number;
  /** …and this far from the last AIS position to count as "moving while silent" (m). */
  moved_m: number;
}

export const DEFAULT_SILENCE: SilenceConfig = {
  gnss_max_age_s: 15,
  silent_after_s: 600,
  silent_factor: 4,
  obs_max_age_s: 90,
  moved_m: 1000,
};

export interface SilenceFinding {
  kind: SilenceKind;
  severity: 'warning' | 'critical';
  title: string;
  explanation: string;
}

export interface SilenceInput {
  nowMs: number;
  lastReport: { t: number; lat: number; lon: number } | null;
  gnss: GnssDiagnostics | null;
  observations: TargetObservation[];
  /** Median interval between this vessel's recent reports (s), if known. */
  typicalIntervalS?: number | null;
}

function latestObs(obs: TargetObservation[], nowMs: number, maxAgeMs: number): TargetObservation | null {
  let lo = 0;
  let hi = obs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(obs[mid]!.observed_at) <= nowMs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  const o = obs[best]!;
  return nowMs - Date.parse(o.observed_at) <= maxAgeMs ? o : null;
}

export function assessSilence(input: SilenceInput, cfg: SilenceConfig = DEFAULT_SILENCE): SilenceFinding[] {
  const out: SilenceFinding[] = [];
  const g = input.gnss;
  const gFresh = g && input.nowMs - Date.parse(g.observed_at) <= cfg.gnss_max_age_s * 1000;
  if (gFresh && g.interference_indicator === 'suspected_jamming') {
    out.push({
      kind: 'gnss_jamming',
      severity: 'warning',
      title: 'GNSS jamming reported by the onboard receiver',
      explanation: `Receiver interference state indicates jamming${g.agc != null ? ` (AGC ${g.agc})` : ''}; position reports may stop or degrade.`,
    });
  }
  if (gFresh && g.interference_indicator === 'suspected_spoofing') {
    out.push({
      kind: 'gnss_spoofing_flag',
      severity: 'critical',
      title: 'GNSS spoofing reported by the onboard receiver',
      explanation: 'Receiver spoofing detector is active; treat GNSS-derived positions (including AIS) as untrusted.',
    });
  }
  const typical = typeof input.typicalIntervalS === 'number' && Number.isFinite(input.typicalIntervalS) ? input.typicalIntervalS : 0;
  const silentAfterS = Math.max(cfg.silent_after_s, cfg.silent_factor * typical);
  const lr = input.lastReport;
  const lrOk = lr && [lr.t, lr.lat, lr.lon].every((x) => typeof x === 'number' && Number.isFinite(x));
  if (lrOk && input.nowMs - lr.t > silentAfterS * 1000) {
    const o = latestObs(input.observations, input.nowMs, cfg.obs_max_age_s * 1000);
    if (o) {
      const moved = haversineM(lr.lat, lr.lon, o.lat, o.lon);
      if (moved > cfg.moved_m) {
        out.push({
          kind: 'ais_silent_while_tracked',
          severity: 'warning',
          title: 'AIS silent while the vessel is still tracked',
          explanation: `No AIS report for ${Math.round((input.nowMs - lr.t) / 1000)} s (usual gap ${Math.round(typical)} s), but ${o.provider_id} shows the vessel ${(moved / 1000).toFixed(1)} km from its last AIS position.`,
        });
      }
    }
  }
  return out;
}
