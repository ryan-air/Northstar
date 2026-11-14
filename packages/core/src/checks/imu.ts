import type { CheckResult, ImuSample, PositionEvent } from '@northstar/contracts';
import { haversineM, knotsToMps } from '../geo/haversine.js';

export interface ImuConfig {
  accel_noise_mps2: number;
  gyro_noise_rads: number;
  bias_random_walk: number;
  residual_fail_sigma: number;
  residual_warn_sigma: number;
}

export interface DeadReckonState {
  lat: number;
  lon: number;
  sog_mps: number;
  cog_rad: number;
  variance_m2: number;
  last_t: number;
}

/**
 * Compare GNSS-derived movement with IMU/INS dead reckoning.
 * Uncertainty grows with time; IMU is never indefinite ground truth.
 */
export function checkImuConsistency(
  current: PositionEvent,
  previous: PositionEvent | null,
  imu: ImuSample | null,
  dr: DeadReckonState | null,
  config: ImuConfig,
  nowIso: string,
): { result: CheckResult; dr: DeadReckonState | null } {
  if (!imu) {
    return {
      dr,
      result: {
        entity_id: current.entity_id,
        check_id: 'imu',
        status: 'unavailable',
        anomaly_score: null,
        severity: 'none',
        observed_at: nowIso,
        explanation: 'IMU/INS stream unavailable. Live status: Unavailable.',
        source_ids: [],
        quality: 0,
        freshness: 0,
        reliability: 0,
        missing_reason: 'No physical IMU connected',
        evidence: {},
        hard_alert: false,
      },
    };
  }

  const simulated = imu.labels?.simulated === true;
  if (!previous || !dr) {
    const sog = knotsToMps(current.speed_over_ground_knots ?? 0);
    const cog = ((current.course_over_ground_deg ?? 0) * Math.PI) / 180;
    const init: DeadReckonState = {
      lat: current.position.lat,
      lon: current.position.lon,
      sog_mps: sog,
      cog_rad: cog,
      variance_m2: 25,
      last_t: Date.parse(current.source_timestamp),
    };
    return {
      dr: init,
      result: {
        entity_id: current.entity_id,
        check_id: 'imu',
        status: 'pending',
        anomaly_score: 0,
        severity: 'none',
        observed_at: nowIso,
        explanation: `Dead-reckoning filter initializing.`,
        source_ids: [simulated ? 'imu_simulated' : 'imu'],
        quality: 0.5,
        freshness: 1,
        reliability: simulated ? 0.4 : 0.7,
        missing_reason: null,
        evidence: { variance_m2: init.variance_m2 },
        hard_alert: false,
      },
    };
  }

  const t1 = Date.parse(current.source_timestamp);
  const dt = (t1 - dr.last_t) / 1000;
  if (dt <= 0) {
    return {
      dr,
      result: {
        entity_id: current.entity_id,
        check_id: 'imu',
        status: 'warning',
        anomaly_score: 0.2,
        severity: 'low',
        observed_at: nowIso,
        explanation: 'Non-positive dt for IMU integration; skipped.',
        source_ids: [simulated ? 'imu_simulated' : 'imu'],
        quality: 0.4,
        freshness: 0.5,
        reliability: 0.4,
        missing_reason: null,
        evidence: {},
        hard_alert: false,
      },
    };
  }

  // Integrate: use forward accel along-track (ax) and yaw rate (gz)
  const ax = imu.accel_mps2[0];
  const gz = imu.gyro_rads[2];
  const sog = Math.max(0, dr.sog_mps + ax * dt);
  const cog = dr.cog_rad + gz * dt;
  const dist = ((dr.sog_mps + sog) / 2) * dt;
  const R = 6371000;
  const dLat = ((dist * Math.cos(cog)) / R) * (180 / Math.PI);
  const dLon =
    ((dist * Math.sin(cog)) / (R * Math.cos((dr.lat * Math.PI) / 180))) * (180 / Math.PI);
  const predLat = dr.lat + dLat;
  const predLon = dr.lon + dLon;

  // Uncertainty growth
  const processNoise =
    (config.accel_noise_mps2 * dt) ** 2 * 100 +
    config.bias_random_walk * dt * 1000 +
    (config.gyro_noise_rads * dt * sog * 50) ** 2;
  const variance = dr.variance_m2 + processNoise;
  const sigma = Math.sqrt(variance);

  const residual = haversineM(current.position.lat, current.position.lon, predLat, predLon);
  const norm = residual / Math.max(sigma, 1);
  let anomaly = 0;
  let status: CheckResult['status'] = 'pass';
  let explanation: string;
  if (norm >= config.residual_fail_sigma) {
    anomaly = Math.min(1, norm / 8);
    status = 'fail';
    explanation = `GNSS–IMU residual ${residual.toFixed(0)} m (${norm.toFixed(1)}σ) exceeds threshold; inertial estimate disagrees with reported fix. IMU uncertainty σ≈${sigma.toFixed(0)} m.`;
  } else if (norm >= config.residual_warn_sigma) {
    anomaly = Math.min(0.7, norm / 8);
    status = 'warning';
    explanation = `Elevated GNSS–IMU residual ${residual.toFixed(0)} m (${norm.toFixed(1)}σ).`;
  } else {
    explanation = `GNSS and dead-reckoning agree within uncertainty (${residual.toFixed(0)} m, ${norm.toFixed(1)}σ, σ≈${sigma.toFixed(0)} m).`;
  }

  // Soft-reset DR toward GNSS when consistent; when disagreeing keep DR for evidence
  const alpha = status === 'pass' ? 0.5 : 0.1;
  const next: DeadReckonState = {
    lat: predLat * (1 - alpha) + current.position.lat * alpha,
    lon: predLon * (1 - alpha) + current.position.lon * alpha,
    sog_mps: sog,
    cog_rad: cog,
    variance_m2: status === 'pass' ? Math.max(25, variance * 0.7) : variance,
    last_t: t1,
  };

  return {
    dr: next,
    result: {
      entity_id: current.entity_id,
      check_id: 'imu',
      status,
      anomaly_score: anomaly,
      severity: status === 'fail' ? 'high' : status === 'warning' ? 'medium' : 'none',
      observed_at: nowIso,
      explanation,
      source_ids: [simulated ? 'imu_simulated' : 'imu', current.source],
      quality: simulated ? 0.5 : 0.8,
      freshness: 1,
      reliability: simulated ? 0.45 : 0.75,
      missing_reason: null,
      evidence: {
        residual_m: residual,
        sigma_m: sigma,
        normalized_residual: norm,
        simulated,
      },
      hard_alert: false,
    },
  };
}
