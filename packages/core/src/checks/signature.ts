import type { CheckResult, SignatureStatus } from '@northstar/contracts';

export function checkDeviceSignature(
  entityId: string,
  status: SignatureStatus,
  nowIso: string,
  detail?: string,
): CheckResult {
  if (status === 'missing') {
    return {
      entity_id: entityId,
      check_id: 'device_signature',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'No device signature present on this observation.',
      source_ids: [],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'Unsigned observation (e.g. public AIS)',
      evidence: { signature_status: status },
      hard_alert: false,
    };
  }

  if (status === 'pending') {
    return {
      entity_id: entityId,
      check_id: 'device_signature',
      status: 'pending',
      anomaly_score: 0,
      severity: 'none',
      observed_at: nowIso,
      explanation: 'Device signature verification pending.',
      source_ids: ['device_telemetry'],
      quality: 0.5,
      freshness: 1,
      reliability: 0.5,
      missing_reason: null,
      evidence: { signature_status: status },
      hard_alert: false,
    };
  }

  if (status === 'verified') {
    return {
      entity_id: entityId,
      check_id: 'device_signature',
      status: 'pass',
      anomaly_score: 0,
      severity: 'none',
      observed_at: nowIso,
      explanation:
        'Ed25519 device signature verified. Proves provenance and integrity of the signed telemetry; does not prove the physical sensor reading is true.',
      source_ids: ['device_telemetry'],
      quality: 1,
      freshness: 1,
      reliability: 1,
      missing_reason: null,
      evidence: { signature_status: status },
      hard_alert: false,
    };
  }

  // failed | untrusted_key | replay_rejected | stale
  const hard = status === 'failed' || status === 'replay_rejected' || status === 'untrusted_key';
  return {
    entity_id: entityId,
    check_id: 'device_signature',
    status: 'fail',
    anomaly_score: 1,
    severity: 'critical',
    observed_at: nowIso,
    explanation:
      detail ??
      `Device signature check failed (${status}). Cryptographic authentication failure.`,
    source_ids: ['device_telemetry'],
    quality: 1,
    freshness: 1,
    reliability: 1,
    missing_reason: null,
    evidence: { signature_status: status },
    hard_alert: hard,
  };
}
