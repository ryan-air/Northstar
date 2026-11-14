import { z } from 'zod';
import { OsnmaStatusSchema } from './status.js';

export const GnssDiagnosticsSchema = z.object({
  entity_id: z.string(),
  device_id: z.string().optional(),
  observed_at: z.string().datetime(),
  satellite_count: z.number().int().nonnegative().nullable(),
  c_n0_dbhz: z.array(z.number()).nullable(),
  hdop: z.number().nonnegative().nullable(),
  pdop: z.number().nonnegative().nullable().optional(),
  agc: z.number().nullable().optional(),
  pseudorange_residual_m: z.array(z.number()).nullable().optional(),
  clock_drift_ns_s: z.number().nullable().optional(),
  interference_indicator: z.enum(['none', 'suspected_jamming', 'suspected_spoofing', 'unknown']).default('unknown'),
  labels: z
    .object({
      simulated: z.boolean().optional(),
      fixture: z.boolean().optional(),
      /** Real sensor data replayed from a recording (e.g. an imported lab return). */
      recorded: z.boolean().optional(),
    })
    .optional(),
  missing_inputs: z.array(z.string()).default([]),
});
export type GnssDiagnostics = z.infer<typeof GnssDiagnosticsSchema>;

export const ImuSampleSchema = z.object({
  entity_id: z.string(),
  device_id: z.string().optional(),
  observed_at: z.string().datetime(),
  accel_mps2: z.tuple([z.number(), z.number(), z.number()]),
  gyro_rads: z.tuple([z.number(), z.number(), z.number()]),
  bias_estimate: z
    .object({
      accel: z.tuple([z.number(), z.number(), z.number()]).optional(),
      gyro: z.tuple([z.number(), z.number(), z.number()]).optional(),
    })
    .optional(),
  labels: z
    .object({
      simulated: z.boolean().optional(),
      fixture: z.boolean().optional(),
      /** Real sensor data replayed from a recording (e.g. an imported lab return). */
      recorded: z.boolean().optional(),
    })
    .optional(),
});
export type ImuSample = z.infer<typeof ImuSampleSchema>;

export const OsnmaResultSchema = z.object({
  entity_id: z.string().optional(),
  status: OsnmaStatusSchema,
  observed_at: z.string().datetime(),
  satellite_id: z.string().nullable().optional(),
  message_type: z.string().nullable().optional(),
  reason: z.string().nullable().default(null),
  /** 'synthetic': recorded-format OSNMA results generated for a dataset (not a real SIS). */
  mode: z.enum(['live', 'protocol_verification_demo', 'not_connected', 'synthetic']).default('not_connected'),
  public_key_id: z.string().nullable().optional(),
});
export type OsnmaResult = z.infer<typeof OsnmaResultSchema>;

export const AttestationEvidenceSchema = z.object({
  device_id: z.string(),
  assurance_level: z.enum(['hardware', 'software', 'none']),
  provider: z.string(),
  verified: z.boolean(),
  observed_at: z.string().datetime(),
  reason: z.string().nullable().default(null),
  /** Chain verifies only to a synthetic root (not a vendor root): evidence class simulated. */
  synthetic: z.boolean().optional(),
});
export type AttestationEvidence = z.infer<typeof AttestationEvidenceSchema>;

/** Lab dual-antenna IQ / AoA evidence (instrumented Hist Lab vessel only). */
export const RfLabResultSchema = z.object({
  v: z.number().int().optional(),
  layout_id: z.string(),
  entity_id: z.string().nullable().optional(),
  observed_at: z.string().datetime(),
  /** 'lab_iq_recorded': analysed from a recorded, GPS-timestamped capture bound to this vessel. */
  mode: z.enum(['lab_iq_multichannel', 'not_connected', 'lab_iq_recorded']).default('lab_iq_multichannel'),
  antennas: z.number().int().positive(),
  sample_rate_hz: z.number().positive(),
  center_freq_hz: z.number().positive(),
  fc_note: z.string().nullable().optional(),
  status: z.enum(['pass', 'fail', 'warning', 'pending', 'unavailable']),
  aoa_status: z.enum(['pass', 'fail', 'warning', 'pending', 'unavailable']),
  reason: z.string().nullable().default(null),
  spoof_overlay: z.string().nullable().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  aoa: z
    .object({
      method: z.string(),
      mean_phase_deg: z.number().optional(),
      phase_std_rad: z.number().optional(),
      cluster_score: z.number().optional(),
      directions_deg: z.array(z.number()).default([]),
      coherence: z.number().optional(),
      baseline_note: z.string().optional(),
    })
    .optional(),
});
export type RfLabResult = z.infer<typeof RfLabResultSchema>;
