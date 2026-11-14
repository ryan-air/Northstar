/**
 * Continuously append Digitraffic AIS snapshots so Lab historical tracks grow over time.
 * Digitraffic REST from/to is latest-per-vessel only — multi-point history requires recording.
 */
import { DigitrafficAdapter } from '../adapters/digitraffic.js';
import { appendRecords, loadManifest, saveManifest } from './store.js';
import type { ReplayRecord } from './types.js';

export class HistoricalRecorder {
  private timer: NodeJS.Timeout | null = null;
  private adapter = new DigitrafficAdapter({
    latitude: 59.95,
    longitude: 24.9,
    radiusKm: 60,
    maxVessels: 200,
  });
  lastPollAt: string | null = null;
  lastCount = 0;
  status: 'idle' | 'recording' | 'error' = 'idle';
  lastError: string | null = null;

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.status = 'recording';
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = 'idle';
  }

  async pollOnce(): Promise<number> {
    try {
      const result = await this.adapter.poll();
      if (!result.ok) {
        this.status = 'error';
        this.lastError = result.reason ?? 'poll failed';
        return 0;
      }
      const capturedAt = new Date().toISOString();
      const records: ReplayRecord[] = result.events.map((e) => ({
        mmsi: Number(e.labels?.mmsi ?? String(e.entity_id).replace('LIVE-', '')),
        lat: e.position.lat,
        lon: e.position.lon,
        sog: e.speed_over_ground_knots ?? null,
        cog: e.course_over_ground_deg ?? null,
        heading: e.heading_deg ?? null,
        timestamp_external_ms: Date.parse(e.source_timestamp) || null,
        captured_at: capturedAt,
        source: 'digitraffic',
        provider_id: 'digitraffic_historical',
        name: e.name,
      }));
      appendRecords(records.filter((r) => Number.isFinite(r.mmsi)));
      this.lastPollAt = capturedAt;
      this.lastCount = records.length;
      this.status = 'recording';
      this.lastError = null;

      const prev = loadManifest();
      saveManifest({
        region: 'gulf_of_finland',
        source: 'digitraffic',
        licence: 'CC BY 4.0 Fintraffic Digitraffic',
        records: (prev?.records ?? 0) + records.length,
        unique_mmsi: prev?.unique_mmsi ?? 0,
        note:
          'Polled Digitraffic AIS; multi-point Lab history is built by recording because REST from/to returns latest-only.',
        built_at: prev?.built_at ?? capturedAt,
        last_appended_at: capturedAt,
        interval_s: 15,
      });
      return records.length;
    } catch (e) {
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : String(e);
      return 0;
    }
  }
}
