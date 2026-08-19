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
import {
  applyJobCancelled,
  applyJobFailure,
  applyJobReport,
  applyThrownFailure,
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
  /** Stop starting work and wait for every running job to finish. */
  drain(): Promise<void>;
  /** Cancel everything and wait. Used only by daemon shutdown after drain's deadline. */
  stop(): Promise<void>;
}

export interface CreateSupervisorInput {
  db: Db;
  bus: EventBus;
  settings: SettingsRepo;
  nowMs: () => number;
  /** Seam for tests: substitute the worker process. Production never sets it. */
  createAgent?: CreateAgentFn;
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
  const { db, bus, settings, nowMs } = input;
  const mediaFileRepo = createMediaFileRepo(db);
  const jobRepo = createJobRepo(db);

  const workers = new Map<string, WorkerSlot>();
  let nextWorkerNumber = 0;
  let paused = false;
  /** Set by `drain`/`stop`: nothing new is started, ever again, by this supervisor. */
  let draining = false;
  let ticking: Promise<void> | null = null;
  let tickAgain = false;
  let lastAnnounced: { target: Record<WorkerClass, number>; active: number } | null = null;

  const activeOf = (workerClass: WorkerClass): number =>
    [...workers.values()].filter((worker) => worker.workerClass === workerClass).length;

  const usedHardware = (): Partial<Record<HardwareType, number>> => {
    const used: Partial<Record<HardwareType, number>> = {};
    for (const worker of workers.values()) {
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
        state = applyJobCancelled({ db, payload, nowMs }).state;
        text = 'Cancelled by an operator; the file was requeued unpenalised.';
      } else if (outcome.ok) {
        state = applyJobReport({ db, payload, report: outcome.report, nowMs }).state;
        text = outcome.report.outcome;
      } else if (outcome.error instanceof AgentFailure && outcome.error.cancelled) {
        // The worker was cancelled and died before it could report the
        // cancelled run itself. Still the operator's decision, not the
        // file's fault: requeue rather than count an attempt.
        state = applyJobCancelled({ db, payload, nowMs }).state;
        text = 'Cancelled by an operator; the file was requeued unpenalised.';
      } else {
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
  }): void => {
    const { claimed, workerClass, hardwareType } = start;
    const binaries = settings.getBinaries();

    let payload: JobPayload;
    try {
      const draft = buildJobPayload({
        db,
        claimed,
        jobId: '',
        workerClass,
        hardwareType,
        ffmpegPath: binaries.ffmpeg,
        ffprobePath: binaries.ffprobe,
      });
      const jobId = jobRepo.start({
        fileId: draft.fileId,
        flowId: draft.flow.id,
        flowHash: draft.flow.definitionHash,
        nowMs: nowMs(),
        workerClass,
      });
      payload = { ...draft, jobId };
    } catch (error) {
      const row = mediaFileRepo.getById(claimed.fileId);
      if (row !== null) {
        const failure = applyThrownFailure({ db, row, payload: null, error, nowMs });
        bus.emit({
          type: 'job.finished',
          jobId: failure.jobId,
          fileId: row.id,
          state: failure.state,
          outcome: failure.outcome,
        });
      }
      return;
    }

    nextWorkerNumber += 1;
    const id = `worker-${String(nextWorkerNumber)}`;

    const agent = makeAgent({
      id,
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
    });

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const slot: WorkerSlot = {
      id,
      workerClass,
      hardwareType,
      agent,
      jobId: payload.jobId,
      fileId: payload.fileId,
      path: payload.path,
      startedAtMs: nowMs(),
      done,
    };
    workers.set(id, slot);

    bus.emit({
      type: 'job.started',
      jobId: payload.jobId,
      fileId: payload.fileId,
      libraryId: payload.libraryId,
      path: payload.path,
      workerId: id,
    });

    void agent
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
        // The slot is released only after the outcome is written, so a tick
        // triggered by this completion can never claim a second file into a
        // pool that still believes this one is running.
        workers.delete(id);
        resolveDone();
        // Refill immediately rather than waiting for the next timer tick:
        // an idle slot between a finished encode and the next poll is the
        // difference between converging overnight and not.
        void tick();
      });
  };

  const reconcile = (): void => {
    const target = currentTarget();

    if (!paused && !draining) {
      for (const workerClass of QUEUED_WORKER_CLASSES) {
        for (;;) {
          // Re-read on every iteration: the target of a class already at or
          // over its count starts nothing, and a pool that SHRANK because a
          // window closed simply never refills.
          if (activeOf(workerClass) >= target[workerClass]) break;

          const eligible = eligibleLibrariesFor({
            db,
            hardware: settings.getHardware(),
            used: usedHardware(),
          });
          if (eligible.length === 0) break;

          const claimed = mediaFileRepo.claimNext({
            workerClass,
            nowMs: nowMs(),
            libraryIds: eligible.map((entry) => entry.libraryId),
          });
          if (claimed === null) break;

          const hardwareType =
            eligible.find((entry) => entry.libraryId === claimed.libraryId)?.hardwareType ?? 'cpu';
          startWorker({ claimed, workerClass, hardwareType });
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

  /** Every job still in flight, as promises that resolve once written back. */
  const inFlight = (): Promise<void>[] => [...workers.values()].map((worker) => worker.done);

  const awaitAll = async (): Promise<void> => {
    // A loop rather than one `Promise.all`: a completion can start nothing
    // new while draining, but a worker that was mid-`startWorker` when
    // `drain()` was called still has to be waited for.
    for (;;) {
      const pending = inFlight();
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

    drain: async (): Promise<void> => {
      draining = true;
      await awaitAll();
    },

    stop: async (): Promise<void> => {
      draining = true;
      for (const worker of workers.values()) worker.agent.cancel();
      await awaitAll();
    },
  };
};
