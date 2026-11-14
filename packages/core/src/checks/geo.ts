import type { CheckResult, PositionEvent } from '@northstar/contracts';
import type { LandIndex } from '../geo/landIndex.js';
import { pointInPolygon, type PolygonFeature } from '../geo/pointInPolygon.js';

export interface GeoConfig {
  shore_buffer_m: number;
  port_buffer_m: number;
  warning_inland_m: number;
  fail_inland_m: number;
}

export interface GeoContext {
  land: LandIndex;
  ports: Array<{ id: string; geometry: PolygonFeature }>;
  restricted: Array<{ id: string; geometry: PolygonFeature; name?: string }>;
}

export function checkGeographic(
  event: PositionEvent,
  ctx: GeoContext,
  config: GeoConfig,
  nowIso: string,
): CheckResult {
  const { lon, lat } = event.position;
  const accuracy = event.quality.position_accuracy_m ?? 50;
  const landHit = ctx.land.query(lon, lat);

  const evidence: Record<string, unknown> = {
    on_land: landHit.onLand,
    inland_depth_m: landHit.inlandDepthM,
    accuracy_m: accuracy,
    land_feature: landHit.featureId,
  };

  // Restricted / impossible regions
  for (const zone of ctx.restricted) {
    if (pointInPolygon(lon, lat, zone.geometry)) {
      return {
        entity_id: event.entity_id,
        check_id: 'geographic',
        status: 'fail',
        anomaly_score: 1,
        severity: 'critical',
        observed_at: nowIso,
        explanation: `Position reported inside restricted/impossible region ${zone.name ?? zone.id}.`,
        source_ids: [event.source, 'geo_restricted'],
        quality: 0.95,
        freshness: 1,
        reliability: 0.95,
        missing_reason: null,
        evidence: { ...evidence, restricted_zone: zone.id },
        hard_alert: true,
      };
    }
  }

  // Port tolerance
  let inPort = false;
  for (const port of ctx.ports) {
    if (pointInPolygon(lon, lat, port.geometry)) {
      inPort = true;
      evidence.port_id = port.id;
      break;
    }
  }

  if (!landHit.onLand) {
    return {
      entity_id: event.entity_id,
      check_id: 'geographic',
      status: 'pass',
      anomaly_score: 0,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'Reported position is in water (not inside land polygons).',
      source_ids: [event.source, 'geo_land'],
      quality: 0.9,
      freshness: 1,
      reliability: 0.9,
      missing_reason: null,
      evidence,
      hard_alert: false,
    };
  }

  // On land
  const depth = landHit.inlandDepthM;
  if (inPort && depth < config.port_buffer_m) {
    return {
      entity_id: event.entity_id,
      check_id: 'geographic',
      status: 'warning',
      anomaly_score: 0.25,
      severity: 'low',
      observed_at: nowIso,
      explanation: `Position overlaps land but is within port area ${evidence.port_id}; treated as caution, not proof of spoofing.`,
      source_ids: [event.source, 'geo_land', 'geo_port'],
      quality: 0.85,
      freshness: 1,
      reliability: 0.85,
      missing_reason: null,
      evidence,
      hard_alert: false,
    };
  }

  // Grade by inland depth vs accuracy
  if (depth > config.fail_inland_m && accuracy <= 100) {
    return {
      entity_id: event.entity_id,
      check_id: 'geographic',
      status: 'fail',
      anomaly_score: 1,
      severity: 'critical',
      observed_at: nowIso,
      explanation: `Position well inland (~${depth.toFixed(0)} m from shore vertex) with reported accuracy ${accuracy} m — strong geographic conflict.`,
      source_ids: [event.source, 'geo_land'],
      quality: 0.95,
      freshness: 1,
      reliability: 0.95,
      missing_reason: null,
      evidence,
      hard_alert: true,
    };
  }

  if (depth > config.warning_inland_m || depth > accuracy) {
    return {
      entity_id: event.entity_id,
      check_id: 'geographic',
      status: 'warning',
      anomaly_score: 0.7,
      severity: 'high',
      observed_at: nowIso,
      explanation: `Position appears on land (~${depth.toFixed(0)} m inland). Map matching is evidence, not proof; shore/dry-dock ambiguity remains.`,
      source_ids: [event.source, 'geo_land'],
      quality: 0.85,
      freshness: 1,
      reliability: 0.85,
      missing_reason: null,
      evidence,
      hard_alert: false,
    };
  }

  return {
    entity_id: event.entity_id,
    check_id: 'geographic',
    status: 'warning',
    anomaly_score: 0.45,
    severity: 'medium',
    observed_at: nowIso,
    explanation: `Near-shore land overlap within accuracy envelope (${accuracy} m); low confidence geographic anomaly.`,
    source_ids: [event.source, 'geo_land'],
    quality: 0.7,
    freshness: 1,
    reliability: 0.7,
    missing_reason: null,
    evidence,
    hard_alert: false,
  };
}
