import type { CheckResult, PositionEvent, VesselClass } from '@northstar/contracts';
import { haversineM, mpsToKnots } from '../geo/haversine.js';

/**
 * ITU Maritime Identification Digits (MID) allocated to administrations
 * (ITU-R M.585 / MARS table). Snapshot embedded for offline use — refresh from the
 * ITU MARS database when it changes (see EVALUATION.md "data needed").
 */
const MID_RANGES: Array<[number, number]> = [
  [201, 216], [218, 220], [224, 279],
  [301, 301], [303, 312], [314, 314], [316, 316], [319, 319], [321, 321], [323, 323],
  [325, 325], [327, 327], [329, 332], [334, 334], [336, 336], [338, 339], [341, 341],
  [343, 343], [345, 345], [347, 348], [350, 359], [361, 362], [364, 364], [366, 379],
  [401, 401], [403, 403], [405, 405], [408, 408], [410, 410], [412, 414], [416, 417],
  [419, 419], [422, 423], [425, 425], [428, 428], [431, 432], [434, 434], [436, 438],
  [440, 441], [443, 443], [445, 445], [447, 447], [450, 451], [453, 453], [455, 455],
  [457, 457], [459, 459], [461, 461], [463, 463], [466, 466], [468, 468], [470, 473],
  [475, 475], [477, 478],
  [501, 501], [503, 503], [506, 506], [508, 508], [510, 512], [514, 516], [518, 518],
  [520, 520], [523, 523], [525, 525], [529, 529], [531, 531], [533, 533], [536, 536],
  [538, 538], [540, 540], [542, 542], [544, 544], [546, 546], [548, 548], [550, 550],
  [553, 553], [555, 555], [557, 557], [559, 559], [561, 561], [563, 567], [570, 570],
  [572, 572], [574, 574], [576, 578],
  [601, 601], [603, 603], [605, 605], [607, 613], [615, 622], [624, 627], [629, 638],
  [642, 642], [644, 645], [647, 647], [649, 650], [654, 657], [659, 672], [674, 679],
  [701, 701], [710, 710], [720, 720], [725, 725], [730, 730], [735, 735], [740, 740],
  [745, 745], [750, 750], [755, 755], [760, 760], [765, 765], [770, 770], [775, 775],
];

export function isAllocatedMid(mid: number): boolean {
  return MID_RANGES.some(([lo, hi]) => mid >= lo && mid <= hi);
}

export type MmsiKind =
  | 'ship'
  | 'group'
  | 'coast_station'
  | 'sar_aircraft'
  | 'aid_to_navigation'
  | 'craft_associated'
  | 'ais_sart_mob_epirb'
  | 'invalid';

/** Classify a 9-digit MMSI and extract its MID per ITU-R M.585. */
export function parseMmsi(raw: number | string): { kind: MmsiKind; mid: number | null; valid_mid: boolean } {
  const s = String(raw).trim();
  if (!/^\d{9}$/.test(s)) return { kind: 'invalid', mid: null, valid_mid: false };
  const mid3 = (from: number) => Number(s.slice(from, from + 3));
  let kind: MmsiKind;
  let mid: number | null;
  if (/^97[024]/.test(s)) return { kind: 'ais_sart_mob_epirb', mid: null, valid_mid: true };
  if (s.startsWith('111')) {
    kind = 'sar_aircraft';
    mid = mid3(3);
  } else if (s.startsWith('99')) {
    kind = 'aid_to_navigation';
    mid = mid3(2);
  } else if (s.startsWith('98')) {
    kind = 'craft_associated';
    mid = mid3(2);
  } else if (s.startsWith('00')) {
    kind = 'coast_station';
    mid = mid3(2);
  } else if (s.startsWith('0')) {
    kind = 'group';
    mid = mid3(1);
  } else if (/^[2-7]/.test(s)) {
    kind = 'ship';
    mid = mid3(0);
  } else {
    return { kind: 'invalid', mid: null, valid_mid: false };
  }
  return { kind, mid, valid_mid: mid != null && isAllocatedMid(mid) };
}

export interface IdentityConfig {
  /** Positions kept for clone detection. */
  history: number;
  /** Implied speed above class max × this factor counts as an impossible hop. */
  clone_speed_factor: number;
  /** Only hops within this dt are considered (s). */
  clone_max_dt_s: number;
  /** Window for static-data change detection (s). */
  static_window_s: number;
  /** Class max SOG (kn) used for impossible-hop detection. */
  max_sog_kn: Record<string, number>;
}

export const DEFAULT_IDENTITY: IdentityConfig = {
  history: 8,
  clone_speed_factor: 1.5,
  clone_max_dt_s: 900,
  static_window_s: 86_400,
  max_sog_kn: { other: 30 },
};

export interface IdentityState {
  recent: Array<{ lat: number; lon: number; t: number }>;
  statics: Array<{ t: number; name?: string; call_sign?: string; imo?: string }>;
}

export function createIdentityState(): IdentityState {
  return { recent: [], statics: [] };
}

function mmsiOf(e: PositionEvent): string | null {
  const m = e.labels?.mmsi;
  if (m != null && String(m).trim() !== '') return String(m).trim();
  const digits = /(\d{9})$/.exec(e.entity_id);
  return digits ? digits[1]! : null;
}

