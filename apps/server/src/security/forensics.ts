/** Ring buffer of cryptographic security events for the hackathon cyber console. */
import { randomBytes } from 'node:crypto';

export type SecurityEventKind =
  | 'signature_verified'
  | 'signature_failed'
  | 'replay_rejected'
  | 'untrusted_key'
  | 'key_rotated'
  | 'key_revoked'
  | 'device_enrolled'
  | 'osnma_verified'
  | 'osnma_failed'
  | 'audit_tamper_detected'
  | 'challenge_issued'
  | 'challenge_rejected'
  | 'ingest_rejected'
  | 'enrolment_rejected'
  | 'admin_denied';

export interface SecurityEvent {
  id: string;
  ts: string;
  kind: SecurityEventKind;
  severity: 'info' | 'warning' | 'critical';
  device_id?: string;
  entity_id?: string;
  detail: Record<string, unknown>;
  /** Short judge-facing explanation */
  explanation: string;
}

interface OutstandingChallenge {
  nonce: string;
  exp: number;
}

const MAX_OUTSTANDING = 8;

export class SecurityForensics {
  private events: SecurityEvent[] = [];
  /** Multiple outstanding nonces per device (TTL'd). */
  private challenges = new Map<string, OutstandingChallenge[]>();
  constructor(private cap = 200) {}

  push(
    kind: SecurityEventKind,
    explanation: string,
    detail: Record<string, unknown> = {},
    severity: SecurityEvent['severity'] = 'info',
  ): SecurityEvent {
    const ev: SecurityEvent = {
      id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      kind,
      severity,
      device_id: typeof detail.device_id === 'string' ? detail.device_id : undefined,
      entity_id: typeof detail.entity_id === 'string' ? detail.entity_id : undefined,
      detail,
      explanation,
    };
    this.events.push(ev);
    if (this.events.length > this.cap) this.events.shift();
    return ev;
  }

  list(limit = 50): SecurityEvent[] {
    return this.events.slice(-limit).reverse();
  }

  private prune(deviceId: string): OutstandingChallenge[] {
    const now = Date.now();
    const list = (this.challenges.get(deviceId) ?? []).filter((c) => c.exp > now);
    this.challenges.set(deviceId, list);
    return list;
  }

  /**
   * Issue a freshness nonce. Does not overwrite existing outstanding nonces —
   * keeps up to MAX_OUTSTANDING so spam cannot starve the real device.
   */
  issueChallenge(deviceId: string, ttlMs = 30_000): { nonce: string; expires_at: string } {
    const nonce = randomBytes(16).toString('base64url');
    const exp = Date.now() + ttlMs;
    const list = this.prune(deviceId);
    list.push({ nonce, exp });
    while (list.length > MAX_OUTSTANDING) list.shift();
    this.challenges.set(deviceId, list);
    this.push(
      'challenge_issued',
      `Issued freshness challenge nonce for ${deviceId}`,
      { device_id: deviceId, nonce, ttl_ms: ttlMs, outstanding: list.length },
      'info',
    );
    return { nonce, expires_at: new Date(exp).toISOString() };
  }

  /** @deprecated Use signed challenge request; peek of outstanding list is not exposed via API. */
  peekChallenge(deviceId: string): { nonce: string; expires_at: string } | null {
    const list = this.prune(deviceId);
    const row = list[list.length - 1];
    if (!row) return null;
    return { nonce: row.nonce, expires_at: new Date(row.exp).toISOString() };
  }

  /**
   * Validate that a nonce is outstanding without consuming it.
   * Call before signature verification; call consumeChallengeNonce after verify succeeds.
   */
  peekChallengeNonce(
    deviceId: string,
    nonce: string | undefined | null,
    required = false,
  ): { ok: true } | { ok: false; reason: 'challenge_required' | 'challenge_rejected' } {
    const list = this.prune(deviceId);
    if (list.length === 0) {
      if (required) {
        this.push(
          'challenge_rejected',
          'Challenge required but none outstanding — issue a nonce first',
          { device_id: deviceId, reason: 'challenge_required' },
          'critical',
        );
        return { ok: false, reason: 'challenge_required' };
      }
      return { ok: true };
    }
    if (!nonce || !list.some((c) => c.nonce === nonce)) {
      this.push(
        'challenge_rejected',
        'Challenge nonce mismatch (peek)',
        { device_id: deviceId },
        'critical',
      );
      return { ok: false, reason: 'challenge_rejected' };
    }
    return { ok: true };
  }

  /**
   * Consume a matching outstanding nonce after signature verification succeeds.
   */
  consumeChallengeNonce(
    deviceId: string,
    nonce: string | undefined | null,
    required = false,
  ): { ok: true } | { ok: false; reason: 'challenge_required' | 'challenge_rejected' } {
    const list = this.prune(deviceId);
    if (list.length === 0) {
      if (required) {
        this.push(
          'challenge_rejected',
          'Challenge required but none outstanding — issue a nonce first',
          { device_id: deviceId, reason: 'challenge_required' },
          'critical',
        );
        return { ok: false, reason: 'challenge_required' };
      }
      return { ok: true };
    }
    if (!nonce) {
      this.push(
        'challenge_rejected',
        'Challenge nonce missing on consume',
        { device_id: deviceId },
        'critical',
      );
      return { ok: false, reason: 'challenge_rejected' };
    }
    const idx = list.findIndex((c) => c.nonce === nonce);
    if (idx < 0) {
      this.push(
        'challenge_rejected',
        'Challenge nonce mismatch on consume',
        { device_id: deviceId },
        'critical',
      );
      return { ok: false, reason: 'challenge_rejected' };
    }
    list.splice(idx, 1);
    this.challenges.set(deviceId, list);
    return { ok: true };
  }

  /**
   * Legacy single-step consume (peek+consume). Prefer peekChallengeNonce +
   * consumeChallengeNonce around signature verify.
   */
  consumeChallenge(
    deviceId: string,
    nonce: string | undefined | null,
    required = false,
  ): { ok: true } | { ok: false; reason: 'challenge_required' | 'challenge_rejected' } {
    const peek = this.peekChallengeNonce(deviceId, nonce, required);
    if (!peek.ok) return peek;
    return this.consumeChallengeNonce(deviceId, nonce, required);
  }
}
