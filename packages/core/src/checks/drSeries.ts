/**
 * GNSS-independent dead reckoning from a recorded heading (gyrocompass HDT) and speed log
 * (VBW) series. The DR position is advanced from the last *trusted* fix; a fix that fails
 * does not become the new anchor, so a spoofed track cannot drag the reference with it.
 *
 * Reported as check_id 'imu' (the motion-sensor slot) with evidence_class 'recorded'.
 */
import type { CheckResult, PositionEvent } from '@northstar/contracts';
import { haversineM } from '../geo/haversine.js';

export interface DrSample {
  t: number; // epoch ms
  heading_deg: number | null;
  speed_kn: number | null;
  /** Where the heading came from: gyrocompass, or IMU yaw rate integrated across a gap. */
  heading_src?: 'gyro' | 'imu';
}

export interface DrSeriesConfig {
  /** Fixed error floor (antenna offset, fix noise) in metres. */
  base_sigma_m: number;
  /** Error growth as a fraction of distance travelled (speed-log scale + heading error). */
  sigma_frac: number;
  /** Re-anchor anyway after this long without a trusted fix (s). */
  max_anchor_age_s: number;
  /** Gap in the series larger than this (s) makes DR unavailable. */
  max_gap_s: number;
}

export const DEFAULT_DR_SERIES: DrSeriesConfig = {
  base_sigma_m: 60,
  sigma_frac: 0.03,
  max_anchor_age_s: 3 * 3600,
  max_gap_s: 120,
};

export interface DrAnchor {
  t: number;
  lat: number;
  lon: number;
}

const R = 6_371_000;

function lowerBound(series: DrSample[], t: number): number {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Integrate heading/speed from anchor time to t. Returns null on gaps or missing data. */
export function deadReckon(
  series: DrSample[],
  anchor: DrAnchor,
  t: number,
  maxGapS: number,
): { lat: number; lon: number; dist_m: number } | null {
  if (t <= anchor.t) return { lat: anchor.lat, lon: anchor.lon, dist_m: 0 };
  let i = lowerBound(series, anchor.t);
  if (i > 0) i -= 1;
  let lat = (anchor.lat * Math.PI) / 180;
  let lon = (anchor.lon * Math.PI) / 180;
  let tPrev = anchor.t;
  let dist = 0;
  const maxGapMs = maxGapS * 1000;
  let lastHdg: number | null = null;
  let lastSpd: number | null = null;
  let lastValidT = anchor.t;
  while (tPrev < t) {
    const s = series[i];
    if (!s) return null;
    const next = series[i + 1];
    const segEnd = Math.min(t, next ? next.t : t);
    // The sample held over this segment must not be older than the allowed gap.
    if (segEnd - s.t > maxGapMs) return null;
    if (segEnd > tPrev) {
      // Hold the last valid heading/speed across short dropouts (bounded by maxGapS above).
      // Treat anything that is not a finite number as missing (inputs are not trusted).
      const sh = typeof s.heading_deg === 'number' && Number.isFinite(s.heading_deg) ? s.heading_deg : null;
      const ss = typeof s.speed_kn === 'number' && Number.isFinite(s.speed_kn) && s.speed_kn >= 0 && s.speed_kn < 100 ? s.speed_kn : null;
      if (sh != null) lastHdg = sh;
      if (ss != null) lastSpd = ss;
      if (lastHdg == null || lastSpd == null) return null;
      if (sh == null || ss == null) {
        if (s.t - lastValidT > maxGapMs) return null;
      } else lastValidT = s.t;
      const hdg = lastHdg;
      const spd = lastSpd;
      const d = spd * 0.514444 * ((segEnd - tPrev) / 1000);
      const brg = (hdg * Math.PI) / 180;
      lat += (d * Math.cos(brg)) / R;
      lon += (d * Math.sin(brg)) / (R * Math.cos(lat));
      dist += d;
      tPrev = segEnd;
    }
    if (!next) break;
    i++;
  }
  if (tPrev < t) return null;
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, dist_m: dist };
}

