/** Lightweight mirror of contracts for the browser (avoid pulling Node zod build into Vite if needed). */

export type TrustBand = 'high' | 'caution' | 'suspicious' | 'critical';
export type CheckStatus = 'pass' | 'warning' | 'fail' | 'unavailable' | 'pending' | 'unsupported';
export type ScenarioId =
  | 'normal'
  | 'sudden_spoof'
  | 'gradual_drift'
  | 'ais_disagreement'
  | 'gnss_jamming'
  | 'imu_disagreement'
  | 'signed_tamper'
  | 'signed_replay'
  | 'stale_clock_skew'
  | 'osnma_auth'
  | 'osnma_failure'
  | 'rf_aoa_spoof_cluster'
  | 'reset';

export interface CheckResult {
  entity_id: string;
  check_id: string;
  status: CheckStatus;
  anomaly_score: number | null;
  severity: string;
  observed_at: string;
  explanation: string;
  source_ids: string[];
  quality: number;
  freshness: number;
  reliability: number;
  missing_reason: string | null;
  evidence?: Record<string, unknown>;
  hard_alert: boolean;
  /** live | recorded | simulated | demo (P0.5) */
  evidence_class?: 'live' | 'recorded' | 'simulated' | 'demo';
}

export interface TrustAssessment {
  entity_id: string;
  trust_score: number;
  trust_band: TrustBand;
  evidence_coverage: number;
  /** Coverage from live/recorded evidence only (P0.6). */
  verified_evidence_coverage?: number;
  coverage_band: string;
  available_checks: number;
  expected_checks: number;
  hard_alerts: string[];
  /** 'non_vessel_transponder' for test units / base stations / AtoN (label only). */
  transponder_kind?: 'vessel' | 'non_vessel_transponder';
  transponder_kind_reasons?: string[];
  explanation: string;
  assessed_at: string;
  config_version: string;
  checks: CheckResult[];
}

export type VesselOrigin = 'lab' | 'live';
export type ViewMode = 'both' | 'live' | 'lab';

export interface VesselState {
  entity_id: string;
  name?: string;
  vessel_class?: string;
  origin?: VesselOrigin;
  position: { lat: number; lon: number };
  speed_over_ground_knots?: number | null;
  course_over_ground_deg?: number | null;
  heading_deg?: number | null;
  trust: TrustAssessment;
  track: Array<{ lat: number; lon: number; t: string; anomalous?: boolean }>;
  last_update: string;
}

export interface LiveFeedStatus {
  enabled: true;
  primary_source: 'digitraffic' | 'aisstream' | 'none';
  digitraffic: {
    status: string;
    vessel_count: number;
    last_updated: string | null;
    last_error: string | null;
  };
  aisstream: { status: string; reason: string | null };
  vessel_count: number;
  last_poll_at: string | null;
  note: string;
}

export interface AlertEvent {
  id: string;
  entity_id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  explanation: string;
  trust_score_before?: number | null;
  trust_score_after?: number | null;
  check_ids: string[];
  observed_at: string;
  hard: boolean;
}

export interface AppSnapshot {
  data_mode: string;
  monitoring_label: string;
  view_mode?: ViewMode;
  sim_time: string;
  last_update: string;
  active_scenario: ScenarioId;
  metrics: {
    vessels_monitored: number;
    high_risk_vessels: number;
    active_alerts: number;
    average_evidence_coverage: number;
  };
  feed_health: Record<string, string>;
  vessels: VesselState[];
  live?: LiveFeedStatus;
  live_vessels?: VesselState[];
  lab?: {
    mode: 'historical_replay' | 'synthetic_fallback' | 'unavailable';
    source: string;
    vessel_count: number;
    signed_entity_id: string | null;
    fullstack_entity_id?: string | null;
    speed?: number;
    note: string;
    osnma_protocol_status?: string;
    rf_aoa_status?: string | null;
    rf_summary?: Record<string, unknown> | null;
    recorder?: {
      status: string;
      last_poll_at: string | null;
      last_count: number;
      last_error: string | null;
    };
  };
  alerts: AlertEvent[];
  timeline: AlertEvent[];
  selected_entity_id?: string | null;
  injection?: { policy: 'simulated_only'; simulated_ships: string[]; lab_vessel_id: string | null };
}

export interface LabEvent {
  kind: string;
  start: string;
  end: string;
  detail: string;
}

export interface ScenarioResult {
  scenario: string;
  target?: string;
  retargeted_from?: string;
}
