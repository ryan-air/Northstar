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
