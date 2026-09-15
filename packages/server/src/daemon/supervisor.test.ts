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
import { createJobRepo } from '../db/job-repo.js';
import { createSettingsRepo, type HardwareSettings } from '../db/settings-repo.js';
import type { OnlineNode } from '../nodes/hub.js';
import { applyJobFailure } from '../worker/apply-report.js';
import { AgentFailure, type AgentHandle } from '../worker/agent-handle.js';
import type { JobPayload } from '../worker/job-payload.js';
import type { JobReport } from '../worker/run-payload.js';
import { createEventBus, type TrawlarrEvent } from './events.js';
import {
  createSupervisor,
  type AgentFactoryInput,
  type CreateAgentFn,
  type Supervisor,
} from './supervisor.js';

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

const HEVC_PROBE: ProbeData = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '60.0', size: '2048', bit_rate: '8192' },
};

const HEVC_FACTS: FactSet = extractFacts({ probe: HEVC_PROBE, container: 'mkv', sizeBytes: 2048 });

/** What a Replace that really swapped a new file in reports. */
const replacedFile = (path: string): NonNullable<JobReport['replaced']> => ({
  path,
  container: 'mkv',
  sizeBytes: 2048,
  mtimeMs: NOW,
  ctimeMs: NOW,
  nlink: 1,
  deviceId: 9,
  inode: 4242,
  hash: { sizeBytes: 2048, headHex: 'newhead', tailHex: 'newtail' },
  probe: HEVC_PROBE,
  probeError: null,
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
  /** `local`, or the remote node this agent was created for. */
  readonly nodeId: string;
  readonly payload: JobPayload;
  readonly cancelled: boolean;
  readonly killed: boolean;
  /** How many times the supervisor called `settled()`, and whether the job row had ended each time. */
  readonly settledCalls: { jobEnded: boolean }[];
  finish(report: JobReport): Promise<void>;
  die(reason: string): Promise<void>;
  fail(error: AgentFailure): Promise<void>;
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

  const makeFake = (factoryInput: AgentFactoryInput, nodeId: string): FakeAgent & AgentHandle => {
    let payload: JobPayload | null = null;
    let cancelled = false;
    let killed = false;
    let settle: { resolve: (report: JobReport) => void; reject: (error: unknown) => void } | null =
      null;

    const settledCalls: { jobEnded: boolean }[] = [];
    const agent: FakeAgent & AgentHandle = {
      id: factoryInput.id,
      nodeId,
      pid: undefined,
      exited: Promise.resolve(0),
      settledCalls,
      settled: () => {
        const job = payload === null ? null : createJobRepo(db).getById(payload.jobId);
        settledCalls.push({ jobEnded: job?.endedAt != null });
      },
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
      fail: async (error: AgentFailure) => {
        live.delete(agent);
        settle?.reject(error);
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
    return agent;
  };

  const createAgent: CreateAgentFn = (factoryInput) => {
    const agent = makeFake(factoryInput, 'local');
    input.onAgentCreated?.({ supervisor, index: all.length });
    return agent;
  };

  /** What `remoteNodes()` returns; a test edits it in place. */
  const online: OnlineNode[] = [];

  const addNode = (over: {
    nodeId: string;
    target: number;
    reachable: string[];
    hardware?: HardwareSettings;
    paused?: boolean;
  }): void => {
    // `job.node_id` is a foreign key: a node must have a row before a job can name it.
    db.prepare(`INSERT INTO node (id, name) VALUES (?, ?)`).run(over.nodeId, over.nodeId);
    online.push({
      nodeId: over.nodeId,
      schedule: { timezone: 'UTC', baseCounts: { transcode: over.target, health: 0 }, windows: [] },
      paused: over.paused ?? false,
      hardware: over.hardware ?? { available: ['cpu'], caps: {} },
      reachableLibraryIds: new Set(over.reachable),
    });
  };

  const newSupervisor = (): Supervisor =>
    createSupervisor({
      db,
      bus,
      settings,
      nowMs: () => now,
      createAgent,
      remoteNodes: () => online,
      createRemoteAgent: (factoryInput) => makeFake(factoryInput, factoryInput.nodeId),
    });

  const supervisor = newSupervisor();

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
    newSupervisor,
    makeFake,
    online,
    addNode,
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

  it('records the new identity when a cancelled report says a replacement already landed', async () => {
    // Replace installed, then the operator's cancel refused a later plugin's
    // commit. The cancel still requeues unpenalised, but the file on disk is
    // not the one the row describes any more.
    const { supervisor, agents, db, cancelledReport } = harness({
      queued: 1,
      target: { transcode: 1, health: 0 },
    });

    await supervisor.tick();
    supervisor.pause();
    const agent = agents.running()[0]!;
    const fileId = agent.payload.fileId;
    await agent.finish({
      ...cancelledReport(agent),
      failed: true,
      superseded: true,
      replaced: replacedFile(agent.payload.path),
      postFacts: HEVC_FACTS,
    });

    const row = rowFor(db, fileId);
    expect(row.state).toBe('queued');
    expect(row.attempt_count).toBe(0);
    expect(row.inode_key).toBe('9:4242');
    expect(row.size_bytes).toBe(2048);
    expect(createJobRepo(db).getById(agent.payload.jobId)?.state).toBe('cancelled');
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

const jobNodeOf = (db: Db, jobId: string): string | null =>
  (db.prepare(`SELECT node_id FROM job WHERE id = ?`).get(jobId) as { node_id: string | null })
    .node_id;

describe('the supervisor, across remote nodes', () => {
  it('claims onto a remote node up to its own target while local claims its own', async () => {
    // Asymmetric: local target 1, remote target 2, six files. Swapping the
    // two targets anywhere changes the split.
    const { supervisor, agents, addNode, libraryId, db } = harness({
      queued: 6,
      target: { transcode: 1, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 2, reachable: [libraryId] });

    await supervisor.tick();

    const running = agents.running();
    expect(running.filter((agent) => agent.nodeId === 'local')).toHaveLength(1);
    expect(running.filter((agent) => agent.nodeId === 'node-x')).toHaveLength(2);
    expect(rowsInState(db, 'running')).toHaveLength(3);

    const byJob = new Map(supervisor.status().workers.map((worker) => [worker.jobId, worker]));
    for (const agent of running) {
      expect(byJob.get(agent.payload.jobId)?.nodeId).toBe(agent.nodeId);
      // `job.node_id` records where every job ran, local ones included.
      expect(jobNodeOf(db, agent.payload.jobId)).toBe(agent.nodeId);
    }
  });

  it('never claims onto a remote node from a library it cannot reach', async () => {
    const { supervisor, agents, addNode, addLibrary, db } = harness({
      queued: 3,
      target: { transcode: 0, health: 0 },
    });
    const reachable = addLibrary({ queued: 1 });
    addNode({ nodeId: 'node-x', target: 4, reachable: [reachable] });

    await supervisor.tick();

    expect(agents.running()).toHaveLength(1);
    expect(agents.running()[0]!.payload.libraryId).toBe(reachable);
    expect(rowsInState(db, 'queued')).toHaveLength(3);
  });

  it('never claims hardware work onto a remote node that declared only cpu', async () => {
    // The LOCAL node has nvenc and a target of zero; the remote node has a
    // target but no GPU. Using the local hardware for the remote view would
    // claim here.
    const { supervisor, agents, addNode, libraryId, db } = harness({
      queued: 2,
      target: { transcode: 0, health: 0 },
      hardware: { available: ['cpu', 'nvenc'], caps: {} },
      flowEncoder: 'hevc_nvenc',
    });
    addNode({ nodeId: 'node-x', target: 2, reachable: [libraryId] });

    await supervisor.tick();

    expect(agents.started()).toHaveLength(0);
    expect(rowsInState(db, 'queued')).toHaveLength(2);
  });

  it('claims nothing onto a paused remote node, while local still claims', async () => {
    const { supervisor, agents, addNode, libraryId } = harness({
      queued: 4,
      target: { transcode: 1, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 2, reachable: [libraryId], paused: true });

    await supervisor.tick();

    expect(agents.running().map((agent) => agent.nodeId)).toEqual(['local']);
  });

  it('stalls a remote run whose lease expired, spending an attempt', async () => {
    const { supervisor, agents, addNode, libraryId, db } = harness({
      queued: 1,
      target: { transcode: 0, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    const agent = agents.running()[0]!;

    // What the hub's release hands the handle: nothing authored this.
    await agent.fail(new AgentFailure('Node node-x was offline too long.', { reported: false }));

    const row = rowFor(db, agent.payload.fileId);
    expect(row.state).toBe('held');
    expect(row.attempt_count).toBe(1);
  });

  it('folds a superseded result into the closed job row without touching the file', async () => {
    const { supervisor, agents, addNode, libraryId, db, events } = harness({
      queued: 1,
      target: { transcode: 0, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    supervisor.pause();
    const agent = agents.running()[0]!;
    const { fileId, jobId } = agent.payload;

    // The release already happened: the attempt was stalled and the row closed.
    applyJobFailure({ db, payload: agent.payload, reason: 'released', nowMs: () => NOW });
    const before = rowFor(db, fileId);

    await agent.fail(
      new AgentFailure('The commit was refused.', { reported: true, superseded: true }),
    );

    expect(rowFor(db, fileId)).toEqual(before);
    expect(createJobRepo(db).getById(jobId)?.outcome).toBe('released\nThe commit was refused.');
    expect(events.find((event) => event.type === 'job.finished')).toMatchObject({
      jobId,
      state: before.state,
    });
    expect(supervisor.status().workers).toHaveLength(0);
  });

  it('never strands a file whose commit was refused while its job still held the claim', async () => {
    // Nothing released this row, so nothing else will ever end it: the
    // refusal must still take the file out of `running`.
    const { supervisor, agents, addNode, libraryId, db } = harness({
      queued: 1,
      target: { transcode: 0, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    supervisor.pause();
    const agent = agents.running()[0]!;

    await agent.fail(new AgentFailure('refused', { reported: true, superseded: true }));

    expect(rowFor(db, agent.payload.fileId).state).toBe('held');
    expect(createJobRepo(db).getById(agent.payload.jobId)?.endedAt).not.toBeNull();
  });

  it('records a landed replacement from a superseded report before stalling the still-held row', async () => {
    const { supervisor, agents, addNode, libraryId, db, successReport } = harness({
      queued: 1,
      target: { transcode: 0, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    supervisor.pause();
    const agent = agents.running()[0]!;

    await agent.finish({
      ...successReport(agent),
      success: false,
      failed: true,
      superseded: true,
      outcome: 'Flow aborted after a replacement: refused',
      replaced: replacedFile(agent.payload.path),
      postFacts: HEVC_FACTS,
    });

    const row = rowFor(db, agent.payload.fileId);
    expect(row.state).toBe('held');
    expect(row.attempt_count).toBe(1);
    expect(row.inode_key).toBe('9:4242');
    expect(createJobRepo(db).getById(agent.payload.jobId)?.endedAt).not.toBeNull();
  });

  it('only appends a superseded report to a job row that already ended, even with a replacement', async () => {
    // The release closed the row and a newer claim may own the file: that
    // job re-probes; this late report must not write the file's identity.
    const { supervisor, agents, addNode, libraryId, db, successReport } = harness({
      queued: 1,
      target: { transcode: 0, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    supervisor.pause();
    const agent = agents.running()[0]!;
    applyJobFailure({ db, payload: agent.payload, reason: 'released', nowMs: () => NOW });
    const before = rowFor(db, agent.payload.fileId);

    await agent.finish({
      ...successReport(agent),
      success: false,
      failed: true,
      superseded: true,
      outcome: 'Flow aborted after a replacement: refused',
      replaced: replacedFile(agent.payload.path),
      postFacts: HEVC_FACTS,
    });

    expect(rowFor(db, agent.payload.fileId)).toEqual(before);
    expect(createJobRepo(db).getById(agent.payload.jobId)?.outcome).toContain('refused');
  });

  it('requeues unpenalised when a map edit unmapped the claimed path before it was sent', async () => {
    const { supervisor, agents, addNode, libraryId, db } = harness({
      queued: 1,
      target: { transcode: 0, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    supervisor.pause();
    const agent = agents.running()[0]!;

    await agent.fail(
      new AgentFailure(
        `This job could not be sent to node node-x: Path "${agent.payload.path}" is outside the node's path map.`,
        { reported: true, unmapped: true },
      ),
    );

    const row = rowFor(db, agent.payload.fileId);
    expect(row.state).toBe('queued');
    expect(row.attempt_count).toBe(0);
    const job = createJobRepo(db).getById(agent.payload.jobId);
    expect(job?.endedAt).not.toBeNull();
    expect(job?.outcome).toContain(agent.payload.path);
  });

  it('calls settled() exactly once, after the job row has ended', async () => {
    const { supervisor, agents, addNode, libraryId, successReport } = harness({
      queued: 1,
      target: { transcode: 0, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    supervisor.pause();
    const agent = agents.running()[0]!;

    await agent.finish(successReport(agent));

    expect(agent.settledCalls).toEqual([{ jobEnded: true }]);
  });

  it('adopts a run started before a restart: it holds a slot, and its settlement is written', async () => {
    const { supervisor, agents, addNode, libraryId, db, newSupervisor, makeFake, successReport } =
      harness({ queued: 3, target: { transcode: 0, health: 0 } });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    const original = agents.running()[0]!;
    const payload = original.payload;
    await supervisor.drain({ includeRemote: false });

    // "Restart": a second supervisor over the same database.
    const restarted = newSupervisor();
    const adopted = makeFake(restarted.agentInputFor(payload), 'node-x');
    restarted.adopt({ payload, agent: adopted, nodeId: 'node-x' });
    await restarted.tick();

    // The adopted run fills node-x's only slot: nothing more is claimed for it.
    expect(restarted.status().workers.map((worker) => [worker.jobId, worker.nodeId])).toEqual([
      [payload.jobId, 'node-x'],
    ]);
    expect(rowsInState(db, 'running')).toHaveLength(1);

    restarted.pause();
    await adopted.finish(successReport(adopted));
    expect(rowFor(db, payload.fileId).state).toBe('good');
    expect(createJobRepo(db).getById(payload.jobId)?.endedAt).not.toBeNull();
    expect(restarted.status().workers).toHaveLength(0);
  });

  it('drains for shutdown without waiting on a remote run', async () => {
    const { supervisor, agents, addNode, libraryId } = harness({
      queued: 2,
      target: { transcode: 0, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    expect(agents.running()).toHaveLength(1);

    await supervisor.drain({ includeRemote: false });

    expect(agents.running()).toHaveLength(1);
  });

  it('stops without cancelling a remote run, which must survive the restart', async () => {
    // A remote cancel is DURABLE (`job.cancel_requested_at`), so cancelling on
    // shutdown would cancel every remote job on every daemon restart.
    const { supervisor, agents, addNode, libraryId, cancelledReport } = harness({
      queued: 2,
      target: { transcode: 1, health: 0 },
    });
    addNode({ nodeId: 'node-x', target: 1, reachable: [libraryId] });
    await supervisor.tick();
    const local = agents.running().find((agent) => agent.nodeId === 'local')!;
    const remote = agents.running().find((agent) => agent.nodeId === 'node-x')!;

    const stopping = supervisor.stop();
    expect(local.cancelled).toBe(true);
    expect(remote.cancelled).toBe(false);
    expect(remote.killed).toBe(false);
    await local.finish(cancelledReport(local));
    await stopping;
  });
});
