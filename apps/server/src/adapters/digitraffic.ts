/**
 * Fintraffic Digitraffic marine AIS — free Finnish open data, no API key.
 * https://www.digitraffic.fi/en/marine-traffic/
 *
 * Live positions for Gulf of Finland / Finnish waters. Not a global AIS feed.
 */
import type { PositionEvent, VesselClass } from '@northstar/contracts';

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
}

export interface DigitrafficPollResult {
  ok: boolean;
  reason?: string;
  updatedAt?: string;
  events: PositionEvent[];
  vesselCount: number;
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

      for (const f of features.slice(0, max)) {
        const [flon, flat] = f.geometry?.coordinates ?? [];
        if (typeof flat !== 'number' || typeof flon !== 'number') continue;
        if (!Number.isFinite(flat) || !Number.isFinite(flon)) continue;
        const mmsi = f.mmsi ?? f.properties?.mmsi;
        if (!mmsi) continue;
        const meta = this.metaByMmsi.get(mmsi);
        const heading = f.properties?.heading;
        const tsMs = f.properties?.timestampExternal;
        const sourceTs =
          typeof tsMs === 'number' && tsMs > 0
            ? new Date(tsMs).toISOString()
            : body.dataUpdatedTime ?? nowIso;

        const event: PositionEvent = {
          schema_version: 1,
          entity_id: `LIVE-${mmsi}`,
          entity_type: 'vessel',
          vessel_class: shipTypeToClass(meta?.shipType),
          name: meta?.name?.trim() || `MMSI ${mmsi}`,
          position: { lat: flat, lon: flon, crs: 'EPSG:4326' },
          speed_over_ground_knots:
            typeof f.properties?.sog === 'number' && f.properties.sog < 102
              ? f.properties.sog
              : null,
          course_over_ground_deg:
            typeof f.properties?.cog === 'number' && f.properties.cog < 360
              ? f.properties.cog
              : null,
          heading_deg:
            typeof heading === 'number' && heading >= 0 && heading < 360 ? heading : null,
          source: 'ais',
          provider_id: 'digitraffic',
          upstream_lineage: ['digitraffic', 'fintraffic'],
          source_timestamp: sourceTs,
          ingested_at: nowIso,
          device_signature_status: 'missing',
          osnma_status: 'unavailable',
          quality: {
            position_accuracy_m: f.properties?.navStat != null ? 50 : null,
            signal_quality_available: false,
          },
          labels: {
            live: true,
            fixture: false,
            simulated: false,
            mmsi,
            call_sign: meta?.callSign,
            destination: meta?.destination,
          },
        };
        events.push(event);
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
      };
    } catch (e) {
      this.status = 'down';
      this.lastError = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: this.lastError, events: [], vesselCount: 0 };
    }
  }
}
