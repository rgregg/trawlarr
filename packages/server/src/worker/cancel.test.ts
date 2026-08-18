import { beforeEach, describe, expect, it } from 'vitest';
import { buildIdentityCandidate, extractFacts, type FlowDefinition } from '@trawlarr/core';
import type { DocumentPort } from '@trawlarr/engine';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { buildJobPayload, type JobPayload } from './job-payload.js';
import type { JobReport } from './run-payload.js';
import { AgentFailure, createAgentHandle, type AgentHandleDeps } from './agent-handle.js';
import { applyJobCancelled, applyJobFailure } from './apply-report.js';
import { fakeChild, fakeTimers, type FakeChild, type FakeTimers } from '../../test/fake-child.js';

/**
 * Cancelling a job, end to end on the daemon side: what is asked of the
 * worker, what is signalled and when, and what the file's row looks like
 * afterwards.
 *
 * EVERY test here injects `killFn`. A fake child's pid belongs either to
 * nothing or to some unrelated real process on the machine running this
 * suite, so a fake pid plus a real `process.kill(-pid)` is a live grenade —
 * which is also why `fakeChild()` has no pid at all unless a test gives it
 * one. The real signal is exercised against real pids we created ourselves,
 * in `test/agent-process.test.ts`.
 */

const NOW = 1_700_000_000_000;

const payload = {
  jobId: 'job-1',
  fileId: 'file-1',
  path: '/lib/movie.mkv',
} as unknown as JobPayload;

const report = {
  jobId: 'job-1',
  fileId: 'file-1',
  steps: [],
  stopReason: 'cancelled',
  failed: false,
  error: null,
  success: false,
  outcome: 'Flow finished: cancelled.',
  replaced: null,
  preFacts: {},
  postFacts: null,
  cancelled: true,
} as unknown as JobReport;

const nullDocuments = (): DocumentPort => ({
  get: () => undefined,
  insert: () => {},
  update: () => {},
  removeOne: () => {},
});

