import { describe, expect, it } from 'vitest';
import { createHardAlertState, fuseTrust, type FusionConfig } from './fuse.js';
import type { CheckResult } from '@northstar/contracts';
import fusion from '../../../../config/fusion.v1.json';

const config = fusion as FusionConfig;

function check(
  partial: Partial<CheckResult> & Pick<CheckResult, 'check_id' | 'status' | 'anomaly_score'>,
): CheckResult {
  return {
    entity_id: 'VESSEL-001',
    observed_at: '2026-11-11T10:00:00.000Z',
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

describe('fuseTrust', () => {
  it('does not treat unavailable as failure', () => {
    const checks = [
      check({ check_id: 'kinematics', status: 'pass', anomaly_score: 0 }),
      check({
        check_id: 'imu',
        status: 'unavailable',
        anomaly_score: null,
        missing_reason: 'no imu',
      }),
      check({
        check_id: 'osnma',
        status: 'unsupported',
        anomaly_score: null,
      }),
    ];
    const { assessment } = fuseTrust(
      'VESSEL-001',
      checks,
      config,
      createHardAlertState(),
      '2026-11-11T10:00:00.000Z',
    );
    expect(assessment.trust_score).toBe(100);
    expect(assessment.evidence_coverage).toBeLessThan(100);
  });

  it('applies hard-alert debounce and caps trust', () => {
    let state = createHardAlertState();
    const hard = check({
      check_id: 'kinematics',
      status: 'fail',
      anomaly_score: 1,
      hard_alert: true,
      explanation: 'jump',
    });
    const soft = check({
      check_id: 'neighbors',
      status: 'pass',
      anomaly_score: 0,
    });
    let r = fuseTrust('VESSEL-001', [hard, soft], config, state, '2026-11-11T10:00:00.000Z');
    state = r.hardState;
    // first trigger — may not yet persist depending on debounce_n
    r = fuseTrust('VESSEL-001', [hard, soft], config, state, '2026-11-11T10:00:05.000Z');
    expect(r.assessment.trust_score).toBeLessThanOrEqual(20);
    expect(r.assessment.hard_alerts.length).toBeGreaterThan(0);
  });

  it('does not let passing checks dilute a decisive failure', () => {
    const checks = [
      check({ check_id: 'kinematics', status: 'fail', anomaly_score: 0.9 }),
      ...Array.from({ length: 20 }, (_, i) =>
        check({
          check_id: `passing_${i}` as CheckResult['check_id'],
          status: 'pass',
          anomaly_score: 0,
        }),
      ),
    ];
    const { assessment } = fuseTrust(
      'VESSEL-001',
      checks,
      config,
      createHardAlertState(),
      '2026-11-11T10:00:00.000Z',
    );
    expect(assessment.trust_score).toBe(10);
    expect(assessment.explanation).toContain('test');
  });

  it('combines independent warnings with noisy-OR', () => {
    const checks = [
      check({ check_id: 'kinematics', status: 'warning', anomaly_score: 0.4 }),
      check({ check_id: 'geographic', status: 'warning', anomaly_score: 0.4 }),
    ];
    const { assessment } = fuseTrust(
      'VESSEL-001',
      checks,
      config,
      createHardAlertState(),
      '2026-11-11T10:00:00.000Z',
    );
    expect(assessment.trust_score).toBeLessThanOrEqual(60);
    expect(assessment.trust_score).toBeGreaterThan(40);
    expect(assessment.explanation).toContain('test');
  });
});
