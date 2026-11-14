import { z } from 'zod';
import { AlertEventSchema, CheckResultSchema, TrustAssessmentSchema } from './events.js';
import { DataModeSchema, TrustBandSchema } from './status.js';

export const ScenarioIdSchema = z.enum([
  'normal',
  'sudden_spoof',
  'gradual_drift',
  'ais_disagreement',
  'gnss_jamming',
  'imu_disagreement',
  'signed_tamper',
  'signed_replay',
  'stale_clock_skew',
  'osnma_auth',
  'osnma_failure',
  'rf_aoa_spoof_cluster',
  'reset',
]);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

export const ScenarioCommandSchema = z.object({
  scenario: ScenarioIdSchema,
  entity_id: z.string().optional(),
});
export type ScenarioCommand = z.infer<typeof ScenarioCommandSchema>;

export const VesselOriginSchema = z.enum(['lab', 'live']);
export type VesselOrigin = z.infer<typeof VesselOriginSchema>;

export const VesselStateSchema = z.object({
  entity_id: z.string(),
  name: z.string().optional(),
  vessel_class: z.string().optional(),
  origin: VesselOriginSchema.optional(),
  position: z.object({ lat: z.number(), lon: z.number() }),
  speed_over_ground_knots: z.number().nullable().optional(),
  course_over_ground_deg: z.number().nullable().optional(),
  heading_deg: z.number().nullable().optional(),
  trust: TrustAssessmentSchema,
  track: z
    .array(
      z.object({
        lat: z.number(),
        lon: z.number(),
        t: z.string().datetime(),
        anomalous: z.boolean().optional(),
      }),
    )
    .default([]),
  last_update: z.string().datetime(),
});
export type VesselState = z.infer<typeof VesselStateSchema>;

export const LiveFeedStatusSchema = z.object({
  enabled: z.literal(true),
  primary_source: z.enum(['digitraffic', 'aisstream', 'none']),
  digitraffic: z.object({
    status: z.string(),
    vessel_count: z.number(),
    last_updated: z.string().nullable(),
    last_error: z.string().nullable(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  aisstream: z.object({
    status: z.string(),
    reason: z.string().nullable(),
  }),
  vessel_count: z.number(),
  last_poll_at: z.string().nullable(),
  note: z.string(),
});
export type LiveFeedStatus = z.infer<typeof LiveFeedStatusSchema>;

export const FleetMetricsSchema = z.object({
  vessels_monitored: z.number().int().nonnegative(),
  high_risk_vessels: z.number().int().nonnegative(),
  active_alerts: z.number().int().nonnegative(),
  average_evidence_coverage: z.number().min(0).max(100),
});
export type FleetMetrics = z.infer<typeof FleetMetricsSchema>;

export const FeedHealthSchema = z.object({
  ais_a: z.enum(['ok', 'degraded', 'down', 'unavailable']),
  ais_b: z.enum(['ok', 'degraded', 'down', 'unavailable']),
  ais_live: z.enum(['ok', 'degraded', 'down', 'unavailable', 'connecting']),
  device_telemetry: z.enum(['ok', 'degraded', 'down', 'unavailable']),
  osnma: z.enum(['ok', 'degraded', 'down', 'unavailable', 'demo']),
  rf_lab: z.enum(['ok', 'degraded', 'down', 'unavailable', 'demo']),
  imu: z.enum(['ok', 'degraded', 'down', 'unavailable', 'simulated']),
  gnss_raw: z.enum(['ok', 'degraded', 'down', 'unavailable', 'simulated']),
});
export type FeedHealth = z.infer<typeof FeedHealthSchema>;

export const ViewModeSchema = z.enum(['both', 'live', 'lab']);
export type ViewMode = z.infer<typeof ViewModeSchema>;

export const AppSnapshotSchema = z.object({
  data_mode: DataModeSchema,
  monitoring_label: z.string(),
  view_mode: ViewModeSchema.default('both'),
  sim_time: z.string().datetime(),
  last_update: z.string().datetime(),
  active_scenario: ScenarioIdSchema,
  metrics: FleetMetricsSchema,
  feed_health: FeedHealthSchema,
  vessels: z.array(VesselStateSchema),
  live: LiveFeedStatusSchema.optional(),
  live_vessels: z.array(VesselStateSchema).default([]),
  lab: z
    .object({
      mode: z.enum(['historical_replay', 'synthetic_fallback', 'unavailable']),
      source: z.string(),
      vessel_count: z.number(),
      signed_entity_id: z.string().nullable(),
      fullstack_entity_id: z.string().nullable().optional(),
      speed: z.number().optional(),
      note: z.string(),
      osnma_protocol_status: z.string().optional(),
      rf_aoa_status: z.string().nullable().optional(),
      rf_summary: z.record(z.string(), z.unknown()).nullable().optional(),
      manifest: z.record(z.string(), z.unknown()).nullable().optional(),
      recorder: z
        .object({
          status: z.string(),
          last_poll_at: z.string().nullable(),
          last_count: z.number(),
          last_error: z.string().nullable(),
        })
        .optional(),
    })
    .optional(),
  alerts: z.array(AlertEventSchema),
  timeline: z.array(AlertEventSchema),
  selected_entity_id: z.string().nullable().optional(),
  /** Attack-injection policy: attacks only ever go to these simulated ships. */
  injection: z
    .object({
      policy: z.literal('simulated_only'),
      simulated_ships: z.array(z.string()),
      lab_vessel_id: z.string().nullable(),
    })
    .optional(),
});
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;

export const WsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), payload: AppSnapshotSchema }),
  z.object({ type: z.literal('vessel_update'), payload: VesselStateSchema }),
  z.object({ type: z.literal('alert'), payload: AlertEventSchema }),
  z.object({ type: z.literal('check'), payload: CheckResultSchema }),
  z.object({
    type: z.literal('tick'),
    payload: z.object({ sim_time: z.string().datetime(), last_update: z.string().datetime() }),
  }),
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;

export function trustBandFromScore(score: number): z.infer<typeof TrustBandSchema> {
  if (score >= 85) return 'high';
  if (score >= 65) return 'caution';
  if (score >= 35) return 'suspicious';
  return 'critical';
}

export function coverageBandFromPct(pct: number): 'high' | 'medium' | 'low' {
  if (pct >= 70) return 'high';
  if (pct >= 40) return 'medium';
  return 'low';
}
