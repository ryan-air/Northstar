/**
 * Record the Digitraffic real-time AIS stream (MQTT over WebSocket, public, no key) to a
 * replay file at full cadence. The REST poll the server records gives 1–20 min between
 * reports per vessel; this stream carries every position Digitraffic receives (seconds),
 * which is what slow-drift / small-offset evaluation needs.
 *
 *   npx tsx scripts/record/digitraffic-stream.ts [--out PATH] [--bbox minLon,minLat,maxLon,maxLat] [--minutes N]
 *
 * Output: ReplayRecord JSONL (source 'digitraffic', provider_id 'digitraffic_stream'),
 * default NORTHSTAR_DATA_DIR/replay/gof_ais_stream.jsonl (gitignored runtime dir).
 * Vessel metadata from the same stream goes to <out>.meta.json.
 * Data: Fintraffic / Digitraffic, CC BY 4.0.
 *
 * Minimal MQTT 3.1.1 client (CONNECT, SUBSCRIBE QoS 0, PUBLISH receive, PINGREQ) on Node's
 * built-in WebSocket, so no extra dependency.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(__dirname, '../..');
const URL = 'wss://meri.digitraffic.fi:443/mqtt';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dataDir = (process.env.NORTHSTAR_DATA_DIR ?? '.northstar/data').replace(/^~/, process.env.HOME ?? '');
const outArg = arg('out');
const OUT = outArg
  ? isAbsolute(outArg) ? outArg : join(ROOT, outArg)
  : join(isAbsolute(dataDir) ? dataDir : join(ROOT, dataDir), 'replay', 'gof_ais_stream.jsonl');
const META = OUT.replace(/\.jsonl$/, '') + '.meta.json';
const [minLon, minLat, maxLon, maxLat] = (arg('bbox') ?? '22,59,31,61').split(',').map(Number) as [
  number, number, number, number,
];
const STOP_AFTER_MS = arg('minutes') ? Number(arg('minutes')) * 60_000 : null;

// ---------------------------------------------------------------- MQTT framing

function encLen(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function str(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
}

function packet(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type, ...encLen(body.length)]), body]);
}

const connectPkt = (clientId: string, keepalive: number) =>
  packet(
    0x10,
    Buffer.concat([str('MQTT'), Buffer.from([4, 0x02, keepalive >> 8, keepalive & 0xff]), str(clientId)]),
  );

const subscribePkt = (id: number, topics: string[]) =>
  packet(
    0x82,
    Buffer.concat([Buffer.from([id >> 8, id & 0xff]), ...topics.map((t) => Buffer.concat([str(t), Buffer.from([0])]))]),
  );

const PINGREQ = Buffer.from([0xc0, 0x00]);

/** Split a byte stream into complete MQTT packets; returns leftover bytes. */
function parsePackets(buf: Buffer, onPacket: (type: number, flags: number, body: Buffer) => void): Buffer {
  let off = 0;
  while (buf.length - off >= 2) {
    let mult = 1;
    let len = 0;
    let i = off + 1;
    let done = false;
    for (; i < buf.length && i < off + 5; i++) {
      len += (buf[i]! & 0x7f) * mult;
      mult *= 128;
      if ((buf[i]! & 0x80) === 0) {
        done = true;
        i++;
        break;
      }
    }
    if (!done || buf.length < i + len) break;
    onPacket(buf[off]! >> 4, buf[off]! & 0x0f, buf.subarray(i, i + len));
    off = i + len;
  }
  return buf.subarray(off);
}

// ---------------------------------------------------------------- recorder