export function checkDrSeries(
  current: PositionEvent,
  series: DrSample[],
  anchor: DrAnchor | null,
  nowIso: string,
  config: DrSeriesConfig = DEFAULT_DR_SERIES,
  /** False when independent evidence contradicts this fix: it must not become an anchor. */
  canAnchor = true,
  /**
   * Independent position fix (e.g. radar) at or before this report. When newer than the
   * stored anchor it becomes the anchor, so the reference never follows a drifting track.
   */
  independentAnchor: DrAnchor | null = null,
): { result: CheckResult; anchor: DrAnchor | null } {
  if (independentAnchor && independentAnchor.t <= Date.parse(current.source_timestamp) && (!anchor || independentAnchor.t > anchor.t)) {
    anchor = independentAnchor;
  }
  const t = Date.parse(current.source_timestamp);
  const here: DrAnchor = { t, lat: current.position.lat, lon: current.position.lon };
  const base = {
    entity_id: current.entity_id,
    check_id: 'imu' as const,
    observed_at: nowIso,
    source_ids: [current.source, 'gyro_hdt', 'speed_log_vbw'],
    evidence_class: 'recorded' as const,
    missing_reason: null,
  };
  if (!anchor || (t - anchor.t) / 1000 > config.max_anchor_age_s) {
    if (!canAnchor) {
      return {
        anchor,
        result: {
          ...base,
          status: 'pending',
          anomaly_score: null,
          severity: 'none',
          explanation: 'Dead reckoning waiting for a fix that independent observations confirm before anchoring.',
          quality: 0.3,
          freshness: 1,
          reliability: 0.8,
          hard_alert: false,
        },
      };
    }
    return {
      anchor: here,
      result: {
        ...base,
        status: 'pending',
        anomaly_score: null,
        severity: 'none',
        explanation: 'Dead reckoning (gyro heading + speed log) anchored on this fix; next fix will be checked.',
        quality: 0.5,
        freshness: 1,
        reliability: 0.8,
        hard_alert: false,
      },
    };
  }
  const dr = deadReckon(series, anchor, t, config.max_gap_s);
  if (!dr) {
    // Keep the trusted anchor: never adopt an unchecked fix (it may be spoofed).
    return {
      anchor,
      result: {
        ...base,
        status: 'unavailable',
        anomaly_score: null,
        severity: 'none',
        explanation: 'Heading/speed-log series has a gap over this interval; dead reckoning unavailable.',
        quality: 0,
        freshness: 0,
        reliability: 0,
        missing_reason: 'gap in heading/speed series',
        hard_alert: false,
      },
    };
  }
  const resid = haversineM(dr.lat, dr.lon, current.position.lat, current.position.lon);
  const sigma = config.base_sigma_m + config.sigma_frac * dr.dist_m;
  const z = resid / sigma;
  const status: CheckResult['status'] = z <= 3 ? 'pass' : z <= 6 ? 'warning' : 'fail';
  const elapsed = (t - anchor.t) / 1000;
  const anchorKind = anchor === independentAnchor ? 'independent (radar) fix' : 'trusted fix';
  return {
    // Only a passing fix becomes the next anchor.
    anchor: status === 'pass' ? here : anchor,
    result: {
      ...base,
      status,
      anomaly_score: status === 'pass' ? Math.min(0.2, z / 15) : Math.min(1, 0.4 + (z - 3) / 10),
      severity: status === 'fail' ? 'high' : status === 'warning' ? 'medium' : 'none',
      explanation:
        status === 'pass'
          ? `Dead reckoning from the last ${anchorKind} (${elapsed.toFixed(0)} s, ${(dr.dist_m / 1000).toFixed(1)} km) agrees within ${resid.toFixed(0)} m.`
          : `Dead reckoning from the last ${anchorKind} (${elapsed.toFixed(0)} s ago, gyro heading + speed log, no GNSS) puts the vessel ${(resid / 1000).toFixed(resid > 10_000 ? 0 : 2)} km from its reported position (${z.toFixed(1)}σ).`,
      quality: 0.9,
      freshness: 1,
      reliability: 0.85,
      evidence: {
        residual_m: Math.round(resid),
        sigma_m: Math.round(sigma),
        z: Math.round(z * 10) / 10,
        anchor_age_s: Math.round(elapsed),
        anchor_source: anchor === independentAnchor ? 'independent' : 'ais',
        dr_distance_m: Math.round(dr.dist_m),
      },
      hard_alert: status === 'fail',
    },
  };
}
