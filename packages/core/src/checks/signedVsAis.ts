import type { CheckResult, PositionEvent } from '@northstar/contracts';
import { haversineM } from '../geo/haversine.js';

export interface SignedVsAisConfig {
  warn_m: number;
  fail_m: number;
}

export const DEFAULT_SIGNED_VS_AIS: SignedVsAisConfig = {
  warn_m: 500,
  fail_m: 2000,
};

/**
 * Compare signed onboard telemetry against the last AIS position for the same entity.
 * Independent device positions make AIS spoofing visible as disagreement.
 */
export function checkSignedVsAis(
  signed: PositionEvent,
  ais: PositionEvent | null,
  nowIso: string,
  config: SignedVsAisConfig = DEFAULT_SIGNED_VS_AIS,
): CheckResult {
  if (signed.source !== 'device_telemetry') {
    return {
      entity_id: signed.entity_id,
      check_id: 'signed_vs_ais',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'Signed-vs-AIS comparison only runs on device_telemetry observations.',
      source_ids: [],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'Not a signed device observation',
      hard_alert: false,
    };
  }

  if (!ais) {
    return {
      entity_id: signed.entity_id,
      check_id: 'signed_vs_ais',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'No AIS position available to compare against signed onboard data.',
      source_ids: ['device_telemetry'],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'No AIS counterpart',
      hard_alert: false,
    };
  }

  const distM = haversineM(
    signed.position.lat,
    signed.position.lon,
    ais.position.lat,
    ais.position.lon,
  );
  const evidence = {
    distance_m: distM,
    signed_lat: signed.position.lat,
    signed_lon: signed.position.lon,
    ais_lat: ais.position.lat,
    ais_lon: ais.position.lon,
    ais_source: ais.source,
    warn_m: config.warn_m,
    fail_m: config.fail_m,
  };

  if (distM >= config.fail_m) {
    return {
      entity_id: signed.entity_id,
      check_id: 'signed_vs_ais',
      status: 'fail',
      anomaly_score: 1,
      severity: 'critical',
      observed_at: nowIso,
      explanation: `Signed onboard position disagrees with AIS by ${distM.toFixed(0)} m (fail ≥ ${config.fail_m} m). Possible AIS spoof or onboard GNSS fault.`,
      source_ids: ['device_telemetry', ais.source],
      quality: 0.95,
      freshness: 1,
      reliability: 1,
      missing_reason: null,
      evidence,
      hard_alert: true,
    };
  }

  if (distM >= config.warn_m) {
    return {
      entity_id: signed.entity_id,
      check_id: 'signed_vs_ais',
      status: 'warning',
      anomaly_score: 0.65,
      severity: 'high',
      observed_at: nowIso,
      explanation: `Signed onboard position disagrees with AIS by ${distM.toFixed(0)} m (warn ≥ ${config.warn_m} m).`,
      source_ids: ['device_telemetry', ais.source],
      quality: 0.9,
      freshness: 1,
      reliability: 0.95,
      missing_reason: null,
      evidence,
      hard_alert: false,
    };
  }

  return {
    entity_id: signed.entity_id,
    check_id: 'signed_vs_ais',
    status: 'pass',
    anomaly_score: 0,
    severity: 'none',
    observed_at: nowIso,
    explanation: `Signed onboard position agrees with AIS within ${distM.toFixed(0)} m.`,
    source_ids: ['device_telemetry', ais.source],
    quality: 0.95,
    freshness: 1,
    reliability: 1,
    missing_reason: null,
    evidence,
    hard_alert: false,
  };
}
