import { describe, expect, it } from 'vitest';
import { createHardAlertState, fuseTrust, type FusionConfig } from './fuse.js';
import { stampEvidenceClass } from './evidenceClass.js';
import type { CheckResult, PositionEvent } from '@northstar/contracts';
import fusionV1 from '../../../../config/fusion.v1.json';
import fusionV2 from '../../../../config/fusion.v2.json';

const v1 = fusionV1 as FusionConfig;
const v2 = fusionV2 as FusionConfig;
const T = '2026-11-11T10:00:00.000Z';

function check(
  partial: Partial<CheckResult> & Pick<CheckResult, 'check_id' | 'status' | 'anomaly_score'>,
): CheckResult {
  return {
    entity_id: 'V',
    observed_at: T,
    explanation: 'test',
    source_ids: [],
    quality: 1,
    freshness: 1,
    reliability: 1,
    missing_reason: null,
    hard_alert: false,
    severity: 'none',
    ...partial,
  };
}

const score = (cfg: FusionConfig, checks: CheckResult[]) =>
  fuseTrust('V', checks, cfg, createHardAlertState(), T).assessment.trust_score;

describe('fusion v2 (P2.4)', () => {
  it('two independent 0.4 warnings score strictly worse than either alone (fails under max())', () => {
    const one = score(v2, [check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.4 })]);
    const two = score(v2, [
      check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.4 }),
      check({ check_id: 'geographic', status: 'warning', anomaly_score: 0.4 }),
    ]);
    expect(one).toBe(60);
    expect(two).toBeLessThan(one);
  });

  it('documents v1: the same pair collapses to max() — the noisy-OR term never wins', () => {
    const one = score(v1, [check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.4 })]);
    const two = score(v1, [
      check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.4 }),
      check({ check_id: 'geographic', status: 'warning', anomaly_score: 0.4 }),
    ]);
    expect(two).toBe(one);
  });

  it('five independent 0.5 anomalies score worse than one', () => {
    const ids: CheckResult['check_id'][] = ['kinematics', 'geographic', 'fleet_coherence', 'signed_vs_ais', 'device_signature'];
    const one = score(v2, [check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.5 })]);
    const five = score(v2, ids.map((id) => check({ check_id: id, status: 'warning', anomaly_score: 0.5 })));
    expect(five).toBeLessThan(one);
    expect(five).toBeLessThan(35); // critical band
  });

  it('weights change the combined score', () => {
    const pair = (w: number) =>
      score({ ...v2, weights: { ...v2.weights, geographic: w } }, [
        check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.5 }),
        check({ check_id: 'geographic', status: 'warning', anomaly_score: 0.5 }),
      ]);
    expect(pair(0.1)).toBeGreaterThan(pair(1.0));
  });

  it('reliability = 0 removes a check’s influence', () => {
    const base = score(v2, [check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.5 })]);
    const withDead = score(v2, [
      check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.5 }),
      check({ check_id: 'geographic', status: 'fail', anomaly_score: 1, reliability: 0 }),
    ]);
    expect(withDead).toBe(base);
  });

  it('correlation discount applies to the secondary member of a group', () => {
    const both = score(v2, [
      check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.5 }),
      check({ check_id: 'imu', status: 'warning', anomaly_score: 0.5 }),
    ]);
    const independent = score(v2, [
      check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.5 }),
      check({ check_id: 'geographic', status: 'warning', anomaly_score: 0.5 }),
    ]);
    expect(both).toBeGreaterThan(independent);
  });
});

describe('hard-alert debounce on distinct observations (P2.5)', () => {
  const hard = check({ check_id: 'kinematics', status: 'fail', anomaly_score: 1, hard_alert: true });

  it('a re-polled duplicate (same source_timestamp) cannot confirm an alert', () => {
    let st = createHardAlertState();
    const obs = '2026-11-11T09:59:50.000Z';
    st = fuseTrust('V', [hard], v2, st, '2026-11-11T10:00:00.000Z', { observationTs: obs }).hardState;
    const r = fuseTrust('V', [hard], v2, st, '2026-11-11T10:00:15.000Z', { observationTs: obs });
    expect(r.assessment.hard_alerts).toHaveLength(0);
  });

  it('two genuinely separate AIS reports confirm it', () => {
    let st = createHardAlertState();
    st = fuseTrust('V', [hard], v2, st, '2026-11-11T10:00:00.000Z', {
      observationTs: '2026-11-11T09:59:50.000Z',
    }).hardState;
    const r = fuseTrust('V', [hard], v2, st, '2026-11-11T10:02:00.000Z', {
      observationTs: '2026-11-11T10:01:55.000Z',
    });
    expect(r.assessment.hard_alerts.length).toBeGreaterThan(0);
    expect(r.assessment.trust_score).toBeLessThanOrEqual(20);
  });

  it('signature failures still confirm on n = 1', () => {
    const sig = check({
      check_id: 'device_signature',
      status: 'fail',
      anomaly_score: 1,
      hard_alert: true,
      evidence: { signature_status: 'failed' },
    });
    const r = fuseTrust('V', [sig], v2, createHardAlertState(), T, { observationTs: T });
    expect(r.assessment.hard_alerts.length).toBe(1);
  });
});

describe('evidence classes and verified coverage (P0.5/P0.6)', () => {
  const ev: PositionEvent = {
    schema_version: 1,
    entity_id: 'V',
    entity_type: 'vessel',
    position: { lat: 60, lon: 25, crs: 'EPSG:4326' },
    source: 'ais_provider_a',
    source_timestamp: T,
    ingested_at: T,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 10, signal_quality_available: false },
    labels: { live: false, simulated: false, fixture: false },
  };

  it('stamps every check and keeps verified coverage ≤ padded coverage', () => {
    const checks = stampEvidenceClass(
      [
        check({ check_id: 'kinematics', status: 'pass', anomaly_score: 0 }),
        check({ check_id: 'geographic', status: 'pass', anomaly_score: 0 }),
        check({ check_id: 'osnma', status: 'pass', anomaly_score: 0 }),
        check({ check_id: 'rf_lab', status: 'pass', anomaly_score: 0 }),
        check({ check_id: 'attestation', status: 'pass', anomaly_score: 0 }),
      ],
      { event: ev, osnma: { status: 'authenticated', observed_at: T, reason: null, mode: 'protocol_verification_demo' } },
    );
    expect(checks.every((c) => !!c.evidence_class)).toBe(true);
    expect(checks.find((c) => c.check_id === 'kinematics')!.evidence_class).toBe('recorded');
    expect(checks.find((c) => c.check_id === 'osnma')!.evidence_class).toBe('demo');
    expect(checks.find((c) => c.check_id === 'rf_lab')!.evidence_class).toBe('demo');
    const a = fuseTrust('V', checks, v2, createHardAlertState(), T).assessment;
    expect(a.verified_evidence_coverage).toBeDefined();
    expect(a.verified_evidence_coverage!).toBeLessThan(a.evidence_coverage);
  });
});
