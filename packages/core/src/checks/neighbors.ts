import type { CheckResult, PositionEvent } from '@northstar/contracts';
import { haversineM, nmToM } from '../geo/haversine.js';

export interface NeighborsConfig {
  radius_nm: number;
  max_age_s: number;
  conflict_distance_m: number;
  min_independent_sources: number;
}

export interface NeighborObservation {
  event: PositionEvent;
  independence: number; // 0..1
  reliability: number; // 0..1
}

/**
 * Independent observation of the target itself (e.g. VTS radar track or SAR detection
 * associated with this MMSI). Not derived from the vessel's own GNSS.
 */
export interface TargetObservation {
  observed_at: string;
  lat: number;
  lon: number;
  accuracy_m: number;
  provider_id: string;
}

/**
 * Compare the reported position with the freshest independent observation of the same
 * vessel (≤ max_age_s). Returns null when there is none, so the caller falls back to the
 * nearby-traffic comparison. Pass ≤ tolerance; warning ≤ 3× tolerance; fail beyond.
 */
export function checkTargetObservation(
  target: PositionEvent,
  observations: TargetObservation[],
  config: NeighborsConfig,
  nowIso: string,
): CheckResult | null {
  const tTarget = Date.parse(target.source_timestamp);
  let best: TargetObservation | null = null;
  let bestAge = Infinity;
  for (const o of observations) {
    const age = Math.abs(tTarget - Date.parse(o.observed_at)) / 1000;
    if (age <= config.max_age_s && age < bestAge) {
      best = o;
      bestAge = age;
    }
  }
  if (!best) return null;
  const d = haversineM(target.position.lat, target.position.lon, best.lat, best.lon);
  // Allow for motion between the two timestamps (≤ 15 m/s) and both position errors.
  const tol = Math.max(config.conflict_distance_m, 3 * best.accuracy_m + 50) + 15 * bestAge;
  const status: CheckResult['status'] = d <= tol ? 'pass' : d <= 3 * tol ? 'warning' : 'fail';
  const anomaly = d <= tol ? 0.05 : Math.min(1, 0.4 + (d - tol) / (6 * tol));
  return {
    entity_id: target.entity_id,
    check_id: 'neighbors',
    status,
    anomaly_score: anomaly,
    severity: status === 'fail' ? 'high' : status === 'warning' ? 'medium' : 'none',
    observed_at: nowIso,
    explanation:
      status === 'pass'
        ? `Independent observation (${best.provider_id}, ${bestAge.toFixed(0)} s apart) agrees within ${d.toFixed(0)} m.`
        : `Independent observation (${best.provider_id}, ${bestAge.toFixed(0)} s apart) places the vessel ${(d / 1000).toFixed(d > 10_000 ? 0 : 2)} km from its reported position (tolerance ${tol.toFixed(0)} m).`,
    source_ids: [target.source, best.provider_id],
    quality: 0.9,
    freshness: Math.exp(-bestAge / 60),
    reliability: 0.85,
    evidence: {
      provider_id: best.provider_id,
      observation_age_s: bestAge,
      distance_m: Math.round(d),
      tolerance_m: Math.round(tol),
      observation_accuracy_m: best.accuracy_m,
    },
    missing_reason: null,
    hard_alert: status === 'fail',
  };
}

/**
 * Neighbor consistency: compare target motion/location with nearby AIS / independent observations.
 * Stale observations do not count as current agreement. AIS is never treated as ground truth.
 */
export function checkNeighbors(
  target: PositionEvent,
  neighbors: NeighborObservation[],
  config: NeighborsConfig,
  nowIso: string,
  now: Date = new Date(nowIso),
): CheckResult {
  const radiusM = nmToM(config.radius_nm);
  const fresh: NeighborObservation[] = [];

  for (const n of neighbors) {
    if (n.event.entity_id === target.entity_id) continue;
    const ageS = (now.getTime() - Date.parse(n.event.source_timestamp)) / 1000;
    if (ageS > config.max_age_s) continue;
    const d = haversineM(
      target.position.lat,
      target.position.lon,
      n.event.position.lat,
      n.event.position.lon,
    );
    if (d <= radiusM) fresh.push({ ...n, event: n.event });
  }

  if (fresh.length === 0) {
    return {
      entity_id: target.entity_id,
      check_id: 'neighbors',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation:
        'Insufficient neighbor evidence: no fresh nearby vessels or independent observations within range.',
      source_ids: [target.source],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'No fresh neighbors within radius',
      evidence: { radius_nm: config.radius_nm, candidates: neighbors.length },
      hard_alert: false,
    };
  }

  // Cross-source conflict: same entity reported by different providers with large separation
  // (caller may pass alternate reports for the same entity as "neighbors" with same entity_id filtered above)
  // Here we look for mutually inconsistent neighbor cluster relative to target jump.

  // Simple model: if target displaced hugely from its own recent neighbors' relative geometry
  // we approximate by checking whether any high-reliability independent source disagrees on
  // target position when provided as an alternate report with entity_id match via evidence field.
  const conflicts: string[] = [];
  let anomaly = 0;
  const sourceIds = new Set<string>([target.source]);

  // Relative speed consistency with nearby traffic (soft)
  for (const n of fresh) {
    sourceIds.add(n.event.source);
    const ageS = (now.getTime() - Date.parse(n.event.source_timestamp)) / 1000;
    const freshness = Math.exp(-ageS / 30);
    const d = haversineM(
      target.position.lat,
      target.position.lon,
      n.event.position.lat,
      n.event.position.lon,
    );
    // If both report nearly identical positions but different entity IDs — suspicious spoof clone
    if (d < 30 && n.independence > 0.5) {
      anomaly = Math.max(anomaly, 0.6 * freshness * n.reliability);
      conflicts.push(
        `Neighbor ${n.event.entity_id} is unusually co-located (${d.toFixed(0)} m); possible identity conflict.`,
      );
    }
  }

  // Independence score of evidence set
  const independent = fresh.filter((n) => n.independence >= 0.5);
  if (independent.length < config.min_independent_sources) {
    return {
      entity_id: target.entity_id,
      check_id: 'neighbors',
      status: anomaly >= 0.4 ? 'warning' : 'pass',
      anomaly_score: anomaly,
      severity: anomaly >= 0.4 ? 'medium' : 'none',
      observed_at: nowIso,
      explanation:
        conflicts.length > 0
          ? conflicts.join(' ')
          : `Nearby traffic present but limited source independence (${independent.length} independent). Soft consistency only; AIS is not cryptographic ground truth.`,
      source_ids: [...sourceIds],
      quality: 0.5,
      freshness: 0.7,
      reliability: 0.5,
      missing_reason: null,
      evidence: {
        fresh_count: fresh.length,
        independent_count: independent.length,
        conflicts,
      },
      hard_alert: false,
    };
  }

  // Soft agreement: presence of independent fresh neighbors without conflict → low anomaly
  if (conflicts.length === 0) {
    anomaly = 0;
  }

  const status = anomaly >= 0.75 ? 'fail' : anomaly >= 0.4 ? 'warning' : 'pass';
  return {
    entity_id: target.entity_id,
    check_id: 'neighbors',
    status,
    anomaly_score: anomaly,
    severity: status === 'fail' ? 'high' : status === 'warning' ? 'medium' : 'none',
    observed_at: nowIso,
    explanation:
      conflicts.length > 0
        ? conflicts.join(' ')
        : `Fresh independent observations (${independent.length}) are consistent with reported neighborhood; not treated as proof of authenticity.`,
    source_ids: [...sourceIds],
    quality: 0.75,
    freshness: 0.85,
    reliability: 0.7,
    missing_reason: null,
    evidence: {
      fresh_count: fresh.length,
      independent_count: independent.length,
      conflicts,
    },
    hard_alert: false,
  };
}

