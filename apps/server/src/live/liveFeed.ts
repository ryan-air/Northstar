import type { VesselState } from '@northstar/contracts';
import { IngestValidator, type FusionConfig, type ValidationCode } from '@northstar/core';
import type { PositionEvent } from '@northstar/contracts';
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
  /** P1.4: ingest rejections by reason (never reach the pipeline). */
  ingest?: { accepted: number; rejected: Record<string, number>; secondary_accepted: number };
}

export type IngestRejectHandler = (info: {
  feed: 'digitraffic' | 'aisstream';
  code: ValidationCode;
  reason: string;
  entity_id?: string;
}) => void;

export class LiveFeedService {
  readonly pipeline: TrustPipeline;
  readonly digitraffic: DigitrafficAdapter;
  readonly aisstream: AisStreamAdapter;
  private timer: NodeJS.Timeout | null = null;
  private onUpdate: ((vessels: VesselState[]) => void) | null = null;
  lastPollAt: string | null = null;
  private aisstreamReason: string | null = null;
  readonly validator: IngestValidator;
  readonly secondaryValidator: IngestValidator;
  private onReject: IngestRejectHandler | null = null;

  constructor(
    fusion: FusionConfig,
    thresholds: ThresholdsConfig,
    geo: GeoData,
    aisstreamKey?: string,
  ) {
    this.pipeline = new TrustPipeline(fusion, thresholds, geo);
    const v = thresholds.validation;
    const opts = {
      staleAfterMs: (v?.ais_stale_after_s ?? 600) * 1000,
      maxFutureSkewMs: (v?.max_future_skew_s ?? 30) * 1000,
    };
    this.validator = new IngestValidator(opts);
    this.secondaryValidator = new IngestValidator(opts);
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
        // P3.4: AISStream is a secondary feed for ais_cross_feed — never merged into
        // the Digitraffic track (no interleaving of two providers' reports).
        const out = this.secondaryValidator.validate(event, new Date());
        if (!out.ok) {
          this.reject('aisstream', out.code, out.reason, event);
          return;
        }
        this.pipeline.ingestSecondary(out.event);
      },
    });
  }

  setOnReject(fn: IngestRejectHandler): void {
    this.onReject = fn;
  }

  private reject(feed: 'digitraffic' | 'aisstream', code: ValidationCode, reason: string, e?: PositionEvent): void {
    this.onReject?.({ feed, code, reason, entity_id: e?.entity_id });
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
      const nowDate = new Date(now);
      for (const e of result.events) {
        seen.add(e.entity_id);
        // P1.3 + P1.4: dedup (same MMSI + AIS timestamp), sentinels, stale/future/out-of-order.
        const out = this.validator.validate(e, nowDate);
        if (!out.ok) {
          // Re-polled unchanged positions are the common case — count, don't spam forensics.
          if (out.code !== 'duplicate') this.reject('digitraffic', out.code, out.reason, e);
          continue;
        }
        this.pipeline.process(out.event, now);
      }
      // Drop Digitraffic vessels not in the latest poll (keep aisstream-only briefly)
      for (const v of this.pipeline.getVessels()) {
        if (!v.entity_id.startsWith('LIVE-')) continue;
        if (!seen.has(v.entity_id)) {
          const age = Date.now() - Date.parse(v.last_update);
          if (Number.isFinite(age) && age > 15 * 60_000) {
            this.pipeline.removeEntity(v.entity_id);
            this.validator.forget(v.entity_id);
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
      ingest: {
        accepted: this.validator.accepted,
        rejected: { ...this.validator.rejected },
        secondary_accepted: this.secondaryValidator.accepted,
      },
      note:
        'Live AIS from Fintraffic Digitraffic (Finnish waters). Attacks are only injected into simulated Lab ships.',
    };
  }
}
