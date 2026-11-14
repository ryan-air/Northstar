import type {
  AlertEvent,
  AttestationEvidence,
  CheckResult,
  GnssDiagnostics,
  ImuSample,
  OsnmaResult,
  PositionEvent,
  RfLabResult,
  TrustAssessment,
  VesselState,
} from '@northstar/contracts';
import {
  checkAisCrossFeed,
  checkAttestation,
  checkDeviceSignature,
  checkFleetCoherence,
  checkFleetCoherenceV2,
  checkIdentity,
  createIdentityState,
  stampEvidenceClass,
  createTransponderKindState,
  updateTransponderKind,
  type TransponderKind,
  type TransponderKindState,
  type FleetDisplacement,
  type IdentityConfig,
  type IdentityState,
  checkGeographic,
  checkGnssDiagnostics,
  checkImuConsistency,
  checkKinematics,
  checkNeighbors,
  checkOsnma,
  checkRfLab,
  checkSpatialAoa,
  checkSignedVsAis,
  createHardAlertState,
  fuseTrust,
  haversineM,
  type DeadReckonState,
  type FusionConfig,
  type HardAlertState,
  type KinematicsConfig,
  type KinematicsState,
} from '@northstar/core';
import type { GeoData } from '../geo/loadGeo.js';
import type { ThresholdsConfig } from '../config.js';
import { randomUUID } from 'node:crypto';

/** Per-source kinematic state (P3.1). Keys: ais_digitraffic | ais_aisstream | device_telemetry. */
interface SourceRuntime {
  lastEvent?: PositionEvent;
  prevEvent?: PositionEvent;
  kinState: KinematicsState;
  dr: DeadReckonState | null;
}

export function sourceKeyOf(e: PositionEvent): string {
  if (e.source === 'device_telemetry') return 'device_telemetry';
  if (e.provider_id === 'aisstream') return 'ais_aisstream';
  return 'ais_digitraffic';
}

/** Event as seen by kinematics: observation_time (if any) replaces source_timestamp. */
function kinematicView(e: PositionEvent): PositionEvent {
  return e.observation_time ? { ...e, source_timestamp: e.observation_time } : e;
}

interface EntityRuntime {
  sources: Map<string, SourceRuntime>;
  /** Ring buffer of recent AIS events (oldest first). */
  aisHistory: PositionEvent[];
  identityState: IdentityState;
  transponderState: TransponderKindState;
  lastIdentity?: CheckResult;
  transponderKind?: { kind: TransponderKind; reasons: string[] };
  lastEvent?: PositionEvent;
  previousEvent?: PositionEvent;
  lastAisEvent?: PositionEvent;
  lastSecondary?: PositionEvent;
  kinState: KinematicsState;
  hardState: HardAlertState;
  dr: DeadReckonState | null;
  trust?: TrustAssessment;
  track: VesselState['track'];
  name?: string;
  vessel_class?: string;
  gnss?: GnssDiagnostics;
  imu?: ImuSample;
  osnma?: OsnmaResult | null;
  attestation?: AttestationEvidence | null;
  rfLab?: RfLabResult | null;
}

export class TrustPipeline {
  private entities = new Map<string, EntityRuntime>();
  private alerts: AlertEvent[] = [];
  private timeline: AlertEvent[] = [];
  private kinConfig: KinematicsConfig;
  private identityConfig: IdentityConfig | null;
  private readonly perSource: boolean;

  constructor(
    private fusion: FusionConfig,
    private thresholds: ThresholdsConfig,
    private geo: GeoData,
  ) {
    this.kinConfig = {
      ...thresholds.kinematics,
      vessel_class_limits: thresholds.vessel_class_limits as KinematicsConfig['vessel_class_limits'],
    };
    this.perSource = thresholds.state?.per_source === true;
    this.identityConfig = thresholds.identity
      ? {
          ...thresholds.identity,
          max_sog_kn: Object.fromEntries(
            Object.entries(thresholds.vessel_class_limits).map(([k, v]) => [k, v.max_sog_kn]),
          ),
        }
      : null;
  }

  get configVersions(): { fusion: string; thresholds: string } {
    return { fusion: this.fusion.version, thresholds: this.thresholds.version };
  }

  reset(): void {
    this.entities.clear();
    this.alerts = [];
    this.timeline = [];
  }

  removeEntity(entityId: string): void {
    this.entities.delete(entityId);
  }

  ingestSecondary(event: PositionEvent): void {
    const rt = this.ensure(event.entity_id);
    rt.lastSecondary = event;
  }