const handleFor = (
  child: FakeChild,
  kills: { pid: number; signal: NodeJS.Signals }[],
  timers: FakeTimers,
  over: Partial<AgentHandleDeps> = {},
) =>
  createAgentHandle({
    id: 'w1',
    documents: nullDocuments(),
    onStep: () => {},
    onHeartbeat: () => {},
    onProgress: () => {},
    onLog: () => {},
    nowMs: () => NOW,
    forkFn: () => child as never,
    killFn: (pid, signal) => kills.push({ pid, signal }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...over,
  });

describe('cancelling a running worker', () => {
  it('asks the agent to stop before it reaches for a signal', async () => {
    const child = fakeChild();
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const timers = fakeTimers();
    const handle = handleFor(child, kills, timers);

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    handle.cancel();

    // Rung one of the ladder, and nothing else: a worker that is about to
    // stop on request must not be shot for it.
    expect(child.sent.at(-1)).toEqual({ type: 'cancel' });
    expect(kills).toEqual([]);

    child.emit('message', { type: 'done', report });
    await expect(running).resolves.toMatchObject({ cancelled: true });

    // And the grace timer is disarmed by that report, so no signal arrives
    // later either — including at a pid the OS may by then have reused.
    timers.advance(600_000);
    expect(kills).toEqual([]);
  });

  it('kills the worker GROUP, negatively, when the grace period expires', () => {
    const child = fakeChild();
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const timers = fakeTimers();
    const handle = handleFor(child, kills, timers);

    void handle.run(payload).catch(() => {});
    child.emit('message', { type: 'ready', pid: 4242 });
    handle.cancel();

    // A worker that has gone quiet gets the full grace period and not a
    // millisecond less: ffmpeg legitimately ignores a stop request while it
    // finalises a container.
    timers.advance(29_999);
    expect(kills).toEqual([]);

    timers.advance(1);
    // NEGATIVE pid — the whole group the detached worker leads, which is
    // where a plugin's own ffmpeg grandchild lives. A bare-pid kill reaps
    // the node process and leaves the transcode running with nothing
    // tracking it.
    expect(kills).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    timers.advance(5_000);
    expect(kills.at(-1)).toEqual({ pid: -4242, signal: 'SIGKILL' });
    expect(kills).toHaveLength(2);
  });

  it('escalates on a schedule the caller injects, so nothing here waits on a clock', () => {
    const child = fakeChild();
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const timers = fakeTimers();
    const handle = handleFor(child, kills, timers, { cancelGraceMs: 7, killGraceMs: 3 });

    void handle.run(payload).catch(() => {});
    child.emit('message', { type: 'ready', pid: 4242 });
    handle.cancel();

    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([7]);
    timers.advance(7);
    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([3]);
    timers.advance(3);
    expect(kills.map((kill) => kill.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(timers.pending.size).toBe(0);
  });

  it('sweeps the group once when a cancelled worker dies, because the group outlives it', async () => {
    const child = fakeChild();
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const timers = fakeTimers();
    const handle = handleFor(child, kills, timers);

    const running = handle.run(payload);
    child.emit('message', { type: 'ready', pid: 4242 });
    handle.cancel();
    timers.advance(30_000);
    expect(kills).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    // The worker itself died of that SIGTERM — but a process group survives
    // its leader, and an ffmpeg a plugin spawned ITSELF is still in it with
    // no parent left watching. So the final SIGKILL goes out with the exit,
    // rather than being dropped along with the grace timer.
    child.emit('exit', null, 'SIGTERM');
    expect(kills).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);

    // ...and exactly once. Nothing may be signalled on a later timer tick,
    // by which point the kernel is free to hand that pid to someone else.
    timers.advance(600_000);
    expect(kills).toHaveLength(2);

    const failure = await running.catch((error: unknown) => error as AgentFailure);
    expect(failure).toBeInstanceOf(AgentFailure);
    expect(failure.cancelled).toBe(true);
  });

  it('signals nothing at all when a run that was never cancelled ends', () => {
    const child = fakeChild();
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const timers = fakeTimers();
    const handle = handleFor(child, kills, timers);

    void handle.run(payload).catch(() => {});
    child.emit('message', { type: 'ready', pid: 4242 });
    child.emit('message', { type: 'done', report });
    child.emit('exit', 0, null);
    timers.advance(600_000);

    // The group sweep belongs to cancellation, which is a hard stop. An
    // ordinary run that finished and left is not signalled, and neither is
    // whatever now owns that pid.
    expect(kills).toEqual([]);
  });

  it('refuses to signal group 0 or group 1 whatever pid the child claims', () => {
    // pgid 0 is "my own group" — the daemon and every sibling worker — and
    // pgid 1 is "everything I am permitted to signal". Neither can ever be
    // a child we forked, so both are refused rather than translated into
    // something plausible. The guard lives in `killProcessGroup`; this
    // proves the handle really goes through it.
    for (const pid of [0, 1]) {
      const child = fakeChild(pid);
      const kills: { pid: number; signal: NodeJS.Signals }[] = [];
      const timers = fakeTimers();
      const handle = handleFor(child, kills, timers);

      void handle.run(payload).catch(() => {});
      child.emit('message', { type: 'ready', pid });
      handle.kill();
      expect(kills).toEqual([]);

      handle.cancel();
      timers.advance(600_000);
      expect(kills).toEqual([]);
    }
  });

  it('refuses those groups even when the claim arrives on the message channel', () => {
    // The pid in a `ready` message is written by a process that will go on
    // to run third-party plugin code, so it is a CLAIM. It is used only
    // when the fork itself surfaced no pid, and it passes through the same
    // guard.
    for (const pid of [0, 1, -1]) {
      const child = fakeChild();
      const kills: { pid: number; signal: NodeJS.Signals }[] = [];
      const timers = fakeTimers();
      const handle = handleFor(child, kills, timers);

      void handle.run(payload).catch(() => {});
      child.emit('message', { type: 'ready', pid });
      handle.kill();
      expect(kills).toEqual([]);
    }
  });
});

/**
 * The database half: what a cancelled job does to the file's row.
 *
 * A real database, not a double — the whole claim is about columns.
 */
const FLOW: FlowDefinition = {
  nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
  edges: [],
};

const PROBE: ProbeData = {
  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }],
  format: { duration: '2.0' },
};

let db: Db;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  seedCount = 0;
});

/** Distinguishes two seeded files in one database; flow and library names are unique. */
let seedCount = 0;

