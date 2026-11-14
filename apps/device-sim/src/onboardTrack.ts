import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

interface ReplaySample {
  mmsi: number;
  lat: number;
  lon: number;
  sog?: number | null;
  cog?: number | null;
  heading?: number | null;
  timestamp_external_ms?: number;
  captured_at?: string;
}

export interface OnboardPosition {
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
}

export interface OnboardTrackOptions {
  path: string;
  mmsi: number;
  /** One-sigma horizontal GNSS noise in meters. */
  noiseMeters?: number;
}

function sampleTime(sample: ReplaySample): number {
  return sample.timestamp_external_ms ?? Date.parse(sample.captured_at ?? '');
}

function gaussian(): number {
  // Box-Muller transform. Avoid log(0) if Math.random happens to return zero.
  const u = Math.max(Number.EPSILON, Math.random());
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function mmsiFromIdentity(entityId: string, configuredMmsi?: string): number {
  const raw = configuredMmsi?.trim() || entityId.replace(/^LAB-/i, '');
  if (!/^\d{6,9}$/.test(raw)) {
    throw new Error(
      `Cannot derive MMSI from ENTITY_ID=${entityId}; set NORTHSTAR_MMSI to 6-9 digits`,
    );
  }
  return Number(raw);
}

/**
 * Device-local position source backed by a single MMSI's recorded AIS track.
 * The JSONL file is streamed once so unrelated vessels are never retained.
 */
export class OnboardTrack {
  private readonly firstTimeMs: number;
  private readonly durationMs: number;
  private readonly startedAtMs = Date.now();

  private constructor(
    readonly mmsi: number,
    private readonly samples: ReplaySample[],
    private readonly noiseMeters: number,
  ) {
    this.firstTimeMs = sampleTime(samples[0]!);
    this.durationMs = Math.max(1, sampleTime(samples[samples.length - 1]!) - this.firstTimeMs);
  }

  static async load(options: OnboardTrackOptions): Promise<OnboardTrack> {
    const samples: ReplaySample[] = [];
    const lines = createInterface({
      input: createReadStream(options.path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const sample = JSON.parse(line) as ReplaySample;
        if (
          sample.mmsi === options.mmsi &&
          Number.isFinite(sample.lat) &&
          Number.isFinite(sample.lon) &&
          Number.isFinite(sampleTime(sample))
        ) {
          samples.push(sample);
        }
      } catch {
        // Ignore malformed recorder lines; valid samples remain usable.
      }
    }

    samples.sort((a, b) => sampleTime(a) - sampleTime(b));
    if (samples.length === 0) {
      throw new Error(`No replay samples found for MMSI ${options.mmsi} in ${options.path}`);
    }
    return new OnboardTrack(options.mmsi, samples, options.noiseMeters ?? 3);
  }

  position(nowMs = Date.now()): OnboardPosition {
    const elapsedMs = Math.max(0, nowMs - this.startedAtMs);
    const targetMs = this.firstTimeMs + (elapsedMs % this.durationMs);
    let lo = 0;
    let hi = this.samples.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (sampleTime(this.samples[mid]!) < targetMs) lo = mid + 1;
      else hi = mid;
    }

    const b = this.samples[lo]!;
    const a = this.samples[Math.max(0, lo - 1)]!;
    const ta = sampleTime(a);
    const tb = sampleTime(b);
    const ratio = tb === ta ? 1 : Math.min(1, Math.max(0, (targetMs - ta) / (tb - ta)));
    const lat = a.lat + (b.lat - a.lat) * ratio;
    const lon = a.lon + (b.lon - a.lon) * ratio;
    const latNoise = gaussian() * this.noiseMeters / 111_320;
    const lonScale = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const lonNoise = gaussian() * this.noiseMeters / (111_320 * lonScale);

    return {
      lat: lat + latNoise,
      lon: lon + lonNoise,
      sog: typeof b.sog === 'number' && b.sog < 102 ? b.sog : null,
      cog: typeof b.cog === 'number' && b.cog >= 0 && b.cog < 360 ? b.cog : null,
      heading:
        typeof b.heading === 'number' && b.heading >= 0 && b.heading < 360 ? b.heading : null,
    };
  }
}