interface Loc {
  time: number;
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

const meta: Record<string, Record<string, unknown>> = existsSync(META)
  ? (JSON.parse(readFileSync(META, 'utf8')) as Record<string, Record<string, unknown>>)
  : {};
const lastTs = new Map<number, number>();
const stats = { received: 0, written: 0, outside_bbox: 0, duplicate: 0, invalid: 0, vessels: new Set<number>() };
let metaDirty = false;

function onLocation(mmsi: number, p: Loc): void {
  stats.received++;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.time) || !(mmsi >= 1e8 && mmsi < 1e9)) {
    stats.invalid++;
    return;
  }
  if (p.lon < minLon || p.lon > maxLon || p.lat < minLat || p.lat > maxLat) {
    stats.outside_bbox++;
    return;
  }
  const tsMs = p.time * 1000;
  if ((lastTs.get(mmsi) ?? -1) >= tsMs) {
    stats.duplicate++;
    return;
  }
  lastTs.set(mmsi, tsMs);
  const m = meta[String(mmsi)] ?? {};
  const row = {
    mmsi,
    lat: p.lat,
    lon: p.lon,
    sog: p.sog ?? null,
    cog: p.cog ?? null,
    heading: p.heading ?? null,
    navStat: p.navStat ?? null,
    timestamp_external_ms: tsMs,
    captured_at: new Date().toISOString(),
    source: 'digitraffic',
    provider_id: 'digitraffic_stream',
    rot: p.rot ?? null,
    posAcc: p.posAcc ?? null,
    raim: p.raim ?? null,
    ...(typeof m.name === 'string' ? { name: m.name } : {}),
    ...(typeof m.shipType === 'number' ? { shipType: m.shipType } : {}),
    ...(['referencePointA', 'referencePointB', 'referencePointC', 'referencePointD'] as const).reduce(
      (o, k) => (typeof m[k] === 'number' ? { ...o, [k]: m[k] } : o),
      {},
    ),
  };
  appendFileSync(OUT, JSON.stringify(row) + '\n');
  stats.written++;
  stats.vessels.add(mmsi);
}

function onMessage(topic: string, payload: Buffer): void {
  const m = /^vessels-v2\/(\d+)\/(location|metadata)$/.exec(topic);
  if (!m) return;
  let json: unknown;
  try {
    json = JSON.parse(payload.toString('utf8'));
  } catch {
    stats.invalid++;
    return;
  }
  if (m[2] === 'location') onLocation(Number(m[1]), json as Loc);
  else {
    meta[m[1]!] = json as Record<string, unknown>;
    metaDirty = true;
  }
}

function connect(attempt = 0): void {
  const clientId = `northstar-rec-${randomBytes(4).toString('hex')}`;
  const ws = new WebSocket(URL, ['mqtt']);
  ws.binaryType = 'arraybuffer';
  let rest: Buffer = Buffer.alloc(0);
  let ping: NodeJS.Timeout | null = null;
  ws.onopen = () => {
    ws.send(connectPkt(clientId, 30));
  };
  ws.onmessage = (ev) => {
    rest = parsePackets(Buffer.concat([rest, Buffer.from(ev.data as ArrayBuffer)]), (type, flags, body) => {
      if (type === 2) {
        // CONNACK
        if (body[1] !== 0) {
          console.error(`[stream] CONNACK refused (${body[1]})`);
          ws.close();
          return;
        }
        attempt = 0;
        ws.send(subscribePkt(1, ['vessels-v2/+/location', 'vessels-v2/+/metadata']));
        ping = setInterval(() => ws.readyState === ws.OPEN && ws.send(PINGREQ), 20_000);
        console.log(`[stream] connected; recording to ${OUT}`);
      } else if (type === 3) {
        const tl = (body[0]! << 8) | body[1]!;
        const topic = body.subarray(2, 2 + tl).toString('utf8');
        const qos = (flags >> 1) & 3;
        onMessage(topic, body.subarray(2 + tl + (qos > 0 ? 2 : 0)));
      }
    });
  };
  ws.onclose = () => {
    if (ping) clearInterval(ping);
    const wait = Math.min(60_000, 2_000 * 2 ** attempt);
    console.warn(`[stream] disconnected; reconnecting in ${wait / 1000}s`);
    setTimeout(() => connect(attempt + 1), wait);
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function main(): void {
  mkdirSync(dirname(OUT), { recursive: true });
  const started = Date.now();
  connect();
  setInterval(() => {
    if (metaDirty) {
      writeFileSync(META, JSON.stringify(meta));
      metaDirty = false;
    }
    const mins = ((Date.now() - started) / 60_000).toFixed(1);
    console.log(
      `[stream] ${mins} min: written ${stats.written} (${stats.vessels.size} vessels), ` +
        `received ${stats.received}, outside bbox ${stats.outside_bbox}, dup ${stats.duplicate}, invalid ${stats.invalid}`,
    );
    if (STOP_AFTER_MS && Date.now() - started >= STOP_AFTER_MS) process.exit(0);
  }, 60_000);
}

main();
