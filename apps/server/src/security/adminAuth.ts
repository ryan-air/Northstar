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

// ———————————————————————————————————— scoped admin credentials

export const ADMIN_SCOPES = ['scenario', 'rf', 'osnma', 'audit', 'devices', 'demo'] as const;
export type AdminScope = (typeof ADMIN_SCOPES)[number];

export interface AdminPrincipal {
  name: string;
  scopes: Set<AdminScope | '*'>;
  digest: Buffer;
}

/**
 * NORTHSTAR_ADMIN_TOKENS = "name:scope+scope:token;name2:*:token2". Only SHA-256 digests are
 * kept in memory. The single NORTHSTAR_ADMIN_TOKEN (or loopback demo token) is a '*' principal.
 */
export function parseScopedTokens(spec: string | undefined): AdminPrincipal[] {
  if (!spec?.trim()) return [];
  return spec
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, scopes, ...rest] = entry.split(':');
      const token = rest.join(':');
      if (!name || !scopes || !token || token.length < 16) {
        throw new Error(`NORTHSTAR_ADMIN_TOKENS entry "${name ?? '?'}" must be name:scopes:token (token ≥ 16 chars)`);
      }
      const set = new Set<AdminScope | '*'>();
      for (const sc of scopes.split('+')) {
        if (sc !== '*' && !(ADMIN_SCOPES as readonly string[]).includes(sc)) {
          throw new Error(`NORTHSTAR_ADMIN_TOKENS: unknown scope "${sc}" for ${name}`);
        }
        set.add(sc as AdminScope | '*');
      }
      return { name, scopes: set, digest: digest(token) };
    });
}

export type AdminDecision =
  | { ok: true; principal: string }
  | { ok: false; status: 401 | 403; error: 'admin_authorization_required' | 'insufficient_scope' };

/** Decide an admin request for `scope`. A null full token with no principals = auth disabled (tests). */
export function authorizeAdmin(
  authorization: string | string[] | undefined,
  scope: AdminScope,
  fullToken: string | null,
  principals: AdminPrincipal[],
): AdminDecision {
  if (fullToken === null && principals.length === 0) return { ok: true, principal: 'tests' };
  const h = Array.isArray(authorization) ? authorization[0] : authorization;
  const given = h?.startsWith('Bearer ') ? h.slice(7) : null;
  if (given == null) return { ok: false, status: 401, error: 'admin_authorization_required' };
  if (fullToken !== null && tokenEquals(given, fullToken)) return { ok: true, principal: 'admin' };
  const g = digest(given);
  // Compare against every principal (constant work regardless of which one matches).
  let match: AdminPrincipal | null = null;
  for (const p of principals) if (timingSafeEqual(g, p.digest) && !match) match = p;
  if (!match) return { ok: false, status: 401, error: 'admin_authorization_required' };
  if (!match.scopes.has('*') && !match.scopes.has(scope)) return { ok: false, status: 403, error: 'insufficient_scope' };
  return { ok: true, principal: match.name };
}

/** Plain-HTTP device telemetry is accepted only on loopback unless explicitly allowed. */
export function plaintextTelemetryAllowed(host: string, allowFlag: boolean): boolean {
  return allowFlag || isLoopbackHost(host);
}