/** A claimed file that has already burned `attempts` failed attempts. */
const seededWithAttempts = (attempts: number): { payload: JobPayload } => {
  seedCount += 1;
  const tag = String(seedCount);
  const flow = createFlowRepo(db).create({ name: `flow-${tag}`, definition: FLOW, nowMs: NOW });
  const library = createLibraryRepo(db).create({
    name: `lib-${tag}`,
    roots: [`/lib-${tag}`],
    extensions: ['mkv'],
    flowId: flow.id,
    nowMs: NOW,
  });
  const mediaFileRepo = createMediaFileRepo(db);
  const fileId = mediaFileRepo.upsertScanned({
    libraryId: library.id,
    identity: buildIdentityCandidate({
      deviceId: 66,
      inode: 1234 + seedCount,
      hash: { sizeBytes: 4096, headHex: `head${tag}`, tailHex: 'tail' },
    }),
    path: `/lib-${tag}/movie.mkv`,
    nlink: 1,
    sizeBytes: 4096,
    mtimeMs: NOW - 1000,
    ctimeMs: NOW - 1000,
    container: 'mkv',
    nowMs: NOW,
  });
  mediaFileRepo.setProbe({
    fileId,
    probe: PROBE,
    facts: extractFacts({ probe: PROBE, container: 'mkv', sizeBytes: 4096 }),
  });
  mediaFileRepo.setLedger({
    fileId,
    record: {
      state: 'held',
      signature: null,
      attemptCount: attempts,
      consecutiveNoopCount: 0,
      holdUntilMs: NOW + 3_600_000,
    },
  });

  const jobId = createJobRepo(db).start({
    fileId,
    flowId: flow.id,
    flowHash: flow.definitionHash,
    nowMs: NOW,
  });

  return {
    payload: buildJobPayload({
      db,
      claimed: { fileId, libraryId: library.id, path: `/lib-${tag}/movie.mkv` },
      jobId,
      workerClass: 'transcode',
      hardwareType: 'cpu',
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    }),
  };
};

describe('applyJobCancelled', () => {
  it('requeues a cancelled file with its attempt count cleared', () => {
    const { payload: claimed } = seededWithAttempts(2);

    const { state } = applyJobCancelled({ db, payload: claimed, nowMs: () => NOW });

    expect(state).toBe('queued');
    const row = createMediaFileRepo(db).getById(claimed.fileId);
    expect(row?.state).toBe('queued');
    // The point of the whole function: a human pressing cancel is not
    // evidence the file is bad. `applyStall` counts attempts toward the
    // terminal `failed` state, so charging one here would push a healthy
    // file into a state only a manual requeue can undo — after three
    // interrupted evenings.
    expect(row?.attempt_count).toBe(0);
    // ...and no backoff either: the file is eligible the moment a worker
    // frees up, not in an hour.
    expect(row?.hold_until_ms).toBeNull();
  });

  it('is the difference between a cancel and a failure, on the same row', () => {
    // The comparison that gives the claim above its teeth: the SAME seeded
    // row, folded the other way, does penalise the attempt.
    const cancelled = seededWithAttempts(2);
    applyJobCancelled({ db, payload: cancelled.payload, nowMs: () => NOW });
    const afterCancel = createMediaFileRepo(db).getById(cancelled.payload.fileId);

    const failed = seededWithAttempts(2);
    applyJobFailure({ db, payload: failed.payload, reason: 'died', nowMs: () => NOW });
    const afterFailure = createMediaFileRepo(db).getById(failed.payload.fileId);

    expect(afterCancel?.attempt_count).toBe(0);
    expect(afterFailure?.attempt_count).toBe(3);
  });

  it('closes the job row as cancelled rather than failed, keeping its steps', () => {
    const { payload: claimed } = seededWithAttempts(0);
    const jobRepo = createJobRepo(db);
    jobRepo.recordStep({
      jobId: claimed.jobId,
      step: {
        seq: 1,
        nodeId: 'start',
        pluginId: 'trawlarr:start',
        outputNumber: 1,
        durationMs: 1,
        logExcerpt: '',
        error: null,
      },
    });

    applyJobCancelled({ db, payload: claimed, nowMs: () => NOW + 5 });

    const job = jobRepo.listForFile(claimed.fileId).find((row) => row.id === claimed.jobId);
    // Not `failed`: an operator reading job history must not see their own
    // interruption recorded as the file's fault.
    expect(job?.state).toBe('cancelled');
    expect(job?.endedAt).toBe(NOW + 5);
    expect(jobRepo.getSteps(claimed.jobId)).toHaveLength(1);
  });

  it('refuses to fold a cancel for a row that no longer exists', () => {
    const { payload: claimed } = seededWithAttempts(0);
    db.prepare(`DELETE FROM media_file WHERE id = ?`).run(claimed.fileId);

    expect(() => applyJobCancelled({ db, payload: claimed, nowMs: () => NOW })).toThrow();
  });
});
