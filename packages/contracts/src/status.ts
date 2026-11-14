import { z } from 'zod';

/** Shared check / layer status vocabulary (spec §5.4). */
export const CheckStatusSchema = z.enum([
  'pass',
  'warning',
  'fail',
  'unavailable',
  'pending',
  'unsupported',
]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const TrustBandSchema = z.enum(['high', 'caution', 'suspicious', 'critical']);
export type TrustBand = z.infer<typeof TrustBandSchema>;

export const DataModeSchema = z.enum(['live', 'replay', 'simulation']);
export type DataMode = z.infer<typeof DataModeSchema>;

export const SignatureStatusSchema = z.enum([
  'verified',
  'failed',
  'missing',
  'untrusted_key',
  'replay_rejected',
  'stale',
  'pending',
]);
export type SignatureStatus = z.infer<typeof SignatureStatusSchema>;

export const OsnmaStatusSchema = z.enum([
  'authenticated',
  'failed',
  'pending',
  'unavailable',
  'unsupported',
]);
export type OsnmaStatus = z.infer<typeof OsnmaStatusSchema>;

export const CoverageBandSchema = z.enum(['high', 'medium', 'low']);
export type CoverageBand = z.infer<typeof CoverageBandSchema>;

export const AssuranceLevelSchema = z.enum(['hardware', 'software', 'none']);
export type AssuranceLevel = z.infer<typeof AssuranceLevelSchema>;
