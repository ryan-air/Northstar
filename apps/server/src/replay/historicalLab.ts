import type {
  GnssDiagnostics,
  ImuSample,
  OsnmaStatus,
  PositionEvent,
  ScenarioId,
  VesselClass,
} from '@northstar/contracts';
import {
  buildTracks,
  enrichNames,
  loadAllRecords,
  loadManifest,
} from './store.js';
import type { ReplayManifest, VesselTrack } from './types.js';
import { gnssFixture } from '../fixtures/loadFixtures.js';

export interface LabScenarioState {
  id: ScenarioId;
  targetId: string;
  startedAtMs: number;
  driftMeters: number;
  spoofLat?: number;
  spoofLon?: number;
  jamming: boolean;
  imuDisagree: boolean;
  aisDisagree: boolean;
  signedTamper: boolean;
  signedReplay: boolean;
  staleClock: boolean;
  osnmaFail: boolean;
  osnmaPending: boolean;
}

interface VesselPlayhead {
  track: VesselTrack;
  /** ms into the track (loops) */
  cursorMs: number;
  sequence: number;
  lastLat: number;
  lastLon: number;
  lastSog: number;
}

/**
 * Lab driver backed by recorded Digitraffic AIS (historical), with optional attack overlays.
 */
export class HistoricalLab {
  vessels: VesselPlayhead[] = [];
  simTimeMs: number;
  scenario: LabScenarioState;
  tickCount = 0;
  /** Playback speed vs recorded wall time */
  speed = 8;
  ready = false;
  manifest: ReplayManifest | null = null;
  signedEntityId: string | null = null;
  sourceLabel = 'digitraffic_historical_replay';
  /** Protocol-demo OSNMA status mirrored onto Hist Lab events (not live SIS). */
  protocolOsnmaStatus: OsnmaStatus = 'unavailable';

  constructor(startIso = new Date().toISOString()) {
    this.simTimeMs = Date.parse(startIso);
    this.scenario = this.normalScenario('LAB-0');
  }

  async init(): Promise<{ ok: boolean; reason: string; vesselCount: number }> {
    const records = loadAllRecords();
    this.manifest = loadManifest();
    if (records.length < 50) {
      this.ready = false;
      return {
        ok: false,
        reason: 'Not enough recorded Digitraffic samples yet — recorder will fill data/replay/',
        vesselCount: 0,
      };
    }
    const tracks = buildTracks(records, { maxVessels: 24, minSamples: 3 });
    await enrichNames(tracks);
    if (tracks.length === 0) {
      this.ready = false;
      return { ok: false, reason: 'No multi-point tracks in replay cache', vesselCount: 0 };
    }

    // Prefer a moving vessel as signed demo target
    const moving =
      tracks.find((t) => {
        const sogs = t.samples.map((s) => s.sog ?? 0).filter((x) => x > 0.5 && x < 40);
        return sogs.length >= 2;
      }) ?? tracks[0]!;

    this.vessels = tracks.map((track) => {
      const s0 = track.samples[0]!;
      return {
        track,
        cursorMs: 0,
        sequence: 1,
        lastLat: s0.lat,
        lastLon: s0.lon,
        lastSog: typeof s0.sog === 'number' ? s0.sog : 0,
      };
    });
    this.signedEntityId = moving.entity_id;
    this.scenario = this.normalScenario(moving.entity_id);
    this.ready = true;
    // Align lab clock to first sample time for honesty in UI
    const t0 =
      moving.samples[0]!.timestamp_external_ms ??
      Date.parse(moving.samples[0]!.captured_at);
    this.simTimeMs = t0;
    return { ok: true, reason: 'historical Digitraffic replay ready', vesselCount: tracks.length };
  }

  private normalScenario(targetId: string): LabScenarioState {
    return {
      id: 'normal',
      targetId,
      startedAtMs: this.simTimeMs,
      driftMeters: 0,
      jamming: false,
      imuDisagree: false,
      aisDisagree: false,
      signedTamper: false,
      signedReplay: false,
      staleClock: false,
      osnmaFail: false,
      osnmaPending: false,
    };
  }

