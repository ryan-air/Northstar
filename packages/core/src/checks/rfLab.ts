import type { CheckResult, RfLabResult } from '@northstar/contracts';

/** Lab IQ capture present and healthy (instrumented vessel only). */
export function checkRfLab(
  entityId: string,
  result: RfLabResult | null,
  nowIso: string,
): CheckResult {
  if (!result || result.mode === 'not_connected') {
    return {
      entity_id: entityId,
      check_id: 'rf_lab',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation:
        'No lab dual-antenna IQ attached. RF lab evidence is only on the full-stack Hist Lab vessel.',
      source_ids: [],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'No rf_lab result for this entity',
      evidence: { mode: result?.mode ?? 'not_connected' },
      hard_alert: false,
    };
  }

  const overlay = result.spoof_overlay
    ? ` Overlay: ${result.spoof_overlay}.`
    : '';
  const base = `[Lab IQ ${result.antennas}-ant @ ${(result.sample_rate_hz / 1e6).toFixed(1)} MS/s, fc ${(result.center_freq_hz / 1e6).toFixed(3)} MHz] `;

  if (result.status === 'fail') {
    return {
      entity_id: entityId,
      check_id: 'rf_lab',
      status: 'fail',
      anomaly_score: 0.7,
      severity: 'high',
      observed_at: result.observed_at,
      explanation: `${base}${result.reason ?? 'RF lab quality failed.'}${overlay}`,
      source_ids: ['rf_lab', result.layout_id],
      quality: 0.85,
      freshness: 1,
      reliability: 0.75,
      missing_reason: null,
      evidence: {
        antennas: result.antennas,
        center_freq_hz: result.center_freq_hz,
        spoof_overlay: result.spoof_overlay,
        metrics: result.metrics,
      },
      hard_alert: false,
    };
  }

  if (result.status === 'warning') {
    return {
      entity_id: entityId,
      check_id: 'rf_lab',
      status: 'warning',
      anomaly_score: 0.35,
      severity: 'medium',
      observed_at: result.observed_at,
      explanation: `${base}${result.reason ?? 'RF lab warning.'}${overlay}`,
      source_ids: ['rf_lab', result.layout_id],
      quality: 0.7,
      freshness: 1,
      reliability: 0.7,
      missing_reason: null,
      evidence: {
        antennas: result.antennas,
        center_freq_hz: result.center_freq_hz,
        metrics: result.metrics,
      },
      hard_alert: false,
    };
  }

  return {
    entity_id: entityId,
    check_id: 'rf_lab',
    status: 'pass',
    anomaly_score: 0,
    severity: 'none',
    observed_at: result.observed_at,
    explanation: `${base}Dual-antenna lab capture attached.${result.fc_note ? ` ${result.fc_note}.` : ''}${overlay}`,
    source_ids: ['rf_lab', result.layout_id],
    quality: 0.9,
    freshness: 1,
    reliability: 0.8,
    missing_reason: null,
    evidence: {
      antennas: result.antennas,
      sample_rate_hz: result.sample_rate_hz,
      center_freq_hz: result.center_freq_hz,
      metrics: result.metrics,
    },
    hard_alert: false,
  };
}

/** Spatial AoA / phase-interferometry check from lab dual-ant IQ. */
export function checkSpatialAoa(
  entityId: string,
  result: RfLabResult | null,
  nowIso: string,
): CheckResult {
  if (!result || result.mode === 'not_connected') {
    return {
      entity_id: entityId,
      check_id: 'spatial_aoa',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation:
        'Angle-of-arrival unavailable — no dual-antenna lab IQ on this vessel (LIVE AIS has no RF array).',
      source_ids: [],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'No spatial_aoa / rf_lab result',
      evidence: {},
      hard_alert: false,
    };
  }

  const dirs = result.aoa?.directions_deg ?? [];
  const cluster = result.aoa?.cluster_score;
  const coherence = result.aoa?.coherence;
  const overlay = result.spoof_overlay
    ? ` [${result.spoof_overlay}]`
    : '';
  const dirStr = dirs.length
    ? ` DoA proxy ${dirs.map((d: number) => d.toFixed(1)).join(', ')}°.`
    : '';
  const clusterStr =
    cluster != null ? ` Cluster score ${cluster.toFixed(2)} (higher = more spatial diversity).` : '';
  const coherenceStr =
    coherence != null ? ` Coherence ${coherence.toFixed(2)}.` : '';

  if (result.aoa_status === 'fail') {
    return {
      entity_id: entityId,
      check_id: 'spatial_aoa',
      status: 'fail',
      anomaly_score: 0.85,
      severity: 'high',
      observed_at: result.observed_at,
      explanation: `[${result.antennas}-ant AoA${result.mode === 'lab_iq_recorded' ? ', recorded' : ''}]${overlay} Single-direction-like spatial signature.${dirStr}${clusterStr}${coherenceStr} ${result.reason ?? ''}`.trim(),
      source_ids: ['spatial_aoa', 'rf_lab', result.layout_id],
      quality: 0.85,
      freshness: 1,
      reliability: result.spoof_overlay ? 0.65 : 0.8,
      missing_reason: null,
      evidence: {
        aoa: result.aoa,
        coherence,
        cluster_score: cluster,
        spoof_overlay: result.spoof_overlay,
        antennas: result.antennas,
        center_freq_hz: result.center_freq_hz,
      },
      hard_alert: false,
    };
  }

  if (result.aoa_status === 'warning') {
    return {
      entity_id: entityId,
      check_id: 'spatial_aoa',
      status: 'warning',
      anomaly_score: 0.4,
      severity: 'medium',
      observed_at: result.observed_at,
      explanation: `[${result.antennas}-ant AoA${result.mode === 'lab_iq_recorded' ? ', recorded' : ''}]${overlay}${dirStr}${clusterStr}${coherenceStr} ${result.reason ?? ''}`.trim(),
      source_ids: ['spatial_aoa', 'rf_lab'],
      quality: 0.7,
      freshness: 1,
      reliability: 0.7,
      missing_reason: null,
      evidence: {
        aoa: result.aoa,
        coherence,
        cluster_score: cluster,
        center_freq_hz: result.center_freq_hz,
      },
      hard_alert: false,
    };
  }

  return {
    entity_id: entityId,
    check_id: 'spatial_aoa',
    status: 'pass',
    anomaly_score: 0,
    severity: 'none',
    observed_at: result.observed_at,
    explanation: `[${result.antennas}-ant AoA${result.mode === 'lab_iq_recorded' ? ', recorded' : ''}] Spatial diversity consistent with distributed energy.${dirStr}${clusterStr}${coherenceStr} Absolute angle needs known baseline; relative phase used.`.trim(),
    source_ids: ['spatial_aoa', 'rf_lab', result.layout_id],
    quality: 0.9,
    freshness: 1,
    reliability: 0.8,
    missing_reason: null,
    evidence: {
      aoa: result.aoa,
      antennas: result.antennas,
      coherence,
      cluster_score: cluster,
      center_freq_hz: result.center_freq_hz,
    },
    hard_alert: false,
  };
}