/** Compare two reports of the same entity from different providers. */
export function checkAisCrossFeed(
  primary: PositionEvent,
  secondary: PositionEvent | null,
  nowIso: string,
  conflictDistanceM = 500,
  /** v2: secondary reports further than this from the primary (s) are not compared. */
  maxAgeS?: number,
): CheckResult {
  const gapS = secondary
    ? Math.abs(Date.parse(primary.source_timestamp) - Date.parse(secondary.source_timestamp)) / 1000
    : 0;
  if (secondary && maxAgeS != null && gapS > maxAgeS) {
    return {
      entity_id: primary.entity_id,
      check_id: 'ais_cross_feed',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation: `Latest second-provider report is ${gapS.toFixed(0)} s from this one (limit ${maxAgeS} s); not compared.`,
      source_ids: [primary.source, secondary.source],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'Second AIS report too old',
      evidence: { secondary_gap_s: Math.round(gapS) },
      hard_alert: false,
    };
  }
  if (!secondary) {
    return {
      entity_id: primary.entity_id,
      check_id: 'ais_cross_feed',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'Second AIS provider unavailable; cannot compare independent feeds.',
      source_ids: [primary.source],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'No second AIS source',
      evidence: {
        primary_provider: primary.provider_id ?? primary.source,
        secondary_provider: null,
      },
      hard_alert: false,
    };
  }

  const sameUpstream =
    primary.upstream_lineage &&
    secondary.upstream_lineage &&
    primary.upstream_lineage.some((u: string) => secondary.upstream_lineage!.includes(u));

  const d = haversineM(
    primary.position.lat,
    primary.position.lon,
    secondary.position.lat,
    secondary.position.lon,
  );

  if (sameUpstream) {
    return {
      entity_id: primary.entity_id,
      check_id: 'ais_cross_feed',
      status: 'warning',
      anomaly_score: 0,
      severity: 'low',
      observed_at: nowIso,
      explanation:
        'Two AIS feeds share upstream lineage; independence cannot be claimed. Distance comparison recorded for transparency only.',
      source_ids: [primary.source, secondary.source],
      quality: 0.3,
      freshness: 1,
      reliability: 0.3,
      missing_reason: null,
      evidence: { distance_m: d, shared_upstream: true },
      hard_alert: false,
    };
  }

  if (d > conflictDistanceM) {
    return {
      entity_id: primary.entity_id,
      check_id: 'ais_cross_feed',
      status: 'fail',
      anomaly_score: Math.min(1, d / (conflictDistanceM * 3)),
      severity: 'high',
      observed_at: nowIso,
      explanation: `Independent AIS providers disagree by ${d.toFixed(0)} m on ${primary.entity_id}.`,
      source_ids: [primary.source, secondary.source],
      quality: 0.85,
      freshness: 1,
      reliability: 0.8,
      missing_reason: null,
      evidence: {
        distance_m: d,
        primary: primary.position,
        secondary: secondary.position,
        primary_provider: primary.provider_id ?? primary.source,
        secondary_provider: secondary.provider_id ?? secondary.source,
      },
      hard_alert: false,
    };
  }

  return {
    entity_id: primary.entity_id,
    check_id: 'ais_cross_feed',
    status: 'pass',
    anomaly_score: 0,
    severity: 'none',
    observed_at: nowIso,
    explanation: `Independent AIS providers agree within ${conflictDistanceM} m (${d.toFixed(0)} m separation).`,
    source_ids: [primary.source, secondary.source],
    quality: 0.85,
    freshness: 1,
    reliability: 0.8,
    missing_reason: null,
    evidence: { distance_m: d },
    hard_alert: false,
  };
}
