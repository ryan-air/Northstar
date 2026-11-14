/**
 * Signed telemetry ingest — extracted from the NorthstarApp god-object so the
 * verify → bind → challenge → replay → pipeline path is reviewable in one place.
 *
 * The live implementation still lives on NorthstarApp.ingestSigned for now;
 * this module re-exports the binding / rejection policy constants used by tests
 * and documents the fail-closed contract.
 */

export const INGEST_POLICY = {
  /** Rejected signatures / replays must never call TrustPipeline.process. */
  rejectedUpdatesTrack: false,
  /** Authenticate only by public_key_id — never fall back to payload.device_id. */
  lookupByPayloadDeviceId: false,
  /** payload.device_id and payload.entity_id must match the enrolled device. */
  requireDeviceEntityBinding: true,
  /** Consume challenge nonce only after signature verification succeeds. */
  consumeChallengeAfterVerify: true,
  /** ReplayGuard keyed on authenticated device.device_id. */
  replayKey: 'authenticated_device_id' as const,
} as const;
