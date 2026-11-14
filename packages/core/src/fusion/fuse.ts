import {
  coverageBandFromPct,
  trustBandFromScore,
  type CheckId,
  type CheckResult,
  type TrustAssessment,
} from '@northstar/contracts';
import { VERIFIED_EVIDENCE_CLASSES } from './evidenceClass.js';

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
    /**
     * v2: count DISTINCT source_timestamp values per alert key within the window
     * (a re-polled duplicate cannot confirm an alert). Absent/false = v1 behaviour
     * (every evaluation counts).
     */
    debounce_distinct_observations?: boolean;
    /** v2: alert-key prefixes confirmed on a single observation (n = 1). */
    immediate_keys?: string[];
  };
  freshness_half_life_s: number;
  stale_after_s: number;
  /**
   * 'v1' (default when absent): max(maxAnomaly, 0.85·noisyOR) with weight-share terms.
   * 'v2': q = reliability × freshness, w = weight / max(weight) ∈ [0,1],
   *       anomaly = max( maxᵢ(sᵢ·qᵢ), 1 − Πᵢ(1 − sᵢ·qᵢ·wᵢ) ).
   */
  fusion_mode?: 'v1' | 'v2';
}

export interface FuseOptions {
  /** source_timestamp of the observation being assessed (for distinct-observation debounce). */
  observationTs?: string;
}

export interface HardAlertState {
  /** recent trigger timestamps per alert key */
  triggers: Map<string, number[]>;
  /** v2: recent (assessedAt, observationTs) pairs per alert key */
  observations?: Map<string, Array<{ at: number; obs: number }>>;
  /** active hard alerts with expiry */
  active: Map<string, number>;
}

export function createHardAlertState(): HardAlertState {
  return { triggers: new Map(), active: new Map(), observations: new Map() };
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
  opts: FuseOptions = {},
): { assessment: TrustAssessment; hardState: HardAlertState } {
  const now = Date.parse(assessedAt);
  const nextHard: HardAlertState = {
    triggers: new Map(hardState.triggers),
    active: new Map(hardState.active),
    observations: new Map(hardState.observations ?? []),
  };
  const distinct = config.hard_alerts.debounce_distinct_observations === true;
  const obsTs = opts.observationTs ? Date.parse(opts.observationTs) : now;

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
    const windowMs = config.hard_alerts.debounce_window_s * 1000;
    if (distinct) {
      const prev = nextHard.observations!.get(key) ?? [];
      const recent = [...prev.filter((o) => now - o.at <= windowMs), { at: now, obs: obsTs }];
      nextHard.observations!.set(key, recent);
      const distinctCount = new Set(recent.map((o) => o.obs)).size;
      const immediate = (config.hard_alerts.immediate_keys ?? []).some((p) => key.startsWith(p));
      const needed = immediate ? 1 : config.hard_alerts.debounce_n;
      nextHard.triggers.set(key, recent.map((o) => o.at));
      if (distinctCount >= needed) {
        nextHard.active.set(key, now + config.hard_alerts.persist_s * 1000);
      }
      continue;
    }
    const arr = nextHard.triggers.get(key) ?? [];
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
  let anomaly: number;
  if (config.fusion_mode === 'v2') {
    const maxWeight = Math.max(
      1e-9,
      ...Object.values(config.weights).filter((w) => Number.isFinite(w) && w > 0),
    );
    let maxTerm = 0;
    let product = 1;
    for (const c of anomalous) {
      const s = Math.min(1, Math.max(0, c.anomaly_score ?? 0));
      const q = Math.min(1, Math.max(0, c.reliability)) * Math.min(1, Math.max(0, c.freshness));
      const configured = effectiveWeight.get(c.check_id) ?? config.weights[c.check_id] ?? 1;
      const w = Math.min(1, Math.max(0, configured / maxWeight));
      maxTerm = Math.max(maxTerm, s * q);
      product *= 1 - s * q * w;
    }
    const combined = 1 - product;
    anomaly = Math.max(maxTerm, combined);
  } else {
    anomaly = Math.max(maxAnomaly, noisyOr * 0.85);
  }
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

  // Verified coverage: identical formula but only live/recorded evidence counts.
  let vNum = 0;
  for (const id of config.expected_checks) {
    const w = config.coverage_weights[id] ?? 1;
    const c = checks.find((x) => x.check_id === id);
    if (!c) continue;
    if (c.status === 'unavailable' || c.status === 'unsupported') continue;
    if (c.freshness <= 0) continue;
    if (!c.evidence_class || !VERIFIED_EVIDENCE_CLASSES.has(c.evidence_class)) continue;
    vNum += w * Math.min(1, c.freshness);
  }
  const verifiedCoverage = covDen > 0 ? (100 * vNum) / covDen : 0;

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
    verified_evidence_coverage: Math.round(verifiedCoverage * 10) / 10,
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
    'identity',
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
