import {
  coverageBandFromPct,
  trustBandFromScore,
  type CheckId,
  type CheckResult,
  type TrustAssessment,
} from '@northstar/contracts';

export interface FusionConfig {
  version: string;
  weights: Record<string, number>;
  correlation_groups: Array<{
    id: string;
    members: string[];
    secondary_discount: number;
  }>;
  expected_checks: string[];
  coverage_weights: Record<string, number>;
  hard_alerts: {
    impossible_movement_anomaly: number;
    deep_inland_m: number;
    deep_inland_accuracy_m_max: number;
    signature_failure: boolean;
    debounce_n: number;
    debounce_window_s: number;
    persist_s: number;
  };
  freshness_half_life_s: number;
  stale_after_s: number;
}

export interface HardAlertState {
  /** recent trigger timestamps per alert key */
  triggers: Map<string, number[]>;
  /** active hard alerts with expiry */
  active: Map<string, number>;
}

export function createHardAlertState(): HardAlertState {
  return { triggers: new Map(), active: new Map() };
}

function isRunnable(c: CheckResult): boolean {
  return (
    c.status === 'pass' ||
    c.status === 'warning' ||
    c.status === 'fail' ||
    c.status === 'pending'
  );
}

function hasAnomaly(c: CheckResult): c is CheckResult & { anomaly_score: number } {
  return c.anomaly_score != null && isRunnable(c) && c.status !== 'pending';
}

/**
 * Strong-evidence anomaly fusion with correlation discounting and hard-alert overrides.
 * Passing checks never dilute anomalies; unavailable checks only reduce coverage.
 */
export function fuseTrust(
  entityId: string,
  checks: CheckResult[],
  config: FusionConfig,
  hardState: HardAlertState,
  assessedAt: string,
): { assessment: TrustAssessment; hardState: HardAlertState } {
  const now = Date.parse(assessedAt);
  const nextHard: HardAlertState = {
    triggers: new Map(hardState.triggers),
    active: new Map(hardState.active),
  };

  // Expire old actives
  for (const [k, exp] of nextHard.active) {
    if (exp < now) nextHard.active.delete(k);
  }

  // Detect hard conditions
  const hardKeys: string[] = [];
  for (const c of checks) {
    if (!c.hard_alert) continue;
    const key = `${c.check_id}:${c.evidence?.signature_status ?? c.status}`;
    hardKeys.push(key);
    const arr = nextHard.triggers.get(key) ?? [];
    const windowMs = config.hard_alerts.debounce_window_s * 1000;
    const recent = [...arr.filter((t) => now - t <= windowMs), now];
    nextHard.triggers.set(key, recent);
    if (recent.length >= config.hard_alerts.debounce_n) {
      nextHard.active.set(key, now + config.hard_alerts.persist_s * 1000);
    }
  }

  // Correlation-aware weights
  const effectiveWeight = new Map<string, number>();
  for (const c of checks) {
    if (!hasAnomaly(c)) continue;
    effectiveWeight.set(c.check_id, config.weights[c.check_id] ?? 1);
  }
  for (const group of config.correlation_groups) {
    const members = group.members
      .map((id) => checks.find((c) => c.check_id === id))
      .filter((c): c is CheckResult => !!c && hasAnomaly(c));
    if (members.length < 2) continue;
    members.sort((a, b) => (b.anomaly_score ?? 0) - (a.anomaly_score ?? 0));
    // strongest keeps full weight; others discounted
    for (let i = 1; i < members.length; i++) {
      const id = members[i]!.check_id;
      effectiveWeight.set(
        id,
        (effectiveWeight.get(id) ?? 1) * group.secondary_discount,
      );
    }
  }

  const anomalous = checks.filter(
    (c) =>
      hasAnomaly(c) &&
      c.anomaly_score > 0 &&
      (c.status === 'fail' || c.status === 'warning'),
  );
  const weighted = anomalous.map((c) => {
    const configured = effectiveWeight.get(c.check_id) ?? config.weights[c.check_id] ?? 1;
    return {
      check: c,
      weight: Math.max(0, configured * c.reliability * c.freshness),
    };
  });
  const weightTotal = weighted.reduce((sum, item) => sum + item.weight, 0);
  const maxAnomaly = weighted.reduce(
    (max, item) => Math.max(max, item.check.anomaly_score ?? 0),
    0,
  );
  const noisyOr =
    weightTotal > 0
      ? 1 -
        weighted.reduce((product, item) => {
          const score = item.check.anomaly_score ?? 0;
          return product * (1 - score * Math.min(1, item.weight / weightTotal));
        }, 1)
      : 0;
  const anomaly = Math.max(maxAnomaly, noisyOr * 0.85);
  let trust = Math.round(100 * (1 - anomaly));
  const activeHard = [...nextHard.active.keys()];
  if (activeHard.length > 0) {
    trust = Math.min(trust, 20);
  }
  trust = Math.max(0, Math.min(100, trust));

  // Coverage: weighted share of expected checks that are fresh & runnable (or explicitly unsupported counts partial)
  let covNum = 0;
  let covDen = 0;
  for (const id of config.expected_checks) {
    const w = config.coverage_weights[id] ?? 1;
    covDen += w;
    const c = checks.find((x) => x.check_id === id);
    if (!c) continue;
    if (c.status === 'unavailable' || c.status === 'unsupported') continue;
    if (c.freshness <= 0) continue;
    covNum += w * Math.min(1, c.freshness);
  }
  const coverage = covDen > 0 ? (100 * covNum) / covDen : 0;

  const available = checks.filter((c) => c.status !== 'unavailable' && c.status !== 'unsupported')
    .length;

  const failing = checks.filter((c) => c.status === 'fail' || c.status === 'warning');
  let explanation: string;
  if (activeHard.length > 0) {
    const hardChecks = checks.filter((c) => c.hard_alert);
    explanation = `Hard alert active: ${hardChecks.map((c) => c.explanation).join(' ')}`;
  } else if (failing.length === 0) {
    explanation = 'Available checks are within nominal bounds.';
  } else {
    explanation = failing.map((c) => c.explanation).join(' ');
  }

  const assessment: TrustAssessment = {
    entity_id: entityId,
    trust_score: trust,
    trust_band: trustBandFromScore(trust),
    evidence_coverage: Math.round(coverage * 10) / 10,
    coverage_band: coverageBandFromPct(coverage),
    available_checks: available,
    expected_checks: config.expected_checks.length,
    hard_alerts: activeHard,
    explanation,
    assessed_at: assessedAt,
    config_version: config.version,
    checks: checks as CheckResult[],
  };

  return { assessment, hardState: nextHard };
}

export function emptyChecks(entityId: string, nowIso: string): CheckResult[] {
  const ids: CheckId[] = [
    'kinematics',
    'geographic',
    'neighbors',
    'gnss_diagnostics',
    'imu',
    'osnma',
    'ais_cross_feed',
    'device_signature',
    'attestation',
    'rf_lab',
    'spatial_aoa',
    'signed_vs_ais',
    'fleet_coherence',
  ];
  return ids.map((check_id) => ({
    entity_id: entityId,
    check_id,
    status: 'unavailable' as const,
    anomaly_score: null,
    severity: 'none' as const,
    observed_at: nowIso,
    explanation: 'Not yet evaluated.',
    source_ids: [],
    quality: 0,
    freshness: 0,
    reliability: 0,
    missing_reason: 'Pending first observation',
    hard_alert: false,
  }));
}
