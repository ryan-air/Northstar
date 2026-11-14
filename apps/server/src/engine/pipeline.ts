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

interface EntityRuntime {
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

  constructor(
    private fusion: FusionConfig,
    private thresholds: ThresholdsConfig,
    private geo: GeoData,
  ) {
    this.kinConfig = {
      ...thresholds.kinematics,
      vessel_class_limits: thresholds.vessel_class_limits as KinematicsConfig['vessel_class_limits'],
    };
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

    const kin = checkKinematics(event, rt.lastEvent ?? null, rt.kinState, this.kinConfig, nowIso);
    rt.kinState = kin.state;

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

    const imuR = checkImuConsistency(
      event,
      rt.lastEvent ?? null,
      rt.imu ?? null,
      rt.dr,
      this.thresholds.imu,
      nowIso,
    );
    rt.dr = imuR.dr;

    const osnma = checkOsnma(event.entity_id, rt.osnma ?? null, nowIso);
    const sig = checkDeviceSignature(
      event.entity_id,
      event.device_signature_status,
      nowIso,
    );
    const attest = checkAttestation(event.entity_id, rt.attestation ?? null, nowIso);
    const rfLab = checkRfLab(event.entity_id, rt.rfLab ?? null, nowIso);
    const spatialAoa = checkSpatialAoa(event.entity_id, rt.rfLab ?? null, nowIso);
    const signedVsAis = checkSignedVsAis(
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
    const fleetCoherence = checkFleetCoherence(
      event.entity_id,
      fleetDisplacements,
      nowIso,
    );

    const checks: CheckResult[] = [
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

    const prevScore = rt.trust?.trust_score ?? null;
    const fused = fuseTrust(event.entity_id, checks, this.fusion, rt.hardState, nowIso);
    rt.hardState = fused.hardState;
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
    if (event.source.startsWith('ais_') || event.source === 'ais') {
      rt.lastAisEvent = event;
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

  private ensure(id: string): EntityRuntime {
    let rt = this.entities.get(id);
    if (!rt) {
      rt = {
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
