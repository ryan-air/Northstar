/**
 * Fintraffic Digitraffic marine AIS — free Finnish open data, no API key.
 * https://www.digitraffic.fi/en/marine-traffic/
 *
 * Live positions for Gulf of Finland / Finnish waters. Not a global AIS feed.
 */
import type { PositionEvent, VesselClass } from '@northstar/contracts';
import type { ReplayRecord } from '../replay/types.js';

const BASE = 'https://meri.digitraffic.fi/api/ais/v1';
const USER = 'Northstar/1.0 (hackathon integrity demo)';

export interface DigitrafficFeature {
  mmsi: number;
  type: string;
  geometry: { type: string; coordinates: [number, number] };
  properties: {
    mmsi: number;
    sog: number;
    cog: number;
    navStat: number;
    rot: number;
    heading: number;
    posAcc?: boolean;
    raim?: boolean;
    timestamp?: number;
    timestampExternal?: number;
  };
}

export interface DigitrafficLocations {
  type: 'FeatureCollection';
  dataUpdatedTime?: string;
  features: DigitrafficFeature[];
}

export interface DigitrafficVesselMeta {
  mmsi: number;
  name?: string;
  shipType?: number;
  callSign?: string;
  imo?: number;
  destination?: string;
  draught?: number;
  posType?: number;
  referencePointA?: number;
  referencePointB?: number;
  referencePointC?: number;
  referencePointD?: number;
}

export interface DigitrafficPollResult {
  ok: boolean;
  reason?: string;
  updatedAt?: string;
  events: PositionEvent[];
  vesselCount: number;
  /** Full-fidelity rows for the historical recorder (P1.1). */
  records?: ReplayRecord[];
}

/**
 * Decode the AIS ROT field (ROT_AIS, −128…127) to °/min.
 * −128 = not available; ±127 = turning faster than 5°/30 s with no turn indicator
 * (magnitude unknown) → null. NOTE: assumes Digitraffic passes the raw ROT_AIS value.
 */
export function decodeAisRot(rot: number | null | undefined): number | null {
  if (typeof rot !== 'number' || !Number.isFinite(rot)) return null;
  if (rot === -128 || Math.abs(rot) >= 127) return null;
  const v = (rot / 4.733) ** 2;
  return rot < 0 ? -v : v;
}

/** posAcc flag → nominal accuracy (m): true = DGNSS (≤10 m), false = autonomous (>10 m). */
export function accuracyFromPosAcc(posAcc: boolean | null | undefined): number | null {
  if (posAcc === true) return 10;
  if (posAcc === false) return 50;
  return null;
}

export function dimensionsFromMeta(
  meta: DigitrafficVesselMeta | undefined,
): { a: number; b: number; c: number; d: number } | null {
  if (!meta) return null;
  const { referencePointA: a, referencePointB: b, referencePointC: c, referencePointD: d } = meta;
  if ([a, b, c, d].some((x) => typeof x !== 'number' || x < 0)) return null;
  if ((a ?? 0) + (b ?? 0) + (c ?? 0) + (d ?? 0) === 0) return null;
  return { a: a!, b: b!, c: c!, d: d! };
}

export function shipTypeToClassPublic(t?: number): VesselClass {
  return shipTypeToClass(t);
}

function shipTypeToClass(t?: number): VesselClass {
  if (t == null) return 'other';
  if (t === 30) return 'fishing'; // filtered by Digitraffic usually
  if (t === 52) return 'tug';
  if (t === 36 || t === 37) return 'pleasure';
  if (t >= 60 && t <= 69) return 'passenger';
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  return 'other';
}

export class DigitrafficAdapter {
  private metaByMmsi = new Map<number, DigitrafficVesselMeta>();
  private metaFetchedAt = 0;
  status: 'unavailable' | 'connecting' | 'ok' | 'down' | 'degraded' = 'unavailable';
  lastError: string | null = null;
  lastUpdated: string | null = null;
  lastCount = 0;

