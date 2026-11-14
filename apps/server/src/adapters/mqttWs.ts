/**
 * Minimal MQTT 3.1.1 client over WebSocket (Node's built-in WebSocket): CONNECT, SUBSCRIBE
 * QoS 0, receive PUBLISH, PINGREQ, reconnect with backoff. Enough for read-only public
 * streams (e.g. Digitraffic marine AIS); no dependency.
 */
import { randomBytes } from 'node:crypto';

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

export const connectPacket = (clientId: string, keepalive: number) =>
  packet(0x10, Buffer.concat([str('MQTT'), Buffer.from([4, 0x02, keepalive >> 8, keepalive & 0xff]), str(clientId)]));

export const subscribePacket = (id: number, topics: string[]) =>
  packet(
    0x82,
    Buffer.concat([Buffer.from([id >> 8, id & 0xff]), ...topics.map((t) => Buffer.concat([str(t), Buffer.from([0])]))]),
  );

const PINGREQ = Buffer.from([0xc0, 0x00]);

/** Split a byte stream into complete MQTT packets; returns the leftover bytes. */
export function parsePackets(buf: Buffer, onPacket: (type: number, flags: number, body: Buffer) => void): Buffer {
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

export type MqttState = 'idle' | 'connecting' | 'ok' | 'down';

export interface MqttWsOptions {
  url: string;
  topics: string[];
  clientIdPrefix?: string;
  keepaliveS?: number;
  onMessage: (topic: string, payload: Buffer) => void;
  onState?: (s: MqttState, reason?: string) => void;
}

export class MqttWsClient {
  state: MqttState = 'idle';
  lastReason: string | null = null;
  private ws: WebSocket | null = null;
  private ping: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly opts: MqttWsOptions) {}

  private set(s: MqttState, reason?: string): void {
    this.state = s;
    if (reason) this.lastReason = reason;
    this.opts.onState?.(s, reason);
  }

  start(): void {
    this.stopped = false;
    if (typeof WebSocket === 'undefined') {
      this.set('down', 'WebSocket not available in this Node version');
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.set('idle');
  }

  private connect(): void {
    if (this.stopped) return;
    this.set('connecting');
    const clientId = `${this.opts.clientIdPrefix ?? 'mqttws'}-${randomBytes(4).toString('hex')}`;
    const keepalive = this.opts.keepaliveS ?? 30;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url, ['mqtt']);
    } catch (e) {
      this.scheduleReconnect((e as Error).message);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    let rest: Buffer = Buffer.alloc(0);
    ws.onopen = () => ws.send(connectPacket(clientId, keepalive));
    ws.onmessage = (ev) => {
      rest = parsePackets(Buffer.concat([rest, Buffer.from(ev.data as ArrayBuffer)]), (type, flags, body) => {
        if (type === 2) {
          if (body[1] !== 0) {
            this.set('down', `CONNACK refused (${body[1]})`);
            ws.close();
            return;
          }
          this.attempt = 0;
          ws.send(subscribePacket(1, this.opts.topics));
          if (this.ping) clearInterval(this.ping);
          this.ping = setInterval(() => ws.readyState === ws.OPEN && ws.send(PINGREQ), (keepalive * 1000 * 2) / 3);
          this.set('ok');
        } else if (type === 3) {
          const tl = (body[0]! << 8) | body[1]!;
          const topic = body.subarray(2, 2 + tl).toString('utf8');
          const qos = (flags >> 1) & 3;
          try {
            this.opts.onMessage(topic, body.subarray(2 + tl + (qos > 0 ? 2 : 0)));
          } catch {
            /* a bad message must not kill the stream */
          }
        }
      });
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.scheduleReconnect('disconnected');
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.set('down', reason);
    const wait = Math.min(60_000, 2_000 * 2 ** this.attempt++);
    this.retry = setTimeout(() => this.connect(), wait);
  }
}
