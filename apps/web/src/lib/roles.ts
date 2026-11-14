import type { AppSnapshot, CheckResult, VesselState } from './types';

export type Role = 'live' | 'recorded' | 'simulated' | 'lab';

/** Where a ship's data comes from — attacks are only ever injected into 'simulated' ships. */
export function roleOf(v: VesselState, s: AppSnapshot | null): Role {
  if (v.origin === 'live') return 'live';
  if (s?.injection?.lab_vessel_id === v.entity_id) return 'lab';
  if (s?.injection?.simulated_ships.includes(v.entity_id)) return 'simulated';
  return 'recorded';
}

export const ROLE_LABEL: Record<Role, string> = {
  live: 'LIVE AIS',
  recorded: 'RECORDED AIS',
  simulated: 'SIMULATED · attack target',
  lab: 'LAB VESSEL · independent sensors',
};

/**
 * Evidence layers a ship of this role never has data for. They are hidden only while
 * unavailable, so anything a scenario does produce still shows. Recorded ships keep all.
 */
const NEVER_AVAILABLE: Partial<Record<Role, Set<CheckResult['check_id']>>> = {
  // Public AIS: no RF array, no Galileo authentication, no signed onboard track.
  live: new Set(['rf_lab', 'spatial_aoa', 'osnma', 'signed_vs_ais']),
  // Synthetic ships have no signing device (RF / OSNMA stay: attacks can target them).
  simulated: new Set(['device_signature', 'signed_vs_ais', 'attestation']),
};

export const NOT_APPLICABLE_NOTE: Partial<Record<Role, string>> = {
  live: 'not available for public AIS',
  simulated: 'simulated ships have no signing device',
};

export function visibleChecks(role: Role, checks: CheckResult[]): { shown: CheckResult[]; hidden: number } {
  const never = NEVER_AVAILABLE[role];
  if (!never) return { shown: checks, hidden: 0 };
  const shown = checks.filter(
    (c) => !(never.has(c.check_id) && (c.status === 'unavailable' || c.status === 'unsupported')),
  );
  return { shown, hidden: checks.length - shown.length };
}
