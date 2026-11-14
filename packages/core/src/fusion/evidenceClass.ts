import type {
  AttestationEvidence,
  CheckResult,
  EvidenceClass,
  GnssDiagnostics,
  ImuSample,
  OsnmaResult,
  PositionEvent,
  RfLabResult,
} from '@northstar/contracts';

/**
 * Provenance context for one assessment. Everything here is derived from labels the
 * ingest path already sets; nothing is inferred from check outcomes.
 */
export interface EvidenceContext {
  event: PositionEvent;
  secondary?: PositionEvent | null;
  gnss?: GnssDiagnostics | null;
  imu?: ImuSample | null;
  osnma?: OsnmaResult | null;
  attestation?: AttestationEvidence | null;
  rfLab?: RfLabResult | null;
  /**
   * True when the signed onboard track is known to be derived from the AIS track
   * (U12 — the device-sim replays the vessel's own AIS). Defaults to true because no
   * independent onboard receiver exists in this repo.
   */
  onboardTrackIsAisCopy?: boolean;
}

/** Class of a position event from its labels. */
export function eventEvidenceClass(e: PositionEvent | null | undefined): EvidenceClass {
  if (!e) return 'demo';
  const l = e.labels ?? {};
  if (l.simulated) return 'simulated';
  if (l.fixture) return 'demo';
  if (l.live) return 'live';
  // Not simulated, not fixture, not live → real data replayed from a recording.
  return 'recorded';
}

function sensorClass(labels: { simulated?: boolean; fixture?: boolean } | undefined): EvidenceClass {
  if (!labels) return 'demo';
  if (labels.fixture) return 'demo';
  if (labels.simulated) return 'simulated';
  return 'live';
}

/** Evidence class for a single check given the provenance context. */
export function classifyCheckEvidence(checkId: CheckResult['check_id'], ctx: EvidenceContext): EvidenceClass {
  const ev = eventEvidenceClass(ctx.event);
  switch (checkId) {
    case 'kinematics':
    case 'geographic':
    case 'neighbors':
    case 'fleet_coherence':
    case 'identity':
      return ev;
    case 'ais_cross_feed':
      return ctx.secondary ? eventEvidenceClass(ctx.secondary) : ev;
    case 'gnss_diagnostics':
      return sensorClass(ctx.gnss?.labels);
    case 'imu':
      // Hist Lab IMU is reconstructed from AIS deltas → simulated at best.
      return sensorClass(ctx.imu?.labels);
    case 'osnma':
      if (ctx.osnma?.mode === 'live') return 'live';
      return 'demo';
    case 'attestation':
      // Server-asserted software attestation (U2): no verifiable chain.
      return ctx.attestation && ctx.attestation.assurance_level === 'hardware' && ctx.attestation.verified
        ? 'live'
        : 'demo';
    case 'rf_lab':
    case 'spatial_aoa':
      // Fixed capture with no timestamps/geometry bound to this vessel (U1).
      return 'demo';
    case 'device_signature':
      // The cryptographic verification itself is real when a signed envelope arrives.
      return ctx.event.source === 'device_telemetry' ? (ev === 'simulated' ? 'live' : ev) : ev;
    case 'signed_vs_ais':
      return ctx.onboardTrackIsAisCopy === false ? ev : 'simulated';
    default:
      return 'demo';
  }
}

/** Stamp evidence_class on every check that has not set one itself. */
export function stampEvidenceClass(checks: CheckResult[], ctx: EvidenceContext): CheckResult[] {
  return checks.map((c) =>
    c.evidence_class ? c : { ...c, evidence_class: classifyCheckEvidence(c.check_id, ctx) },
  );
}

export const VERIFIED_EVIDENCE_CLASSES: ReadonlySet<EvidenceClass> = new Set(['live', 'recorded']);
