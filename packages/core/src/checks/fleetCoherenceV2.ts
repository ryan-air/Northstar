import type { CheckResult } from '@northstar/contracts';
import { destination, haversineM, knotsToMps } from '../geo/haversine.js';
import { BALTIC_SPOOF_ATTRACTORS, type FleetDisplacement } from './fleetCoherence.js';

/**
 * Fleet coherence v2 — time- and speed-aware.
 *
 * Each vessel's *unexplained* displacement is the distance between where it was
 * observed and where its own SOG/COG at the previous fix predicts it should be.
 * Only vessels with unexplained displacement ≥ jump_m over dt ≤ max_dt_s count as
 * "jumpers". Normal lane traffic therefore contributes nothing, however fast.
 *
 * The evaluated vessel is flagged only if it is itself one of the jumpers that
 * forms the area pattern; bystanders pass with the area context in evidence.
 */
export interface FleetCoherenceV2Config {
  min_vessels: number;
  jump_m: number;
  max_dt_s: number;
  stationary_sog_kn: number;
  cluster_radius_m: number;
  airport_radius_m: number;
  coherent_bearing_tol_deg: number;
  /** Max ratio between the largest and smallest offset magnitudes in a coherent group. */
  coherent_magnitude_ratio: number;
}

export const DEFAULT_FLEET_COHERENCE_V2: FleetCoherenceV2Config = {
  min_vessels: 4,
  jump_m: 1000,
  max_dt_s: 600,
  stationary_sog_kn: 0.5,
  cluster_radius_m: 1500,
  airport_radius_m: 3000,
  coherent_bearing_tol_deg: 20,
  coherent_magnitude_ratio: 1.6,
};

export interface UnexplainedDisplacement {
  entity_id: string;
  unexplained_m: number;
  /** east/north components of the unexplained vector (m) */
  ue: number;
  un: number;
  lat: number;
  lon: number;
  dt_s: number;
  stationary: boolean;
}

export function unexplainedDisplacement(d: FleetDisplacement): UnexplainedDisplacement | null {
  if (d.dt_s == null || !(d.dt_s > 0)) return null;
  const sog = d.from_sog_kn ?? 0;
  const cog = d.from_cog_deg;
  const pred =
    sog > 0 && cog != null
      ? destination(d.prev_lat, d.prev_lon, cog, knotsToMps(sog) * d.dt_s)
      : { lat: d.prev_lat, lon: d.prev_lon };
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((d.lat * Math.PI) / 180);
  const ue = (d.lon - pred.lon) * mPerDegLon;
  const un = (d.lat - pred.lat) * mPerDegLat;
  return {
    entity_id: d.entity_id,
    unexplained_m: haversineM(pred.lat, pred.lon, d.lat, d.lon),
    ue,
    un,
    lat: d.lat,
    lon: d.lon,
    dt_s: d.dt_s,
    stationary: (d.from_sog_kn ?? 0) < 0.5 && (d.to_sog_kn ?? 0) < 0.5,
  };
}

function bearingOf(u: UnexplainedDisplacement): number {
  return ((Math.atan2(u.ue, u.un) * 180) / Math.PI + 360) % 360;
}