  setScenario(id: ScenarioId, entityId?: string): void {
    if (id === 'reset') {
      this.resetPlayheads();
      this.scenario = this.normalScenario(this.signedEntityId ?? this.vessels[0]?.track.entity_id ?? 'LAB-0');
      return;
    }
    const target = entityId ?? this.signedEntityId ?? this.vessels[0]?.track.entity_id ?? 'LAB-0';
    this.scenario = {
      id,
      targetId: target,
      startedAtMs: this.simTimeMs,
      driftMeters: 0,
      jamming: id === 'gnss_jamming',
      imuDisagree: id === 'imu_disagreement',
      aisDisagree: id === 'ais_disagreement',
      signedTamper: id === 'signed_tamper',
      signedReplay: id === 'signed_replay',
      staleClock: id === 'stale_clock_skew',
      osnmaFail: id === 'osnma_failure',
      osnmaPending: false,
      spoofLat: undefined,
      spoofLon: undefined,
    };
    if (id === 'sudden_spoof' || id === 'ais_disagreement') {
      this.scenario.spoofLat = 60.32;
      this.scenario.spoofLon = 24.95;
    }
  }

  resetPlayheads(): void {
    for (const v of this.vessels) {
      v.cursorMs = 0;
      const s0 = v.track.samples[0]!;
      v.lastLat = s0.lat;
      v.lastLon = s0.lon;
      v.lastSog = typeof s0.sog === 'number' ? s0.sog : 0;
      v.sequence = 1;
    }
    this.tickCount = 0;
    if (this.vessels[0]) {
      const s0 = this.vessels[0].track.samples[0]!;
      this.simTimeMs =
        s0.timestamp_external_ms ?? Date.parse(s0.captured_at);
    }
  }

  tick(dtS = 1): {
    aisA: PositionEvent[];
    aisB: PositionEvent[];
    imu: ImuSample[];
    gnss: GnssDiagnostics[];
    simTimeIso: string;
  } {
    // Advance the lab clock with playback speed so kinematics sees consistent Δt vs Δs
    const stepMs = dtS * 1000 * this.speed;
    this.simTimeMs += stepMs;
    this.tickCount += 1;
    const simTimeIso = new Date(this.simTimeMs).toISOString();
    const aisA: PositionEvent[] = [];
    const aisB: PositionEvent[] = [];
    const imu: ImuSample[] = [];
    const gnss: GnssDiagnostics[] = [];

    if (this.scenario.id === 'gradual_drift') {
      this.scenario.driftMeters += 15 * dtS * this.speed;
    }

    for (const v of this.vessels) {
      v.cursorMs = (v.cursorMs + stepMs) % v.track.durationMs;
      const sample = this.sampleAt(v.track, v.cursorMs);
      const truePos = { lat: sample.lat, lon: sample.lon };
      v.sequence += 1;

      let reported = { ...truePos };
      if (v.track.entity_id === this.scenario.targetId) {
        if (this.scenario.spoofLat != null && this.scenario.spoofLon != null) {
          reported = { lat: this.scenario.spoofLat, lon: this.scenario.spoofLon };
        } else if (this.scenario.driftMeters > 0) {
          // drift north
          reported = {
            lat: truePos.lat + this.scenario.driftMeters / 111_320,
            lon: truePos.lon,
          };
        }
      }

      const sog =
        typeof sample.sog === 'number' && sample.sog < 102 ? sample.sog : v.lastSog;
      const cog =
        typeof sample.cog === 'number' && sample.cog < 360 ? sample.cog : null;
      const heading =
        typeof sample.heading === 'number' && sample.heading >= 0 && sample.heading < 360
          ? sample.heading
          : cog;

      const base = this.toEvent(
        v,
        reported,
        sog,
        cog,
        heading,
        'ais_provider_a',
        'digitraffic_historical',
        simTimeIso,
        false,
      );
      aisA.push(base);

      // IMU: reconstructed from AIS deltas (not a real IMU tape)
      const dsog = sog - v.lastSog;
      imu.push({
        entity_id: v.track.entity_id,
        device_id:
          v.track.entity_id === this.signedEntityId ? 'DEV-VESSEL-001' : undefined,
        observed_at: simTimeIso,
        accel_mps2: [dsog * 0.05, 0, 0],
        gyro_rads: [0, 0, 0],
        labels: {
          simulated: true,
          fixture: true,
          // reconstructed from historical AIS — honest labelling via explanation path
        },
      });

      // This lab has no independent GNSS receiver: never derive diagnostics from scenario flags.
      gnss.push({
        ...gnssFixture('nominal', v.track.entity_id, simTimeIso),
        labels: { simulated: true, fixture: true },
      });

      v.lastLat = truePos.lat;
      v.lastLon = truePos.lon;
      v.lastSog = sog;
    }

    return { aisA, aisB, imu, gnss, simTimeIso };
  }

