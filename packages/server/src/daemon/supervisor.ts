import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  evaluateSchedule,
  flowRequiredHardware,
  type FileState,
  type HardwareType,
  type WorkerClass,
} from '@trawlarr/core';
import type { DocumentPort, StepRecord } from '@trawlarr/engine';
import type { Db } from '../db/connection.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type ClaimedFile } from '../db/media-file-repo.js';
import { createPluginDocumentRepo } from '../db/plugin-document-repo.js';
import type { HardwareSettings, SettingsRepo } from '../db/settings-repo.js';
import type { OnlineNode } from '../nodes/hub.js';
import { ensureLocalNode, LOCAL_NODE_ID } from '../nodes/local-node.js';
import {
  applyJobCancelled,
  applyJobFailure,
  applyJobReport,
  applyJobUnmapped,
  applyThrownFailure,
  recordReplacement,
} from '../worker/apply-report.js';
import { AgentFailure, createAgentHandle, type AgentHandle } from '../worker/agent-handle.js';
import { buildJobPayload, type JobPayload } from '../worker/job-payload.js';
import type { JobReport } from '../worker/run-payload.js';
import type { EventBus } from './events.js';

/**
 * Everything a worker process needs wired to the daemon, handed to the agent
 * factory.
 *
 * The factory is a SEAM (`createSupervisor`'s `createAgent`): production
 * builds a real `createAgentHandle` from it, and a test builds a fake agent
 * it can drive by hand. The sinks travel through the seam rather than being
 * closed over privately so that a fake agent reports steps, progress and log
 * lines through the SAME path production uses — otherwise the ordering of
 * `job.started`/`job.step`/`job.progress`/`job.finished` would only ever be
 * exercised by the real fork, which no deterministic test can drive.
 */
export interface AgentFactoryInput {
  id: string;
  documents: DocumentPort;
  onStep: (step: StepRecord) => void;
  onHeartbeat: (nowMs: number) => void;
  onProgress: (progress: { percent: number | null; stage: string }) => void;
  onLog: (text: string) => void;
  nowMs: () => number;
}

export type CreateAgentFn = (input: AgentFactoryInput) => AgentHandle;

export interface SupervisorWorkerStatus {
  id: string;
  workerClass: WorkerClass;
  hardwareType: HardwareType;
  jobId: string | null;
  fileId: string | null;
  path: string | null;
  startedAtMs: number | null;
  pid: number | undefined;
  /** `local`, or the remote node running this job. */
  nodeId: string;
}

export interface SupervisorStatus {
  target: Record<WorkerClass, number>;
  workers: SupervisorWorkerStatus[];
  paused: boolean;
}

export interface Supervisor {
  /** Reconcile the pool with the schedule and the queue. Idempotent; safe to call at any time. */
  tick(): Promise<void>;
  status(): SupervisorStatus;
  /** Human/API pause. Running jobs finish; nothing new is started. */
  pause(): void;
  resume(): void;
  cancelJob(jobId: string): boolean;
  /**
   * Stop starting work and wait for every running job to finish.
   *
   * `includeRemote: false` waits on local runs only — what daemon shutdown
   * does, because a remote run does not end with this daemon (see `stop`).
   */
  drain(options?: { includeRemote?: boolean }): Promise<void>;
  /**
   * Cancel every LOCAL run and wait for them. Used only by daemon shutdown
   * after drain's deadline. Remote runs are neither cancelled nor waited on.
   */
  stop(): Promise<void>;
  /**
   * The sinks an agent for `payload` reports through, with a fresh worker id:
   * what `createAgent` is handed for a fresh claim, for a caller that builds
   * the agent itself (the node hub adopting leased jobs after a restart).
   */
  agentInputFor(payload: JobPayload): AgentFactoryInput;
  /**
   * Track a run that was already claimed and started before this process
   * (daemon restart). Claims nothing and starts no job row; the agent must
   * have been built from `agentInputFor(payload)`, and its `run` is called
   * here, immediately.
   */
  adopt(input: { payload: JobPayload; agent: AgentHandle; nodeId: string }): void;
}