function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function checkFleetCoherenceV2(
  entityId: string,
  displacements: FleetDisplacement[],
  nowIso: string,
  config: FleetCoherenceV2Config = DEFAULT_FLEET_COHERENCE_V2,
): CheckResult {
  const unexplained = displacements
    .map(unexplainedDisplacement)
    .filter((u): u is UnexplainedDisplacement => u != null);

  if (unexplained.length < 2) {
    return {
      entity_id: entityId,
      check_id: 'fleet_coherence',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'Insufficient fleet displacement samples for coherence analysis.',
      source_ids: [],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'Need multiple vessels with prior positions',
      hard_alert: false,
    };
  }

  const jumpers = unexplained.filter(
    (u) => u.unexplained_m >= config.jump_m && u.dt_s <= config.max_dt_s,
  );
  const moving = unexplained.filter((u) => !u.stationary);
  const self = jumpers.find((u) => u.entity_id === entityId) ?? null;
  const evidence: Record<string, unknown> = {
    algorithm: 'fleet_coherence.v2',
    sample_count: unexplained.length,
    moving_count: moving.length,
    jumper_count: jumpers.length,
    self_unexplained_m: unexplained.find((u) => u.entity_id === entityId)?.unexplained_m ?? null,
    self_is_jumper: !!self,
  };

  const patternMembers = new Set<string>();
  const findings: string[] = [];
  let anomaly = 0;

  if (jumpers.length >= config.min_vessels) {
    // (a) common destination cluster
    let best: UnexplainedDisplacement[] = [];
    for (const seed of jumpers) {
      const near = jumpers.filter(
        (o) => haversineM(seed.lat, seed.lon, o.lat, o.lon) <= config.cluster_radius_m,
      );
      if (near.length > best.length) best = near;
    }
    evidence.common_cluster_size = best.length;
    if (best.length >= config.min_vessels) {
      best.forEach((b) => patternMembers.add(b.entity_id));
      anomaly = Math.max(anomaly, 0.95);
      findings.push(
        `${best.length} vessels made unexplained jumps (≥${config.jump_m} m beyond their own SOG/COG prediction) into a common area.`,
      );
    }

    // (b) attractor proximity
    const atAttractor = jumpers.filter((d) =>
      BALTIC_SPOOF_ATTRACTORS.some(
        (a) => haversineM(d.lat, d.lon, a.lat, a.lon) <= config.airport_radius_m,
      ),
    );
    evidence.near_airport_count = atAttractor.length;
    if (atAttractor.length >= config.min_vessels) {
      atAttractor.forEach((b) => patternMembers.add(b.entity_id));
      anomaly = Math.max(anomaly, 0.9);
      findings.push(`${atAttractor.length} jumping vessels landed near a known spoof attractor.`);
    }

    // (c) coherent offset: similar bearing and magnitude of unexplained vectors
    let bestGroup: UnexplainedDisplacement[] = [];
    for (const seed of jumpers) {
      const b0 = bearingOf(seed);
      const group = jumpers.filter((o) => {
        if (angDiff(bearingOf(o), b0) > config.coherent_bearing_tol_deg) return false;
        const r =
          Math.max(o.unexplained_m, seed.unexplained_m) /
          Math.max(1, Math.min(o.unexplained_m, seed.unexplained_m));
        return r <= config.coherent_magnitude_ratio;
      });
      if (group.length > bestGroup.length) bestGroup = group;
    }
    evidence.coherent_offset_count = bestGroup.length;
    if (bestGroup.length >= config.min_vessels) {
      bestGroup.forEach((b) => patternMembers.add(b.entity_id));
      anomaly = Math.max(anomaly, 0.85);
      findings.push(
        `${bestGroup.length} vessels share a coherent unexplained offset (bearing within ${config.coherent_bearing_tol_deg}°).`,
      );
    }
  }

  evidence.area_pattern = findings.length > 0;
  evidence.pattern_member_count = patternMembers.size;

  if (findings.length === 0 || !patternMembers.has(entityId)) {
    return {
      entity_id: entityId,
      check_id: 'fleet_coherence',
      status: 'pass',
      anomaly_score: 0,
      severity: 'none',
      observed_at: nowIso,
      explanation:
        findings.length === 0
          ? 'No area-wide unexplained displacement pattern across the fleet.'
          : `Area pattern present (${findings.join(' ')}) but this vessel's own motion is explained by its SOG/COG.`,
      source_ids: ['fleet'],
      quality: 0.85,
      freshness: 1,
      reliability: 0.85,
      missing_reason: null,
      evidence,
      hard_alert: false,
    };
  }

  const hard = anomaly >= 0.9;
  return {
    entity_id: entityId,
    check_id: 'fleet_coherence',
    status: anomaly >= 0.85 ? 'fail' : 'warning',
    anomaly_score: anomaly,
    severity: hard ? 'critical' : 'high',
    observed_at: nowIso,
    explanation: `This vessel is part of an area-wide pattern: ${findings.join(' ')}`,
    source_ids: ['fleet'],
    quality: 0.9,
    freshness: 1,
    reliability: 0.9,
    missing_reason: null,
    evidence,
    hard_alert: hard,
  };
}
