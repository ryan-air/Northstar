import type { VesselState } from '@northstar/contracts';
import type { FusionConfig } from '@northstar/core';
import type { ThresholdsConfig } from '../config.js';
import type { GeoData } from '../geo/loadGeo.js';
import { TrustPipeline } from '../engine/pipeline.js';
import { DigitrafficAdapter } from '../adapters/digitraffic.js';
import { AisStreamAdapter } from '../adapters/aisstream.js';

export interface LiveStatus {
  enabled: true;
  primary_source: 'digitraffic' | 'aisstream' | 'none';
  digitraffic: {
    status: string;
    vessel_count: number;
    last_updated: string | null;
    last_error: string | null;
    meta: ReturnType<DigitrafficAdapter['providerMeta']>;
  };
  aisstream: {
    status: string;
    reason: string | null;
  };
  vessel_count: number;
  last_poll_at: string | null;
  note: string;
}

export class LiveFeedService {
  readonly pipeline: TrustPipeline;
  readonly digitraffic: DigitrafficAdapter;
  readonly aisstream: AisStreamAdapter;
  private timer: NodeJS.Timeout | null = null;
  private onUpdate: ((vessels: VesselState[]) => void) | null = null;
  lastPollAt: string | null = null;
  private aisstreamReason: string | null = null;

  constructor(
    fusion: FusionConfig,
    thresholds: ThresholdsConfig,
    geo: GeoData,
    aisstreamKey?: string,
  ) {
    this.pipeline = new TrustPipeline(fusion, thresholds, geo);
    this.digitraffic = new DigitrafficAdapter({
      latitude: 59.95,
      longitude: 24.9,
      radiusKm: 70,
      maxVessels: 100,
    });
    this.aisstream = new AisStreamAdapter({
      apiKey: aisstreamKey,
      bbox: [22.5, 59.3, 28.5, 60.6],
      onPosition: (event) => {
        const now = new Date().toISOString();
        this.pipeline.process(event, now);
        this.emit();
      },
    });
  }

  setOnUpdate(fn: (vessels: VesselState[]) => void): void {
    this.onUpdate = fn;
  }

  start(pollMs = 12_000): void {
    if (this.timer) return;
    const started = this.aisstream.start();
    this.aisstreamReason = started.reason;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.aisstream.stop();
  }

  async pollOnce(): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.digitraffic.poll(now);
    this.lastPollAt = now;
    if (result.ok) {
      const seen = new Set<string>();
      for (const e of result.events) {
        seen.add(e.entity_id);
        this.pipeline.process(e, now);
      }
      // Drop Digitraffic vessels not in the latest poll (keep aisstream-only briefly)
      for (const v of this.pipeline.getVessels()) {
        if (!v.entity_id.startsWith('LIVE-')) continue;
        if (!seen.has(v.entity_id)) {
          const age = Date.now() - Date.parse(v.last_update);
          if (Number.isFinite(age) && age > 15 * 60_000) {
            this.pipeline.removeEntity(v.entity_id);
          }
        }
      }
    }
    this.emit();
  }

  private emit(): void {
    this.onUpdate?.(this.getVessels());
  }

  getVessels(): VesselState[] {
    return this.pipeline.getVessels();
  }

  status(): LiveStatus {
    const vessels = this.getVessels();
    const primary =
      this.digitraffic.status === 'ok' || this.digitraffic.status === 'degraded'
        ? 'digitraffic'
        : this.aisstream.status === 'ok'
          ? 'aisstream'
          : this.digitraffic.status === 'connecting'
            ? 'digitraffic'
            : 'none';
    return {
      enabled: true,
      primary_source: primary,
      digitraffic: {
        status: this.digitraffic.status,
        vessel_count: this.digitraffic.lastCount,
        last_updated: this.digitraffic.lastUpdated,
        last_error: this.digitraffic.lastError,
        meta: this.digitraffic.providerMeta(),
      },
      aisstream: {
        status: this.aisstream.status,
        reason: this.aisstreamReason ?? this.aisstream.lastReason,
      },
      vessel_count: vessels.length,
      last_poll_at: this.lastPollAt,
      note:
        'Live AIS from Fintraffic Digitraffic (Finnish waters). Lab vessels remain simulated for attack demos.',
    };
  }
}
