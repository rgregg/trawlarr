import { describe, expect, it } from 'vitest';
import {
  extractFacts,
  type FactSet,
  type FileState,
  type FlowDefinition,
  type ScheduleWindow,
  type WorkerClass,
} from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { createSettingsRepo, type HardwareSettings } from '../db/settings-repo.js';
import { AgentFailure, type AgentHandle } from '../worker/agent-handle.js';
import type { JobPayload } from '../worker/job-payload.js';
import type { JobReport } from '../worker/run-payload.js';
import { createEventBus, type TrawlarrEvent } from './events.js';
import { createSupervisor, type CreateAgentFn, type Supervisor } from './supervisor.js';

/** 2024-01-01T00:30:00Z — inside a 00:00-01:00 window, wherever one is used. */
const NOW = Date.UTC(2024, 0, 1, 0, 30);
const ONE_HOUR = 60 * 60 * 1000;

const PROBE: ProbeData = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '60.0', size: '4096', bit_rate: '16384' },
};

const FACTS: FactSet = extractFacts({ probe: PROBE, container: 'mkv', sizeBytes: 4096 });

/**
 * A flow whose `setVideoEncoder` node names `encoder`, which is what
 * `flowRequiredHardware` derives the node's hardware requirement from — the
 * one thing about the flow these tests care about. It is never RUN here:
 * every agent is a fake.
 */
const flowFor = (encoder: string): FlowDefinition => ({
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'check',
      pluginId: 'trawlarr:checkVideoCodec',
      pluginVersion: '1.0.0',
      inputs: { codec: 'hevc' },
    },
    { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'encoder',
      pluginId: 'trawlarr:setVideoEncoder',
      pluginVersion: '1.0.0',
      inputs: { encoder, quality: '30' },
    },
    { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
    { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
    { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'encoder' },
    { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'execute' },
  ],
});

const rowsInState = (db: Db, state: FileState): MediaFileRow[] =>
  db.prepare(`SELECT * FROM media_file WHERE state = ?`).all(state) as MediaFileRow[];

const rowFor = (db: Db, fileId: string): MediaFileRow =>
  db.prepare(`SELECT * FROM media_file WHERE id = ?`).get(fileId) as MediaFileRow;

/**
 * A worker that never becomes a process.
 *
 * Every ending a real worker has — a report, a cancelled report, a child
 * that vanished — is delivered by hand through `finish`/`die`, so no test
 * here depends on a scheduler producing an interleaving. `step`/`progress`
 * call the daemon's own sinks, the same ones `createAgentHandle` is given,
 * so the event ordering under test is production's ordering.
 */
interface FakeAgent {
  readonly id: string;
  readonly payload: JobPayload;
  readonly cancelled: boolean;
  readonly killed: boolean;
  finish(report: JobReport): Promise<void>;
  die(reason: string): Promise<void>;
  step(over?: { seq?: number; pluginId?: string }): void;
  progress(percent: number): void;
}

/**
 * Drains the microtask queue.
 *
 * Nothing in the supervisor's completion path does I/O — it is synchronous
 * database work plus another reconcile — so yielding the queue a fixed
 * number of times is enough to run it to completion. This waits on the event
 * loop's own turns, never on elapsed time, and no assertion anywhere in this
 * file reads a clock.
 */
const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

interface HarnessInput {
  queued: number;
  target: Record<WorkerClass, number>;
  hardware?: HardwareSettings;
  flowEncoder?: string;
  windows?: ScheduleWindow[];
  /**
   * Called with the harness's own `supervisor` getter as each fake agent is
   * created — the seam a test uses to FORCE an interleaving (a tick
   * re-entered from inside `startWorker`, before the new worker's slot
   * exists).
   */
  onAgentCreated?: (input: { supervisor: Supervisor; index: number }) => void;
}