export interface CreateSupervisorInput {
  db: Db;
  bus: EventBus;
  settings: SettingsRepo;
  nowMs: () => number;
  /**
   * Where per-job logs are allocated under. Optional so a test exercising
   * the supervisor's scheduling arithmetic against a fake agent (which never
   * writes a byte to any log) does not have to invent one; production always
   * passes the daemon's real data directory.
   */
  dataDir?: string;
  /** Seam for tests: substitute the worker process. Production never sets it. */
  createAgent?: CreateAgentFn;
  /** Remote nodes currently online. Absent in tests that only exercise the local node. */
  remoteNodes?: () => OnlineNode[];
  /** Builds the handle for a job claimed onto a remote node. Required with `remoteNodes`. */
  createRemoteAgent?: (input: AgentFactoryInput & { nodeId: string }) => AgentHandle;
}

/**
 * Worker classes that actually have a queue to claim from.
 *
 * `health` is a `WorkerClass` because the type needs to exist (health-check
 * nodes are v1.1), NOT because anything schedules against it: there is no
 * health queue, so a schedule asking for health workers gets none rather
 * than getting transcode workers wearing a different label. Inventing a
 * queue for it here would be inventing a feature.
 */
export const QUEUED_WORKER_CLASSES: readonly WorkerClass[] = ['transcode'];

interface WorkerSlot {
  id: string;
  nodeId: string;
  workerClass: WorkerClass;
  hardwareType: HardwareType;
  agent: AgentHandle;
  jobId: string | null;
  fileId: string | null;
  path: string | null;
  startedAtMs: number | null;
  /** Resolves when this worker's job has been fully folded into the database. */
  done: Promise<void>;
}

/**
 * One node as `reconcile` schedules it: the local daemon, or an online
 * remote node. Each has its OWN target, hardware and headroom — a remote
 * node's GPU is not this machine's, and its schedule is its own.
 */
interface NodeView {
  nodeId: string;
  target: Record<WorkerClass, number>;
  hardware: HardwareSettings;
  /** Libraries the node reported reachable; null for local, which reaches every library. */
  reachable: ReadonlySet<string> | null;
  paused: boolean;
}

/** A library this node could legitimately claim from right now, and on what. */
interface EligibleLibrary {
  libraryId: string;
  hardwareType: HardwareType;
}

/**
 * The hardware a library's flow demands, and whether this node can satisfy it
 * with the headroom it has left.
 *
 * `flowRequiredHardware` is DERIVED from the flow every time (never stored),
 * so editing a flow to use `hevc_nvenc` changes what a node will claim on the
 * very next tick. A flow that names no hardware encoder runs on `cpu`, which
 * every node has — declared or not — so a missing `'cpu'` in a hand-edited
 * `available` list cannot silently stop all work.
 */