  setGnss(d: GnssDiagnostics): void {
    this.ensure(d.entity_id).gnss = d;
  }

  setImu(s: ImuSample): void {
    this.ensure(s.entity_id).imu = s;
  }

  setOsnma(entityId: string, r: OsnmaResult | null): void {
    this.ensure(entityId).osnma = r;
  }

  setAttestation(entityId: string, a: AttestationEvidence | null): void {
    this.ensure(entityId).attestation = a;
  }

  setRfLab(entityId: string, r: RfLabResult | null): void {
    this.ensure(entityId).rfLab = r;
  }

  process(event: PositionEvent, nowIso: string): VesselState {
    const rt = this.ensure(event.entity_id);
    rt.name = event.name ?? rt.name;
    rt.vessel_class = event.vessel_class ?? rt.vessel_class;

    const srcKey = sourceKeyOf(event);
    const src = this.ensureSource(rt, srcKey);
    const kinEvent = kinematicView(event);
    // v2: the "previous" point always comes from the same source (never device↔AIS).
    const prevForKin = this.perSource ? (src.lastEvent ?? null) : (rt.lastEvent ?? null);
    const kinStateIn = this.perSource ? src.kinState : rt.kinState;

    const kin = checkKinematics(kinEvent, prevForKin, kinStateIn, this.kinConfig, nowIso);
    if (this.perSource) src.kinState = kin.state;
    else rt.kinState = kin.state;

    const geo = checkGeographic(
      event,
      { land: this.geo.land, ports: this.geo.ports, restricted: this.geo.restricted },
      this.thresholds.geographic,
      nowIso,
    );

    // Spatial grid (~0.05°) so neighbour scan is not full O(n²) at fleet scale.
    const cell = (lat: number, lon: number) =>
      `${Math.floor(lat / 0.05)}:${Math.floor(lon / 0.05)}`;
    const eventCell = cell(event.position.lat, event.position.lon);
    const [ecy, ecx] = eventCell.split(':').map(Number) as [number, number];
    const neighborObs = [...this.entities.entries()]
      .filter(([id, e]) => {
        if (id === event.entity_id || !e.lastEvent) return false;
        const [cy, cx] = cell(e.lastEvent.position.lat, e.lastEvent.position.lon)
          .split(':')
          .map(Number) as [number, number];
        return Math.abs(cy - ecy) <= 1 && Math.abs(cx - ecx) <= 1;
      })
      .map(([, e]) => e.lastEvent!)
      .map((e) => ({
        event: e,
        independence: e.provider_id === event.provider_id ? 0.2 : 0.8,
        reliability: 0.7,
      }));

    const neighbors = checkNeighbors(event, neighborObs, this.thresholds.neighbors, nowIso);

    const cross = checkAisCrossFeed(
      event,
      rt.lastSecondary && rt.lastSecondary.entity_id === event.entity_id
        ? rt.lastSecondary
        : null,
      nowIso,
      this.thresholds.neighbors.conflict_distance_m,
    );

    const gnss = checkGnssDiagnostics(
      event.entity_id,
      rt.gnss ?? null,
      this.thresholds.gnss_diagnostics,
      nowIso,
    );

    // v2: dead-reckoning state is meaningless across a long reporting gap — restart it
    // (same gap rule as the CUSUM reset). The IMU check itself is unchanged (U4).
    const gapS =
      prevForKin != null
        ? (Date.parse(kinEvent.source_timestamp) - Date.parse(prevForKin.source_timestamp)) / 1000
        : 0;
    const resetGap = this.kinConfig.cusum?.reset_gap_s;
    if (this.perSource && resetGap != null && gapS > resetGap) src.dr = null;
    const imuR = checkImuConsistency(
      kinEvent,
      prevForKin,
      rt.imu ?? null,
      this.perSource ? src.dr : rt.dr,
      this.thresholds.imu,
      nowIso,
    );
    if (this.perSource) src.dr = imuR.dr;
    else rt.dr = imuR.dr;

    const osnma = checkOsnma(event.entity_id, rt.osnma ?? null, nowIso);
    const sig = checkDeviceSignature(
      event.entity_id,
      event.device_signature_status,
      nowIso,
    );
    const attest = checkAttestation(event.entity_id, rt.attestation ?? null, nowIso);
    const rfLab = checkRfLab(event.entity_id, rt.rfLab ?? null, nowIso);
    const spatialAoa = checkSpatialAoa(event.entity_id, rt.rfLab ?? null, nowIso);
    const svaCfg = this.thresholds.signed_vs_ais;
    const signedVsAis = svaCfg
      ? checkSignedVsAis(
          event,
          event.source === 'device_telemetry'
            ? interpolateAis(rt.aisHistory, Date.parse(kinEvent.source_timestamp), svaCfg.interp_window_s)
            : null,
          nowIso,
          { warn_m: svaCfg.warn_m, fail_m: svaCfg.fail_m },
        )
      : checkSignedVsAis(
          event,
          event.source === 'device_telemetry' ? (rt.lastAisEvent ?? null) : null,
          nowIso,
        );

    const recentCutoffMs = Date.parse(nowIso) - this.thresholds.neighbors.max_age_s * 1000;
    const fleetDisplacements = [...this.entities.entries()].flatMap(([entityId, entityRt]) => {
      const from =
        entityId === event.entity_id ? entityRt.lastEvent : entityRt.previousEvent;
      const to = entityId === event.entity_id ? event : entityRt.lastEvent;
      if (!from || !to || Date.parse(to.source_timestamp) < recentCutoffMs) {
        return [];
      }
      const dist_m = haversineM(
        from.position.lat,
        from.position.lon,
        to.position.lat,
        to.position.lon,
      );
      return [
        {
          entity_id: entityId,
          prev_lat: from.position.lat,
          prev_lon: from.position.lon,
          lat: to.position.lat,
          lon: to.position.lon,
          dist_m,
          d_lat: to.position.lat - from.position.lat,
          d_lon: to.position.lon - from.position.lon,
        },
      ];
    });
    const fleetCoherence = this.thresholds.fleet_coherence
      ? checkFleetCoherenceV2(
          event.entity_id,
          this.fleetDisplacementsV2(event, kinEvent, srcKey, nowIso),
          nowIso,
          this.thresholds.fleet_coherence,
        )
      : checkFleetCoherence(event.entity_id, fleetDisplacements, nowIso);

    let identity: CheckResult;
    if (!this.identityConfig) {
      identity = unavailableCheck(event.entity_id, 'identity', nowIso, 'Identity check not enabled in this config version');
    } else if (srcKey === 'device_telemetry') {
      identity =
        rt.lastIdentity ?? unavailableCheck(event.entity_id, 'identity', nowIso, 'No AIS identity yet');
    } else {
      const idr = checkIdentity(event, rt.identityState, this.identityConfig, nowIso);
      rt.identityState = idr.state;
      rt.lastIdentity = idr.result;
      identity = idr.result;
    }

    const rawChecks: CheckResult[] = [
      kin.result,
      geo,
      neighbors,
      cross,
      gnss,
      imuR.result,
      osnma,
      sig,
      attest,
      rfLab,
      spatialAoa,
      signedVsAis,
      fleetCoherence,
    ];
    if (this.identityConfig) rawChecks.push(identity);
    const checks = stampEvidenceClass(rawChecks, {
      event,
      secondary: rt.lastSecondary ?? null,
      gnss: rt.gnss ?? null,
      imu: rt.imu ?? null,
      osnma: rt.osnma ?? null,
      attestation: rt.attestation ?? null,
      rfLab: rt.rfLab ?? null,
      onboardTrackIsAisCopy: true,
    });

    const prevScore = rt.trust?.trust_score ?? null;
    const fused = fuseTrust(event.entity_id, checks, this.fusion, rt.hardState, nowIso, {
      observationTs: kinEvent.source_timestamp,
    });
    rt.hardState = fused.hardState;
    if (srcKey !== 'device_telemetry') {
      const tk = updateTransponderKind(
        rt.transponderState,
        event,
        this.geo.land.query(event.position.lon, event.position.lat).onLand,
      );
      rt.transponderState = tk.state;
      rt.transponderKind = { kind: tk.kind, reasons: tk.reasons };
    }
    fused.assessment = {
      ...fused.assessment,
      ...(rt.transponderKind
        ? { transponder_kind: rt.transponderKind.kind, transponder_kind_reasons: rt.transponderKind.reasons }
        : {}),
    };
    rt.trust = fused.assessment;

    const anomalous =
      fused.assessment.trust_band === 'suspicious' ||
      fused.assessment.trust_band === 'critical' ||
      kin.result.hard_alert ||
      geo.hard_alert;

    rt.track.push({
      lat: event.position.lat,
      lon: event.position.lon,
      t: event.source_timestamp,
      anomalous,
    });
    if (rt.track.length > 200) rt.track.shift();

    if (
      prevScore != null &&
      Math.abs(prevScore - fused.assessment.trust_score) >= 10
    ) {
      this.pushAlert({
        id: randomUUID(),
        entity_id: event.entity_id,
        kind: 'trust_change',
        severity:
          fused.assessment.trust_band === 'critical'
            ? 'critical'
            : fused.assessment.trust_band === 'suspicious'
              ? 'warning'
              : 'info',
        title: `Trust ${prevScore} → ${fused.assessment.trust_score}`,
        explanation: fused.assessment.explanation,
        trust_score_before: prevScore,
        trust_score_after: fused.assessment.trust_score,
        check_ids: checks.filter((c) => c.status === 'fail' || c.status === 'warning').map((c) => c.check_id),
        observed_at: nowIso,
        evidence_refs: [],
        hard: fused.assessment.hard_alerts.length > 0,
      });
    } else if (fused.assessment.hard_alerts.length > 0) {
      this.pushAlert({
        id: randomUUID(),
        entity_id: event.entity_id,
        kind: 'hard_alert',
        severity: 'critical',
        title: 'Hard integrity alert',
        explanation: fused.assessment.explanation,
        trust_score_before: prevScore,
        trust_score_after: fused.assessment.trust_score,
        check_ids: checks.filter((c) => c.hard_alert).map((c) => c.check_id),
        observed_at: nowIso,
        evidence_refs: [],
        hard: true,
      });
    }

    rt.previousEvent = rt.lastEvent;
    rt.lastEvent = event;
    src.prevEvent = src.lastEvent;
    src.lastEvent = kinEvent;
    if (event.source.startsWith('ais_') || event.source === 'ais') {
      rt.lastAisEvent = event;
      rt.aisHistory.push(event);
      const cap = this.thresholds.state?.ais_history ?? 32;
      if (rt.aisHistory.length > cap) rt.aisHistory.splice(0, rt.aisHistory.length - cap);
    }

    return {
      entity_id: event.entity_id,
      name: rt.name,
      vessel_class: rt.vessel_class,
      position: event.position,
      speed_over_ground_knots: event.speed_over_ground_knots,
      course_over_ground_deg: event.course_over_ground_deg,
      heading_deg: event.heading_deg,
      trust: fused.assessment,
      track: [...rt.track],
      last_update: nowIso,
    };
  }

