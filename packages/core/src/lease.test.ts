import { describe, expect, it } from 'vitest';
import {
  decideCommit,
  leaseAfterStep,
  leaseIsExpired,
  leaseOnClaim,
  leaseOnDaemonStart,
  leaseOnDisconnect,
  leaseOnReconnect,
} from './lease.js';

const HOUR = 3_600_000;

describe('lease', () => {
  it('starts connected with no expiry', () => {
    expect(leaseOnClaim()).toEqual({ state: 'connected', expiresAtMs: null });
  });

  it('a disconnect starts the grace clock', () => {
    expect(leaseOnDisconnect(leaseOnClaim(), 1000, HOUR)).toEqual({
      state: 'grace',
      expiresAtMs: 1000 + HOUR,
    });
  });

  it('a disconnect while committing does NOT start a clock', () => {
    // The node may be mid-rename. Expiring now would release a file whose
    // replacement is landing; only the 24 h reaper floor may act on it.
    const committing = { state: 'committing' as const, expiresAtMs: null };
    expect(leaseOnDisconnect(committing, 1000, HOUR)).toEqual(committing);
  });

  it('expires only in grace and only once the deadline has passed', () => {
    const grace = leaseOnDisconnect(leaseOnClaim(), 0, HOUR);
    expect(leaseIsExpired(grace, HOUR - 1)).toBe(false);
    expect(leaseIsExpired(grace, HOUR)).toBe(true);
    expect(leaseIsExpired(leaseOnClaim(), 10 * HOUR)).toBe(false);
    expect(leaseIsExpired({ state: 'committing', expiresAtMs: null }, 10 * HOUR)).toBe(false);
  });

  it('reconnecting inside grace restores connected; after expiry it stays expired', () => {
    const grace = leaseOnDisconnect(leaseOnClaim(), 0, HOUR);
    expect(leaseOnReconnect(grace, HOUR - 1)).toEqual({ state: 'connected', expiresAtMs: null });
    expect(leaseOnReconnect(grace, HOUR).state).toBe('expired');
    expect(leaseOnReconnect({ state: 'expired', expiresAtMs: 5 }, 0).state).toBe('expired');
  });

  it('daemon start gives every non-committing lease a fresh grace window from startup', () => {
    expect(leaseOnDaemonStart(leaseOnClaim(), 50, HOUR)).toEqual({
      state: 'grace',
      expiresAtMs: 50 + HOUR,
    });
    const oldGrace = { state: 'grace' as const, expiresAtMs: 1 };
    expect(leaseOnDaemonStart(oldGrace, 50, HOUR).expiresAtMs).toBe(50 + HOUR);
  });

  it('leaseAfterStep returns committing to connected and leaves others alone', () => {
    expect(leaseAfterStep({ state: 'committing', expiresAtMs: null }).state).toBe('connected');
    expect(leaseAfterStep({ state: 'grace', expiresAtMs: 9 }).state).toBe('grace');
  });
});

describe('decideCommit', () => {
  const connected = leaseOnClaim();

  it('grants a replace on a connected, still-claimed job and moves to committing', () => {
    expect(
      decideCommit({ lease: connected, nowMs: 0, stillClaimed: true, kind: 'replace' }),
    ).toEqual({
      granted: true,
      lease: { state: 'committing', expiresAtMs: null },
    });
  });

  it('grants a plugin commit without entering committing', () => {
    expect(
      decideCommit({ lease: connected, nowMs: 0, stillClaimed: true, kind: 'plugin' }),
    ).toEqual({
      granted: true,
      lease: connected,
    });
  });

  it('refuses when the file is no longer claimed by this job', () => {
    const decision = decideCommit({
      lease: connected,
      nowMs: 0,
      stillClaimed: false,
      kind: 'replace',
    });
    expect(decision.granted).toBe(false);
  });

  it('refuses in grace and expired — a commit needs a live connection', () => {
    for (const lease of [
      { state: 'grace' as const, expiresAtMs: 100 },
      { state: 'expired' as const, expiresAtMs: 100 },
    ]) {
      expect(decideCommit({ lease, nowMs: 0, stillClaimed: true, kind: 'replace' }).granted).toBe(
        false,
      );
    }
  });
});