const harness = (input: HarnessInput) => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);

  let now = NOW;
  const settings = createSettingsRepo({ db });
  settings.setHardware(input.hardware ?? { available: ['cpu'], caps: {} });
  settings.setSchedule({
    timezone: 'UTC',
    baseCounts: input.target,
    windows: input.windows ?? [],
  });

  const libraryRepo = createLibraryRepo(db);
  const flowRepo = createFlowRepo(db);
  const mediaFileRepo = createMediaFileRepo(db);

  let libraryNumber = 0;
  const addLibrary = (over: { queued: number; flowEncoder?: string }): string => {
    libraryNumber += 1;
    const name = `Library ${String(libraryNumber)}`;
    const root = `/media/lib${String(libraryNumber)}`;
    const flow = flowRepo.create({
      name: `Flow ${String(libraryNumber)}`,
      definition: flowFor(over.flowEncoder ?? 'libx265'),
      nowMs: now,
    });
    const library = libraryRepo.create({ name, roots: [root], flowId: flow.id, nowMs: now });

    for (let index = 0; index < over.queued; index += 1) {
      // Distinct device/inode/content per file: identity is what keeps these
      // separate rows, and a shared hash would collapse them into one.
      const fileId = mediaFileRepo.upsertScanned({
        libraryId: library.id,
        identity: {
          inodeKey: `${String(2049 + libraryNumber)}:${String(1000 + index)}`,
          contentKey: `4096:${String(libraryNumber)}${String(index)}:ff`,
        },
        path: `${root}/file${String(index)}.mkv`,
        nlink: 1,
        sizeBytes: 4096,
        mtimeMs: now,
        ctimeMs: now,
        container: 'mkv',
        nowMs: now,
      });
      mediaFileRepo.setProbe({ fileId, probe: PROBE, facts: FACTS });
      mediaFileRepo.setState({ fileId, state: 'queued' });
    }

    return library.id;
  };

  const libraryId = addLibrary({ queued: input.queued, flowEncoder: input.flowEncoder });

  const bus = createEventBus();
  const events: TrawlarrEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const all: FakeAgent[] = [];
  const live = new Set<FakeAgent>();

  const createAgent: CreateAgentFn = (factoryInput) => {
    let payload: JobPayload | null = null;
    let cancelled = false;
    let killed = false;
    let settle: { resolve: (report: JobReport) => void; reject: (error: unknown) => void } | null =
      null;

    const agent: FakeAgent & AgentHandle = {
      id: factoryInput.id,
      pid: undefined,
      exited: Promise.resolve(0),
      get payload() {
        if (payload === null) throw new Error(`${factoryInput.id} was never given a job.`);
        return payload;
      },
      get cancelled() {
        return cancelled;
      },
      get killed() {
        return killed;
      },
      run: (given: JobPayload) => {
        payload = given;
        return new Promise<JobReport>((resolve, reject) => {
          settle = { resolve, reject };
        });
      },
      cancel: () => {
        cancelled = true;
      },
      kill: () => {
        killed = true;
      },
      finish: async (report: JobReport) => {
        live.delete(agent);
        settle?.resolve(report);
        await flush();
      },
      die: async (reason: string) => {
        live.delete(agent);
        // Exactly what a vanished child produces: nothing authored the
        // failure, so `reported` is false. See `AgentFailure`.
        settle?.reject(new AgentFailure(reason, { reported: false, cancelled }));
        await flush();
      },
      step: (over) => {
        factoryInput.onStep({
          seq: over?.seq ?? 1,
          nodeId: 'start',
          pluginId: over?.pluginId ?? 'trawlarr:start',
          pluginName: 'Start',
          outputNumber: 1,
          outputOutcome: null,
          durationMs: 7,
          logExcerpt: '',
          error: null,
        });
      },
      progress: (percent: number) => {
        factoryInput.onProgress({ percent, stage: 'transcode' });
      },
    };

    all.push(agent);
    live.add(agent);
    input.onAgentCreated?.({ supervisor, index: all.length });
    return agent;
  };

  const supervisor = createSupervisor({
    db,
    bus,
    settings,
    nowMs: () => now,
    createAgent,
  });

  const successReport = (agent: FakeAgent): JobReport => ({
    jobId: agent.payload.jobId,
    fileId: agent.payload.fileId,
    steps: [],
    stopReason: 'end-of-flow',
    failed: false,
    error: null,
    success: true,
    outcome: 'converged',
    replaced: null,
    preFacts: FACTS,
    postFacts: null,
    cancelled: false,
  });

  const cancelledReport = (agent: FakeAgent): JobReport => ({
    ...successReport(agent),
    success: false,
    outcome: 'cancelled',
    cancelled: true,
  });

  return {
    db,
    supervisor,
    libraryId,
    addLibrary,
    events,
    settings,
    successReport,
    cancelledReport,
    agents: {
      started: () => [...all],
      running: () => [...live],
    },
    setTarget: (counts: Record<WorkerClass, number>) => {
      settings.setSchedule({ timezone: 'UTC', baseCounts: counts, windows: input.windows ?? [] });
    },
    setNow: (ms: number) => {
      now = ms;
    },
  };
};

