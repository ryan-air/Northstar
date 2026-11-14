import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.js';
import type { ReplayManifest, ReplayRecord, VesselTrack } from './types.js';

const REPLAY_DIR = join(REPO_ROOT, 'data/replay');
const JSONL_PATH = join(REPLAY_DIR, 'gof_ais.jsonl');
const MANIFEST_PATH = join(REPLAY_DIR, 'manifest.json');

function shipTypeToClass(t?: number): VesselTrack['vessel_class'] {
  if (t == null) return 'other';
  if (t === 30) return 'fishing';
  if (t === 52) return 'tug';
  if (t === 36 || t === 37) return 'pleasure';
  if (t >= 60 && t <= 69) return 'passenger';
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  return 'other';
}

export function ensureReplayDir(): void {
  mkdirSync(REPLAY_DIR, { recursive: true });
}

export function loadManifest(): ReplayManifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ReplayManifest;
}

export function saveManifest(m: ReplayManifest): void {
  ensureReplayDir();
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

export function appendRecords(records: ReplayRecord[]): void {
  if (records.length === 0) return;
  ensureReplayDir();
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  appendFileSync(JSONL_PATH, lines);
}

export function loadAllRecords(): ReplayRecord[] {
  if (!existsSync(JSONL_PATH)) return [];
  const text = readFileSync(JSONL_PATH, 'utf8');
  const out: ReplayRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ReplayRecord);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

/**
 * Build per-vessel tracks. Prefer vessels that moved (path length / sog).
 * Caps fleet size for demo CPU.
 */
export function buildTracks(
  records: ReplayRecord[],
  opts: { maxVessels?: number; minSamples?: number } = {},
): VesselTrack[] {
  const maxVessels = opts.maxVessels ?? 24;
  const minSamples = opts.minSamples ?? 3;
  const byMmsi = new Map<number, ReplayRecord[]>();

  for (const r of records) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const list = byMmsi.get(r.mmsi) ?? [];
    list.push(r);
    byMmsi.set(r.mmsi, list);
  }

  const ranked: Array<VesselTrack & { score: number }> = [];
  for (const [mmsi, raw] of byMmsi) {
    const sorted = [...raw].sort((a, b) => {
      const ta = a.timestamp_external_ms ?? Date.parse(a.captured_at);
      const tb = b.timestamp_external_ms ?? Date.parse(b.captured_at);
      return ta - tb;
    });
    const samples: ReplayRecord[] = [];
    for (const s of sorted) {
      const prev = samples[samples.length - 1];
      if (
        prev &&
        Math.abs(prev.lat - s.lat) < 1e-7 &&
        Math.abs(prev.lon - s.lon) < 1e-7 &&
        (prev.sog ?? 0) === (s.sog ?? 0)
      ) {
        continue;
      }
      samples.push(s);
    }
    if (samples.length < minSamples) continue;

    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const t0 = first.timestamp_external_ms ?? Date.parse(first.captured_at);
    const t1 = last.timestamp_external_ms ?? Date.parse(last.captured_at);
    let pathM = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      const dlat = (b.lat - a.lat) * 111_320;
      const dlon = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
      pathM += Math.hypot(dlat, dlon);
    }
    const avgSog =
      samples.reduce((s, x) => s + (typeof x.sog === 'number' && x.sog < 102 ? x.sog : 0), 0) /
      samples.length;

    ranked.push({
      mmsi,
      entity_id: `LAB-${mmsi}`,
      name: first.name?.trim() || `MMSI ${mmsi}`,
      vessel_class: shipTypeToClass(first.shipType),
      samples,
      durationMs: Math.max(1, t1 - t0),
      score: pathM + avgSog * 100,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxVessels).map(({ score: _s, ...t }) => t);
}

export async function enrichNames(tracks: VesselTrack[]): Promise<void> {
  try {
    const res = await fetch('https://meri.digitraffic.fi/api/ais/v1/vessels', {
      headers: {
        'Digitraffic-User': 'Northstar/1.0',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
    });
    if (!res.ok) return;
    const list = (await res.json()) as Array<{
      mmsi: number;
      name?: string;
      shipType?: number;
    }>;
    const map = new Map(list.map((v) => [v.mmsi, v]));
    for (const t of tracks) {
      const meta = map.get(t.mmsi);
      if (meta?.name?.trim()) t.name = meta.name.trim();
      if (meta?.shipType != null) {
        t.vessel_class = shipTypeToClass(meta.shipType);
        for (const s of t.samples) {
          s.name = t.name;
          s.shipType = meta.shipType;
        }
      }
    }
  } catch {
    /* offline ok */
  }
}

export { JSONL_PATH, MANIFEST_PATH, REPLAY_DIR };