const eligibleLibrariesFor = (input: {
  db: Db;
  hardware: HardwareSettings;
  used: Partial<Record<HardwareType, number>>;
}): EligibleLibrary[] => {
  const flowRepo = createFlowRepo(input.db);
  const eligible: EligibleLibrary[] = [];

  for (const library of createLibraryRepo(input.db).list()) {
    // A paused library's files are never CLAIMED — not claimed and then
    // abandoned. `claimNext` has no notion of "enabled", so the enabled set
    // is recomputed here, before every claim, exactly as `runQueue` does it.
    if (!library.enabled) continue;
    if (library.flowId === null) continue;
    const flow = flowRepo.getById(library.flowId);
    if (flow === null) continue;

    const required = flowRequiredHardware(flow.definition);
    // A node that has not declared this hardware never even sees the
    // library in its claim filter, which is what makes "a node with no GPU
    // is never handed GPU work" true by construction rather than by a check
    // somewhere downstream.
    if (required.some((type) => !input.hardware.available.includes(type))) continue;

    // A flow naming more than one hardware family is charged to the first
    // in `HARDWARE_TYPES` order (`flowRequiredHardware` returns them in that
    // order, so this is stable), having already required all of them to be
    // available above.
    const hardwareType: HardwareType = required[0] ?? 'cpu';
    const cap = input.hardware.caps[hardwareType];
    // THE CAP IS CHECKED BEFORE THE CLAIM. Claiming and then unwinding
    // leaves a row `running` that nothing is going to finish.
    if (cap !== undefined && (input.used[hardwareType] ?? 0) >= cap) continue;

    eligible.push({ libraryId: library.id, hardwareType });
  }

  return eligible;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Keeps N worker processes running: as many as the schedule allows, as many
 * as the declared hardware allows, and never more than one per claimed file.
 *
 * This replaces `runQueue` as the DAEMON's drain mechanism. `runQueue`
 * itself is untouched — `trawlarr run` without a daemon still uses it, and
 * its `repeatClaimStop` diagnostic is not re-derived here.
 *
 * THE ORDER INSIDE `tick()` IS THE DESIGN:
 *
 *  1. `evaluateSchedule` gives the target count per class for `nowMs()`.
 *  2. A class already at or above its target starts nothing. Nothing is ever
 *     KILLED for a target that dropped — see the window ruling below.
 *  3. Under target, and while the hardware caps allow, claim one file and
 *     start one worker for it. The claim happens HERE, in the daemon, and
 *     commits `running` before the fork — the scanner's in-flight-output
 *     guard depends on a `running` row existing before any replacement byte
 *     can land on disk.
 *
 * A SCHEDULE WINDOW CLOSING DOES NOT INTERRUPT WORK IN PROGRESS. Windows set
 * the TARGET; workers retire on completion and the freed slot simply is not
 * refilled. Cancelling a two-hour transcode produces nothing at all and
 * costs the whole two hours again later — in exactly the hours the window
 * was protecting. The hard stop is an explicit `cancelJob`/`stop`, never a
 * window edge.
 *
 * `tick()` is re-entrancy-safe: it is called from a timer, from every job
 * completion, and from the API, and two overlapping ticks would double-start
 * workers (each seeing the other's slot as still free). A call made while
 * one is in flight joins it and requests one more pass afterwards, so a
 * completion that lands mid-tick still gets its slot refilled.
 */
export const createSupervisor = (input: CreateSupervisorInput): Supervisor => {
  const { db, bus, settings, nowMs, dataDir } = input;
  const mediaFileRepo = createMediaFileRepo(db);
  const jobRepo = createJobRepo(db);

  // Every job this starts records `node_id`, a foreign key to the node row:
  // the local row must exist before the first claim, whether or not an API
  // context (which also writes it) was ever built.
  ensureLocalNode({ db, settings, nowMs });

  const workers = new Map<string, WorkerSlot>();
  let nextWorkerNumber = 0;
  let paused = false;
  /** Set by `drain`/`stop`: nothing new is started, ever again, by this supervisor. */
  let draining = false;
  let ticking: Promise<void> | null = null;
  let tickAgain = false;
  let lastAnnounced: { target: Record<WorkerClass, number>; active: number } | null = null;

  const activeOf = (nodeId: string, workerClass: WorkerClass): number =>
    [...workers.values()].filter(
      (worker) => worker.nodeId === nodeId && worker.workerClass === workerClass,
    ).length;

  /** Hardware in use ON ONE NODE: a remote node's encodes never spend this machine's caps. */
  const usedHardware = (nodeId: string): Partial<Record<HardwareType, number>> => {
    const used: Partial<Record<HardwareType, number>> = {};
    for (const worker of workers.values()) {
      if (worker.nodeId !== nodeId) continue;
      used[worker.hardwareType] = (used[worker.hardwareType] ?? 0) + 1;
    }
    return used;
  };

  const currentTarget = (): Record<WorkerClass, number> =>
    evaluateSchedule({ schedule: settings.getSchedule(), nowMs: nowMs() });

  const announce = (target: Record<WorkerClass, number>): void => {
    const active = workers.size;
    if (
      lastAnnounced !== null &&
      lastAnnounced.active === active &&
      lastAnnounced.target.transcode === target.transcode &&
      lastAnnounced.target.health === target.health
    ) {
      return;
    }
    lastAnnounced = { target, active };
    bus.emit({ type: 'workers.changed', target, active });
  };

  const workerForJob = (jobId: string): WorkerSlot | undefined =>
    [...workers.values()].find((worker) => worker.jobId === jobId);

  const makeAgent: CreateAgentFn =
    input.createAgent ??
    ((factoryInput) =>
      createAgentHandle({
        id: factoryInput.id,
        documents: factoryInput.documents,
        onStep: factoryInput.onStep,
        onHeartbeat: factoryInput.onHeartbeat,
        onProgress: factoryInput.onProgress,
        onLog: factoryInput.onLog,
        nowMs: factoryInput.nowMs,
      }));

  /**
   * A run that stopped because its commit was refused: its claim on the file
   * is no longer its own, and another worker may hold the file now.
   *
   * THE ATTEMPT WAS ALREADY COUNTED. A refusal follows a release, and the
   * release stalled the attempt and closed the job row (the hub rejects the
   * handle; this supervisor folds that through `applyJobFailure`). Writing the
   * ledger again would spend a second attempt for one run — or, worse,
   * overwrite whatever the NEXT worker's claim has done to the row since. So
   * the refusal is appended to the closed row's outcome, and the file is only
   * read, for the event.
   *
   * Two shapes do not match that premise, and neither may strand anything:
   *
   *  - the job row is still open AND still holds the file (`running`, latest
   *    job): nothing released it, so nothing else is ever going to end it.
   *    Folded as an ordinary failed attempt, with backoff — a refusal that
   *    keeps recurring must not become a claim/refuse loop.
   *  - the job row is still open but the file is no longer claimed by it: the
   *    row is closed as failed, and the file (someone else's now) is left alone.
   */
  const settleSuperseded = (payload: JobPayload, text: string, report?: JobReport): FileState => {
    const job = jobRepo.getById(payload.jobId);
    const file = mediaFileRepo.getById(payload.fileId);
    if (job !== null && job.endedAt !== null) {
      // Even a report carrying a replacement: the row was released and a
      // newer claim may own the file now. That job re-probes it; writing an
      // identity from here could overwrite what the newer job recorded.
      jobRepo.appendOutcome({ jobId: payload.jobId, text });
      return file?.state ?? 'failed';
    }
    const latest = jobRepo.listForFile(payload.fileId)[0];
    if (file !== null && file.state === 'running' && latest?.id === payload.jobId) {
      // Still ours: a replacement that landed before the refusal is recorded
      // before the stall, or the retry would start from the old identity and
      // probe of a file that is no longer on disk.
      if (report?.replaced != null) recordReplacement({ db, row: file, report, nowMs });
      return applyJobFailure({ db, payload, reason: text, nowMs }).state;
    }
    jobRepo.finish({ jobId: payload.jobId, state: 'failed', outcome: text, nowMs: nowMs() });
    return file?.state ?? 'failed';
  };

  /**
   * Fold one finished run into the database and emit its ending.
   *
   * EVERY ending arrives here as a value — a report, or a thrown
   * `AgentFailure` — and every one of them writes the row out of `running`.
   * A child that vanished (OOM killer, `process.exit()` in a plugin, a
   * segfault, the host rebooting) authored nothing, so the daemon is the
   * only process that can record its outcome; `applyJobFailure` stalls the
   * attempt, which backs the file off and makes it claimable again. A row
   * left `running` by a dead worker is a file nothing will ever pick up.
   */
  const settleJob = (
    payload: JobPayload,
    outcome: { ok: true; report: JobReport } | { ok: false; error: unknown },
  ): void => {
    let state: FileState;
    let text: string;
    try {
      if (outcome.ok && outcome.report.cancelled) {
        state = applyJobCancelled({ db, payload, report: outcome.report, nowMs }).state;
        text = 'Cancelled by an operator; the file was requeued unpenalised.';
      } else if (outcome.ok && outcome.report.superseded === true) {
        // A refused commit AFTER a Replace landed (`runPayload` reports rather
        // than throws then): the same fold as a `failed` frame marked
        // superseded, carrying the replacement to record.
        text = outcome.report.outcome;
        state = settleSuperseded(payload, text, outcome.report);
      } else if (outcome.ok) {
        state = applyJobReport({ db, payload, report: outcome.report, nowMs }).state;
        text = outcome.report.outcome;
      } else if (outcome.error instanceof AgentFailure && outcome.error.cancelled) {
        // The worker was cancelled and died before it could report the
        // cancelled run itself. Still the operator's decision, not the
        // file's fault: requeue rather than count an attempt.
        state = applyJobCancelled({ db, payload, nowMs }).state;
        text = 'Cancelled by an operator; the file was requeued unpenalised.';
      } else if (outcome.error instanceof AgentFailure && outcome.error.unmapped) {
        // A map or library edit raced the claim, so the job was never sent:
        // requeued without spending an attempt, with the path in the outcome.
        text = messageOf(outcome.error);
        state = applyJobUnmapped({ db, payload, reason: text, nowMs }).state;
      } else if (outcome.error instanceof AgentFailure && outcome.error.superseded) {
        // Checked AFTER cancelled: a commit refused because an operator
        // cancelled the job is still the operator's decision.
        text = messageOf(outcome.error);
        state = settleSuperseded(payload, text);
      } else {
        // Every other failure is an ordinary failed attempt — including a
        // commit gate that could not get an answer at all (the daemon
        // unreachable mid-request): the agent aborts that as a plain failure,
        // not `superseded`, because nothing has shown that the claim was
        // lost, and a stalled attempt with backoff is the conservative fold.
        // A remote lease that expired arrives here too (`reported: false`,
        // from the hub's release), and is stalled exactly as a vanished local
        // child is.
        text = messageOf(outcome.error);
        state = applyJobFailure({ db, payload, reason: text, nowMs }).state;
      }
    } catch (error) {
      // `applyJobReport` throws when the replacement cannot be recorded (an
      // identity collision, an unprobeable replacement). That is a failed
      // ATTEMPT on this row, exactly as `runJob` treats it — never an
      // unhandled rejection that leaves the row claimed forever.
      const row = mediaFileRepo.getById(payload.fileId);
      text = `Unhandled error: ${messageOf(error)}`;
      state =
        row === null ? 'failed' : applyThrownFailure({ db, row, payload, error, nowMs }).state;
    }

    bus.emit({
      type: 'job.finished',
      jobId: payload.jobId,
      fileId: payload.fileId,
      state,
      outcome: text,
    });
  };

  /**
   * Claim is already done; this owns everything from "we hold a `running`
   * row" to "the row is out of `running` again".
   *
   * A payload that cannot even be built (library deleted mid-flight, flow
   * detached, file never probed) is folded through `applyThrownFailure` —
   * with its synthetic job row — rather than being left claimed. The slot is
   * never occupied in that case, so the reconcile loop simply tries the next
   * file.
   */
  const startWorker = (start: {
    claimed: ClaimedFile;
    workerClass: WorkerClass;
    hardwareType: HardwareType;
    nodeId: string;
  }): void => {
    const { claimed, workerClass, hardwareType, nodeId } = start;
    const binaries = settings.getBinaries();
    const local = nodeId === LOCAL_NODE_ID;

    let payload: JobPayload;
    try {
      // Generated HERE, before the row exists: the on-disk log path is
      // named after this job's id (`jobLogPath`), and both the `job` row's
      // `log_path` and the payload the worker actually writes to have to
      // agree on it, which is only possible if the id is chosen before
      // either of them is built rather than handed back by one of them.
      const jobId = randomUUID();
      const draft = buildJobPayload({
        db,
        claimed,
        jobId,
        dataDir,
        workerClass,
        hardwareType,
        ffmpegPath: binaries.ffmpeg,
        ffprobePath: binaries.ffprobe,
      });
      jobRepo.start({
        id: jobId,
        fileId: draft.fileId,
        flowId: draft.flow.id,
        flowHash: draft.flow.definitionHash,
        nowMs: nowMs(),
        workerClass,
        nodeId,
        logPath: draft.logPath,
      });
      payload = draft;
    } catch (error) {
      foldStartFailure(claimed.fileId, null, error);
      return;
    }

    const factoryInput = agentInputFor(payload);
    let agent: AgentHandle;
    try {
      agent = local
        ? makeAgent(factoryInput)
        : requireRemoteAgentFactory()({ ...factoryInput, nodeId });
    } catch (error) {
      // The job row exists and the file is `running`: an agent that could
      // not even be built must still take both out of it.
      foldStartFailure(claimed.fileId, payload, error);
      return;
    }

    if (local) {
      // WHICH PROCESS IS RUNNING THIS JOB, recorded the instant it exists.
      //
      // The row had to be inserted before the fork (the scanner's
      // in-flight-output guard depends on the claim being committed before
      // any replacement byte can land), so this is the earliest moment the
      // pid is knowable. It is what lets the stall reaper reclaim a claim
      // whose worker is PROVABLY gone instead of waiting out a day of silence
      // — see `reapStalled`. `os.hostname()` travels with it because a pid
      // means nothing without the pid table it belongs to. Local only: a
      // remote node's worker has no pid in any table this daemon can read,
      // and its liveness is its lease.
      jobRepo.setWorker({ jobId: payload.jobId, pid: agent.pid ?? null, host: hostname() });
    }

    const slot = occupy({ id: factoryInput.id, agent, payload, nodeId, startedAtMs: nowMs() });

    bus.emit({
      type: 'job.started',
      jobId: payload.jobId,
      fileId: payload.fileId,
      libraryId: payload.libraryId,
      path: payload.path,
      workerId: slot.id,
      // The fork's own pid, straight from the daemon's own knowledge of
      // what it created — never `ready.pid`, the agent's self-report over a
      // channel a plugin can write to. `agent.pid` is set synchronously by
      // `createAgentHandle`'s `fork()` call, before `ready` ever arrives.
      pid: agent.pid ?? null,
    });

    trackRun(slot, payload);
  };

  const foldStartFailure = (fileId: string, payload: JobPayload | null, error: unknown): void => {
    const row = mediaFileRepo.getById(fileId);
    if (row === null) return;
    const failure = applyThrownFailure({ db, row, payload, error, nowMs });
    bus.emit({
      type: 'job.finished',
      jobId: failure.jobId,
      fileId: row.id,
      state: failure.state,
      outcome: failure.outcome,
    });
  };

  const requireRemoteAgentFactory = (): NonNullable<CreateSupervisorInput['createRemoteAgent']> => {
    if (input.createRemoteAgent === undefined) {
      throw new Error('This supervisor was given remote nodes but no way to build a remote agent.');
    }
    return input.createRemoteAgent;
  };

  /** The sinks for one job, under a fresh worker id. */
  const agentInputFor = (payload: JobPayload): AgentFactoryInput => {
    nextWorkerNumber += 1;
    return {
      id: `worker-${String(nextWorkerNumber)}`,
      documents: createPluginDocumentRepo(db),
      onStep: (step) => {
        jobRepo.recordStep({
          jobId: payload.jobId,
          step: {
            seq: step.seq,
            nodeId: step.nodeId,
            pluginId: step.pluginId,
            outputNumber: step.outputNumber,
            durationMs: step.durationMs,
            logExcerpt: step.logExcerpt,
            error: step.error,
          },
        });
        bus.emit({
          type: 'job.step',
          jobId: payload.jobId,
          seq: step.seq,
          pluginId: step.pluginId,
          outputNumber: step.outputNumber,
          durationMs: step.durationMs,
        });
      },
      onHeartbeat: (at) => {
        jobRepo.heartbeat({ jobId: payload.jobId, nowMs: at });
      },
      onProgress: (progress) => {
        bus.emit({
          type: 'job.progress',
          jobId: payload.jobId,
          percent: progress.percent,
          stage: progress.stage,
        });
      },
      onLog: (text) => {
        bus.emit({ type: 'job.log', jobId: payload.jobId, text });
      },
      nowMs,
    };
  };

  /**
   * Register a slot for a run, keyed by its JOB: one slot per job is the
   * invariant, and a worker id is only a label (a test's fake agents may
   * all share one).
   */
  const occupy = (run: {
    id: string;
    agent: AgentHandle;
    payload: JobPayload;
    nodeId: string;
    startedAtMs: number;
  }): WorkerSlot & { resolveDone: () => void } => {
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const slot = {
      id: run.id,
      nodeId: run.nodeId,
      workerClass: run.payload.workerClass,
      hardwareType: run.payload.hardwareType,
      agent: run.agent,
      jobId: run.payload.jobId,
      fileId: run.payload.fileId,
      path: run.payload.path,
      startedAtMs: run.startedAtMs,
      done,
      resolveDone,
    };
    workers.set(slot.jobId, slot);
    return slot;
  };

  /**
   * Run the agent and fold its ending in. Shared by a fresh claim and an
   * adopted run, so an adopted remote job settles through exactly the path
   * a fresh one does.
   */
  const trackRun = (slot: WorkerSlot & { resolveDone: () => void }, payload: JobPayload): void => {
    void slot.agent
      .run(payload)
      .then(
        (report) => {
          settleJob(payload, { ok: true, report });
        },
        (error: unknown) => {
          settleJob(payload, { ok: false, error });
        },
      )
      .then(() => {
        // Only once the outcome is written: a remote node deletes the report
        // it has been holding when told, so telling it before the write
        // could lose the report entirely if the write then failed.
        slot.agent.settled?.();
      })
      .then(() => {
        // The slot is released only after the outcome is written, so a tick
        // triggered by this completion can never claim a second file into a
        // pool that still believes this one is running.
        workers.delete(payload.jobId);
        slot.resolveDone();
        // Refill immediately rather than waiting for the next timer tick:
        // an idle slot between a finished encode and the next poll is the
        // difference between converging overnight and not.
        void tick();
      });
  };

  /**
   * Every node this supervisor schedules, local first.
   *
   * A remote node is only here while it is ONLINE (welcomed by the hub): an
   * offline node is never claimed for, because a claim it cannot receive
   * would sit in grace for an hour doing nothing.
   */
  const nodeViews = (localTarget: Record<WorkerClass, number>): NodeView[] => {
    const views: NodeView[] = [
      {
        nodeId: LOCAL_NODE_ID,
        target: localTarget,
        hardware: settings.getHardware(),
        reachable: null,
        paused: false,
      },
    ];
    // Without a way to build a remote agent there is nothing to schedule
    // remotely: a claim made anyway could only be stalled, spending an attempt.
    if (input.createRemoteAgent === undefined) return views;
    for (const node of input.remoteNodes?.() ?? []) {
      if (node.nodeId === LOCAL_NODE_ID) continue;
      views.push({
        nodeId: node.nodeId,
        target: evaluateSchedule({ schedule: node.schedule, nowMs: nowMs() }),
        hardware: { available: node.hardware.available, caps: node.hardware.caps },
        reachable: node.reachableLibraryIds,
        paused: node.paused,
      });
    }
    return views;
  };

  const reconcile = (): void => {
    const target = currentTarget();

    if (!paused && !draining) {
      for (const view of nodeViews(target)) {
        if (view.paused) continue;
        for (const workerClass of QUEUED_WORKER_CLASSES) {
          for (;;) {
            // Re-read on every iteration: the target of a class already at or
            // over its count starts nothing, and a pool that SHRANK because a
            // window closed simply never refills. A draining flag set by a
            // completion mid-loop is honoured too.
            if (paused || draining) break;
            if (activeOf(view.nodeId, workerClass) >= view.target[workerClass]) break;

            const eligible = eligibleLibrariesFor({
              db,
              hardware: view.hardware,
              used: usedHardware(view.nodeId),
            }).filter((entry) => view.reachable === null || view.reachable.has(entry.libraryId));
            if (eligible.length === 0) break;

            const claimed = mediaFileRepo.claimNext({
              workerClass,
              nowMs: nowMs(),
              libraryIds: eligible.map((entry) => entry.libraryId),
            });
            if (claimed === null) break;

            const hardwareType =
              eligible.find((entry) => entry.libraryId === claimed.libraryId)?.hardwareType ??
              'cpu';
            startWorker({ claimed, workerClass, hardwareType, nodeId: view.nodeId });
          }
        }
      }
    }

    announce(target);
  };

  const tick = async (): Promise<void> => {
    if (ticking !== null) {
      // Joining rather than returning early: a caller that awaits `tick()`
      // must be able to rely on a reconcile having happened AFTER its call,
      // and a completion landing mid-tick must not lose its refill.
      tickAgain = true;
      return ticking;
    }
    // The flag is armed BEFORE any reconciling, and the promise a joiner
    // gets is this one — not the `async` function's own, which would already
    // have been resolved (and the flag cleared) by the time it was assigned.
    let release = () => {};
    ticking = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      do {
        tickAgain = false;
        reconcile();
      } while (tickAgain);
    } finally {
      ticking = null;
      release();
    }
  };

  /**
   * The slots daemon SHUTDOWN may wait on or cancel: local runs only.
   *
   * A remote run does not end with this daemon, by design. Its node keeps
   * encoding, and the next daemon start adopts the job and puts its lease in
   * grace until the node reconnects. Cancelling it here would be worse than
   * pointless: a remote cancel is DURABLE (`job.cancel_requested_at`), so
   * every restart would permanently cancel every remote job in flight. And
   * waiting on it would hold shutdown for the whole remaining encode.
   */
  const localSlots = (): WorkerSlot[] =>
    [...workers.values()].filter((worker) => worker.nodeId === LOCAL_NODE_ID);

  const awaitAll = async (includeRemote: boolean): Promise<void> => {
    // A loop rather than one `Promise.all`: a completion can start nothing
    // new while draining, but a worker that was mid-`startWorker` when
    // `drain()` was called still has to be waited for.
    for (;;) {
      const slots = includeRemote ? [...workers.values()] : localSlots();
      const pending = slots.map((worker) => worker.done);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  };

  return {
    tick,

    status: () => ({
      target: currentTarget(),
      workers: [...workers.values()].map((worker) => ({
        id: worker.id,
        workerClass: worker.workerClass,
        hardwareType: worker.hardwareType,
        jobId: worker.jobId,
        fileId: worker.fileId,
        path: worker.path,
        startedAtMs: worker.startedAtMs,
        pid: worker.agent.pid,
        nodeId: worker.nodeId,
      })),
      paused,
    }),

    pause: () => {
      paused = true;
    },

    resume: () => {
      paused = false;
    },

    cancelJob: (jobId: string): boolean => {
      const worker = workerForJob(jobId);
      if (worker === undefined) return false;
      worker.agent.cancel();
      return true;
    },

    drain: async (options?: { includeRemote?: boolean }): Promise<void> => {
      draining = true;
      await awaitAll(options?.includeRemote ?? true);
    },

    stop: async (): Promise<void> => {
      draining = true;
      // Local only — see `localSlots` for why a remote run is never cancelled
      // by a shutdown.
      for (const worker of localSlots()) worker.agent.cancel();
      await awaitAll(false);
    },

    agentInputFor,

    adopt: ({ payload, agent, nodeId }): void => {
      // Never claims and never starts a job row: both happened in the
      // previous life. The slot counts against the node's target and
      // hardware like any other, so the node is not handed a second job into
      // the slot this one still occupies. `run` is called now, because a
      // remote handle drops every frame (a commit-request included) until it
      // has been.
      const slot = occupy({
        id: agent.id,
        agent,
        payload,
        nodeId,
        startedAtMs: jobRepo.getById(payload.jobId)?.startedAt ?? nowMs(),
      });
      trackRun(slot, payload);
    },
  };
};