  constructor(
    private opts: {
      /** Gulf of Finland default centre */
      latitude?: number;
      longitude?: number;
      radiusKm?: number;
      /** Cap vessels ingested per poll to protect demo CPU */
      maxVessels?: number;
    } = {},
  ) {}

  providerMeta() {
    return {
      provider_id: 'digitraffic_fintraffic',
      upstream_lineage: ['meri.digitraffic.fi', 'Finnish Transport Infrastructure Agency'],
      independence_from_fixtures: true,
      licence: 'CC BY 4.0 (Digitraffic open data)',
      region: 'Finnish waters / Gulf of Finland',
    };
  }

  async refreshMetadata(): Promise<void> {
    const now = Date.now();
    if (now - this.metaFetchedAt < 30 * 60_000 && this.metaByMmsi.size > 0) return;
    try {
      const res = await fetch(`${BASE}/vessels`, {
        headers: {
          'Digitraffic-User': USER,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
        },
      });
      if (!res.ok) throw new Error(`vessels HTTP ${res.status}`);
      const list = (await res.json()) as DigitrafficVesselMeta[];
      this.metaByMmsi.clear();
      for (const v of list) {
        if (v?.mmsi) this.metaByMmsi.set(v.mmsi, v);
      }
      this.metaFetchedAt = now;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      // keep stale meta if any
    }
  }

  /** Latest known static data for a vessel (REST /vessels, or the real-time stream's metadata). */
  setMetadata(mmsi: number, meta: DigitrafficVesselMeta): void {
    this.metaByMmsi.set(mmsi, { ...this.metaByMmsi.get(mmsi), ...meta, mmsi });
  }

  /**
   * One Digitraffic AIS position → PositionEvent. Shared by the REST poll and the real-time
   * stream so both produce identical events (same validation and checks downstream).
   */
  buildEvent(
    mmsi: number,
    flat: number,
    flon: number,
    p: Partial<DigitrafficFeature['properties']>,
    sourceTs: string,
    nowIso: string,
  ): PositionEvent {
    const meta = this.metaByMmsi.get(mmsi);
    const aisSecond =
      typeof p.timestamp === 'number' && p.timestamp >= 0 && p.timestamp <= 59 ? p.timestamp : null;
    const accuracy = accuracyFromPosAcc(p.posAcc);
    const event: PositionEvent = {
      schema_version: 1,
      entity_id: `LIVE-${mmsi}`,
      entity_type: 'vessel',
      vessel_class: shipTypeToClass(meta?.shipType),
      name: meta?.name?.trim() || `MMSI ${mmsi}`,
      position: { lat: flat, lon: flon, crs: 'EPSG:4326' },
      speed_over_ground_knots:
        typeof p.sog === 'number' && p.sog < 102
          ? p.sog
          : null,
      course_over_ground_deg:
        typeof p.cog === 'number' && p.cog < 360
          ? p.cog
          : null,
      heading_deg:
        typeof p.heading === 'number' && p.heading >= 0 && p.heading < 360 ? p.heading : null,
      source: 'ais',
      provider_id: 'digitraffic',
      upstream_lineage: ['digitraffic', 'fintraffic'],
      source_timestamp: sourceTs,
      ingested_at: nowIso,
      device_signature_status: 'missing',
      osnma_status: 'unavailable',
      quality: {
        // v1 used "navStat present → 50 m" (invented). Now derived from posAcc.
        position_accuracy_m: accuracy,
        signal_quality_available: false,
      },
      nav_status: typeof p.navStat === 'number' && p.navStat >= 0 && p.navStat <= 15 ? p.navStat : null,
      rot_deg_min: decodeAisRot(p.rot),
      rate_of_turn_deg_per_min: decodeAisRot(p.rot),
      raim: typeof p.raim === 'boolean' ? p.raim : null,
      ais_utc_second: aisSecond,
      epfd_type: typeof meta?.posType === 'number' ? meta.posType : null,
      dimensions_m: dimensionsFromMeta(meta),
      labels: {
        live: true,
        fixture: false,
        simulated: false,
        mmsi,
        call_sign: meta?.callSign,
        destination: meta?.destination,
        imo: meta?.imo,
      },
    };
    return event;
  }

