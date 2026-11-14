/**
 * Digitraffic marine AIS real-time stream (MQTT over WebSocket, public, no key).
 * Topics: vessels-v2/<mmsi>/location and vessels-v2/<mmsi>/metadata. Positions arrive as
 * Digitraffic receives them (seconds), versus ~1–3 min per ship on the REST endpoint.
 * Data: Fintraffic / Digitraffic, CC BY 4.0.
 */
import type { DigitrafficFeature, DigitrafficVesselMeta } from './digitraffic.js';
import { MqttWsClient, type MqttState } from './mqttWs.js';

export const DIGITRAFFIC_MQTT_URL = 'wss://meri.digitraffic.fi:443/mqtt';

interface StreamLocation {
  time: number; // epoch seconds
  sog?: number;
  cog?: number;
  navStat?: number;
  rot?: number;
  posAcc?: boolean;
  raim?: boolean;
  heading?: number;
  lat: number;
  lon: number;
}

export interface DigitrafficStreamOptions {
  url?: string;
  onLocation: (mmsi: number, lat: number, lon: number, props: Partial<DigitrafficFeature['properties']>) => void;
  onMetadata?: (mmsi: number, meta: DigitrafficVesselMeta) => void;
}

export class DigitrafficStreamAdapter {
  private client: MqttWsClient;
  messages = 0;
  lastMessageAt: string | null = null;

  constructor(private readonly opts: DigitrafficStreamOptions) {
    this.client = new MqttWsClient({
      url: opts.url ?? DIGITRAFFIC_MQTT_URL,
      topics: ['vessels-v2/+/location', 'vessels-v2/+/metadata'],
      clientIdPrefix: 'northstar-live',
      onMessage: (topic, payload) => this.onMessage(topic, payload),
    });
  }

  get status(): MqttState {
    return this.client.state;
  }

  get lastReason(): string | null {
    return this.client.lastReason;
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  private onMessage(topic: string, payload: Buffer): void {
    const m = /^vessels-v2\/(\d{9})\/(location|metadata)$/.exec(topic);
    if (!m) return;
    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (!json || typeof json !== 'object') return;
    const mmsi = Number(m[1]);
    this.messages++;
    this.lastMessageAt = new Date().toISOString();
    if (m[2] === 'metadata') {
      this.opts.onMetadata?.(mmsi, { ...(json as DigitrafficVesselMeta), mmsi });
      return;
    }
    const l = json as StreamLocation;
    if (typeof l.lat !== 'number' || typeof l.lon !== 'number' || typeof l.time !== 'number') return;
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lon) || !Number.isFinite(l.time)) return;
    this.opts.onLocation(mmsi, l.lat, l.lon, {
      sog: l.sog as number,
      cog: l.cog as number,
      navStat: l.navStat as number,
      rot: l.rot as number,
      heading: l.heading as number,
      posAcc: l.posAcc,
      raim: l.raim,
      timestampExternal: l.time * 1000,
    });
  }
}