export function checkIdentity(
  event: PositionEvent,
  state: IdentityState,
  config: IdentityConfig,
  nowIso: string,
): { result: CheckResult; state: IdentityState } {
  const t = Date.parse(event.observation_time ?? event.source_timestamp);
  const findings: string[] = [];
  let anomaly = 0;
  const evidence: Record<string, unknown> = {};

  const mmsi = mmsiOf(event);
  if (mmsi) {
    const parsed = parseMmsi(mmsi);
    evidence.mmsi = mmsi;
    evidence.mmsi_kind = parsed.kind;
    evidence.mid = parsed.mid;
    evidence.mid_allocated = parsed.valid_mid;
    if (parsed.kind === 'invalid') {
      anomaly = Math.max(anomaly, 0.6);
      findings.push(`MMSI ${mmsi} is not a valid 9-digit identity.`);
    } else if (!parsed.valid_mid) {
      anomaly = Math.max(anomaly, 0.5);
      findings.push(`MMSI ${mmsi} uses MID ${parsed.mid}, which is not an ITU-allocated country code.`);
    }
  }

  // Same identity in two places: alternating impossible hops (A→B→A).
  const limit =
    config.max_sog_kn[(event.vessel_class ?? 'other') as VesselClass] ??
    config.max_sog_kn.other ??
    30;
  const pts = [...state.recent, { lat: event.position.lat, lon: event.position.lon, t }];
  const impossible = (a: { lat: number; lon: number; t: number }, b: typeof a) => {
    const dt = (b.t - a.t) / 1000;
    if (!(dt > 0) || dt > config.clone_max_dt_s) return false;
    const kn = mpsToKnots(haversineM(a.lat, a.lon, b.lat, b.lon) / dt);
    return kn > limit * config.clone_speed_factor;
  };
  let hops = 0;
  for (let i = 1; i < pts.length; i++) if (impossible(pts[i - 1]!, pts[i]!)) hops++;
  const cur = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2];
  let returnsToEarlier = false;
  if (prev && impossible(prev, cur)) {
    for (let i = pts.length - 3; i >= 0; i--) {
      if (!impossible(pts[i]!, cur)) {
        returnsToEarlier = true;
        break;
      }
    }
  }
  evidence.impossible_hops = hops;
  evidence.returns_to_earlier_track = returnsToEarlier;
  if (hops >= 2 && returnsToEarlier) {
    anomaly = Math.max(anomaly, 0.9);
    findings.push(
      `Identity appears in two places: ${hops} impossible hops in the last ${pts.length} reports, alternating between tracks (possible MMSI clone/collision).`,
    );
  }

  // Static data changes within the window.
  const name = event.name?.startsWith('MMSI ') ? undefined : event.name?.trim() || undefined;
  const call_sign = (event.labels?.call_sign as string | undefined)?.trim() || undefined;
  const imoRaw = (event.labels as Record<string, unknown> | undefined)?.imo;
  const imo = imoRaw != null && String(imoRaw) !== '0' ? String(imoRaw) : undefined;
  const statics = [...state.statics.filter((s) => t - s.t <= config.static_window_s * 1000)];
  const last = statics[statics.length - 1];
  const changed: string[] = [];
  if (last) {
    if (name && last.name && name !== last.name) changed.push(`name ${last.name} → ${name}`);
    if (call_sign && last.call_sign && call_sign !== last.call_sign)
      changed.push(`call sign ${last.call_sign} → ${call_sign}`);
    if (imo && last.imo && imo !== last.imo) changed.push(`IMO ${last.imo} → ${imo}`);
  }
  if (!last || name || call_sign || imo) {
    statics.push({ t, name: name ?? last?.name, call_sign: call_sign ?? last?.call_sign, imo: imo ?? last?.imo });
  }
  if (changed.length > 0) {
    anomaly = Math.max(anomaly, changed.some((c) => c.startsWith('IMO')) ? 0.6 : 0.45);
    findings.push(`Static identity changed within 24 h: ${changed.join('; ')}.`);
    evidence.static_changes = changed;
  }

  const nextState: IdentityState = {
    recent: pts.slice(-config.history),
    statics: statics.slice(-20),
  };

  const runnable = mmsi != null || pts.length > 1;
  if (!runnable) {
    return {
      state: nextState,
      result: {
        entity_id: event.entity_id,
        check_id: 'identity',
        status: 'unavailable',
        anomaly_score: null,
        severity: 'none',
        observed_at: nowIso,
        explanation: 'No MMSI or position history available for identity checks.',
        source_ids: [],
        quality: 0,
        freshness: 0,
        reliability: 0,
        missing_reason: 'No MMSI',
        hard_alert: false,
      },
    };
  }

  const status: CheckResult['status'] = anomaly >= 0.85 ? 'fail' : anomaly >= 0.4 ? 'warning' : 'pass';
  return {
    state: nextState,
    result: {
      entity_id: event.entity_id,
      check_id: 'identity',
      status,
      anomaly_score: anomaly,
      severity: anomaly >= 0.85 ? 'high' : anomaly >= 0.4 ? 'medium' : 'none',
      observed_at: nowIso,
      explanation:
        findings.length > 0 ? findings.join(' ') : 'MMSI format, MID and static identity are consistent.',
      source_ids: [event.source],
      quality: 0.85,
      freshness: 1,
      reliability: 0.85,
      missing_reason: null,
      evidence,
      hard_alert: false,
    },
  };
}
