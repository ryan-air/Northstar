import type {
  GnssDiagnostics,
  ImuSample,
  OsnmaStatus,
  PositionEvent,
  ScenarioId,
  VesselClass,
} from '@northstar/contracts';
import type { ReplayRecord } from './types.js';
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
  /** Shared-timeline mode: index of the first sample strictly after the lab clock. */
  nextIdx: number;
  /** ms into the track (loops) */
  playheadMs: number;
  sequence: number;
  lastLat: number;
  lastLon: number;
  lastSog: number;
}

export interface LabTickResult {
  aisA: PositionEvent[];
  aisB: PositionEvent[];
  imu: ImuSample[];
  gnss: GnssDiagnostics[];
  simTimeIso: string;
  /** True when the shared timeline looped this tick (caller must clear Lab state). */
  wrapped: boolean;
}

function sampleTs(s: { timestamp_external_ms: number | null; captured_at: string }): number {
  return s.timestamp_external_ms ?? Date.parse(s.captured_at);
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
  /**
   * P3.3: all vessels share one absolute replay clock and emit only their real samples
   * (interpolation only across gaps ≤ maxInterpGapMs, tagged). Set
   * NORTHSTAR_LAB_LEGACY_PLAYHEAD=true for the old per-vessel looping playheads.
   */
  readonly legacyPlayhead = process.env.NORTHSTAR_LAB_LEGACY_PLAYHEAD === 'true';
  maxInterpGapMs = 180_000;
  /** Shared timeline bounds. */
  timelineStartMs = 0;
  timelineEndMs = 0;
  /** Where the clock (re)starts — the instant with the most simultaneously active tracks. */
  timelineSeedMs = 0;
  wraps = 0;
  /** Drift rate for the gradual_drift overlay in shared mode (m/s of replay time). */
  driftMps = Number(process.env.NORTHSTAR_LAB_DRIFT_MPS ?? 1);

  constructor(startIso = new Date().toISOString()) {
    this.simTimeMs = Date.parse(startIso);
    this.scenario = this.normalScenario('LAB-0');
  }

  /** Lab-return vessel (recorded AIS) that becomes the full-stack ship; set before init(). */
  private extraTrackRecords: ReplayRecord[] | null = null;
  forcedSignedEntityId: string | null = null;
  setLabTrack(records: ReplayRecord[]): void {
    this.extraTrackRecords = records.length >= 3 ? records : null;
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
    if (this.extraTrackRecords) {
      const extra = buildTracks(this.extraTrackRecords, { maxVessels: 1, minSamples: 3 })[0];
      if (extra) {
        const i = tracks.findIndex((x) => x.mmsi === extra.mmsi);
        if (i >= 0) tracks.splice(i, 1);
        tracks.unshift(extra);
        this.forcedSignedEntityId = extra.entity_id;
      }
    }
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
        nextIdx: 0,
        playheadMs: 0,
        sequence: 1,
        lastLat: s0.lat,
        lastLon: s0.lon,
        lastSog: typeof s0.sog === 'number' ? s0.sog : 0,
      };
    });
    this.signedEntityId = this.forcedSignedEntityId ?? moving.entity_id;
    this.scenario = this.normalScenario(this.signedEntityId);
    this.ready = true;
    // Align lab clock to first sample time for honesty in UI
    const t0 =
      moving.samples[0]!.timestamp_external_ms ??
      Date.parse(moving.samples[0]!.captured_at);
    this.simTimeMs = t0;
    if (!this.legacyPlayhead) this.initSharedTimeline();
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

  private initSharedTimeline(): void {
    const spans = this.vessels.map((v) => ({
      a: sampleTs(v.track.samples[0]!),
      b: sampleTs(v.track.samples[v.track.samples.length - 1]!),
    }));
    this.timelineStartMs = Math.min(...spans.map((x) => x.a));
    this.timelineEndMs = Math.max(...spans.map((x) => x.b));
    // Seed: the instant where the most tracks have a real sample within ±90 s
    // (densely active, so the first ticks show real positions, not gaps).
    const times = this.vessels.map((v) => v.track.samples.map(sampleTs));
    const candidates = times.flat().sort((a, b) => a - b);
    const stride = Math.max(1, Math.floor(candidates.length / 400));
    const near = (ts: number[], t: number, w: number) => {
      let lo = 0;
      let hi = ts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid]! < t - w) lo = mid + 1;
        else hi = mid;
      }
      return lo < ts.length && ts[lo]! <= t + w;
    };
    let bestT = this.timelineStartMs;
    let best = -1;
    for (let i = 0; i < candidates.length; i += stride) {
      const t = candidates[i]!;
      const n = times.filter((ts) => near(ts, t, 90_000)).length;
      if (n > best) {
        best = n;
        bestT = t;
      }
    }
    // Start slightly before the seed so the first ticks emit the samples around it.
    this.timelineSeedMs = Math.max(this.timelineStartMs, bestT - 30_000);
    // A lab-return vessel is the full-stack ship: start the clock at its first report.
    const forced = this.forcedSignedEntityId
      ? this.vessels.find((v) => v.track.entity_id === this.forcedSignedEntityId)
      : undefined;
    if (forced) {
      this.timelineSeedMs = Math.max(this.timelineStartMs, sampleTs(forced.track.samples[0]!) - 30_000);
      this.seekShared(this.timelineSeedMs);
      this.signedEntityId = forced.track.entity_id;
      this.scenario = this.normalScenario(forced.track.entity_id);
      return;
    }
    this.seekShared(this.timelineSeedMs);

    // Re-pick the signed full-stack vessel: the moving track with the most samples in
    // the 10 minutes after the seed (so signed-vs-AIS has AIS to compare against).
    let bestTrack: VesselPlayhead | null = null;
    let bestCount = 0;
    for (const v of this.vessels) {
      const n = v.track.samples.filter((smp) => {
        const t = sampleTs(smp);
        return t >= this.timelineSeedMs && t <= this.timelineSeedMs + 600_000 && (smp.sog ?? 0) > 0.5;
      }).length;
      if (n > bestCount) {
        bestCount = n;
        bestTrack = v;
      }
    }
    if (bestTrack) {
      this.signedEntityId = bestTrack.track.entity_id;
      this.scenario = this.normalScenario(bestTrack.track.entity_id);
    }
  }

  /** Move the shared Lab clock (clamped to the timeline); returns the time actually set. */
  seek(tMs: number): number {
    const t = Math.min(Math.max(tMs, this.timelineStartMs), this.timelineEndMs);
    this.seekShared(t);
    return t;
  }

  private seekShared(tMs: number): void {
    this.simTimeMs = tMs;
    for (const v of this.vessels) {
      const ss = v.track.samples;
      let i = 0;
      while (i < ss.length && sampleTs(ss[i]!) <= tMs) i++;
      v.nextIdx = i;
    }
  }

  resetPlayheads(): void {
    if (!this.legacyPlayhead && this.vessels.length > 0) {
      this.tickCount = 0;
      this.seekShared(this.timelineSeedMs);
      for (const v of this.vessels) v.sequence = 1;
      return;
    }
    for (const v of this.vessels) {
      v.playheadMs = 0;
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

  tick(dtS = 1): LabTickResult {
    if (!this.legacyPlayhead && this.vessels.length > 0) return this.tickShared(dtS);
    return this.tickLegacy(dtS);
  }

  /** P3.3 shared absolute timeline. */
  private tickShared(dtS: number): LabTickResult {
    const stepMs = dtS * 1000 * this.speed;
    const prevClock = this.simTimeMs;
    let clock = prevClock + stepMs;
    let wrapped = false;
    if (clock > this.timelineEndMs) {
      // Loop: restart the timeline; the app clears Lab entities + hard-alert state.
      wrapped = true;
      this.wraps += 1;
      this.seekShared(this.timelineStartMs);
      clock = this.timelineStartMs;
    }
    this.simTimeMs = clock;
    this.tickCount += 1;
    const simTimeIso = new Date(clock).toISOString();
    const aisA: PositionEvent[] = [];
    const imu: ImuSample[] = [];
    const gnss: GnssDiagnostics[] = [];
    if (this.scenario.id === 'gradual_drift') {
      this.scenario.driftMeters += this.driftMps * dtS * this.speed;
    }

    for (const v of this.vessels) {
      const ss = v.track.samples;
      const emitted: Array<{ s: VesselTrack['samples'][number]; ts: number; interpolated: boolean }> = [];
      if (!wrapped) {
        while (v.nextIdx < ss.length && sampleTs(ss[v.nextIdx]!) <= clock) {
          const smp = ss[v.nextIdx]!;
          emitted.push({ s: smp, ts: sampleTs(smp), interpolated: false });
          v.nextIdx += 1;
        }
      }
      if (emitted.length === 0) {
        const a = ss[v.nextIdx - 1];
        const b = ss[v.nextIdx];
        if (a && b) {
          const ta = sampleTs(a);
          const tb = sampleTs(b);
          if (tb - ta <= this.maxInterpGapMs && tb > ta) {
            const u = Math.min(1, Math.max(0, (clock - ta) / (tb - ta)));
            emitted.push({
              s: {
                ...a,
                lat: a.lat + (b.lat - a.lat) * u,
                lon: a.lon + (b.lon - a.lon) * u,
                sog:
                  typeof a.sog === 'number' && typeof b.sog === 'number'
                    ? a.sog + (b.sog - a.sog) * u
                    : a.sog,
              },
              ts: clock,
              interpolated: true,
            });
          }
        }
      }
      // Bound per-tick burst (high playback speeds) to the latest few real samples.
      for (const em of emitted.slice(-3)) {
        const ev = this.emitSample(v, em.s, em.ts, em.interpolated);
        aisA.push(ev);
        imu.push({
          entity_id: v.track.entity_id,
          device_id: v.track.entity_id === this.signedEntityId ? 'DEV-VESSEL-001' : undefined,
          observed_at: ev.source_timestamp,
          accel_mps2: [((ev.speed_over_ground_knots ?? v.lastSog) - v.lastSog) * 0.05, 0, 0],
          gyro_rads: [0, 0, 0],
          labels: { simulated: true, fixture: true },
        });
        gnss.push({
          ...gnssFixture('nominal', v.track.entity_id, simTimeIso),
          labels: { simulated: true, fixture: true },
        });
        v.lastSog = ev.speed_over_ground_knots ?? v.lastSog;
        v.lastLat = em.s.lat;
        v.lastLon = em.s.lon;
      }
    }
    return { aisA, aisB: [], imu, gnss, simTimeIso, wrapped };
  }

  private emitSample(
    v: VesselPlayhead,
    smp: VesselTrack['samples'][number],
    tsMs: number,
    interpolated: boolean,
  ): PositionEvent {
    v.sequence += 1;
    let reported = { lat: smp.lat, lon: smp.lon };
    const isTarget = v.track.entity_id === this.scenario.targetId;
    if (isTarget) {
      if (this.scenario.spoofLat != null && this.scenario.spoofLon != null) {
        reported = { lat: this.scenario.spoofLat, lon: this.scenario.spoofLon };
      } else if (this.scenario.driftMeters > 0) {
        reported = { lat: smp.lat + this.scenario.driftMeters / 111_320, lon: smp.lon };
      }
    }
    const sog = typeof smp.sog === 'number' && smp.sog < 102.25 ? smp.sog : null;
    const cog = typeof smp.cog === 'number' && smp.cog < 360 ? smp.cog : null;
    const heading =
      typeof smp.heading === 'number' && smp.heading >= 0 && smp.heading < 360 ? smp.heading : null;
    // P3.5: stale_clock_skew shifts the target's timestamps back 10 min → rejected at ingest.
    const ts = isTarget && this.scenario.staleClock ? tsMs - 10 * 60_000 : tsMs;
    const ev = this.toEvent(
      v,
      reported,
      sog ?? 0,
      cog,
      heading,
      'ais_provider_a',
      'digitraffic_historical',
      new Date(ts).toISOString(),
      false,
    );
    ev.speed_over_ground_knots = sog;
    ev.quality = {
      position_accuracy_m: smp.posAcc === true ? 10 : smp.posAcc === false ? 50 : null,
      signal_quality_available: false,
    };
    ev.nav_status = typeof smp.navStat === 'number' && smp.navStat >= 0 && smp.navStat <= 15 ? smp.navStat : null;
    ev.raim = typeof smp.raim === 'boolean' ? smp.raim : null;
    ev.ais_utc_second =
      typeof smp.ais_timestamp_s === 'number' && smp.ais_timestamp_s >= 0 && smp.ais_timestamp_s <= 59
        ? smp.ais_timestamp_s
        : null;
    ev.epfd_type = typeof smp.posType === 'number' ? smp.posType : null;
    const ra = smp.referencePointA;
    const rb = smp.referencePointB;
    const rc = smp.referencePointC;
    const rd = smp.referencePointD;
    ev.dimensions_m =
      [ra, rb, rc, rd].every((x) => typeof x === 'number' && x >= 0) && (ra! + rb! + rc! + rd!) > 0
        ? { a: ra!, b: rb!, c: rc!, d: rd! }
        : null;
    if (interpolated) ev.interpolated = true;
    if (smp.callSign) ev.labels = { ...ev.labels, call_sign: smp.callSign };
    if (smp.imo) ev.labels = { ...ev.labels, imo: smp.imo };
    return ev;
  }

  private tickLegacy(dtS = 1): LabTickResult {
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
      v.playheadMs = (v.playheadMs + stepMs) % v.track.durationMs;
      const sample = this.sampleAt(v.track, v.playheadMs);
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

    return { aisA, aisB, imu, gnss, simTimeIso, wrapped: false };
  }

  private sampleAt(track: VesselTrack, playheadMs: number): VesselTrack['samples'][number] {
    const samples = track.samples;
    const t0 =
      samples[0]!.timestamp_external_ms ?? Date.parse(samples[0]!.captured_at);
    const target = t0 + playheadMs;
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
      timeline: this.legacyPlayhead
        ? 'legacy_per_vessel_playhead'
        : 'shared_absolute_clock',
      wraps: this.wraps,
      note: this.ready
        ? `Lab positions are recorded Digitraffic AIS (historical replay). Attacks are injected only into the simulated ships. OSNMA: ${this.protocolOsnmaStatus === 'authenticated' ? 'ICD test vector (shared nav-data auth)' : this.protocolOsnmaStatus}. Other recorded ships carry reconstructed GNSS/IMU; the lab vessel carries its own recorded sensors.`
        : 'Waiting for Digitraffic recording cache.',
      osnma_protocol_status: this.protocolOsnmaStatus,
    };
  }
}
