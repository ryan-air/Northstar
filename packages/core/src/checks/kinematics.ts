import type { CheckResult, PositionEvent, VesselClass } from '@northstar/contracts';
import { angleDiffDeg, bearingDeg, haversineM, knotsToMps, mpsToKnots } from '../geo/haversine.js';

export interface ClassLimits {
  max_sog_kn: number;
  max_accel_kn_s: number;
  max_rot_deg_min: number;
  max_jump_m: number;
}

export interface KinematicsConfig {
  min_dt_s: number;
  max_dt_s: number;
  uncertain_dt_skip: boolean;
  drift_cusum_threshold: number;
  drift_cusum_slack_m: number;
  vessel_class_limits: Record<VesselClass, ClassLimits>;
  /**
   * v2 (all optional — absent means exact v1 behaviour):
   * skip COG-derived checks (turn rate, course mismatch) below this SOG.
   */
  min_cog_sog_kn?: number;
  /** v2: prefer the AIS ROT field, then heading, for turn rate. */
  prefer_rot_field?: boolean;
  /** v2: CUSUM constants moved out of code. */
  cusum?: KinematicsCusumConfig;
}

export interface KinematicsCusumConfig {
  /** Fixed residual allowance (m). */
  slack_m: number;
  /** Additional allowance proportional to dt × speed (fraction of distance travelled). */
  speed_slack_frac: number;
  /** Residual normaliser (m per CUSUM unit). */
  scale_m: number;
  /** Per-step drift term subtracted from the CUSUM. */
  k: number;
  /** Multiplicative decay applied to the running CUSUM each step (1 = none). */
  decay: number;
  /** Warning threshold; fail at 1.5×. */
  threshold: number;
  /** Reset CUSUM after a reporting gap longer than this. */
  reset_gap_s: number;
  /**
   * Which prediction residual feeds the CUSUM. 'min' (v1 behaviour) takes the smaller of
   * the SOG/COG and constant-displacement predictions — the latter absorbs any constant
   * drift. 'reported' uses only the vessel's own SOG/COG prediction.
   */
  residual?: 'min' | 'reported';
}

export interface TrackPoint {
  event: PositionEvent;
}

export interface KinematicsState {
  cusum: number;
  lastPredicted?: { lat: number; lon: number };
  lastDispBearing?: number;
  lastImpliedMps?: number;
}

