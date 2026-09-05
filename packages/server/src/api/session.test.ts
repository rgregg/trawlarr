import { describe, expect, it } from 'vitest';
import {
  issueSessionToken,
  parseCookies,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  verifySessionToken,
} from './session.js';

const NOW = Date.now();

describe('issueSessionToken/verifySessionToken', () => {
  it('round-trips the account id', async () => {
    const token = await issueSessionToken({ accountId: 'acc-1', secret: 'top-secret', nowMs: NOW });
    expect(await verifySessionToken({ token, secret: 'top-secret' })).toBe('acc-1');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await issueSessionToken({ accountId: 'acc-1', secret: 'secret-a', nowMs: NOW });
    expect(await verifySessionToken({ token, secret: 'secret-b' })).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await issueSessionToken({
      accountId: 'acc-1',
      secret: 'top-secret',
      nowMs: NOW,
      ttlMs: 1000,
    });
    // jose checks `exp` against the real clock, not an injected one, so an
    // already-past expiry (negative ttl) is what proves the check runs.
    const expired = await issueSessionToken({
      accountId: 'acc-1',
      secret: 'top-secret',
      nowMs: NOW,
      ttlMs: -1000,
    });
    expect(await verifySessionToken({ token: expired, secret: 'top-secret' })).toBeNull();
    expect(await verifySessionToken({ token, secret: 'top-secret' })).toBe('acc-1');
  });

  it('rejects garbage', async () => {
    expect(await verifySessionToken({ token: 'not-a-jwt', secret: 'top-secret' })).toBeNull();
  });
});

describe('parseCookies', () => {
  it('parses a header with multiple cookies', () => {
    expect(parseCookies('a=1; b=2; c=three')).toEqual({ a: '1', b: '2', c: 'three' });
  });

  it('returns empty for an undefined header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('decodes percent-encoded values', () => {
    expect(parseCookies('trawlarr_session=abc%3Ddef')).toEqual({ trawlarr_session: 'abc=def' });
  });
});

describe('serializeSessionCookie/serializeClearedSessionCookie', () => {
  it('includes HttpOnly and SameSite=Strict always', () => {
    const value = serializeSessionCookie({ token: 'tok', secure: false });
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Strict');
    expect(value).not.toContain('Secure');
  });

  it('adds Secure only when the connection is secure', () => {
    const value = serializeSessionCookie({ token: 'tok', secure: true });
    expect(value).toContain('Secure');
  });

  it('clears with Max-Age=0', () => {
    expect(serializeClearedSessionCookie({ secure: false })).toContain('Max-Age=0');
  });
});
