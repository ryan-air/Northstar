/**
 * AISStream.io WebSocket adapter — enabled when AISSTREAM_API_KEY is set.
 * Server-side only (browser connections are not permitted by AISStream).
 */
import WebSocket from 'ws';
import type { PositionEvent } from '@northstar/contracts';

export interface AisStreamConfig {
  apiKey?: string;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox?: [number, number, number, number];
  onPosition?: (event: PositionEvent) => void;
  onMessage?: (raw: unknown) => void;
}

export class AisStreamAdapter {
  private ws: WebSocket | null = null;
  status: 'unavailable' | 'connecting' | 'ok' | 'down' = 'unavailable';
  lastReason: string | null = null;

  constructor(private config: AisStreamConfig) {}

  start(): { ok: boolean; reason: string } {
    if (!this.config.apiKey) {
      this.status = 'unavailable';
      this.lastReason =
        'AISSTREAM_API_KEY not set. Digitraffic live AIS still runs without a key.';
      return { ok: false, reason: this.lastReason };
    }
    if (this.ws) return { ok: true, reason: 'already_connected' };

    this.status = 'connecting';
    const [minLon, minLat, maxLon, maxLat] = this.config.bbox ?? [22.5, 59.3, 28.5, 60.6];
    try {
      this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream', {
        perMessageDeflate: true,
      });
      this.ws.on('open', () => {
        this.ws?.send(
          JSON.stringify({
            APIKey: this.config.apiKey,
            BoundingBoxes: [
              [
                [minLat, minLon],
                [maxLat, maxLon],
              ],
            ],
            FilterMessageTypes: ['PositionReport'],
          }),
        );
        this.status = 'ok';
        this.lastReason = 'subscribed Gulf of Finland bbox';
      });
      this.ws.on('message', (data) => {
        try {
          const raw = JSON.parse(data.toString()) as {
            MessageType?: string;
            MetaData?: {
              MMSI?: number;
              ShipName?: string;
              latitude?: number;
              Longitude?: number;
              Latitude?: number;
              longitude?: number;
            };
            Message?: {
              PositionReport?: {
                UserID?: number;
                Latitude?: number;
                Longitude?: number;
                Sog?: number;
                Cog?: number;
                TrueHeading?: number;
              };
            };
          };
          this.config.onMessage?.(raw);
          if (raw.MessageType !== 'PositionReport') return;
          const pr = raw.Message?.PositionReport;
          if (!pr) return;
          const lat = pr.Latitude ?? raw.MetaData?.Latitude ?? raw.MetaData?.latitude;
          const lon = pr.Longitude ?? raw.MetaData?.Longitude ?? raw.MetaData?.longitude;
          const mmsi = pr.UserID ?? raw.MetaData?.MMSI;
          if (lat == null || lon == null || mmsi == null) return;
          const nowIso = new Date().toISOString();
          const event: PositionEvent = {
            schema_version: 1,
            entity_id: `LIVE-${mmsi}`,
            entity_type: 'vessel',
            name: raw.MetaData?.ShipName?.trim() || `MMSI ${mmsi}`,
            position: { lat, lon, crs: 'EPSG:4326' },
            speed_over_ground_knots: pr.Sog ?? null,
            course_over_ground_deg: pr.Cog ?? null,
            heading_deg:
              pr.TrueHeading != null && pr.TrueHeading < 360 ? pr.TrueHeading : null,
            source: 'ais',
            provider_id: 'aisstream',
            source_timestamp: nowIso,
            ingested_at: nowIso,
            device_signature_status: 'missing',
            osnma_status: 'unavailable',
            quality: {
              position_accuracy_m: null,
              signal_quality_available: false,
            },
            labels: { live: true, simulated: false, fixture: false, mmsi },
          };
          this.config.onPosition?.(event);
        } catch {
          /* ignore malformed frames */
        }
      });
      this.ws.on('close', () => {
        this.status = 'down';
        this.ws = null;
        this.lastReason = 'websocket closed';
      });
      this.ws.on('error', (err) => {
        this.status = 'down';
        this.lastReason = err.message;
      });
      return { ok: true, reason: 'connecting to aisstream.io' };
    } catch (e) {
      this.status = 'down';
      this.lastReason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: this.lastReason };
    }
  }

  stop(): void {
    this.ws?.close();
    this.ws = null;
    if (this.status === 'ok' || this.status === 'connecting') this.status = 'unavailable';
  }

  providerMeta() {
    return {
      provider_id: 'aisstream',
      upstream_lineage: ['aisstream.io'],
      independence_from_fixtures: true,
    };
  }
}
