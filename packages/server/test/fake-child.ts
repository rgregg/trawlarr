import type { DaemonToAgent } from '../src/worker/protocol.js';

/**
 * The doubles the agent-handle tests share.
 *
 * They live in ONE place on purpose. Two copies of `fakeChild` drift, and
 * the property that must not drift is the dangerous one: the fake's pid is
 * `undefined` by default. A made-up pid belongs either to nothing or to
 * some unrelated real process on the machine running the suite, and a fake
 * pid handed to a real `process.kill(-pid)` is a live grenade — so the
 * default is "no pid at all", and every test that exercises a kill injects
 * `killFn` as well.
 */

/**
 * A fake child process: every message the daemon sends is recorded, and
 * every message the agent would send is delivered by `emit`.
 *
 * There is no real process and therefore no timing anywhere — a lifecycle
 * test that waits for a race to happen passes against broken code most of
 * the time, so every interleaving is forced by hand.
 */
export const fakeChild = (
  pid: number | undefined = undefined,
): {
  pid: number | undefined;
  connected: boolean;
  send: (message: DaemonToAgent) => boolean;
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  kill: () => boolean;
  emit: (event: string, ...args: unknown[]) => void;
  sent: DaemonToAgent[];
} => {
  const toAgent: DaemonToAgent[] = [];
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    pid,
    connected: true,
    send: (message: DaemonToAgent) => {
      toAgent.push(message);
      return true;
    },
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(fn);
    },
    kill: () => true,
    emit: (event: string, ...args: unknown[]) => {
      listeners[event]?.forEach((fn) => {
        fn(...args);
      });
    },
    sent: toAgent,
  };
};

export type FakeChild = ReturnType<typeof fakeChild>;

/**
 * A clock that only moves when a test moves it.
 *
 * `setTimer` records a callback against a due time; `advance(ms)` runs
 * every callback that has come due, in due order, INCLUDING ones armed by a
 * callback that just ran (which is exactly the SIGTERM-then-SIGKILL
 * escalation). Nothing here waits: a test that really slept for a 30 second
 * grace period is a test nobody runs.
 */
export const fakeTimers = (): {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  pending: Map<number, { fn: () => void; ms: number; dueAt: number }>;
  advance: (ms: number) => void;
  now: () => number;
} => {
  const pending = new Map<number, { fn: () => void; ms: number; dueAt: number }>();
  let next = 0;
  let now = 0;

  const dueBy = (target: number): [number, { fn: () => void; dueAt: number }] | null => {
    let earliest: [number, { fn: () => void; ms: number; dueAt: number }] | null = null;
    for (const entry of pending) {
      if (entry[1].dueAt > target) continue;
      if (earliest === null || entry[1].dueAt < earliest[1].dueAt) earliest = entry;
    }
    return earliest;
  };

  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      next += 1;
      pending.set(next, { fn, ms, dueAt: now + ms });
      return next;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    pending,
    advance: (ms: number): void => {
      const target = now + ms;
      for (;;) {
        const due = dueBy(target);
        if (due === null) break;
        pending.delete(due[0]);
        now = due[1].dueAt;
        due[1].fn();
      }
      now = target;
    },
    now: () => now,
  };
};

export type FakeTimers = ReturnType<typeof fakeTimers>;