describe('the supervisor', () => {
  it('starts as many workers as the schedule allows and no more', async () => {
    const { supervisor, agents, db } = harness({
      queued: 5,
      target: { transcode: 3, health: 0 },
    });

    await supervisor.tick();

    expect(agents.running()).toHaveLength(3);
    expect(rowsInState(db, 'running')).toHaveLength(3);
    expect(rowsInState(db, 'queued')).toHaveLength(2);
  });

  it('starts nothing for a class with no queue, however many the schedule asks for', async () => {
    // Asymmetric on purpose: 2 transcode and 5 health. `health` is a type
    // with no queue, so a supervisor that treated the counts as
    // interchangeable would start seven workers, or two of the wrong class.
    const { supervisor, agents } = harness({ queued: 9, target: { transcode: 2, health: 5 } });

    await supervisor.tick();

    expect(agents.running()).toHaveLength(2);
    expect(agents.running().map((agent) => agent.payload.workerClass)).toEqual([
      'transcode',
      'transcode',
    ]);
  });

  it('refills a freed slot as soon as a job finishes', async () => {
    const { supervisor, agents, successReport } = harness({
      queued: 5,
      target: { transcode: 2, health: 0 },
    });

    await supervisor.tick();
    const first = agents.running()[0]!;
    await first.finish(successReport(first));

    expect(agents.started()).toHaveLength(3);
    expect(agents.running()).toHaveLength(2);
  });

  it('never claims two workers onto the same file, under a forced simultaneous claim', async () => {
    // The invariant, not the outcome: with claims forced to interleave, each
    // file is claimed exactly once. Asserting "worker A got file 1" would be
    // non-deterministic in both directions.
    const { supervisor, agents, db } = harness({ queued: 4, target: { transcode: 4, health: 0 } });

    await supervisor.tick();

    const fileIds = agents.running().map((agent) => agent.payload.fileId);
    expect(fileIds).toHaveLength(4);
    expect(new Set(fileIds).size).toBe(fileIds.length);
    expect(rowsInState(db, 'running')).toHaveLength(4);
  });

  it('does not double-start when a tick is re-entered before a new slot is registered', async () => {
    // FORCED interleaving, not hoped for. The re-entrant tick happens inside
    // agent creation — i.e. after the file's row is already committed
    // `running` but BEFORE the worker's slot exists — which is the one window
    // in which two ticks would each believe the pool had room. Revert the
    // in-flight flag in `tick()` and this goes red: the nested tick claims a
    // second file against a target of one.
    const reentered: number[] = [];
    const { supervisor, agents, db } = harness({
      queued: 4,
      target: { transcode: 1, health: 0 },
      onAgentCreated: ({ supervisor: sup, index }) => {
        reentered.push(index);
        void sup.tick();
      },
    });

    await supervisor.tick();
    await flush();

    expect(reentered).toEqual([1]);
    expect(agents.started()).toHaveLength(1);
    expect(rowsInState(db, 'running')).toHaveLength(1);
    expect(rowsInState(db, 'queued')).toHaveLength(3);
  });

  it('respects a hardware cap below the class target', async () => {
    const { supervisor, agents, db } = harness({
      queued: 5,
      target: { transcode: 4, health: 0 },
      hardware: { available: ['cpu', 'nvenc'], caps: { nvenc: 1 } },
      flowEncoder: 'hevc_nvenc',
    });

    await supervisor.tick();

    expect(agents.running()).toHaveLength(1);
    // And the cap was honoured BEFORE the claim: four rows are still queued,
    // not claimed-and-unwound.
    expect(rowsInState(db, 'running')).toHaveLength(1);
    expect(rowsInState(db, 'queued')).toHaveLength(4);
  });

  it('fills the rest of the pool from libraries a saturated cap does not apply to', async () => {
    // Asymmetric: nvenc capped at 1, three CPU files, target 4. Swapping the
    // two hardware labels anywhere in the cap arithmetic changes these
    // numbers, which a symmetric fixture could not detect.
    const { supervisor, agents, addLibrary } = harness({
      queued: 3,
      target: { transcode: 4, health: 0 },
      hardware: { available: ['cpu', 'nvenc'], caps: { nvenc: 1 } },
      flowEncoder: 'hevc_nvenc',
    });
    addLibrary({ queued: 3, flowEncoder: 'libx265' });

    await supervisor.tick();

    const byHardware = agents.running().map((agent) => agent.payload.hardwareType);
    expect(byHardware.filter((type) => type === 'nvenc')).toHaveLength(1);
    expect(byHardware.filter((type) => type === 'cpu')).toHaveLength(3);
  });

  it('never claims from a library whose flow needs hardware this node does not have', async () => {
    const { supervisor, agents, db } = harness({
      queued: 3,
      target: { transcode: 2, health: 0 },
      hardware: { available: ['cpu'], caps: {} },
      flowEncoder: 'hevc_nvenc',
    });

    await supervisor.tick();

    expect(agents.started()).toHaveLength(0);
    expect(rowsInState(db, 'queued')).toHaveLength(3);
    expect(rowsInState(db, 'running')).toHaveLength(0);
  });

  it('lets a running job finish when the schedule target drops to zero', async () => {
    const { supervisor, agents, setTarget, successReport } = harness({
      queued: 3,
      target: { transcode: 2, health: 0 },
    });

    await supervisor.tick();
    const [first, second] = agents.running();
    setTarget({ transcode: 0, health: 0 });
    await supervisor.tick();

    expect(first!.cancelled).toBe(false); // NOT cancelled — a window edge is not a hard stop
    expect(second!.cancelled).toBe(false);
    expect(first!.killed).toBe(false);
    expect(agents.started()).toHaveLength(2); // and nothing new started

    await first!.finish(successReport(first!));
    await supervisor.tick();
    expect(agents.started()).toHaveLength(2); // the freed slot stays empty
    expect(agents.running()).toHaveLength(1); // and the other one is still working
  });

  it('resizes the pool when a real schedule window closes under an injected clock', async () => {
    // The same ruling driven by the SCHEDULE rather than by a setter: base
    // counts of zero, a 00:00-01:00 window asking for two, and a clock the
    // test moves past the window's end.
    const { supervisor, agents, setNow, successReport, db } = harness({
      queued: 4,
      target: { transcode: 0, health: 0 },
      windows: [
        { id: 'overnight', days: [], startMinute: 0, endMinute: 60, counts: { transcode: 2 } },
      ],
    });

    await supervisor.tick();
    expect(agents.running()).toHaveLength(2);
    expect(supervisor.status().target.transcode).toBe(2);

    setNow(NOW + ONE_HOUR); // 01:30Z — the window is over
    await supervisor.tick();

    expect(supervisor.status().target.transcode).toBe(0);
    expect(agents.running().every((agent) => !agent.cancelled)).toBe(true);

    const [first, second] = agents.running();
    await first!.finish(successReport(first!));
    await second!.finish(successReport(second!));
    await supervisor.tick();

    expect(agents.started()).toHaveLength(2);
    expect(rowsInState(db, 'running')).toHaveLength(0);
    expect(rowsInState(db, 'queued')).toHaveLength(2);
    expect(rowsInState(db, 'good')).toHaveLength(2);
  });

  it('never claims from a paused library', async () => {
    const { supervisor, agents, db, libraryId } = harness({
      queued: 3,
      target: { transcode: 2, health: 0 },
    });
    createLibraryRepo(db).pause(libraryId, 'flow-invalid: missing plugin');

    await supervisor.tick();

    expect(agents.started()).toHaveLength(0);
    expect(rowsInState(db, 'running')).toHaveLength(0);
  });

  it('claims from the enabled library only, when one of two is paused', async () => {
    // Asymmetric: 1 file in the paused library, 3 in the enabled one.
    const { supervisor, agents, db, libraryId, addLibrary } = harness({
      queued: 1,
      target: { transcode: 3, health: 0 },
    });
    const second = addLibrary({ queued: 3 });
    createLibraryRepo(db).pause(libraryId, 'operator paused it');

    await supervisor.tick();

    expect(agents.running()).toHaveLength(3);
    expect(agents.running().every((agent) => agent.payload.libraryId === second)).toBe(true);
  });

  it('folds an agent that dies without reporting into a backoff, and keeps going', async () => {
    const { supervisor, agents, db } = harness({ queued: 2, target: { transcode: 1, health: 0 } });

    await supervisor.tick();
    const first = agents.running()[0]!;
    const fileId = first.payload.fileId;
    await first.die('worker exited with code 1');

    // The row is what matters: it LEFT `running`, so something can claim it
    // again, and the attempt was counted so the backoff applies.
    const row = rowFor(db, fileId);
    expect(row.state).toBe('held');
    expect(row.attempt_count).toBe(1);
    expect(row.hold_until_ms).not.toBeNull();
    expect(rowsInState(db, 'held')).toHaveLength(1);
    expect(rowsInState(db, 'running')).toHaveLength(1); // the NEXT file, now claimed
    expect(agents.started()).toHaveLength(2);
  });

  it('requeues unpenalised when a job reports itself cancelled', async () => {
    const { supervisor, agents, db, cancelledReport } = harness({
      queued: 1,
      target: { transcode: 1, health: 0 },
    });

    await supervisor.tick();
    const agent = agents.running()[0]!;
    const fileId = agent.payload.fileId;
    // Paused first, so the row can be read in the state the cancel left it
    // in rather than in whatever the refill immediately did with it.
    supervisor.pause();
    await agent.finish(cancelledReport(agent));

    const row = rowFor(db, fileId);
    expect(row.state).toBe('queued');
    // An operator's decision is not evidence about the file: no attempt,
    // no hold. Three cancelled evenings must not push a healthy file to
    // `failed`.
    expect(row.attempt_count).toBe(0);
    expect(row.hold_until_ms).toBeNull();
  });

  it('leaves a cancelled file as claimable as one that was never claimed', async () => {
    // The documented consequence of `applyJobCancelled` (see its own comment:
    // "eligible again the moment a worker is free"). A cancel is a stop, not
    // a penalty — so with the pool still open the file comes straight back
    // round, and it comes back with a CLEAN ledger, which is the part that
    // matters: nothing about the operator's evening accumulates towards
    // `failed`.
    const { supervisor, agents, db, cancelledReport } = harness({
      queued: 1,
      target: { transcode: 1, health: 0 },
    });

    await supervisor.tick();
    const first = agents.running()[0]!;
    const fileId = first.payload.fileId;
    await first.finish(cancelledReport(first));

    expect(agents.started()).toHaveLength(2);
    expect(agents.running()[0]!.payload.fileId).toBe(fileId);
    expect(rowFor(db, fileId).attempt_count).toBe(0);
  });

  it('cancels exactly the job it was asked to cancel', async () => {
    // Asymmetric: three workers, the MIDDLE one cancelled.
    const { supervisor, agents } = harness({ queued: 3, target: { transcode: 3, health: 0 } });
    await supervisor.tick();
    const [first, second, third] = agents.running();

    expect(supervisor.cancelJob(second!.payload.jobId)).toBe(true);

    expect(first!.cancelled).toBe(false);
    expect(second!.cancelled).toBe(true);
    expect(third!.cancelled).toBe(false);
    expect(supervisor.cancelJob('job-that-does-not-exist')).toBe(false);
  });

  it('starts nothing while paused, and starts again on resume', async () => {
    const { supervisor, agents, db } = harness({ queued: 3, target: { transcode: 2, health: 0 } });

    supervisor.pause();
    await supervisor.tick();
    expect(agents.started()).toHaveLength(0);
    expect(supervisor.status().paused).toBe(true);
    expect(rowsInState(db, 'queued')).toHaveLength(3);

    supervisor.resume();
    await supervisor.tick();
    expect(agents.running()).toHaveLength(2);
    expect(supervisor.status().paused).toBe(false);
  });

  it('lets a job started before a pause finish, and does not refill after it', async () => {
    const { supervisor, agents, successReport } = harness({
      queued: 4,
      target: { transcode: 2, health: 0 },
    });
    await supervisor.tick();

    supervisor.pause();
    const first = agents.running()[0]!;
    expect(first.cancelled).toBe(false);
    await first.finish(successReport(first));

    expect(agents.started()).toHaveLength(2);
    expect(agents.running()).toHaveLength(1);
  });

  it('drains: starts nothing new and resolves once the running jobs are written back', async () => {
    const { supervisor, agents, db, successReport } = harness({
      queued: 5,
      target: { transcode: 2, health: 0 },
    });
    await supervisor.tick();
    const [first, second] = agents.running();

    let drained = false;
    const draining = supervisor.drain().then(() => {
      drained = true;
    });

    await flush();
    expect(drained).toBe(false); // two jobs are still in flight

    await first!.finish(successReport(first!));
    await second!.finish(successReport(second!));
    await draining;

    expect(drained).toBe(true);
    expect(agents.started()).toHaveLength(2);
    expect(rowsInState(db, 'good')).toHaveLength(2);
    expect(rowsInState(db, 'running')).toHaveLength(0);
  });

  it('stops: cancels everything running and waits for it', async () => {
    const { supervisor, agents, db, cancelledReport } = harness({
      queued: 4,
      target: { transcode: 2, health: 0 },
    });
    await supervisor.tick();
    const [first, second] = agents.running();

    const stopping = supervisor.stop();
    expect(first!.cancelled).toBe(true);
    expect(second!.cancelled).toBe(true);

    await first!.finish(cancelledReport(first!));
    await second!.finish(cancelledReport(second!));
    await stopping;

    expect(rowsInState(db, 'running')).toHaveLength(0);
    expect(rowsInState(db, 'queued')).toHaveLength(4); // both cancelled jobs requeued
  });

  it('reports each running worker in status, with its file, class and hardware', async () => {
    const { supervisor, agents } = harness({ queued: 2, target: { transcode: 2, health: 0 } });
    await supervisor.tick();

    const status = supervisor.status();
    expect(status.target).toEqual({ transcode: 2, health: 0 });
    expect(status.workers).toHaveLength(2);
    expect(status.workers.map((worker) => worker.jobId).sort()).toEqual(
      agents
        .running()
        .map((agent) => agent.payload.jobId)
        .sort(),
    );
    for (const worker of status.workers) {
      expect(worker.workerClass).toBe('transcode');
      expect(worker.hardwareType).toBe('cpu');
      expect(worker.fileId).not.toBeNull();
      expect(worker.startedAtMs).toBe(NOW);
    }
  });

  it('emits started/step/progress/finished for one job, in that order', async () => {
    const { supervisor, agents, events, successReport } = harness({
      queued: 1,
      target: { transcode: 1, health: 0 },
    });

    await supervisor.tick();
    const agent = agents.running()[0]!;
    agent.step();
    agent.progress(50);
    await agent.finish(successReport(agent));

    const seen = events.filter((event) => event.type.startsWith('job.')).map((event) => event.type);
    expect(seen).toEqual(['job.started', 'job.step', 'job.progress', 'job.finished']);
  });

  it('records a step against the job row it belongs to', async () => {
    // Asymmetric: two workers, and only the SECOND one reports steps — two
    // of them. A step recorded against the wrong job row cannot pass.
    const { supervisor, agents, db } = harness({ queued: 2, target: { transcode: 2, health: 0 } });
    await supervisor.tick();
    const [first, second] = agents.running();

    second!.step({ seq: 1 });
    second!.step({ seq: 2, pluginId: 'trawlarr:execute' });

    const stepsFor = (jobId: string) =>
      db.prepare(`SELECT * FROM job_step WHERE job_id = ?`).all(jobId) as { seq: number }[];
    expect(stepsFor(first!.payload.jobId)).toHaveLength(0);
    expect(stepsFor(second!.payload.jobId)).toHaveLength(2);
  });

  it('announces the pool size when it changes, and not when it does not', async () => {
    const { supervisor, events, agents, successReport } = harness({
      queued: 3,
      target: { transcode: 2, health: 0 },
    });

    await supervisor.tick();
    await supervisor.tick(); // idempotent: nothing changed, nothing announced

    const changes = events.filter((event) => event.type === 'workers.changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ target: { transcode: 2, health: 0 }, active: 2 });

    const first = agents.running()[0]!;
    await first.finish(successReport(first));
    // Finishing and refilling returns to two active workers, so the pool
    // size the outside world sees is unchanged.
    expect(events.filter((event) => event.type === 'workers.changed')).toHaveLength(1);
  });

  it('stalls a claimed file whose payload cannot be built, without occupying a worker', async () => {
    // `buildJobPayload` throwing after the claim is committed is the shape
    // that would otherwise leave a `running` row nothing will ever finish.
    const { supervisor, agents, db } = harness({
      queued: 2,
      target: { transcode: 1, health: 0 },
    });
    // A file with no probe: `buildJobPayload` cannot compute a signature for
    // it and throws before any worker exists. The library itself stays
    // eligible, so the claim really is made and really has to be unwound.
    db.prepare(`UPDATE media_file SET probe_json = NULL`).run();

    await supervisor.tick();

    expect(agents.started()).toHaveLength(0);
    expect(rowsInState(db, 'running')).toHaveLength(0);
    expect(rowsInState(db, 'held')).toHaveLength(2);
    // Every attempt is explained by a job row, including one that failed
    // before a real job could start.
    const jobs = db.prepare(`SELECT COUNT(*) AS n FROM job`).get() as { n: number };
    expect(jobs.n).toBe(2);
  });
});