  private sampleAt(track: VesselTrack, cursorMs: number): VesselTrack['samples'][number] {
    const samples = track.samples;
    const t0 =
      samples[0]!.timestamp_external_ms ?? Date.parse(samples[0]!.captured_at);
    const target = t0 + cursorMs;
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const tm =
        samples[mid]!.timestamp_external_ms ?? Date.parse(samples[mid]!.captured_at);
      if (tm < target) lo = mid + 1;
      else hi = mid;
    }
    const b = samples[Math.min(lo, samples.length - 1)]!;
    const a = samples[Math.max(0, lo - 1)]!;
    const ta = a.timestamp_external_ms ?? Date.parse(a.captured_at);
    const tb = b.timestamp_external_ms ?? Date.parse(b.captured_at);
    if (tb === ta) return b;
    const u = Math.min(1, Math.max(0, (target - ta) / (tb - ta)));
    return {
      ...b,
      lat: a.lat + (b.lat - a.lat) * u,
      lon: a.lon + (b.lon - a.lon) * u,
      sog:
        typeof a.sog === 'number' && typeof b.sog === 'number'
          ? a.sog + (b.sog - a.sog) * u
          : b.sog,
      cog: b.cog,
      heading: b.heading,
    };
  }

  private toEvent(
    v: VesselPlayhead,
    pos: { lat: number; lon: number },
    sog: number,
    cog: number | null,
    heading: number | null,
    source: string,
    providerId: string,
    ts: string,
    attack: boolean,
  ): PositionEvent {
    return {
      schema_version: 1,
      entity_id: v.track.entity_id,
      entity_type: 'vessel',
      vessel_class: v.track.vessel_class as VesselClass,
      name: v.track.name,
      position: { lat: pos.lat, lon: pos.lon, crs: 'EPSG:4326' },
      speed_over_ground_knots: sog,
      course_over_ground_deg: cog,
      heading_deg: heading,
      source,
      provider_id: providerId,
      device_id:
        v.track.entity_id === this.signedEntityId ? 'DEV-VESSEL-001' : undefined,
      upstream_lineage: ['digitraffic', 'fintraffic', 'recorded_replay'],
      source_timestamp: ts,
      ingested_at: new Date().toISOString(),
      sequence_number: v.sequence,
      device_signature_status: 'missing',
      osnma_status: this.protocolOsnmaStatus,
      quality: { position_accuracy_m: 50, signal_quality_available: false },
      labels: {
        simulated: false,
        fixture: false,
        live: false,
        mmsi: v.track.mmsi,
        attack: attack || this.scenario.id !== 'normal' ? this.scenario.id : undefined,
      },
    };
  }

  status() {
    return {
      mode: this.ready ? ('historical_replay' as const) : ('unavailable' as const),
      source: this.sourceLabel,
      vessel_count: this.vessels.length,
      signed_entity_id: this.signedEntityId,
      speed: this.speed,
      manifest: this.manifest,
      note: this.ready
        ? `Lab positions are recorded Digitraffic AIS (historical replay). Attack overlays are synthetic. OSNMA: ${this.protocolOsnmaStatus === 'authenticated' ? 'ICD protocol demo (shared nav-data auth)' : this.protocolOsnmaStatus}. GNSS/IMU are fixtures/reconstructed — not ship black-box tapes.`
        : 'Waiting for Digitraffic recording cache.',
      osnma_protocol_status: this.protocolOsnmaStatus,
    };
  }
}
