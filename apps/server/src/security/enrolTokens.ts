/**
 * One-time, per-vessel enrolment tokens. An admin (scope 'devices') issues a token bound to
 * one entity with an expiry; only its SHA-256 is stored; it is consumed on first use.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface Stored {
  digest_hex: string;
  entity_id: string;
  expires_at: string;
  issued_by: string;
  used_at?: string;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export class EnrolTokenStore {
  private items: Stored[] = [];

  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      try {
        this.items = JSON.parse(readFileSync(path, 'utf8')) as Stored[];
      } catch {
        this.items = [];
      }
    }
  }

  private save(): void {
    if (this.path) writeFileSync(this.path, JSON.stringify(this.items, null, 2) + '\n', { mode: 0o600 });
  }

  issue(entityId: string, ttlS: number, issuedBy: string, now = new Date()): { token: string; expires_at: string } {
    const token = randomBytes(24).toString('base64url');
    const expires_at = new Date(now.getTime() + Math.max(60, Math.min(ttlS, 7 * 86400)) * 1000).toISOString();
    this.items.push({ digest_hex: sha(token).toString('hex'), entity_id: entityId, expires_at, issued_by: issuedBy });
    this.items = this.items.filter((i) => !i.used_at && Date.parse(i.expires_at) > now.getTime());
    this.save();
    return { token, expires_at };
  }

  /** Consume a token for `entityId`; false if unknown, expired, used, or bound to another vessel. */
  consume(token: string | undefined, entityId: string, now = new Date()): boolean {
    if (!token) return false;
    const d = sha(token);
    let hit: Stored | null = null;
    for (const i of this.items) {
      if (timingSafeEqual(d, Buffer.from(i.digest_hex, 'hex')) && !hit) hit = i;
    }
    if (!hit || hit.used_at || Date.parse(hit.expires_at) <= now.getTime() || hit.entity_id !== entityId) return false;
    hit.used_at = now.toISOString();
    this.save();
    return true;
  }
}