  getVessels(): VesselState[] {
    const out: VesselState[] = [];
    for (const [id, rt] of this.entities) {
      if (!rt.trust || !rt.lastEvent) continue;
      out.push({
        entity_id: id,
        name: rt.name,
        vessel_class: rt.vessel_class,
        position: rt.lastEvent.position,
        speed_over_ground_knots: rt.lastEvent.speed_over_ground_knots,
        course_over_ground_deg: rt.lastEvent.course_over_ground_deg,
        heading_deg: rt.lastEvent.heading_deg,
        trust: rt.trust,
        track: [...rt.track],
        last_update: rt.lastEvent.source_timestamp,
      });
    }
    return out;
  }

  getAlerts(): AlertEvent[] {
    return [...this.alerts];
  }

  getTimeline(): AlertEvent[] {
    return [...this.timeline];
  }

  /** Clear hard-alert debounce/active state for one entity (Hist Lab loop wrap). */
  resetHardAlerts(entityId: string): void {
    const rt = this.entities.get(entityId);
    if (rt) rt.hardState = createHardAlertState();
  }

  entityIds(): string[] {
    return [...this.entities.keys()];
  }

  private ensureSource(rt: EntityRuntime, key: string): SourceRuntime {
    let s = rt.sources.get(key);
    if (!s) {
      s = { kinState: { cusum: 0 }, dr: null };
      rt.sources.set(key, s);
    }
    return s;
  }

