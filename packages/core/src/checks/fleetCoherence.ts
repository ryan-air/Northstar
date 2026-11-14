import type { CheckResult, PositionEvent } from '@northstar/contracts';
import { haversineM } from '../geo/haversine.js';

/** Known Baltic airport / inland spoof attractors (approx). */
export const BALTIC_SPOOF_ATTRACTORS = [
  { id: 'HEL', name: 'Helsinki-Vantaa', lat: 60.317, lon: 24.963 },
  { id: 'TLL', name: 'Tallinn Airport', lat: 59.413, lon: 24.833 },
  { id: 'URN', name: 'Utti', lat: 60.897, lon: 26.938 },
] as const;

export interface FleetDisplacement {
  entity_id: string;
  prev_lat: number;
  prev_lon: number;
  lat: number;
  lon: number;
  dist_m: number;
  d_lat: number;
  d_lon: number;
  /** v2 (optional): seconds between the two fixes. */
  dt_s?: number;
  /** v2 (optional): SOG/COG reported at the earlier fix — used to predict motion. */
  from_sog_kn?: number | null;
  from_cog_deg?: number | null;
  /** v2 (optional): SOG reported at the later fix. */
  to_sog_kn?: number | null;
}

export interface FleetCoherenceConfig {
  min_vessels: number;
  jump_m: number;
  cluster_radius_m: number;
  airport_radius_m: number;
  coherent_offset_m: number;
  coherent_bearing_tol_deg: number;
}

export const DEFAULT_FLEET_COHERENCE: FleetCoherenceConfig = {
  min_vessels: 4,
  jump_m: 2000,
  cluster_radius_m: 1500,
  airport_radius_m: 3000,
  coherent_offset_m: 800,
  coherent_bearing_tol_deg: 25,
};

export function displacementsFromEvents(
  current: PositionEvent,
  previousById: Map<string, PositionEvent>,
  peers: PositionEvent[],
): FleetDisplacement[] {
  const all = [current, ...peers.filter((p) => p.entity_id !== current.entity_id)];
  const out: FleetDisplacement[] = [];
  for (const e of all) {
    const prev = previousById.get(e.entity_id);
    if (!prev) continue;
    const dist_m = haversineM(prev.position.lat, prev.position.lon, e.position.lat, e.position.lon);
    out.push({
      entity_id: e.entity_id,
      prev_lat: prev.position.lat,
      prev_lon: prev.position.lon,
      lat: e.position.lat,
      lon: e.position.lon,
      dist_m,
      d_lat: e.position.lat - prev.position.lat,
      d_lon: e.position.lon - prev.position.lon,
    });
  }
  return out;
}

/**
 * Detect area-wide coherent spoofing: many vessels jumping to a common point,
 * clustering near known airports, or sharing a large coherent offset.
 */
export function checkFleetCoherence(
  entityId: string,
  displacements: FleetDisplacement[],
  nowIso: string,
  config: FleetCoherenceConfig = DEFAULT_FLEET_COHERENCE,
): CheckResult {
  if (displacements.length < 2) {
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

  const findings: string[] = [];
  let anomaly = 0;
  const evidence: Record<string, unknown> = {
    sample_count: displacements.length,
  };

  const jumpers = displacements.filter((d) => d.dist_m >= config.jump_m);
  evidence.jumper_count = jumpers.length;

  // Common destination cluster among large jumps
  if (jumpers.length >= config.min_vessels) {
    let bestCluster = 0;
    let clusterLat = 0;
    let clusterLon = 0;
    for (const seed of jumpers) {
      const near = jumpers.filter(
        (o) => haversineM(seed.lat, seed.lon, o.lat, o.lon) <= config.cluster_radius_m,
      );
      if (near.length > bestCluster) {
        bestCluster = near.length;
        clusterLat = seed.lat;
        clusterLon = seed.lon;
      }
    }
    evidence.common_cluster_size = bestCluster;
    evidence.common_cluster = { lat: clusterLat, lon: clusterLon };
    if (bestCluster >= config.min_vessels) {
      anomaly = Math.max(anomaly, 0.95);
      findings.push(
        `${bestCluster} vessels jumped ≥${config.jump_m} m toward a common cluster (~${clusterLat.toFixed(3)}, ${clusterLon.toFixed(3)}).`,
      );
    }
  }

  // Airport / inland attractor clustering
  const nearAirport = displacements.filter((d) =>
    BALTIC_SPOOF_ATTRACTORS.some(
      (a) => haversineM(d.lat, d.lon, a.lat, a.lon) <= config.airport_radius_m,
    ),
  );
  evidence.near_airport_count = nearAirport.length;
  if (nearAirport.length >= config.min_vessels) {
    const attractor = BALTIC_SPOOF_ATTRACTORS.find((a) =>
      nearAirport.some((d) => haversineM(d.lat, d.lon, a.lat, a.lon) <= config.airport_radius_m),
    );
    anomaly = Math.max(anomaly, 0.9);
    findings.push(
      `${nearAirport.length} vessels clustered near ${attractor?.name ?? 'a known spoof attractor'} — signature of area-wide GNSS interference.`,
    );
  }

  // Coherent offset: similar displacement vectors
  const large = displacements.filter((d) => d.dist_m >= config.coherent_offset_m);
  if (large.length >= config.min_vessels) {
    const bearings = large.map((d) => (Math.atan2(d.d_lon, d.d_lat) * 180) / Math.PI);
    let coherent = 0;
    for (let i = 0; i < bearings.length; i++) {
      const b0 = bearings[i]!;
      const peers = bearings.filter((b) => {
        let diff = Math.abs(b - b0) % 360;
        if (diff > 180) diff = 360 - diff;
        return diff <= config.coherent_bearing_tol_deg;
      }).length;
      coherent = Math.max(coherent, peers);
    }
    evidence.coherent_offset_count = coherent;
    if (coherent >= config.min_vessels) {
      anomaly = Math.max(anomaly, 0.85);
      findings.push(
        `${coherent} vessels share a coherent large offset (≥${config.coherent_offset_m} m) — fleet-wide displacement pattern.`,
      );
    }
  }

  if (findings.length === 0) {
    return {
      entity_id: entityId,
      check_id: 'fleet_coherence',
      status: 'pass',
      anomaly_score: 0,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'No area-wide coherent displacement pattern detected across the fleet.',
      source_ids: ['ais_provider_a'],
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
    explanation: findings.join(' '),
    source_ids: ['ais_provider_a'],
    quality: 0.9,
    freshness: 1,
    reliability: 0.9,
    missing_reason: null,
    evidence,
    hard_alert: hard,
  };
}
