/**
 * A remote claim's lease (spec: remote nodes, "Leases").
 *
 * The whole point is one guarantee: a file is never written by two workers.
 * A remote node can go quiet for reasons that say nothing about its encode
 * (a Wi-Fi blip, the daemon restarting), so silence alone must not release
 * the file for ever — but it must release it eventually, and once released,
 * the original node must be unable to install. Expiry releases; `decideCommit`
 * is what makes the original node unable to install afterwards.
 */
export type LeaseState = 'connected' | 'grace' | 'committing' | 'expired';

export interface Lease {
  state: LeaseState;
  expiresAtMs: number | null;
}

export const leaseOnClaim = (): Lease => ({ state: 'connected', expiresAtMs: null });

export const leaseOnDisconnect = (lease: Lease, nowMs: number, graceMs: number): Lease =>
  lease.state === 'connected' ? { state: 'grace', expiresAtMs: nowMs + graceMs } : lease;

/**
 * A daemon that was down has no idea how long its nodes have been
 * disconnected, and a lease that ran out while nobody was counting must not
 * expire the instant the daemon returns — that would release every remote
 * encode on every restart. So the clock restarts from startup.
 */
export const leaseOnDaemonStart = (lease: Lease, nowMs: number, graceMs: number): Lease =>
  lease.state === 'connected' || lease.state === 'grace'
    ? { state: 'grace', expiresAtMs: nowMs + graceMs }
    : lease;

export const leaseIsExpired = (lease: Lease, nowMs: number): boolean =>
  lease.state === 'grace' && lease.expiresAtMs !== null && nowMs >= lease.expiresAtMs;

export const leaseOnReconnect = (lease: Lease, nowMs: number): Lease => {
  if (lease.state === 'expired' || leaseIsExpired(lease, nowMs)) {
    return { state: 'expired', expiresAtMs: lease.expiresAtMs };
  }
  if (lease.state === 'grace') return { state: 'connected', expiresAtMs: null };
  return lease;
};

export const leaseAfterStep = (lease: Lease): Lease =>
  lease.state === 'committing' ? { state: 'connected', expiresAtMs: null } : lease;

export const decideCommit = (input: {
  lease: Lease;
  nowMs: number;
  stillClaimed: boolean;
  kind: 'replace' | 'plugin';
}): { granted: true; lease: Lease } | { granted: false; reason: string } => {
  if (!input.stillClaimed) {
    return {
      granted: false,
      reason: 'This file is no longer claimed by this job; another worker may own it.',
    };
  }
  const { lease } = input;
  if (lease.state !== 'connected' && lease.state !== 'committing') {
    return {
      granted: false,
      reason: `The job's lease is ${lease.state}; a commit needs a live connection.`,
    };
  }
  if (input.kind === 'replace')
    return { granted: true, lease: { state: 'committing', expiresAtMs: null } };
  return { granted: true, lease };
};
