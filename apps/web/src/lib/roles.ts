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
 * unavailable, so anything a scenario does produce still shows. The lab vessel keeps all.
 */
const NEVER_AVAILABLE: Partial<Record<Role, Set<CheckResult['check_id']>>> = {
  // Public AIS: no RF array, no Galileo authentication, no signed onboard track, no
  // receiver diagnostics, no IMU and no device attestation.
  live: new Set(['rf_lab', 'spatial_aoa', 'osnma', 'signed_vs_ais', 'gnss_diagnostics', 'imu', 'attestation']),
  // No signing device and no RF array (RF rows still show when an RF attack targets the ship).
  simulated: new Set(['device_signature', 'attestation', 'rf_lab', 'spatial_aoa', 'signed_vs_ais']),
  // Replayed Digitraffic ships: same — only the lab vessel carries device / RF evidence.
  recorded: new Set(['device_signature', 'attestation', 'rf_lab', 'spatial_aoa']),
};

export const NOT_APPLICABLE_NOTE: Partial<Record<Role, string>> = {
  live: 'not available for public AIS',
  simulated: 'no signing device or RF array on simulated ships',
  recorded: 'no signing device or RF array on replayed AIS ships',
};

export function visibleChecks(role: Role, checks: CheckResult[]): { shown: CheckResult[]; hidden: number } {
  const never = NEVER_AVAILABLE[role];
  if (!never) return { shown: checks, hidden: 0 };
  const shown = checks.filter(
    (c) => !(never.has(c.check_id) && (c.status === 'unavailable' || c.status === 'unsupported')),
  );
  return { shown, hidden: checks.length - shown.length };
}


/** Human-readable names for evidence layers. */
export const CHECK_LABEL: Record<CheckResult['check_id'], string> = {
  kinematics: 'Kinematics',
  geographic: 'Geographic',
  neighbors: 'Independent observation',
  ais_cross_feed: 'AIS cross-feed',
  gnss_diagnostics: 'GNSS receiver',
  imu: 'Dead reckoning / IMU',
  osnma: 'Galileo OSNMA',
  device_signature: 'Device signature',
  attestation: 'Hardware attestation',
  rf_lab: 'RF capture',
  spatial_aoa: 'Angle of arrival',
  signed_vs_ais: 'Signed track vs AIS',
  fleet_coherence: 'Fleet coherence',
  identity: 'Identity',
};

/** One short, clean sentence from a check explanation (full text stays in the tooltip). */
export function shortExplanation(text: string, max = 110): string {
  let s = text.replace(/^(\s*\[[^\]]*\]\s*)+/, '').trim();
  const cut = s.search(/(?<=[a-z0-9)%])\.\s/i);
  if (cut > 0) s = s.slice(0, cut + 1);
  if (s.length > max) s = s.slice(0, max - 1).replace(/[\s,;:–—-]+\S*$/, '') + '…';
  return s;
}

const SOURCE_LABEL: Array<[RegExp, string]> = [
  [/^vts_radar:?(.*)$/, 'radar $1'],
  [/^ais_provider_a$|^ais$/, 'AIS'],
  [/^ais_provider_b$/, 'AIS (2nd)'],
  [/gyro_hdt/, 'gyro'],
  [/speed_log\w*/, 'speed log'],
  [/geo_land/, 'coastline'],
  [/gnss_receiver/, 'receiver'],
];

export function shortSources(ids: string[] | undefined): string {
  const out = (ids ?? []).map((id) => {
    for (const [re, label] of SOURCE_LABEL) if (re.test(id)) return id.replace(re, label).trim();
    return id.replace(/_/g, ' ');
  });
  return [...new Set(out)].slice(0, 3).join(', ');
}
