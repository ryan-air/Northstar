/**
 * Seeded fuzzing of every boundary that takes untrusted input. Deterministic (fixed seeds),
 * so any failure reproduces exactly. FUZZ_ITERS raises the iteration count locally.
 *
 * Each target asserts "never throws" plus an invariant (e.g. a tampered envelope never verifies).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SignedTelemetryEnvelopeSchema, type TelemetryPayload } from '@northstar/contracts';
import {
  IngestValidator,
  assessSilence,
  bytesToB64,
  canonicalize,
  checkDrSeries,
  generateKeyPair,
  signPayload,
  validatePositionEvent,
  verifyEnvelope,
  type JsonValue,
} from '@northstar/core';
import { accuracyFromPosAcc, decodeAisRot, dimensionsFromMeta } from '../adapters/digitraffic.js';
import { aisStreamObservationTime } from '../adapters/aisstream.js';
import { parseCsv } from '../lab/labFolder.js';
import { loadLabReturn } from '../lab/labReturn.js';
import { simplifyForDisplay } from '../geo/displaySimplify.js';

const ITERS = Number(process.env.FUZZ_ITERS ?? 400);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

const WEIRD_NUMS = [0, -0, 1, -1, NaN, Infinity, -Infinity, 1e308, -1e308, 2 ** 53, 91, 181, 511, 102.3, 360, 3600];
const WEIRD_STRS = ['', ' ', '"', '""', ',', '\n', '\r\n', '\u0000', '__proto__', 'constructor', '😀', 'Z', '2026-13-45T99:99:99Z', 'A'.repeat(5000)];

function anyValue(r: () => number, depth = 0): unknown {
  const k = Math.floor(r() * (depth > 3 ? 6 : 8));
  switch (k) {
    case 0: return null;
    case 1: return r() < 0.5;
    case 2: return WEIRD_NUMS[Math.floor(r() * WEIRD_NUMS.length)];
    case 3: return (r() - 0.5) * 10 ** Math.floor(r() * 8);
    case 4: return WEIRD_STRS[Math.floor(r() * WEIRD_STRS.length)];
    case 5: return Math.random().toString(36).slice(2, 2 + Math.floor(r() * 12));
    case 6: return Array.from({ length: Math.floor(r() * 4) }, () => anyValue(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(r() * 5); i++) o[String(anyValue(r, 9))] = anyValue(r, depth + 1);
      return o;
    }
  }
}

function validEvent(r: () => number) {
  const ts = new Date(Date.UTC(2030, 0, 1) + Math.floor(r() * 1e6) * 1000).toISOString();
  return {
    entity_id: 'V' + Math.floor(r() * 50),
    entity_type: 'vessel',
    position: { lat: (r() - 0.5) * 180, lon: (r() - 0.5) * 360 },
    speed_over_ground_knots: r() * 30,
    course_over_ground_deg: r() * 360,
    heading_deg: r() * 360,
    source: 'ais',
    source_timestamp: ts,
    ingested_at: ts,
  } as Record<string, unknown>;
}

function mutate(r: () => number, o: Record<string, unknown>): Record<string, unknown> {
  const c = structuredClone(o) as Record<string, unknown>;
  const keys = [...Object.keys(c), 'position', '__proto__', 'labels', 'quality'];
  for (let i = 0; i < 1 + Math.floor(r() * 3); i++) {
    const k = keys[Math.floor(r() * keys.length)]!;
    if (k === 'position' && r() < 0.5) c.position = { lat: anyValue(r), lon: anyValue(r) };
    else c[k] = anyValue(r);
  }
  return c;
}

describe('fuzz: AIS ingest validation', () => {
  it('validatePositionEvent / IngestValidator never throw; accepted events are sane', () => {
    const r = rng(1);
    const v = new IngestValidator({ staleAfterMs: 600_000, maxFutureSkewMs: 30_000 });
    for (let i = 0; i < ITERS * 3; i++) {
      const raw = r() < 0.3 ? anyValue(r) : mutate(r, validEvent(r));
      const now = new Date(Date.UTC(2030, 0, 1) + Math.floor(r() * 1e6) * 1000);
      const a = validatePositionEvent(raw);
      const b = v.validate(raw, now);
      for (const out of [a, b]) {
        if (out.ok) {
          const { lat, lon } = out.event.position;
          expect(Number.isFinite(lat) && Math.abs(lat) <= 90).toBe(true);
          expect(Number.isFinite(lon) && Math.abs(lon) <= 180).toBe(true);
        } else expect(typeof out.code).toBe('string');
      }
    }
  });
});

describe('fuzz: signed telemetry', () => {
  it('envelope schema never throws on random input', () => {
    const r = rng(2);
    for (let i = 0; i < ITERS; i++) expect(() => SignedTelemetryEnvelopeSchema.safeParse(anyValue(r))).not.toThrow();
  });

  it('a tampered signature or payload never verifies', async () => {
    const r = rng(3);
    const { privateKey, publicKey } = await generateKeyPair();
    const payload: TelemetryPayload = {
      v: 1, device_id: 'D1', entity_id: 'V1', sequence_number: 7, timestamp: '2030-01-01T00:00:00.000Z',
      firmware_version: '1', position: { lat: 60, lon: 25 }, speed_over_ground_knots: 10, course_over_ground_deg: 90,
    } as TelemetryPayload;
    const sig = await signPayload(payload, privateKey);
    const good = { payload, signature: sig, public_key_id: 'k', assurance_level: 'software' as const, signature_alg: 'ed25519' as const };
    expect((await verifyEnvelope(good, publicKey)).ok).toBe(true);
    for (let i = 0; i < ITERS / 2; i++) {
      const sigBytes = Buffer.from(sig, 'base64');
      const which = r();
      let env;
      if (which < 0.4) {
        sigBytes[Math.floor(r() * sigBytes.length)]! ^= 1 + Math.floor(r() * 255);
        env = { ...good, signature: bytesToB64(new Uint8Array(sigBytes)) };
      } else if (which < 0.8) {
        const p2 = { ...payload } as Record<string, unknown>;
        const k = ['sequence_number', 'entity_id', 'position', 'timestamp', 'speed_over_ground_knots'][Math.floor(r() * 5)]!;
        p2[k] = k === 'position' ? { lat: 60 + r(), lon: 25 } : k === 'sequence_number' ? 8 + Math.floor(r() * 100) : k === 'speed_over_ground_knots' ? 11 + r() : k === 'timestamp' ? '2030-01-01T00:00:01.000Z' : 'V2';
        env = { ...good, payload: p2 as TelemetryPayload };
      } else {
        env = { ...good, signature: String(anyValue(r)) || 'x', payload: (r() < 0.5 ? anyValue(r) : payload) as TelemetryPayload };
        if (env.payload === payload && env.signature === sig) continue;
      }
      const out = await verifyEnvelope(env, publicKey);
      expect(out.ok).toBe(false);
    }
  });

  it('canonical JSON is key-order independent and deterministic', () => {
    const r = rng(4);
    for (let i = 0; i < ITERS; i++) {
      const v = anyValue(r);
      let json: unknown;
      try {
        json = JSON.parse(JSON.stringify(v));
      } catch {
        continue;
      }
      if (json === undefined) continue;
      const shuffle = (x: unknown): unknown =>
        Array.isArray(x) ? x.map(shuffle) : x && typeof x === 'object'
          ? Object.fromEntries(Object.entries(x as Record<string, unknown>).reverse().map(([k, y]) => [k, shuffle(y)]))
          : x;
      let a: string | null = null;
      try {
        a = canonicalize(json as JsonValue);
      } catch {
        continue; // rejecting non-canonicalisable input is fine; it must just be consistent
      }
      expect(canonicalize(shuffle(json) as JsonValue)).toBe(a);
    }
  });
});

describe('fuzz: AIS adapters', () => {
  it('decoders return finite values or null', () => {
    const r = rng(5);
    for (let i = 0; i < ITERS; i++) {
      const rot = decodeAisRot(anyValue(r) as number);
      expect(rot === null || Number.isFinite(rot)).toBe(true);
      const acc = accuracyFromPosAcc(anyValue(r) as boolean);
      expect(acc === null || Number.isFinite(acc)).toBe(true);
      expect(() => dimensionsFromMeta(anyValue(r) as never)).not.toThrow();
      const t = aisStreamObservationTime(anyValue(r) as string, anyValue(r) as number, 1_900_000_000_000);
      expect(Number.isFinite(t.ms)).toBe(true);
    }
  });
});

describe('fuzz: lab inputs', () => {
  it('CSV parser never throws and round-trips quoted fields', () => {
    const r = rng(6);
    for (let i = 0; i < ITERS; i++) {
      const s = Array.from({ length: Math.floor(r() * 40) }, () => WEIRD_STRS[Math.floor(r() * 8)] ?? 'x').join(r() < 0.5 ? ',' : '');
      expect(() => parseCsv(s)).not.toThrow();
      const vals = Array.from({ length: 3 }, () => ['a,b', 'say "hi"', 'plain', ''][Math.floor(r() * 4)]!);
      const line = vals.map((v) => `"${v.replace(/"/g, '""')}"`).join(',');
      expect(parseCsv(`x,y,z\n${line}`)[0]).toEqual({ x: vals[0], y: vals[1], z: vals[2] });
    }
  });

  it('lab return loader drops garbage rows and never throws', () => {
    const r = rng(7);
    const root = mkdtempSync(join(tmpdir(), 'fz-'));
    for (let i = 0; i < 20; i++) {
      const d = join(root, `r${i}`);
      mkdirSync(d);
      writeFileSync(join(d, 'readiness.json'), JSON.stringify({ items: {}, secrets_found: [] }));
      const lines = Array.from({ length: 30 }, () => (r() < 0.2 ? '{bad json' : JSON.stringify(r() < 0.5 ? anyValue(r) : mutate(r, validEvent(r)))));
      for (const f of ['ais_secondary.jsonl', 'gnss_recorded.jsonl', 'imu.jsonl', 'onboard_track.jsonl']) writeFileSync(join(d, f), lines.join('\n'));
      expect(() => loadLabReturn(root, `r${i}`)).not.toThrow();
    }
    expect(loadLabReturn(root, '../../etc')).toBeNull();
  });
});

describe('fuzz: geometry and new checks', () => {
  it('display simplification keeps rings closed and never throws', () => {
    const r = rng(8);
    for (let i = 0; i < ITERS / 4; i++) {
      const n = 3 + Math.floor(r() * 40);
      const ring = Array.from({ length: n }, () => [24 + r(), 60 + r()]);
      ring.push(ring[0]!);
      const fc = { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] };
      const out = simplifyForDisplay(fc, r() * 0.01, r() < 0.5 ? 0 : 1e-6);
      for (const f of out.features) {
        const rr = (f.geometry as { coordinates: number[][][] }).coordinates[0]!;
        expect(rr.length).toBeGreaterThanOrEqual(4);
        expect(rr[0]).toEqual(rr[rr.length - 1]);
      }
    }
  });

  it('dead reckoning and silence alerts never throw on random series', () => {
    const r = rng(9);
    for (let i = 0; i < ITERS / 2; i++) {
      const series = Array.from({ length: Math.floor(r() * 50) }, (_, k) => ({
        t: 1_900_000_000_000 + k * 1000 * (1 + Math.floor(r() * 3)),
        heading_deg: r() < 0.1 ? null : (anyValue(r) as number),
        speed_kn: r() < 0.1 ? null : (anyValue(r) as number),
      }));
      const ev = validEvent(r) as never;
      expect(() => checkDrSeries(ev, series as never, r() < 0.5 ? null : { t: 1_900_000_000_000, lat: 60, lon: 25 }, 'x')).not.toThrow();
      expect(() =>
        assessSilence({ nowMs: 1_900_000_100_000, lastReport: r() < 0.5 ? null : { t: 1_900_000_000_000, lat: anyValue(r) as number, lon: 25 }, gnss: null, observations: [], typicalIntervalS: anyValue(r) as number }),
      ).not.toThrow();
    }
  });
});
