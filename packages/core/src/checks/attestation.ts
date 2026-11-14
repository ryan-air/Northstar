import type { AttestationEvidence, CheckResult } from '@northstar/contracts';

export function checkAttestation(
  entityId: string,
  evidence: AttestationEvidence | null,
  nowIso: string,
): CheckResult {
  if (!evidence) {
    return {
      entity_id: entityId,
      check_id: 'attestation',
      status: 'unavailable',
      anomaly_score: null,
      severity: 'none',
      observed_at: nowIso,
      explanation:
        'Hardware-backed attestation unavailable. Software-key mode in use (assurance=software).',
      source_ids: [],
      quality: 0,
      freshness: 0,
      reliability: 0,
      missing_reason: 'No TPM / secure element / Secure Enclave Ed25519 path',
      evidence: { assurance_level: 'software' },
      hard_alert: false,
    };
  }

  if (evidence.assurance_level === 'software') {
    return {
      entity_id: entityId,
      check_id: 'attestation',
      status: 'pass',
      anomaly_score: 0,
      severity: 'none',
      observed_at: nowIso,
      explanation: `Software-key attestation provider (${evidence.provider}) present. Assurance level: software — not hardware-backed.`,
      source_ids: [evidence.provider],
      quality: 0.4,
      freshness: 1,
      reliability: 0.4,
      missing_reason: null,
      evidence: { ...evidence },
      hard_alert: false,
    };
  }

  if (!evidence.verified) {
    return {
      entity_id: entityId,
      check_id: 'attestation',
      status: 'fail',
      anomaly_score: 0.8,
      severity: 'high',
      observed_at: nowIso,
      explanation: `Hardware attestation failed: ${evidence.reason ?? 'verification unsuccessful'}.`,
      source_ids: [evidence.provider],
      quality: 0.9,
      freshness: 1,
      reliability: 0.9,
      missing_reason: null,
      evidence: { ...evidence },
      hard_alert: false,
    };
  }

  return {
    entity_id: entityId,
    check_id: 'attestation',
    status: 'pass',
    anomaly_score: 0,
    severity: 'none',
    observed_at: nowIso,
    explanation: `Hardware-backed attestation verified via ${evidence.provider}.`,
    source_ids: [evidence.provider],
    quality: 1,
    freshness: 1,
    reliability: 1,
    missing_reason: null,
    evidence: { ...evidence },
    hard_alert: false,
  };
}