export function checkKinematics(
  current: PositionEvent,
  previous: PositionEvent | null,
  state: KinematicsState,
  config: KinematicsConfig,
  nowIso: string,
): { result: CheckResult; state: KinematicsState } {
  const vesselClass = (current.vessel_class ?? 'other') as VesselClass;
  const limits = config.vessel_class_limits[vesselClass] ?? config.vessel_class_limits.other;

  const findings: string[] = [];
  let anomaly = 0;
  let hard = false;
  const evidence: Record<string, unknown> = {};

  // Reported SOG check
  if (current.speed_over_ground_knots != null) {
    evidence.reported_sog_kn = current.speed_over_ground_knots;
    if (current.speed_over_ground_knots > limits.max_sog_kn * 1.5) {
      anomaly = Math.max(anomaly, 1);
      hard = true;
      findings.push(
        `Reported SOG ${current.speed_over_ground_knots.toFixed(1)} kn exceeds impossible threshold for ${vesselClass} (limit ${limits.max_sog_kn} kn).`,
      );
    } else if (current.speed_over_ground_knots > limits.max_sog_kn) {
      anomaly = Math.max(anomaly, 0.7);
      findings.push(
        `Reported SOG ${current.speed_over_ground_knots.toFixed(1)} kn exceeds configured plausible range for ${vesselClass}.`,
      );
    }
  }

  if (!previous) {
    return {
      state,
      result: baseResult(current, nowIso, anomaly, findings, evidence, hard, state),
    };
  }

  const t0 = Date.parse(previous.source_timestamp);
  const t1 = Date.parse(current.source_timestamp);
  const dtS = (t1 - t0) / 1000;
  evidence.dt_s = dtS;

  if (dtS <= 0 || !Number.isFinite(dtS)) {
    findings.push('Unreliable time interval between fixes; displacement-speed check skipped.');
    return {
      state,
      result: baseResult(current, nowIso, anomaly, findings, evidence, hard, state, 'warning'),
    };
  }

  if (dtS < config.min_dt_s) {
    if (config.uncertain_dt_skip) {
      findings.push(
        `Time interval ${dtS.toFixed(1)}s is below the reliable minimum ${config.min_dt_s}s; jump/accel checks skipped.`,
      );
      // Still check reported SOG above
      return {
        state,
        result: baseResult(current, nowIso, anomaly, findings, evidence, hard, state),
      };
    }
  }

  const distM = haversineM(
    previous.position.lat,
    previous.position.lon,
    current.position.lat,
    current.position.lon,
  );
  evidence.displacement_m = distM;

  // Teleport / jump
  const gapReachabilityM = knotsToMps(limits.max_sog_kn) * dtS * 1.5;
  const maxPlausible =
    dtS > config.max_dt_s
      ? gapReachabilityM
      : limits.max_jump_m + gapReachabilityM;
  if (distM > maxPlausible) {
    anomaly = Math.max(anomaly, 1);
    hard = true;
    findings.push(
      dtS > config.max_dt_s
        ? `After a ${dtS.toFixed(1)} s reporting gap, displacement ${distM.toFixed(0)} m exceeds the maximum reachable distance (${maxPlausible.toFixed(0)} m).`
        : `Sudden position jump of ${distM.toFixed(0)} m in ${dtS.toFixed(1)} s exceeds kinematic limit (${maxPlausible.toFixed(0)} m).`,
    );
  } else if (distM > limits.max_jump_m && dtS < 10) {
    anomaly = Math.max(anomaly, 0.85);
    findings.push(`Large short-interval displacement of ${distM.toFixed(0)} m in ${dtS.toFixed(1)} s.`);
  }

  // Implied speed
  const impliedMps = distM / dtS;
  const impliedKn = mpsToKnots(impliedMps);
  evidence.implied_sog_kn = impliedKn;
  const dispBearing = bearingDeg(
    previous.position.lat,
    previous.position.lon,
    current.position.lat,
    current.position.lon,
  );
  evidence.disp_bearing_deg = dispBearing;
  if (impliedKn > limits.max_sog_kn * 1.8) {
    anomaly = Math.max(anomaly, 1);
    hard = true;
    findings.push(
      `Implied speed ${impliedKn.toFixed(1)} kn from displacement is impossible for ${vesselClass}.`,
    );
  } else if (impliedKn > limits.max_sog_kn * 1.2) {
    anomaly = Math.max(anomaly, 0.75);
    findings.push(`Implied speed ${impliedKn.toFixed(1)} kn exceeds plausible range.`);
  }

  const v2 = config.min_cog_sog_kn != null;
  const cogUsable = (e: PositionEvent) =>
    !v2 || (e.speed_over_ground_knots != null && e.speed_over_ground_knots >= config.min_cog_sog_kn!);
  if (v2 && !cogUsable(current)) evidence.cog_checks_skipped = 'sog_below_min_cog_sog';
  // v2: over a gap longer than max_dt_s the vessel may have manoeuvred — a single
  // reported COG says nothing about the averaged displacement bearing.
  const gapOk = !v2 || dtS <= config.max_dt_s;
  if (v2 && !gapOk) evidence.course_check_skipped = 'gap_exceeds_max_dt';
  if (distM > 50 && current.course_over_ground_deg != null && cogUsable(current) && gapOk) {
    const courseMismatch = Math.abs(angleDiffDeg(current.course_over_ground_deg, dispBearing));
    evidence.reported_derived_course_diff_deg = courseMismatch;
    if (courseMismatch > 45) {
      anomaly = Math.max(anomaly, 0.75);
      findings.push(
        `Reported course differs from derived displacement bearing by ${courseMismatch.toFixed(1)}° over ${distM.toFixed(0)} m.`,
      );
    }
  }

  // Acceleration
  if (previous.speed_over_ground_knots != null && current.speed_over_ground_knots != null) {
    const accel = Math.abs(current.speed_over_ground_knots - previous.speed_over_ground_knots) / dtS;
    evidence.accel_kn_s = accel;
    if (accel > limits.max_accel_kn_s * 3) {
      anomaly = Math.max(anomaly, 0.9);
      findings.push(`Excessive acceleration ${accel.toFixed(3)} kn/s.`);
    } else if (accel > limits.max_accel_kn_s) {
      anomaly = Math.max(anomaly, 0.55);
      findings.push(`Elevated acceleration ${accel.toFixed(3)} kn/s.`);
    }
  }

  // Turn rate
  let rotDegMin: number | null = null;
  if (v2 && config.prefer_rot_field && current.rot_deg_min != null && Number.isFinite(current.rot_deg_min)) {
    rotDegMin = Math.abs(current.rot_deg_min);
    evidence.rot_source = 'ais_rot';
  } else if (
    v2 &&
    config.prefer_rot_field &&
    previous.heading_deg != null &&
    current.heading_deg != null &&
    cogUsable(previous) &&
    cogUsable(current)
  ) {
    rotDegMin = (Math.abs(angleDiffDeg(previous.heading_deg, current.heading_deg)) / dtS) * 60;
    evidence.rot_source = 'heading';
  } else if (
    previous.course_over_ground_deg != null &&
    current.course_over_ground_deg != null &&
    cogUsable(previous) &&
    cogUsable(current)
  ) {
    const dCog = Math.abs(angleDiffDeg(previous.course_over_ground_deg, current.course_over_ground_deg));
    rotDegMin = (dCog / dtS) * 60;
    if (v2) evidence.rot_source = 'cog';
  }
  if (rotDegMin != null) {
    const rot = rotDegMin;
    evidence.rot_deg_min = rot;
    if (rot > limits.max_rot_deg_min * 2.5) {
      anomaly = Math.max(anomaly, 0.85);
      findings.push(`Implausible turn rate ${rot.toFixed(1)} °/min.`);
    } else if (rot > limits.max_rot_deg_min) {
      anomaly = Math.max(anomaly, 0.5);
      findings.push(`Elevated turn rate ${rot.toFixed(1)} °/min.`);
    }
  }

  // Gradual drift via CUSUM of reported and displacement-derived constant-velocity predictions.
  const nextState = { ...state };
  const predictionResiduals: number[] = [];
  if (previous.speed_over_ground_knots != null && previous.course_over_ground_deg != null) {
    const predDist = knotsToMps(previous.speed_over_ground_knots) * dtS;
    const predBearing = previous.course_over_ground_deg;
    // predicted point
    const { destination } = requireDestination();
    const pred = destination(
      previous.position.lat,
      previous.position.lon,
      predBearing,
      predDist,
    );
    nextState.lastPredicted = pred;
    const crossTrack = haversineM(current.position.lat, current.position.lon, pred.lat, pred.lon);
    evidence.cross_track_m = crossTrack;
    predictionResiduals.push(crossTrack);
  }

  if (state.lastDispBearing != null && state.lastImpliedMps != null) {
    const { destination } = requireDestination();
    const dispPred = destination(
      previous.position.lat,
      previous.position.lon,
      state.lastDispBearing,
      state.lastImpliedMps * dtS,
    );
    const dispResidual = haversineM(
      current.position.lat,
      current.position.lon,
      dispPred.lat,
      dispPred.lon,
    );
    evidence.displacement_prediction_m = dispResidual;
    predictionResiduals.push(dispResidual);
  }

  const cz = config.cusum;
  if (cz && dtS > cz.reset_gap_s) {
    // Long gap: prediction is meaningless, start the accumulator over.
    nextState.cusum = 0;
    evidence.drift_cusum = 0;
    evidence.cusum_reset = `gap ${dtS.toFixed(0)} s > ${cz.reset_gap_s} s`;
  } else if (
    cz &&
    config.min_cog_sog_kn != null &&
    (previous.speed_over_ground_knots ?? 0) < config.min_cog_sog_kn &&
    (current.speed_over_ground_knots ?? 0) >= config.min_cog_sog_kn
  ) {
    // Stationary → underway transition (departure): a constant-velocity prediction from
    // SOG≈0 is meaningless. Hold the accumulator; jump/implied-speed checks still run.
    nextState.cusum = cz.decay * (state.cusum || 0);
    evidence.drift_cusum = nextState.cusum;
    evidence.cusum_hold = 'stationary_to_underway';
  } else if (predictionResiduals.length > 0) {
    const reportedOnly = cz?.residual === 'reported' && evidence.cross_track_m != null;
    const predictionResidual = reportedOnly
      ? (evidence.cross_track_m as number)
      : Math.min(...predictionResiduals);
    let threshold = config.drift_cusum_threshold;
    if (cz) {
      const speedMps = knotsToMps(
        Math.max(previous.speed_over_ground_knots ?? 0, current.speed_over_ground_knots ?? 0),
      );
      const slack = cz.slack_m + cz.speed_slack_frac * dtS * speedMps;
      const residual = Math.max(0, predictionResidual - slack);
      nextState.cusum = Math.max(0, cz.decay * (state.cusum || 0) + residual / cz.scale_m - cz.k);
      threshold = cz.threshold;
      evidence.cusum_slack_m = slack;
    } else {
      const residual = Math.max(0, predictionResidual - config.drift_cusum_slack_m);
      nextState.cusum = Math.max(0, (state.cusum || 0) + residual / 40 - 0.4);
    }
    evidence.drift_cusum = nextState.cusum;

    if (nextState.cusum > threshold * 1.5) {
      anomaly = Math.max(anomaly, 0.9);
      findings.push(
        `Gradual trajectory drift detected (CUSUM ${nextState.cusum.toFixed(2)}): position diverges from kinematic prediction.`,
      );
    } else if (nextState.cusum > threshold) {
      anomaly = Math.max(anomaly, 0.65);
      findings.push(`Emerging trajectory drift (CUSUM ${nextState.cusum.toFixed(2)}).`);
    }
  }
  nextState.lastDispBearing = dispBearing;
  nextState.lastImpliedMps = impliedMps;

  return {
    state: nextState,
    result: baseResult(current, nowIso, anomaly, findings, evidence, hard, nextState),
  };
}