  /**
   * v2 fleet displacements: AIS sources only, with dt and the earlier fix's SOG/COG so
   * the coherence check can subtract each vessel's own predicted motion.
   */
  private fleetDisplacementsV2(
    event: PositionEvent,
    kinEvent: PositionEvent,
    srcKey: string,
    nowIso: string,
  ): FleetDisplacement[] {
    const cutoff = Date.parse(nowIso) - this.thresholds.neighbors.max_age_s * 1000;
    const out: FleetDisplacement[] = [];
    const mk = (id: string, from: PositionEvent, to: PositionEvent): FleetDisplacement | null => {
      const t0 = Date.parse(from.source_timestamp);
      const t1 = Date.parse(to.source_timestamp);
      if (!(t1 > t0) || t1 < cutoff) return null;
      return {
        entity_id: id,
        prev_lat: from.position.lat,
        prev_lon: from.position.lon,
        lat: to.position.lat,
        lon: to.position.lon,
        dist_m: haversineM(from.position.lat, from.position.lon, to.position.lat, to.position.lon),
        d_lat: to.position.lat - from.position.lat,
        d_lon: to.position.lon - from.position.lon,
        dt_s: (t1 - t0) / 1000,
        from_sog_kn: from.speed_over_ground_knots ?? null,
        from_cog_deg: from.course_over_ground_deg ?? null,
        to_sog_kn: to.speed_over_ground_knots ?? null,
      };
    };
    for (const [id, rt] of this.entities) {
      if (id === event.entity_id) {
        if (srcKey === 'device_telemetry') continue;
        const from = rt.sources.get(srcKey)?.lastEvent;
        const d = from ? mk(id, from, kinEvent) : null;
        if (d) out.push(d);
        continue;
      }
      const s = rt.sources.get('ais_digitraffic') ?? rt.sources.get('ais_aisstream');
      if (s?.prevEvent && s.lastEvent) {
        const d = mk(id, s.prevEvent, s.lastEvent);
        if (d) out.push(d);
      }
    }
    return out;
  }