  async poll(nowIso = new Date().toISOString()): Promise<DigitrafficPollResult> {
    this.status = this.status === 'ok' ? 'ok' : 'connecting';
    const lat = this.opts.latitude ?? 59.95;
    const lon = this.opts.longitude ?? 24.9;
    const radius = this.opts.radiusKm ?? 70;
    const max = this.opts.maxVessels ?? 80;

    try {
      await this.refreshMetadata();
      const url = `${BASE}/locations?latitude=${lat}&longitude=${lon}&radius=${radius}`;
      const res = await fetch(url, {
        headers: {
          'Digitraffic-User': USER,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
        },
      });
      if (!res.ok) {
        this.status = 'down';
        this.lastError = `locations HTTP ${res.status}`;
        return { ok: false, reason: this.lastError, events: [], vesselCount: 0 };
      }
      const body = (await res.json()) as DigitrafficLocations;
      const features = body.features ?? [];
      const events: PositionEvent[] = [];
      const records: ReplayRecord[] = [];

      // When capping, keep the ships that reported most recently (moving ships report most
      // often), not the first N in the API's MMSI order — which is mostly moored vessels.
      const ranked = [...features].sort(
        (a, b) => (b.properties?.timestampExternal ?? 0) - (a.properties?.timestampExternal ?? 0),
      );
      for (const f of ranked.slice(0, max)) {
        const [flon, flat] = f.geometry?.coordinates ?? [];
        if (typeof flat !== 'number' || typeof flon !== 'number') continue;
        if (!Number.isFinite(flat) || !Number.isFinite(flon)) continue;
        const mmsi = f.mmsi ?? f.properties?.mmsi;
        if (!mmsi) continue;
        const meta = this.metaByMmsi.get(mmsi);
        const p = f.properties ?? ({} as DigitrafficFeature['properties']);
        const tsMs = p.timestampExternal;
        const sourceTs =
          typeof tsMs === 'number' && tsMs > 0
            ? new Date(tsMs).toISOString()
            : body.dataUpdatedTime ?? nowIso;
        const event = this.buildEvent(mmsi, flat, flon, p, sourceTs, nowIso);
        events.push(event);
        records.push({
          mmsi,
          lat: flat,
          lon: flon,
          sog: typeof p.sog === 'number' ? p.sog : null,
          cog: typeof p.cog === 'number' ? p.cog : null,
          heading: typeof p.heading === 'number' ? p.heading : null,
          navStat: typeof p.navStat === 'number' ? p.navStat : null,
          rot: typeof p.rot === 'number' ? p.rot : null,
          posAcc: typeof p.posAcc === 'boolean' ? p.posAcc : null,
          raim: typeof p.raim === 'boolean' ? p.raim : null,
          ais_timestamp_s: typeof p.timestamp === 'number' ? p.timestamp : null,
          timestamp_external_ms: typeof tsMs === 'number' && tsMs > 0 ? tsMs : null,
          captured_at: nowIso,
          source: 'digitraffic',
          provider_id: 'digitraffic_historical',
          name: meta?.name?.trim() || undefined,
          shipType: meta?.shipType,
          callSign: meta?.callSign,
          imo: meta?.imo,
          destination: meta?.destination,
          draught: meta?.draught,
          posType: meta?.posType,
          referencePointA: meta?.referencePointA,
          referencePointB: meta?.referencePointB,
          referencePointC: meta?.referencePointC,
          referencePointD: meta?.referencePointD,
        });
      }

      this.status = events.length > 0 ? 'ok' : 'degraded';
      this.lastError = null;
      this.lastUpdated = body.dataUpdatedTime ?? nowIso;
      this.lastCount = events.length;
      return {
        ok: true,
        updatedAt: this.lastUpdated,
        events,
        vesselCount: events.length,
        records,
      };
    } catch (e) {
      this.status = 'down';
      this.lastError = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: this.lastError, events: [], vesselCount: 0 };
    }
  }
}
