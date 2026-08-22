import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DocumentPort, StepRecord } from '@trawlarr/engine';
import type { JobPayload } from './job-payload.js';
import type { JobReport } from './run-payload.js';
import {
  AGENT_MODULE_URL,
  AgentFailure,
  createAgentHandle,
  type AgentHandleDeps,
} from './agent-handle.js';
import { fakeChild, fakeTimers, type FakeChild, type FakeTimers } from '../../test/fake-child.js';

const FIXED = 1_700_000_000_000;

/**
 * A payload and a report built by hand.
 *
 * Nothing here runs a flow — the handle is a message pump and a lifecycle,
 * so the only property of these two values that matters is that they
 * survive being carried across the boundary unchanged.
 */
const payload = {
  jobId: 'job-1',
  fileId: 'file-1',
  path: '/lib/movie.mkv',
} as unknown as JobPayload;

const report = {
  jobId: 'job-1',
  fileId: 'file-1',
  steps: [],
  stopReason: 'end-of-flow',
  failed: false,
  error: null,
  success: true,
  outcome: 'Flow finished: end-of-flow.',
  replaced: null,
  preFacts: {},
  postFacts: null,
  cancelled: false,
} as unknown as JobReport;

const step = (seq: number): StepRecord => ({
  seq,
  nodeId: 'n1',
  pluginId: 'p1',
  pluginName: 'P1',
  outputNumber: 1,
  outputOutcome: null,
  durationMs: 1,
  logExcerpt: '',
  error: null,
});

const nullDocuments = (): DocumentPort => ({
  get: () => undefined,
  insert: () => {},
  update: () => {},
  removeOne: () => {},
});

const depsFor = (
  child: FakeChild,
  over: Partial<AgentHandleDeps> = {},
  timers: FakeTimers = fakeTimers(),
): AgentHandleDeps & { id: string } => ({
  id: 'w1',
  documents: nullDocuments(),
  onStep: () => {},
  onHeartbeat: () => {},
  onProgress: () => {},
  onLog: () => {},
  nowMs: () => FIXED,
  forkFn: () => child as never,
  killFn: () => {},
  setTimer: timers.setTimer,
  clearTimer: timers.clearTimer,
  ...over,
});

/** The AgentFailure a run rejected with, or a failure of this test if it did not. */
const failureOf = async (promise: Promise<unknown>): Promise<AgentFailure> => {
  try {
    await promise;
  } catch (error) {
    return error as AgentFailure;
  }
  throw new Error('expected the run to reject with an AgentFailure');
};