  private ensure(id: string): EntityRuntime {
    let rt = this.entities.get(id);
    if (!rt) {
      rt = {
        sources: new Map(),
        aisHistory: [],
        identityState: createIdentityState(),
        transponderState: createTransponderKindState(),
        kinState: { cusum: 0 },
        hardState: createHardAlertState(),
        dr: null,
        track: [],
        osnma: null,
      };
      this.entities.set(id, rt);
    }
    return rt;
  }

  private pushAlert(a: AlertEvent): void {
    // debounce identical hard alerts within 5s
    const last = this.timeline[this.timeline.length - 1];
    if (
      last &&
      last.entity_id === a.entity_id &&
      last.kind === a.kind &&
      Date.parse(a.observed_at) - Date.parse(last.observed_at) < 5000
    ) {
      return;
    }
    this.alerts.unshift(a);
    if (this.alerts.length > 50) this.alerts.pop();
    this.timeline.push(a);
    if (this.timeline.length > 200) this.timeline.shift();
  }
}

function unavailableCheck(
  entityId: string,
  checkId: CheckResult['check_id'],
  nowIso: string,
  reason: string,
): CheckResult {
  return {
    entity_id: entityId,
    check_id: checkId,
    status: 'unavailable',
    anomaly_score: null,
    severity: 'none',
    observed_at: nowIso,
    explanation: reason,
    source_ids: [],
    quality: 0,
    freshness: 0,
    reliability: 0,
    missing_reason: reason,
    hard_alert: false,
  };
}

/**
 * AIS position at time tMs, linearly interpolated between the two AIS samples that
 * bracket it, when both lie within ±windowS. Returns null if no bracketing pair.
 */
export function interpolateAis(
  history: PositionEvent[],
  tMs: number,
  windowS: number,
): PositionEvent | null {
  if (history.length === 0 || !Number.isFinite(tMs)) return null;
  const w = windowS * 1000;
  let before: PositionEvent | null = null;
  let after: PositionEvent | null = null;
  for (const h of history) {
    const t = Date.parse(h.source_timestamp);
    if (t <= tMs && tMs - t <= w && (!before || t > Date.parse(before.source_timestamp))) before = h;
    if (t >= tMs && t - tMs <= w && (!after || t < Date.parse(after.source_timestamp))) after = h;
  }
  if (before && after) {
    const ta = Date.parse(before.source_timestamp);
    const tb = Date.parse(after.source_timestamp);
    const u = tb === ta ? 0 : (tMs - ta) / (tb - ta);
    return {
      ...after,
      position: {
        ...after.position,
        lat: before.position.lat + (after.position.lat - before.position.lat) * u,
        lon: before.position.lon + (after.position.lon - before.position.lon) * u,
      },
      source_timestamp: new Date(tMs).toISOString(),
      interpolated: true,
    };
  }
  // Allow the nearest single sample if it is within a short tolerance (≤ 15 s).
  const single = before ?? after;
  if (single && Math.abs(Date.parse(single.source_timestamp) - tMs) <= 15_000) return single;
  return null;
}
