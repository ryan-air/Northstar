/**
 * Shore-signed revocation / rotation events. Ingest must honor this list even if
 * devices.json is tampered back to "active".
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../config.js';
import type { ShoreKeyring } from './shoreKeys.js';
import type { JsonValue } from '@northstar/core';

export type RevocationAction = 'revoke' | 'rotate_invalidate';

export interface RevocationEvent {
  seq: number;
  ts: string;
  action: RevocationAction;
  device_id: string;
  key_id: string;
  shore_key_id: string;
  shore_sig: string;
}

interface RevocationHead {
  count: number;
  tip_hash: string;
  shore_key_id: string;
  shore_sig: string;
}

function eventTipHash(events: RevocationEvent[]): string {
  const h = createHash('sha256');
  for (const ev of events) {
    h.update(ev.shore_sig);
    h.update('\n');
  }
  return h.digest('hex');
}

export class RevocationLog {
  private path: string;
  private headPath: string;
  private seq = 0;
  /** key_id → event */
  private byKeyId = new Map<string, RevocationEvent>();
  private events: RevocationEvent[] = [];
  private shore: ShoreKeyring;
  private recoverPromise: Promise<void>;

  /**
   * @param pathOrRel Absolute path or path relative to REPO_ROOT.
   */
  constructor(shore: ShoreKeyring, pathOrRel = 'data/fixtures/revocation.jsonl') {
    this.shore = shore;
    this.path = pathOrRel.startsWith('/') ? pathOrRel : join(REPO_ROOT, pathOrRel);
    this.headPath = `${this.path}.head.json`;
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) writeFileSync(this.path, '');
    // recover is async (sig verify) — callers must await ready()
    this.recoverPromise = this.recover();
  }

  async ready(): Promise<void> {
    await this.recoverPromise;
  }

  private async recover(): Promise<void> {
    const lines = readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean);
    const loaded: RevocationEvent[] = [];
    for (const line of lines) {
      let ev: RevocationEvent;
      try {
        ev = JSON.parse(line) as RevocationEvent;
      } catch {
        throw new Error(`Revocation log parse error — refuse to start (${this.path})`);
      }
      const { shore_sig, ...unsigned } = ev;
      const ok = await this.shore.verifyJson(unsigned as unknown as JsonValue, shore_sig);
      if (!ok) {
        throw new Error(
          `Revocation shore_sig invalid for seq=${ev.seq} key=${ev.key_id} — refuse to start`,
        );
      }
      loaded.push(ev);
    }

    this.events = loaded;
    this.byKeyId.clear();
    for (const ev of loaded) {
      this.seq = Math.max(this.seq, ev.seq);
      this.byKeyId.set(ev.key_id, ev);
    }

    // Head integrity: deleting a line must be detected.
    // Migrate legacy logs that pre-date the head file by writing one after verifying sigs.
    const tip = eventTipHash(loaded);
    if (!existsSync(this.headPath)) {
      if (loaded.length > 0) {
        await this.writeHead();
        console.warn(`[revocation] wrote missing head for ${loaded.length} verified entries`);
      }
      return;
    }
    const head = JSON.parse(readFileSync(this.headPath, 'utf8')) as RevocationHead;
    if (head.count !== loaded.length || head.tip_hash !== tip) {
      throw new Error(
        `Revocation head mismatch (count ${head.count}/${loaded.length}, tip) — possible line deletion`,
      );
    }
    if (loaded.length === 0) return;
    const headOk = await this.shore.verifyJson(
      {
        count: head.count,
        tip_hash: head.tip_hash,
        shore_key_id: head.shore_key_id,
      } as unknown as JsonValue,
      head.shore_sig,
    );
    if (!headOk) {
      throw new Error('Revocation head shore_sig invalid — refuse to start');
    }
  }

  isKeyRevoked(keyId: string): boolean {
    return this.byKeyId.has(keyId);
  }

  isDeviceRevoked(deviceId: string): boolean {
    for (const ev of this.byKeyId.values()) {
      if (ev.device_id === deviceId && ev.action === 'revoke') return true;
    }
    return false;
  }

  async append(input: {
    action: RevocationAction;
    device_id: string;
    key_id: string;
  }): Promise<RevocationEvent> {
    await this.ready();
    this.seq += 1;
    const ts = new Date().toISOString();
    const unsigned = {
      seq: this.seq,
      ts,
      action: input.action,
      device_id: input.device_id,
      key_id: input.key_id,
      shore_key_id: this.shore.keyId,
    };
    const shore_sig = await this.shore.signJson(unsigned as unknown as JsonValue);
    const ev: RevocationEvent = { ...unsigned, shore_sig };
    appendFileSync(this.path, JSON.stringify(ev) + '\n');
    this.byKeyId.set(ev.key_id, ev);
    this.events.push(ev);
    await this.writeHead();
    return ev;
  }

  private async writeHead(): Promise<void> {
    const tip_hash = eventTipHash(this.events);
    const body = {
      count: this.events.length,
      tip_hash,
      shore_key_id: this.shore.keyId,
    };
    const shore_sig = await this.shore.signJson(body as unknown as JsonValue);
    const head: RevocationHead = { ...body, shore_sig };
    writeFileSync(this.headPath, JSON.stringify(head, null, 2));
  }

  list(): RevocationEvent[] {
    return [...this.byKeyId.values()].sort((a, b) => a.seq - b.seq);
  }
}