/** Whether a promise has settled yet, without waiting on a clock. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  const pending = Symbol('pending');
  const winner = await Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    Promise.resolve(pending),
  ]);
  return winner !== pending;
};

describe('createAgentHandle', () => {
  it('forks the agent module and exposes the child pid', () => {
    const child = fakeChild(4242);
    const forked: string[] = [];
    const handle = createAgentHandle(
      depsFor(child, {
        forkFn: (modulePath: string) => {
          forked.push(modulePath);
          return child as never;
        },
      }),
    );

    expect(forked).toEqual([fileURLToPath(AGENT_MODULE_URL)]);
    expect(forked[0]!.endsWith('/worker/agent.js')).toBe(true);
    expect(handle.pid).toBe(4242);
  });

  it('sends the payload once the agent says it is ready, and resolves with the report', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const running = handle.run(payload);
    expect(child.sent).toEqual([]); // nothing before 'ready'
    child.emit('message', { type: 'ready', pid: 4242 });
    expect(child.sent).toEqual([{ type: 'job', payload }]);

    child.emit('message', { type: 'done', report });
    await expect(running).resolves.toEqual(report);
  });

  it('answers a doc-request from the daemon-side DocumentPort and replies with the SAME id', async () => {
    const child = fakeChild();
    const documents: DocumentPort = {
      get: () => ({ processed: true }),
      insert() {},
      update() {},
      removeOne() {},
    };
    const handle = createAgentHandle(depsFor(child, { documents }));

    void handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', {
      type: 'doc-request',
      id: 7,
      method: 'get',
      collection: 'F2FOutputJSONDB',
      docId: '/a.mkv',
    });
    await Promise.resolve(); // let the port's promise settle

    expect(child.sent.at(-1)).toEqual({
      type: 'doc-result',
      id: 7,
      ok: true,
      value: { processed: true },
    });
  });

  it('answers an ASYNC DocumentPort, which is what a real sqlite-backed store may be', async () => {
    const child = fakeChild();
    const documents: DocumentPort = {
      get: () => Promise.resolve({ processed: true }),
      insert: () => Promise.resolve(),
      update: () => Promise.resolve(),
      removeOne: () => Promise.resolve(),
    };
    const handle = createAgentHandle(depsFor(child, { documents }));

    void handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', {
      type: 'doc-request',
      id: 9,
      method: 'get',
      collection: 'c',
      docId: 'd',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(child.sent.at(-1)).toEqual({
      type: 'doc-result',
      id: 9,
      ok: true,
      value: { processed: true },
    });
  });

  it('passes the write methods through with their data and clock', async () => {
    const child = fakeChild();
    const calls: unknown[][] = [];
    const documents: DocumentPort = {
      get: () => undefined,
      insert: (...args) => {
        calls.push(['insert', ...args]);
      },
      update: (...args) => {
        calls.push(['update', ...args]);
      },
      removeOne: (...args) => {
        calls.push(['removeOne', ...args]);
      },
    };
    const handle = createAgentHandle(depsFor(child, { documents }));

    void handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', {
      type: 'doc-request',
      id: 1,
      method: 'insert',
      collection: 'c',
      docId: 'd',
      data: { a: 1 },
      nowMs: 5,
    });
    child.emit('message', {
      type: 'doc-request',
      id: 2,
      method: 'update',
      collection: 'c',
      docId: 'd',
      data: { a: 2 },
      nowMs: 6,
    });
    child.emit('message', {
      type: 'doc-request',
      id: 3,
      method: 'removeOne',
      collection: 'c',
      docId: 'd',
    });
    await Promise.resolve();

    expect(calls).toEqual([
      ['insert', 'c', 'd', { a: 1 }, 5],
      ['update', 'c', 'd', { a: 2 }, 6],
      ['removeOne', 'c', 'd'],
    ]);
    expect(child.sent.filter((message) => message.type === 'doc-result')).toHaveLength(3);
  });

  it('reports a DocumentPort failure to the agent rather than hanging it forever', async () => {
    const child = fakeChild();
    const documents: DocumentPort = {
      get: () => {
        throw new Error('disk gone');
      },
      insert() {},
      update() {},
      removeOne() {},
    };
    const handle = createAgentHandle(depsFor(child, { documents }));

    void handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', {
      type: 'doc-request',
      id: 7,
      method: 'get',
      collection: 'c',
      docId: 'd',
    });
    await Promise.resolve();

    expect(child.sent.at(-1)).toMatchObject({ type: 'doc-result', id: 7, ok: false });
  });

  it('reports a REJECTED DocumentPort promise too, with the same id', async () => {
    const child = fakeChild();
    const documents: DocumentPort = {
      get: () => Promise.reject(new Error('disk gone')),
      insert() {},
      update() {},
      removeOne() {},
    };
    const handle = createAgentHandle(depsFor(child, { documents }));

    void handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', {
      type: 'doc-request',
      id: 8,
      method: 'get',
      collection: 'c',
      docId: 'd',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(child.sent.at(-1)).toMatchObject({ type: 'doc-result', id: 8, ok: false });
  });

  it('answers a malformed doc-request with an error rather than dropping it', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    void handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    // `insert` without `data`/`nowMs`: unanswerable, but a silent drop is a
    // worker blocked until the stall reaper notices half an hour later.
    child.emit('message', {
      type: 'doc-request',
      id: 4,
      method: 'insert',
      collection: 'c',
      docId: 'd',
    });
    await Promise.resolve();

    expect(child.sent.at(-1)).toMatchObject({ type: 'doc-result', id: 4, ok: false });
  });

  it('never writes to a child that has already disconnected', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    const before = child.sent.length;
    child.connected = false;
    child.emit('message', {
      type: 'doc-request',
      id: 5,
      method: 'get',
      collection: 'c',
      docId: 'd',
    });
    await Promise.resolve();

    expect(child.sent).toHaveLength(before);
    child.die(0, null);
    await expect(running).rejects.toBeInstanceOf(AgentFailure);
  });

  it('rejects with AgentFailure when the child exits before reporting', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.die(1, null);

    await expect(running).rejects.toBeInstanceOf(AgentFailure);
    const failure = await failureOf(running);
    // The distinction the daemon acts on: the child VANISHED, it did not
    // report. Both end in a stalled attempt, but only one of them has a
    // plugin-authored reason to record.
    expect(failure.reported).toBe(false);
    expect(failure.cancelled).toBe(false);
    expect(failure.exitCode).toBe(1);
  });

  /**
   * An exit is not evidence that nothing was reported.
   *
   * `'exit'` and the IPC channel are different handles, and the event loop
   * may service them in either order: the agent waits for `process.send`'s
   * completion callback before leaving, so its report is WRITTEN, but into a
   * pipe the daemon has not necessarily read. Settling on the exit alone
   * discards the report of a run that fully succeeded — and since that run
   * has already replaced the file on disk, the row is then backed off
   * holding the pre-transcode identity, which is what lets the next scan
   * open a second row for it (see `test/report-lost-at-exit.test.ts` for
   * that consequence, driven end to end with a real fork).
   *
   * The interleaving is forced rather than raced: `die()` would model an
   * exit whose channel closed with it, which is the SAFE order and the one
   * that passes against the defect.
   */
  it('honours a report that was still in the channel when the exit was observed', async () => {
    const child = fakeChild();
    const timers = fakeTimers();
    const handle = createAgentHandle(depsFor(child, {}, timers));

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });

    child.emit('exit', 0, null);
    // Nothing has yet said the channel is empty, so nothing may conclude the
    // child reported nothing.
    expect(await settled(running)).toBe(false);

    child.emit('message', { type: 'done', report });
    child.emit('disconnect');

    await expect(running).resolves.toBe(report);
    // The drain deadline is disarmed by the settle: a finished worker must
    // not leave a live handle behind on every job the daemon runs.
    expect(timers.pending.size).toBe(0);
  });

  it('stops waiting for a channel that never closes, rather than stranding the worker', async () => {
    const child = fakeChild();
    const timers = fakeTimers();
    const handle = createAgentHandle(depsFor(child, {}, timers));

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('exit', 0, null);
    expect(await settled(running)).toBe(false);

    // A descriptor a grandchild inherited can hold the write end open after
    // the worker itself is gone. The deadline is a hang detector, not an
    // expectation about speed: the run still ends, as an unreported one.
    timers.advance(30_000);
    const failure = await failureOf(running);
    expect(failure.reported).toBe(false);
    expect(failure.exitCode).toBe(0);
  });

  it('rejects with a REPORTED AgentFailure when the agent says it failed', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', { type: 'failed', error: 'ffmpeg exited 1' });

    const failure = await failureOf(running);
    expect(failure).toBeInstanceOf(AgentFailure);
    expect(failure.reported).toBe(true);
    expect(failure.message).toContain('ffmpeg exited 1');
  });

  it('rejects a run whose child was never even reachable', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const running = handle.run(payload);
    child.emit('error', new Error('spawn EACCES'));

    const failure = await failureOf(running);
    expect(failure).toBeInstanceOf(AgentFailure);
    expect(failure.reported).toBe(false);
  });

  it('forwards steps, heartbeats, progress and logs to the daemon-side callbacks in order', async () => {
    const child = fakeChild();
    const seen: string[] = [];
    const steps: StepRecord[] = [];
    const handle = createAgentHandle(
      depsFor(child, {
        onStep: (value) => {
          seen.push('step');
          steps.push(value);
        },
        onHeartbeat: () => seen.push('heartbeat'),
        onProgress: () => seen.push('progress'),
        onLog: () => seen.push('log'),
      }),
    );

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', { type: 'step', step: step(1) });
    child.emit('message', { type: 'heartbeat', nowMs: FIXED });
    child.emit('message', { type: 'progress', percent: 12, stage: 'execute' });
    child.emit('message', { type: 'log', text: 'hello' });
    child.emit('message', { type: 'done', report });

    await expect(running).resolves.toEqual(report);
    expect(seen).toEqual(['step', 'heartbeat', 'progress', 'log']);
    expect(steps).toEqual([step(1)]);
  });

  it('completes a run in which no progress message ever arrives', async () => {
    // Progress is liveness, never correctness: a dropped progress message
    // must not be able to change what the daemon records.
    const child = fakeChild();
    const progress: unknown[] = [];
    const handle = createAgentHandle(
      depsFor(child, { onProgress: (value) => progress.push(value) }),
    );

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', { type: 'done', report });

    await expect(running).resolves.toEqual(report);
    expect(progress).toEqual([]);
  });

  it('ignores a message that is not part of the protocol', async () => {
    const child = fakeChild();
    const seen: string[] = [];
    const handle = createAgentHandle(
      depsFor(child, {
        onStep: () => seen.push('step'),
        onProgress: () => seen.push('progress'),
      }),
    );

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    // Third-party plugin code shares this channel: anything can arrive on it.
    child.emit('message', 'not an object');
    child.emit('message', { type: 'step' });
    child.emit('message', { type: 'nonsense', report });
    child.emit('message', null);

    expect(seen).toEqual([]);
    expect(await settled(running)).toBe(false);

    child.emit('message', { type: 'done', report });
    await expect(running).resolves.toEqual(report);
  });

  it('settles exactly once when done and exit arrive together', async () => {
    // Forced interleaving: the ordinary end of a run is a `done` message
    // followed immediately by the child exiting. If `exit` could reject a
    // promise `done` already resolved, this ordering is where it happens.
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', { type: 'done', report });
    child.die(0, null);

    await expect(running).resolves.toEqual(report);
    await expect(handle.exited).resolves.toBe(0);
  });

  it('keeps a run rejected when a done message arrives after the child is gone', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    child.die(null, 'SIGKILL');
    child.emit('message', { type: 'done', report });

    await expect(running).rejects.toBeInstanceOf(AgentFailure);
  });

  it('rejects a run started after the child has already gone', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    child.die(0, null);
    await expect(handle.run(payload)).rejects.toBeInstanceOf(AgentFailure);
  });

  it('refuses a second run on the same handle', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const first = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    await expect(handle.run(payload)).rejects.toBeInstanceOf(AgentFailure);

    child.emit('message', { type: 'done', report });
    await expect(first).resolves.toEqual(report);
  });

  it('cancel asks the agent to stop and arms the grace timer', () => {
    const child = fakeChild();
    const timers = fakeTimers();
    const handle = createAgentHandle(depsFor(child, { cancelGraceMs: 1234 }, timers));

    void handle.run(payload).catch(() => {});
    child.emit('message', { type: 'ready', pid: 4242 });
    handle.cancel();

    expect(child.sent.at(-1)).toEqual({ type: 'cancel' });
    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([1234]);
  });

  it('kills the whole process GROUP when a cancelled agent does not exit in time', async () => {
    const child = fakeChild();
    const timers = fakeTimers();
    const signalled: [number, NodeJS.Signals][] = [];
    const handle = createAgentHandle(
      depsFor(child, { killFn: (pid, signal) => signalled.push([pid, signal]) }, timers),
    );

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    handle.cancel();
    timers.advance(30_000);
    timers.advance(5_000);

    // Negative pid: the whole group led by the detached child, ffmpeg
    // included — not just the node process we forked. The ladder itself is
    // pinned in `cancel.test.ts`.
    expect(signalled).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);

    child.die(null, 'SIGKILL');
    const failure = await failureOf(running);
    expect(failure.cancelled).toBe(true);
    expect(failure.reported).toBe(false);
  });

  it('disarms the grace timer when the cancelled agent exits on its own, sweeping the group once', () => {
    const child = fakeChild();
    const timers = fakeTimers();
    const signalled: [number, NodeJS.Signals][] = [];
    const handle = createAgentHandle(
      depsFor(child, { killFn: (pid, signal) => signalled.push([pid, signal]) }, timers),
    );

    void handle.run(payload).catch(() => {});
    child.emit('message', { type: 'ready', pid: 4242 });
    handle.cancel();
    child.die(0, null);
    timers.advance(600_000);

    // No TIMER survives the exit — nothing is signalled minutes later, at a
    // pid the kernel may have handed to someone else. The one SIGKILL that
    // does go out is synchronous with the exit, and it is there because a
    // process group outlives its leader: see `cancel.test.ts`.
    expect(timers.pending.size).toBe(0);
    expect(signalled).toEqual([[-4242, 'SIGKILL']]);
  });

  it('never sends a job to an agent cancelled before it became ready', async () => {
    const child = fakeChild();
    const handle = createAgentHandle(depsFor(child));

    const running = handle.run(payload);
    handle.cancel();
    child.emit('message', { type: 'ready', pid: 4242 });

    expect(child.sent.filter((message) => message.type === 'job')).toEqual([]);
    child.die(0, null);
    const failure = await failureOf(running);
    expect(failure.cancelled).toBe(true);
  });

  it('kill() takes the group down immediately', () => {
    const child = fakeChild();
    const signalled: [number, NodeJS.Signals][] = [];
    const handle = createAgentHandle(
      depsFor(child, { killFn: (pid, signal) => signalled.push([pid, signal]) }),
    );

    void handle.run(payload).catch(() => {});
    child.emit('message', { type: 'ready', pid: 4242 });
    handle.kill();

    expect(signalled).toEqual([[-4242, 'SIGKILL']]);
  });

  it('resolves `exited` with the code, and with null for a signalled child', async () => {
    const one = fakeChild();
    const first = createAgentHandle(depsFor(one));
    one.die(3, null);
    await expect(first.exited).resolves.toBe(3);

    const two = fakeChild();
    const second = createAgentHandle(depsFor(two));
    two.die(null, 'SIGKILL');
    await expect(second.exited).resolves.toBeNull();
  });
});

