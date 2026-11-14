import { z } from 'zod';
import { AssuranceLevelSchema, OsnmaStatusSchema } from './status.js';
import { PositionSchema, QualitySchema, VesselClassSchema } from './events.js';

/** Canonical signed telemetry payload (format version is part of signed bytes). */
export const TelemetryPayloadSchema = z.object({
  v: z.literal(1),
  device_id: z.string().min(1),
  entity_id: z.string().min(1),
  sequence_number: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  /**
   * Optional: the time the position refers to (e.g. Hist Lab replay clock).
   * `timestamp` stays wall-clock so freshness/replay protection are unchanged.
   */
  observation_time: z.string().datetime().optional(),
  firmware_version: z.string(),
  position: PositionSchema,
  speed_over_ground_knots: z.number().nonnegative().nullable(),
  course_over_ground_deg: z.number().min(0).max(360).nullable(),
  heading_deg: z.number().min(0).max(360).nullable().optional(),
  sensors: z
    .object({
      imu: z
        .object({
          accel_mps2: z.tuple([z.number(), z.number(), z.number()]).optional(),
          gyro_rads: z.tuple([z.number(), z.number(), z.number()]).optional(),
        })
        .optional(),
      gnss: QualitySchema.optional(),
    })
    .optional(),
  osnma_status: OsnmaStatusSchema.optional(),
  vessel_class: VesselClassSchema.optional(),
  /** Optional freshness challenge echo (issued by GET /api/challenge/:device_id). */
  challenge_nonce: z.string().min(8).optional(),
});
export type TelemetryPayload = z.infer<typeof TelemetryPayloadSchema>;

export const SignatureAlgSchema = z.enum(['ed25519', 'ecdsa-p256']);
export type SignatureAlg = z.infer<typeof SignatureAlgSchema>;

export const SignedTelemetryEnvelopeSchema = z.object({
  payload: TelemetryPayloadSchema,
  signature: z.string().min(1), // base64
  public_key_id: z.string().min(1),
  assurance_level: AssuranceLevelSchema.default('software'),
  /** Default ed25519 (software). PKCS#11 / YubiKey PIV uses ecdsa-p256. */
  signature_alg: SignatureAlgSchema.default('ed25519'),
});
export type SignedTelemetryEnvelope = z.infer<typeof SignedTelemetryEnvelopeSchema>;

export const DeviceEnrollmentSchema = z.object({
  device_id: z.string(),
  entity_id: z.string(),
  public_key: z.string(), // base64 raw Ed25519 (32) or uncompressed P-256 (65)
  key_id: z.string(),
  enrolled_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable().default(null),
  assurance_level: AssuranceLevelSchema.default('software'),
  signature_alg: SignatureAlgSchema.default('ed25519'),
  firmware_version: z.string().optional(),
});
export type DeviceEnrollment = z.infer<typeof DeviceEnrollmentSchema>;
