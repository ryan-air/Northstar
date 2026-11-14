import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../config.js';

export interface AuditEntry {
  seq: number;
  ts: string;
  kind: string;
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export function hashAuditBody(fields: {
  seq: number;
  ts: string;
  kind: string;
  detail: Record<string, unknown>;
  prev_hash: string;
}): string {
  const body = stableStringify({
    seq: fields.seq,
    ts: fields.ts,
    kind: fields.kind,
    detail: fields.detail,
    prev_hash: fields.prev_hash,
  });
  return createHash('sha256').update(body).digest('hex');
}

export class AuditLog {
  private seq = 0;
  private prevHash = '0'.repeat(64);
  private path: string;
  private failClosedPath: string;
  /** Fail-closed after a broken chain — appends are refused until re-anchor. */
  broken = false;
  brokenPath: string | null = null;
  /** Called after each successful append (e.g. shore checkpoint writer). */
  onAppend: ((entry: AuditEntry) => void) | null = null;

  /**
   * @param pathOrRel Absolute path, or path relative to REPO_ROOT.
   */
  constructor(pathOrRel = 'data/fixtures/audit.jsonl') {
    this.path = pathOrRel.startsWith('/') ? pathOrRel : join(REPO_ROOT, pathOrRel);
    this.failClosedPath = `${this.path}.fail-closed`;
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) writeFileSync(this.path, '');
    this.recover();
  }

  get tip(): { seq: number; hash: string } {
    return { seq: this.seq, hash: this.prevHash };
  }

  private recover(): void {
    // Persistent fail-closed marker survives an emptied log.
    if (existsSync(this.failClosedPath)) {
      try {
        const meta = JSON.parse(readFileSync(this.failClosedPath, 'utf8')) as {
          broken_path?: string;
        };
        this.broken = true;
        this.brokenPath = meta.broken_path ?? null;
      } catch {
        this.broken = true;
      }
      console.warn(
        `[audit] fail-closed marker present${this.brokenPath ? ` (evidence: ${this.brokenPath})` : ''} — refusing appends until re-anchor`,
      );
      return;
    }

    const lines = readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;

    let prev = '0'.repeat(64);
    let ok = true;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.prev_hash !== prev) {
          ok = false;
          break;
        }
        const h = hashAuditBody(entry);
        if (h !== entry.hash) {
          ok = false;
          break;
        }
        prev = entry.hash;
      } catch {
        ok = false;
        break;
      }
    }
    if (!ok) {
      const broken = `${this.path}.broken-${Date.now()}`;
      try {
        writeFileSync(broken, readFileSync(this.path));
      } catch {
        /* ignore */
      }
      // Empty the live log so we do not look "intact", but keep fail-closed via marker.
      writeFileSync(this.path, '');
      this.broken = true;
      this.brokenPath = broken;
      this.seq = 0;
      this.prevHash = '0'.repeat(64);
      writeFileSync(
        this.failClosedPath,
        JSON.stringify(
          {
            broken_at: new Date().toISOString(),
            broken_path: broken,
            reason: 'chain_integrity_failure',
          },
          null,
          2,
        ),
      );
      console.warn(
        `[audit] chain broken on recover — evidence at ${broken}; fail-closed until re-anchor`,
      );
      return;
    }
    const last = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
    this.seq = last.seq;
    this.prevHash = last.hash;
  }

  /**
   * Append an audit entry. When fail-closed, returns null and does not write —
   * server boot must not crash; security summary still reports broken=true.
   */
  append(kind: string, detail: Record<string, unknown>): AuditEntry | null {
    if (this.broken) {
      console.warn(`[audit] refuse append kind=${kind} — fail-closed`);
      return null;
    }
    this.seq += 1;
    const ts = new Date().toISOString();
    const hash = hashAuditBody({
      seq: this.seq,
      ts,
      kind,
      detail,
      prev_hash: this.prevHash,
    });
    const entry: AuditEntry = {
      seq: this.seq,
      ts,
      kind,
      detail,
      prev_hash: this.prevHash,
      hash,
    };
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
    this.prevHash = hash;
    try {
      this.onAppend?.(entry);
    } catch (e) {
      console.warn('[audit] onAppend failed', e);
    }
    return entry;
  }

  /** Clear fail-closed and start a fresh chain (admin / operator re-anchor). */
  reanchor(): void {
    if (existsSync(this.failClosedPath)) {
      try {
        unlinkSync(this.failClosedPath);
      } catch {
        /* ignore */
      }
    }
    writeFileSync(this.path, '');
    this.broken = false;
    this.brokenPath = null;
    this.seq = 0;
    this.prevHash = '0'.repeat(64);
  }
}
