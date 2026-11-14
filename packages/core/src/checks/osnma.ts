import type { CheckResult, OsnmaResult } from '@northstar/contracts';

/**
 * OSNMA authenticates supported Galileo navigation-message data.
 * It does NOT authenticate receiver pseudoranges or prove the PVT is genuine.
 */
export function checkOsnma(
  entityId: string,
  result: OsnmaResult | null,
  nowIso: string,
): CheckResult {
  if (!result || result.mode === 'not_connected') {
    const missing =
      result?.reason ?? 'No OSNMA-capable receiver or live I/NAV stream';
    return {
      entity_id: entityId,
      check_id: 'osnma',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: result?.observed_at ?? nowIso,
      explanation: result?.reason
        ? `OSNMA unavailable: ${result.reason}`
        : 'OSNMA live receiver not connected. Navigation-data authentication unavailable.',
      source_ids: [],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: missing,
      evidence: { mode: result?.mode ?? 'not_connected' },
      hard_alert: false,
    };
  }

  if (result.status === 'unsupported') {
    return {
      entity_id: entityId,
      check_id: 'osnma',
      status: 'unsupported',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'OSNMA unsupported for this signal/constellation context.',
      source_ids: ['osnma'],
      quality: 0,
      freshness: 1,
      reliability: 0,
      missing_reason: result.reason,
      evidence: { mode: result.mode },
      hard_alert: false,
    };
  }

  if (result.status === 'pending') {
    return {
      entity_id: entityId,
      check_id: 'osnma',
      status: 'pending',
      anomaly_score: 0,
      severity: 'none',
      observed_at: nowIso,
      explanation:
        result.mode === 'protocol_verification_demo'
          ? '[ICD test vector] OSNMA authentication pending (delayed auth / TESLA chain).'
          : 'OSNMA authentication pending (delayed auth / TESLA chain).',
      source_ids: ['osnma'],
      quality: 0.5,
      freshness: 1,
      reliability: 0.5,
      missing_reason: null,
      evidence: { mode: result.mode, satellite_id: result.satellite_id },
      hard_alert: false,
    };
  }

  const demo =
    result.mode === 'protocol_verification_demo'
      ? '[ICD test vector] '
      : result.mode === 'synthetic'
        ? '[Synthetic OSNMA data] '
        : '';
  const sharedFleet =
    result.mode === 'protocol_verification_demo'
      ? ' Shared ICD/nav-data auth applied to Hist Lab fleet — not a per-vessel RF receiver.'
      : '';

  if (result.status === 'failed') {
    return {
      entity_id: entityId,
      check_id: 'osnma',
      status: 'fail',
      anomaly_score: 0.9,
      severity: 'high',
      observed_at: nowIso,
      explanation: `${demo}OSNMA navigation-data authentication failed${result.reason ? `: ${result.reason}` : ''}. Does not by itself prove PVT spoofing.${sharedFleet}`,
      source_ids: ['osnma', 'osnmalib_icd'],
      quality: 0.9,
      freshness: 1,
      reliability: result.mode === 'protocol_verification_demo' ? 0.6 : 0.9,
      missing_reason: null,
      evidence: {
        mode: result.mode,
        satellite_id: result.satellite_id,
        reason: result.reason,
        public_key_id: result.public_key_id,
      },
      hard_alert: false,
    };
  }

  if (result.status === 'authenticated') {
    return {
      entity_id: entityId,
      check_id: 'osnma',
      status: 'pass',
      anomaly_score: 0,
      severity: 'none',
      observed_at: nowIso,
      explanation: `${demo}Supported Galileo navigation-message data authenticated (TESLA/MAC + KROOT). This is data authentication, not PVT authentication.${sharedFleet}`,
      source_ids: ['osnma', 'osnmalib_icd'],
      quality: 0.95,
      freshness: 1,
      reliability: result.mode === 'protocol_verification_demo' ? 0.75 : 0.95,
      missing_reason: null,
      evidence: {
        mode: result.mode,
        satellite_id: result.satellite_id,
        public_key_id: result.public_key_id,
      },
      hard_alert: false,
    };
  }

  // unavailable status on result
  return {
    entity_id: entityId,
    check_id: 'osnma',
    status: 'unavailable',
    anomaly_score: null,
    severity: 'none',
    observed_at: nowIso,
    explanation: `${demo}OSNMA status unavailable.`,
    source_ids: ['osnma'],
    quality: 0,
    freshness: 0,
    reliability: 0,
    missing_reason: result.reason ?? 'unavailable',
    evidence: { mode: result.mode },
    hard_alert: false,
  };
}
