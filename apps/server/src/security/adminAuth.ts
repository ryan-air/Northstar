/**
 * Admin and WebSocket token handling.
 *
 * - Admin token: NORTHSTAR_ADMIN_TOKEN. When unset, the published demo token is only
 *   accepted while the server binds to loopback; on any other address the server refuses
 *   to start unless NORTHSTAR_ALLOW_DEMO_ADMIN=true restores the old behaviour.
 * - WebSocket token: NORTHSTAR_WS_TOKEN (optional). When set, /ws requires ?token=<value>
 *   (browsers cannot set headers on a WebSocket) or an Authorization: Bearer header.
 * - All comparisons are constant-time over SHA-256 digests (no length leak).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const DEMO_ADMIN_TOKEN = 'northstar-demo-admin';

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export interface AdminTokenConfig {
  token: string | null;
  source: 'env' | 'demo' | 'none';
  warning?: string;
}

export function resolveAdminToken(opts: {
  envToken?: string;
  testMode: boolean;
  host: string;
  allowDemo?: boolean;
}): AdminTokenConfig {
  const env = opts.envToken?.trim();
  if (env) {
    if (env === DEMO_ADMIN_TOKEN && !isLoopbackHost(opts.host) && !opts.allowDemo) {
      throw new Error(
        `NORTHSTAR_ADMIN_TOKEN is the published demo token; set a real token before binding to ${opts.host}`,
      );
    }
    return { token: env, source: 'env' };
  }
  if (opts.testMode) return { token: null, source: 'none' };
  if (!isLoopbackHost(opts.host) && !opts.allowDemo) {
    throw new Error(
      `NORTHSTAR_ADMIN_TOKEN is unset and the server binds to ${opts.host} (not loopback). ` +
        'Set NORTHSTAR_ADMIN_TOKEN, or NORTHSTAR_ALLOW_DEMO_ADMIN=true to accept the demo token.',
    );
  }
  return {
    token: DEMO_ADMIN_TOKEN,
    source: 'demo',
    warning: `NORTHSTAR_ADMIN_TOKEN is unset; admin routes accept the demo token "${DEMO_ADMIN_TOKEN}" (loopback only)`,
  };
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

export function tokenEquals(given: string | undefined | null, expected: string): boolean {
  if (typeof given !== 'string') return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** True when `authorization` is `Bearer <token>`; a null token means auth is disabled (tests). */
export function bearerOk(authorization: string | string[] | undefined, token: string | null): boolean {
  if (token === null) return true;
  const h = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!h || !h.startsWith('Bearer ')) return false;
  return tokenEquals(h.slice(7), token);
}

/** Same as bearerOk but never true when auth is disabled (used to grant extra rights). */
export function isAdminRequest(authorization: string | string[] | undefined, token: string | null): boolean {
  return token !== null && bearerOk(authorization, token);
}

export function wsTokenOk(
  query: unknown,
  authorization: string | string[] | undefined,
  wsToken: string | null,
): boolean {
  if (!wsToken) return true;
  const q = (query ?? {}) as Record<string, unknown>;
  const t = typeof q.token === 'string' ? q.token : undefined;
  return tokenEquals(t, wsToken) || bearerOk(authorization, wsToken);
}
