import { z } from 'zod';
import { OsnmaStatusSchema, SignatureStatusSchema } from './status.js';

export const PositionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  crs: z.literal('EPSG:4326').default('EPSG:4326'),
});
export type Position = z.infer<typeof PositionSchema>;

export const QualitySchema = z.object({
  position_accuracy_m: z.number().nonnegative().nullable().default(null),
  signal_quality_available: z.boolean().default(false),
  hdop: z.number().nonnegative().nullable().optional(),
  satellite_count: z.number().int().nonnegative().nullable().optional(),
});
export type Quality = z.infer<typeof QualitySchema>;

export const EntityTypeSchema = z.enum(['vessel', 'shore_station', 'virtual', 'synthetic']);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const VESSEL_CLASSES = [
  'cargo',
  'tanker',
  'passenger',
  'fishing',
  'tug',
  'pleasure',
  'other',
] as const;
export const VesselClassSchema = z.enum(VESSEL_CLASSES);
export type VesselClass = (typeof VESSEL_CLASSES)[number];

/** Normalized position event (spec §9.1). */
export const PositionEventSchema = z.object({
  schema_version: z.literal(1).default(1),
  entity_id: z.string().min(1),
  entity_type: EntityTypeSchema.default('vessel'),
  vessel_class: VesselClassSchema.optional(),
  name: z.string().optional(),
  position: PositionSchema,
  speed_over_ground_knots: z.number().nonnegative().nullable().optional(),
  course_over_ground_deg: z.number().min(0).max(360).nullable().optional(),
  heading_deg: z.number().min(0).max(360).nullable().optional(),
  rate_of_turn_deg_per_min: z.number().nullable().optional(),
  source: z.string().min(1),
  provider_id: z.string().optional(),
  device_id: z.string().optional(),
  upstream_lineage: z.array(z.string()).optional(),
  source_timestamp: z.string().datetime(),
  ingested_at: z.string().datetime(),
  sequence_number: z.number().int().nonnegative().nullable().optional(),
  device_signature_status: SignatureStatusSchema.default('missing'),
  osnma_status: OsnmaStatusSchema.default('unavailable'),
  quality: QualitySchema.default({
    position_accuracy_m: null,
    signal_quality_available: false,
  }),
  raw_ref: z.string().nullable().optional(),
  /** AIS navigational status (0–15). Self-reported by the vessel; never used as an exemption. */
  nav_status: z.number().int().min(0).max(15).nullable().optional(),
  /** AIS rate of turn in °/min (decoded; null when not available). */
  rot_deg_min: z.number().nullable().optional(),
  /** AIS RAIM flag. */
  raim: z.boolean().nullable().optional(),
  /** AIS UTC second of the position report (0–59; 60–63 are mapped to null = unavailable). */
  ais_utc_second: z.number().int().min(0).max(59).nullable().optional(),
  /** AIS EPFD / position fixing device type (posType). */
  epfd_type: z.number().int().nullable().optional(),
  /** Antenna reference offsets A (bow), B (stern), C (port), D (starboard) in metres. */
  dimensions_m: z
    .object({
      a: z.number().nonnegative(),
      b: z.number().nonnegative(),
      c: z.number().nonnegative(),
      d: z.number().nonnegative(),
    })
    .nullable()
    .optional(),
  /** True when the event was interpolated between two real samples (Hist Lab). */
  interpolated: z.boolean().optional(),
  /**
   * Time the observation physically refers to, when different from source_timestamp
   * (e.g. device-sim sampling the onboard track at replay time). Used for kinematics/alignment.
   */
  observation_time: z.string().datetime().optional(),
  labels: z
    .object({
      simulated: z.boolean().optional(),
      fixture: z.boolean().optional(),
      live: z.boolean().optional(),
      attack: z.string().optional(),
      mmsi: z.union([z.number(), z.string()]).optional(),
      call_sign: z.string().optional(),
      destination: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
export type PositionEvent = z.infer<typeof PositionEventSchema>;

export const CheckIdSchema = z.enum([
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
]);
export type CheckId = z.infer<typeof CheckIdSchema>;

export const EvidenceClassSchema = z.enum(['live', 'recorded', 'simulated', 'demo']);
export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;

/** Detection-layer result (spec §9.2). */
export const CheckResultSchema = z.object({
  entity_id: z.string(),
  check_id: CheckIdSchema,
  status: z.enum(['pass', 'warning', 'fail', 'unavailable', 'pending', 'unsupported']),
  anomaly_score: z.number().min(0).max(1).nullable(),
  severity: z.enum(['none', 'low', 'medium', 'high', 'critical']).default('none'),
  observed_at: z.string().datetime(),
  explanation: z.string(),
  source_ids: z.array(z.string()).default([]),
  quality: z.number().min(0).max(1).default(1),
  freshness: z.number().min(0).max(1).default(1),
  reliability: z.number().min(0).max(1).default(1),
  missing_reason: z.string().nullable().default(null),
  evidence: z.record(z.string(), z.unknown()).optional(),
  hard_alert: z.boolean().default(false),
  /**
   * Provenance of the evidence behind this check:
   * live = real-time real-world source, recorded = real data replayed,
   * simulated = synthetic/derived, demo = fixed fixture / protocol test vector.
   */
  evidence_class: EvidenceClassSchema.optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const TrustAssessmentSchema = z.object({
  entity_id: z.string(),
  trust_score: z.number().int().min(0).max(100),
  trust_band: z.enum(['high', 'caution', 'suspicious', 'critical']),
  evidence_coverage: z.number().min(0).max(100),
  /**
   * Coverage counting only checks whose evidence_class is live or recorded.
   * evidence_coverage (above) is unchanged and still counts simulated/demo evidence.
   */
  verified_evidence_coverage: z.number().min(0).max(100).optional(),
  /**
   * 'non_vessel_transponder' for test units / base stations / AtoN (label only; checks,
   * trust and alerts are unchanged). Absent on older assessments.
   */
  transponder_kind: z.enum(['vessel', 'non_vessel_transponder']).optional(),
  transponder_kind_reasons: z.array(z.string()).optional(),
  coverage_band: z.enum(['high', 'medium', 'low']),
  available_checks: z.number().int().nonnegative(),
  expected_checks: z.number().int().nonnegative(),
  hard_alerts: z.array(z.string()).default([]),
  explanation: z.string(),
  assessed_at: z.string().datetime(),
  config_version: z.string(),
  checks: z.array(CheckResultSchema),
});
export type TrustAssessment = z.infer<typeof TrustAssessmentSchema>;

export const AlertEventSchema = z.object({
  id: z.string(),
  entity_id: z.string(),
  kind: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  explanation: z.string(),
  trust_score_before: z.number().int().nullable().optional(),
  trust_score_after: z.number().int().nullable().optional(),
  check_ids: z.array(CheckIdSchema).default([]),
  observed_at: z.string().datetime(),
  evidence_refs: z.array(z.string()).default([]),
  hard: z.boolean().default(false),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;
