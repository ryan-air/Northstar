import { describe, expect, it } from 'vitest';
import {
  DEMO_ADMIN_TOKEN,
  bearerOk,
  isAdminRequest,
  isLoopbackHost,
  resolveAdminToken,
  tokenEquals,
  wsTokenOk,
} from './adminAuth.js';

describe('admin token resolution', () => {
  it('recognises loopback hosts', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('demo token only on loopback', () => {
    expect(resolveAdminToken({ testMode: false, host: '127.0.0.1' }).source).toBe('demo');
    expect(() => resolveAdminToken({ testMode: false, host: '0.0.0.0' })).toThrow(/not loopback/);
    expect(resolveAdminToken({ testMode: false, host: '0.0.0.0', allowDemo: true }).token).toBe(DEMO_ADMIN_TOKEN);
  });

  it('rejects the demo token set explicitly on a public bind', () => {
    expect(() => resolveAdminToken({ envToken: DEMO_ADMIN_TOKEN, testMode: false, host: '0.0.0.0' })).toThrow();
    expect(resolveAdminToken({ envToken: 's3cret-long', testMode: false, host: '0.0.0.0' }).source).toBe('env');
  });

  it('test mode disables admin auth but never grants admin', () => {
    const c = resolveAdminToken({ testMode: true, host: '0.0.0.0' });
    expect(c.token).toBeNull();
    expect(bearerOk(undefined, null)).toBe(true);
    expect(isAdminRequest('Bearer x', null)).toBe(false);
  });
});

describe('token comparison', () => {
  it('bearer header', () => {
    expect(bearerOk('Bearer abc', 'abc')).toBe(true);
    expect(bearerOk('Bearer abcd', 'abc')).toBe(false);
    expect(bearerOk('abc', 'abc')).toBe(false);
    expect(bearerOk(undefined, 'abc')).toBe(false);
    expect(tokenEquals('', 'abc')).toBe(false);
  });

  it('ws token via query or header, open when unset', () => {
    expect(wsTokenOk({}, undefined, null)).toBe(true);
    expect(wsTokenOk({ token: 't1' }, undefined, 't1')).toBe(true);
    expect(wsTokenOk({}, 'Bearer t1', 't1')).toBe(true);
    expect(wsTokenOk({ token: 'nope' }, undefined, 't1')).toBe(false);
    expect(wsTokenOk({ token: ['t1'] }, undefined, 't1')).toBe(false);
  });
});

import { authorizeAdmin, parseScopedTokens, plaintextTelemetryAllowed } from './adminAuth.js';
import { EnrolTokenStore } from './enrolTokens.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('scoped admin credentials', () => {
  const ps = parseScopedTokens('ops:scenario+rf:ops-token-1234567890;sec:*:sec-token-1234567890');
  it('grants only the listed scopes', () => {
    expect(authorizeAdmin('Bearer ops-token-1234567890', 'scenario', 'full', ps)).toEqual({ ok: true, principal: 'ops' });
    expect(authorizeAdmin('Bearer ops-token-1234567890', 'audit', 'full', ps)).toMatchObject({ ok: false, status: 403 });
    expect(authorizeAdmin('Bearer sec-token-1234567890', 'audit', 'full', ps)).toMatchObject({ ok: true, principal: 'sec' });
    expect(authorizeAdmin('Bearer full', 'devices', 'full', ps)).toMatchObject({ ok: true, principal: 'admin' });
    expect(authorizeAdmin('Bearer nope', 'rf', 'full', ps)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeAdmin(undefined, 'rf', 'full', ps)).toMatchObject({ ok: false, status: 401 });
  });
  it('rejects malformed specs, short tokens and unknown scopes', () => {
    expect(() => parseScopedTokens('x:rf:short')).toThrow();
    expect(() => parseScopedTokens('x:root:long-enough-token-123')).toThrow(/unknown scope/);
  });
  it('plain-HTTP telemetry only on loopback unless allowed', () => {
    expect(plaintextTelemetryAllowed('127.0.0.1', false)).toBe(true);
    expect(plaintextTelemetryAllowed('0.0.0.0', false)).toBe(false);
    expect(plaintextTelemetryAllowed('0.0.0.0', true)).toBe(true);
  });
});

describe('one-time per-vessel enrolment tokens', () => {
  it('binds to one vessel, is single-use, expires, and stores only a hash', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'et-')), 'enrol_tokens.json');
    const s = new EnrolTokenStore(path);
    const now = new Date('2030-01-01T00:00:00Z');
    const { token } = s.issue('LAB-1', 600, 'sec', now);
    expect(readFileSync(path, 'utf8')).not.toContain(token);
    expect(s.consume(token, 'LAB-2', now)).toBe(false);
    expect(s.consume(token, 'LAB-1', now)).toBe(true);
    expect(s.consume(token, 'LAB-1', now)).toBe(false);
    const late = s.issue('LAB-1', 60, 'sec', now).token;
    expect(new EnrolTokenStore(path).consume(late, 'LAB-1', new Date(now.getTime() + 120_000))).toBe(false);
  });
});
