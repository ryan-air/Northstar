import type {
  GnssDiagnostics,
  ImuSample,
  PositionEvent,
  ScenarioId,
  VesselClass,
} from '@northstar/contracts';
import { destination, haversineM, bearingDeg } from '@northstar/core';
import { createRng } from './rng.js';
import { FLEET, type SimVesselDef } from './vessels.js';

export interface VesselSimState {
  def: SimVesselDef;
  progress: number; // 0..1 along route, loops
  lat: number;
  lon: number;
  sog_kn: number;
  cog_deg: number;
  heading_deg: number;
  sequence: number;
  trueLat: number;
  trueLon: number;
}

export interface ScenarioState {
  id: ScenarioId;
  targetId: string;
  startedAtMs: number;
  /** for gradual drift */
  driftMeters: number;
  /** spoof offset applied to reported position */
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

export class Simulator {
  readonly vessels: VesselSimState[] = [];
  simTimeMs: number;
  scenario: ScenarioState;
  private rng: () => number;
  tickCount = 0;

  constructor(seed: number, startIso = '2026-11-11T07:30:00.000Z') {
    this.rng = createRng(seed);
    this.simTimeMs = Date.parse(startIso);
    this.scenario = {
      id: 'normal',
      targetId: 'VESSEL-001',
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
    for (const def of FLEET) {
      const [lon, lat] = def.route[0]!;
      const next = def.route[1] ?? def.route[0]!;
      this.vessels.push({
        def,
        progress: this.rng() * 0.2,
        lat,
        lon,
        trueLat: lat,
        trueLon: lon,
        sog_kn: def.sog_kn * (0.9 + this.rng() * 0.2),
        cog_deg: bearingDeg(lat, lon, next[1], next[0]),
        heading_deg: bearingDeg(lat, lon, next[1], next[0]),
        sequence: Math.floor(this.rng() * 1000),
      });
    }
  }

  setScenario(id: ScenarioId, entityId?: string): void {
    if (id === 'reset') {
      this.reset();
      return;
    }
    this.scenario = {
      id,
      targetId: entityId ?? 'VESSEL-001',
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
    // osnma_auth forces authenticated fixture path (handled in app)
    if (id === 'osnma_auth') {
      this.scenario.osnmaFail = false;
      this.scenario.osnmaPending = false;
    }

    if (id === 'sudden_spoof') {
      // Jump inland north of Helsinki into restricted/land zone
      this.scenario.spoofLat = 60.32;
      this.scenario.spoofLon = 24.95;
    }
  }

  reset(): void {
    const seed = 42;
    const fresh = new Simulator(seed, new Date(this.simTimeMs).toISOString());
    this.vessels.splice(0, this.vessels.length, ...fresh.vessels);
    this.scenario = fresh.scenario;
    this.tickCount = 0;
  }

  /** Advance simulation by dt seconds; return AIS-like events from both providers. */
  tick(dtS = 1): {
    aisA: PositionEvent[];
    aisB: PositionEvent[];
    imu: ImuSample[];
    gnss: GnssDiagnostics[];
    simTimeIso: string;
  } {
    this.simTimeMs += dtS * 1000;
    this.tickCount += 1;
    const simTimeIso = new Date(this.simTimeMs).toISOString();
    const aisA: PositionEvent[] = [];
    const aisB: PositionEvent[] = [];
    const imu: ImuSample[] = [];
    const gnss: GnssDiagnostics[] = [];

    // Gradual drift accumulates
    if (this.scenario.id === 'gradual_drift') {
      this.scenario.driftMeters += 15 * dtS; // ~15 m/s drift growth
    }

    for (const v of this.vessels) {
      const previousSog = v.sog_kn;
      this.advanceVessel(v, dtS);
      const reported = this.reportedPosition(v);
      v.sequence += 1;

      const base = this.toEvent(v, reported, 'ais_provider_a', 'provider_a', simTimeIso, [
        'fixture_gof_ais',
      ]);
      // stale_clock_skew: target's timestamps shifted back 10 min → rejected at ingest.
      if (this.scenario.staleClock && v.def.entity_id === this.scenario.targetId) {
        base.source_timestamp = new Date(this.simTimeMs - 10 * 60_000).toISOString();
      }
      aisA.push(base);
      if (this.scenario.aisDisagree && v.def.entity_id === this.scenario.targetId) {
        aisB.push(
          this.toEvent(v, { lat: v.trueLat, lon: v.trueLon }, 'ais_provider_b', 'provider_b', simTimeIso, [
            'fixture_gof_ais_b',
          ]),
        );
      }
      const isTarget = v.def.entity_id === this.scenario.targetId;

      // IMU is reconstructed from the simulated AIS kinematics, never scenario-forced.
      const dsog = v.sog_kn - previousSog;
      imu.push({
        entity_id: v.def.entity_id,
        device_id: v.def.device_id,
        observed_at: simTimeIso,
        // IMU disagree: inertial sensor reports a hard turn/acceleration the GNSS track lacks.
        accel_mps2: isTarget && this.scenario.imuDisagree ? [3.5, 2.5, 0] : [dsog * 0.05, 0, 0],
        gyro_rads: isTarget && this.scenario.imuDisagree ? [0, 0, 0.35] : [0, 0, 0],
        labels: { simulated: true, fixture: true },
      });

      // Nominal fixture only: diagnostics are not independent evidence of scenario state.
      gnss.push({
        entity_id: v.def.entity_id,
        device_id: v.def.device_id,
        observed_at: simTimeIso,
        // GNSS jam: few satellites, weak C/N0, high AGC, receiver jamming flag on the target.
        satellite_count: isTarget && this.scenario.jamming ? 3 : 10 + Math.floor(this.rng() * 4),
        c_n0_dbhz: Array.from({ length: isTarget && this.scenario.jamming ? 3 : 8 }, () =>
          isTarget && this.scenario.jamming ? 18 + this.rng() * 5 : 35 + this.rng() * 10,
        ),
        hdop: isTarget && this.scenario.jamming ? 7 + this.rng() * 3 : 1.2 + this.rng(),
        agc: isTarget && this.scenario.jamming ? 85 : 30,
        pseudorange_residual_m: Array.from(
          { length: 8 },
          () => (this.rng() - 0.5) * 2,
        ),
        interference_indicator: isTarget && this.scenario.jamming ? 'suspected_jamming' : 'none',
        labels: { simulated: true, fixture: true },
        missing_inputs: [],
      });
    }

    return { aisA, aisB, imu, gnss, simTimeIso };
  }

  getVessel(id: string): VesselSimState | undefined {
    return this.vessels.find((v) => v.def.entity_id === id);
  }

  private advanceVessel(v: VesselSimState, dtS: number): void {
    const route = v.def.route;
    // Move along polyline by distance
    const distM = (v.sog_kn * 0.514444) * dtS;
    let remaining = distM;
    while (remaining > 0) {
      const idx = Math.floor(v.progress * (route.length - 1));
      const localT = v.progress * (route.length - 1) - idx;
      const a = route[Math.min(idx, route.length - 1)]!;
      const b = route[Math.min(idx + 1, route.length - 1)]!;
      const segLen = haversineM(a[1], a[0], b[1], b[0]) || 1;
      const along = localT * segLen;
      const left = segLen - along;
      if (remaining < left) {
        const frac = (along + remaining) / segLen;
        const br = bearingDeg(a[1], a[0], b[1], b[0]);
        const p = destination(a[1], a[0], br, frac * segLen);
        v.trueLat = p.lat;
        v.trueLon = p.lon;
        v.cog_deg = br;
        v.heading_deg = br;
        v.progress = (idx + frac) / (route.length - 1);
        remaining = 0;
      } else {
        remaining -= left;
        v.progress = (idx + 1) / (route.length - 1);
        if (v.progress >= 0.999) v.progress = 0;
      }
    }
    // noise
    v.trueLat += (this.rng() - 0.5) * 0.00001;
    v.trueLon += (this.rng() - 0.5) * 0.00001;
    v.lat = v.trueLat;
    v.lon = v.trueLon;
    // Speed wanders within ±5% of the route speed but changes at most 0.03 kn/s
    // (realistic for ships; the old per-tick re-roll tripped the acceleration check).
    const target = v.def.sog_kn * (0.95 + this.rng() * 0.1);
    const maxStep = 0.03 * dtS;
    v.sog_kn += Math.max(-maxStep, Math.min(maxStep, target - v.sog_kn));
  }

  private reportedPosition(v: VesselSimState): { lat: number; lon: number } {
    let lat = v.trueLat;
    let lon = v.trueLon;
    if (v.def.entity_id !== this.scenario.targetId) return { lat, lon };

    if (this.scenario.spoofLat != null && this.scenario.spoofLon != null) {
      if (this.scenario.id === 'sudden_spoof' || this.scenario.id === 'ais_disagreement') {
        return { lat: this.scenario.spoofLat, lon: this.scenario.spoofLon };
      }
    }
    // AIS conflict: the primary feed reports the target ~2 km off; provider B reports truth.
    if (this.scenario.aisDisagree) return destination(lat, lon, 0, 2_000);
    if (this.scenario.id === 'gradual_drift' && this.scenario.driftMeters > 0) {
      // Drift north inland gradually
      const p = destination(lat, lon, 10, this.scenario.driftMeters);
      return p;
    }
    return { lat, lon };
  }

  private toEvent(
    v: VesselSimState,
    pos: { lat: number; lon: number },
    source: string,
    provider: string,
    ts: string,
    lineage: string[],
  ): PositionEvent {
    return {
      schema_version: 1,
      entity_id: v.def.entity_id,
      entity_type: 'vessel',
      name: v.def.name,
      vessel_class: v.def.vessel_class as VesselClass,
      position: { lat: pos.lat, lon: pos.lon, crs: 'EPSG:4326' },
      speed_over_ground_knots: v.sog_kn,
      course_over_ground_deg: v.cog_deg,
      heading_deg: v.heading_deg,
      source,
      provider_id: provider,
      device_id: v.def.device_id,
      upstream_lineage: lineage,
      source_timestamp: ts,
      ingested_at: ts,
      sequence_number: v.sequence,
      device_signature_status: 'missing',
      osnma_status: 'unavailable',
      quality: {
        position_accuracy_m: 15,
        signal_quality_available: false,
      },
      labels: { simulated: true, fixture: true, attack: this.scenario.id !== 'normal' ? this.scenario.id : undefined },
    };
  }
}