function requireDestination() {
  // inline to keep module self-contained for tests
  return {
    destination: (
      lat: number,
      lon: number,
      bearingDegVal: number,
      distanceM: number,
    ): { lat: number; lon: number } => {
      const R = 6371000;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const toDeg = (r: number) => (r * 180) / Math.PI;
      const δ = distanceM / R;
      const θ = toRad(bearingDegVal);
      const φ1 = toRad(lat);
      const λ1 = toRad(lon);
      const φ2 = Math.asin(
        Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
      );
      const λ2 =
        λ1 +
        Math.atan2(
          Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
          Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
        );
      return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
    },
  };
}

function baseResult(
  current: PositionEvent,
  nowIso: string,
  anomaly: number,
  findings: string[],
  evidence: Record<string, unknown>,
  hard: boolean,
  state: KinematicsState,
  forceStatus?: CheckResult['status'],
): CheckResult {
  let status: CheckResult['status'] = 'pass';
  if (anomaly >= 0.85) status = 'fail';
  else if (anomaly >= 0.4) status = 'warning';
  if (forceStatus) status = forceStatus;

  const explanation =
    findings.length > 0
      ? findings.join(' ')
      : 'Trajectory and reported kinematics are within configured limits.';

  return {
    entity_id: current.entity_id,
    check_id: 'kinematics',
    status,
    anomaly_score: anomaly,
    severity: hard ? 'critical' : anomaly >= 0.85 ? 'high' : anomaly >= 0.4 ? 'medium' : 'none',
    observed_at: nowIso,
    explanation,
    source_ids: [current.source],
    quality: 0.9,
    freshness: 1,
    reliability: 1,
    missing_reason: null,
    evidence: { ...evidence, cusum: state.cusum },
    hard_alert: hard,
  };
}