/**
 * The agent process is the enforcement of "workers never touch the
 * database": it may not be able to reach a repository even by accident,
 * because a forked worker holds no connection and must never open one.
 */
describe('the agent process reaches no database', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  const valueImportsOf = (file: string): string[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('import type'))
      .flatMap((line) => [...line.matchAll(/from '([^']+)'/g)].map((match) => match[1]!));

  const runtimeClosure = (entry: string): { files: string[]; bare: string[] } => {
    const files: string[] = [];
    const bare: string[] = [];
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (files.includes(file)) continue;
      files.push(file);
      for (const specifier of valueImportsOf(file)) {
        if (!specifier.startsWith('.')) {
          if (!bare.includes(specifier)) bare.push(specifier);
          continue;
        }
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      }
    }
    return { files, bare };
  };

  it('imports no repository, no connection and no sqlite driver at runtime', () => {
    const { files, bare } = runtimeClosure(join(here, 'agent.ts'));
    const local = files.map((file) => relative(join(here, '..'), file));

    // Sanity: the walk really walked — the agent's whole job is `runPayload`.
    expect(local).toContain('worker/run-payload.ts');
    expect(local).toContain('probe/ffprobe.ts');

    expect(local.filter((file) => file.startsWith('db/'))).toEqual([]);
    expect(bare).not.toContain('better-sqlite3');
    expect(bare.filter((name) => name.includes('sqlite'))).toEqual([]);
  });

  it('is a claim that can fail: the same walk over agent-handle.ts is the DAEMON side', () => {
    // The handle holds the DocumentPort the agent talks to, so it lives on
    // the side of the boundary that may hold a database — proving the walk
    // distinguishes the two rather than resolving nothing.
    const { files } = runtimeClosure(join(here, 'run-job.ts'));
    const local = files.map((file) => relative(join(here, '..'), file));
    expect(local.filter((file) => file.startsWith('db/')).length).toBeGreaterThan(1);
  });
});
