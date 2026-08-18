import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killProcessGroup } from '@trawlarr/engine';
import type { ChildProcess } from 'node:child_process';
import type { DocumentPort, KillFn, StepRecord } from '@trawlarr/engine';
import type { JobPayload } from './job-payload.js';
import type { JobReport } from './run-payload.js';
import type { AgentToDaemon, DaemonToAgent } from './protocol.js';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_ENV, parseAgentMessage } from './protocol.js';

/** Where the built agent entry point lives, relative to this module. */
export const AGENT_MODULE_URL: URL = new URL('./agent.js', import.meta.url);

/** How long a cancelled worker gets to exit cleanly before its group is killed. */
const DEFAULT_CANCEL_GRACE_MS = 30_000;

/**
 * Why a run did not produce a report.
 *
 * `reported` is the distinction the daemon acts on, and it is the reason
 * the protocol has a `failed` message at all rather than relying on exit
 * codes:
 *
 *  - `reported: true` — the agent said what went wrong (a plugin threw,
 *    ffmpeg exited non-zero, the flow could not be loaded). There is a
 *    human-readable reason worth storing as the job's outcome.
 *  - `reported: false` — the child VANISHED: killed by the OOM killer,
 *    `process.exit()` called by a plugin, a segfault in a native module, the
 *    host rebooting. Nothing authored the failure, so the outcome text is
 *    the daemon's own description of the disappearance.
 *
 * Both are thrown, and both therefore reach `applyThrownFailure`, which
 * stalls the attempt — the row leaves `running` either way. That is the
 * invariant: a child that dies mid-transcode must never strand its file in
 * a state nothing can claim, and the ONLY process that can write that
 * outcome is the daemon, which is why every ending of a run arrives here as
 * a value rather than being left to the child to record.
 */
export class AgentFailure extends Error {
  readonly cancelled: boolean;
  readonly reported: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    options: {
      cancelled?: boolean;
      reported?: boolean;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    } = {},
  ) {
    super(message);
    this.name = 'AgentFailure';
    this.cancelled = options.cancelled ?? false;
    this.reported = options.reported ?? false;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
  }
}

/** The daemon's view of one worker process. */
export interface AgentHandle {
  readonly id: string;
  readonly pid: number | undefined;
  /** Resolves with the agent's report, or rejects with `AgentFailure`. */
  run(payload: JobPayload): Promise<JobReport>;
  cancel(): void;
  kill(): void;
  /** The child's exit code, or null when it was killed by a signal. */
  readonly exited: Promise<number | null>;
}

export interface AgentHandleDeps {
  documents: DocumentPort;
  onStep: (step: StepRecord) => void;
  onHeartbeat: (nowMs: number) => void;
  onProgress: (progress: { percent: number | null; stage: string }) => void;
  onLog: (text: string) => void;
  nowMs: () => number;
  /** Seam for tests: substitute the fork. Production never sets it. */
  forkFn?: (modulePath: string) => ChildProcess;
  /** Seam for tests: substitute the kill used on this worker's group. */
  killFn?: KillFn;
  /** How long a cancelled worker gets to exit cleanly before its group is killed. */
  cancelGraceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Fork the agent as a DETACHED process-group leader.
 *
 * `detached: true` is not cosmetic: it makes the child's pgid equal its pid,
 * so a plugin's own ffmpeg grandchildren inherit that group and one
 * `kill(-pid)` takes the whole tree down (Task 6). Without it, killing the
 * worker leaves an hour-long encode running with nothing left to record it.
 *
 * `stdio` is `['ignore', 'pipe', 'pipe', 'ipc']`. The protocol travels on
 * the IPC channel and NOWHERE else: stdout and stderr belong to arbitrary
 * third-party plugin code, which prints whatever it likes, so they are
 * treated as untrusted text and forwarded to the job log verbatim. Nothing
 * on them is ever parsed.
 */
export const forkAgent = (modulePath: string): ChildProcess =>
  fork(modulePath, [], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, [PROTOCOL_VERSION_ENV]: String(PROTOCOL_VERSION) },
  });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

/**
 * One worker process, as the daemon sees it.
 *
 * The child is forked immediately so its pid exists before any job is
 * assigned to it, and the job is sent only once the agent has said `ready`
 * — which is the point at which the child's message handler is installed
 * and a payload cannot be dropped on the floor.
 */
export const createAgentHandle = (input: AgentHandleDeps & { id: string }): AgentHandle => {
  const setTimer = input.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = input.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));
  const cancelGraceMs = input.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const child = (input.forkFn ?? forkAgent)(fileURLToPath(AGENT_MODULE_URL));

  let ready = false;
  let cancelled = false;
  let gone = false;
  let pendingPayload: JobPayload | null = null;
  let settle:
    | ((outcome: { ok: true; report: JobReport } | { ok: false; error: AgentFailure }) => void)
    | null = null;
  let started = false;
  let graceTimer: unknown = null;

  let resolveExited: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    resolveExited = resolve;
  });

  /** Never throws: the channel can close between the check and the write. */
  const post = (message: DaemonToAgent): void => {
    if (!child.connected) return;
    try {
      child.send(message);
    } catch {
      // The child went away mid-write. Its exit will settle the run.
    }
  };

  const finish = (
    outcome: { ok: true; report: JobReport } | { ok: false; error: AgentFailure },
  ) => {
    if (settle === null) return; // already settled — a run ends exactly once
    const done = settle;
    settle = null;
    done(outcome);
  };

  const disarmGrace = (): void => {
    if (graceTimer === null) return;
    clearTimer(graceTimer);
    graceTimer = null;
  };

  const killGroup = (): void => {
    killProcessGroup(child.pid, 'SIGKILL', input.killFn);
  };

  const answerDocRequest = (request: Extract<AgentToDaemon, { type: 'doc-request' }>): void => {
    const ok = (value: unknown) => post({ type: 'doc-result', id: request.id, ok: true, value });
    const fail = (error: unknown) =>
      post({ type: 'doc-result', id: request.id, ok: false, error: messageOf(error) });

    try {
      // Every branch answers. A daemon-side throw with no reply is a worker
      // blocked until the stall reaper notices, half an hour later, for what
      // is a one-line error.
      let result: unknown;
      switch (request.method) {
        case 'get':
          result = input.documents.get(request.collection, request.docId);
          break;
        case 'insert':
          if (request.data === undefined || request.nowMs === undefined) {
            throw new Error(`doc-request ${request.id}: insert requires data and nowMs.`);
          }
          result = input.documents.insert(
            request.collection,
            request.docId,
            request.data,
            request.nowMs,
          );
          break;
        case 'update':
          if (request.data === undefined || request.nowMs === undefined) {
            throw new Error(`doc-request ${request.id}: update requires data and nowMs.`);
          }
          result = input.documents.update(
            request.collection,
            request.docId,
            request.data,
            request.nowMs,
          );
          break;
        case 'removeOne':
          result = input.documents.removeOne(request.collection, request.docId);
          break;
      }
      if (isThenable(result)) {
        void Promise.resolve(result).then(ok, fail);
        return;
      }
      ok(result);
    } catch (error) {
      fail(error);
    }
  };

  child.on('message', (raw: unknown) => {
    const message = parseAgentMessage(raw);
    // Unrecognised traffic is dropped, not duck-typed: this channel belongs
    // to a process running third-party code, which is free to call
    // `process.send` itself.
    if (message === null) return;
    switch (message.type) {
      case 'ready':
        ready = true;
        if (cancelled) {
          post({ type: 'cancel' });
          return;
        }
        if (pendingPayload !== null) {
          post({ type: 'job', payload: pendingPayload });
          pendingPayload = null;
        }
        return;
      case 'step':
        input.onStep(message.step);
        return;
      case 'heartbeat':
        input.onHeartbeat(message.nowMs);
        return;
      case 'progress':
        input.onProgress({ percent: message.percent, stage: message.stage });
        return;
      case 'log':
        input.onLog(message.text);
        return;
      case 'doc-request':
        answerDocRequest(message);
        return;
      case 'done':
        disarmGrace();
        finish({ ok: true, report: message.report });
        return;
      case 'failed':
        disarmGrace();
        finish({
          ok: false,
          error: new AgentFailure(`Worker ${input.id} reported failure: ${message.error}`, {
            reported: true,
            cancelled,
          }),
        });
        return;
    }
  });

  // stdout/stderr are untrusted text, forwarded and never parsed. A plugin
  // that prints its whole ffmpeg log should not be able to influence the
  // protocol, and here it structurally cannot: nothing reads these streams
  // except the job log.
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') input.onLog(`[worker ${input.id}] ${line}`);
      }
    });
  }

  const vanished = (exitCode: number | null, signal: NodeJS.Signals | null): AgentFailure =>
    new AgentFailure(
      `Worker ${input.id} (pid ${String(child.pid)}) exited ` +
        `${signal === null ? `with code ${String(exitCode)}` : `on ${signal}`} ` +
        `before reporting a result.`,
      { reported: false, cancelled, exitCode, signal },
    );

  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    gone = true;
    disarmGrace();
    resolveExited(code ?? null);
    finish({ ok: false, error: vanished(code, signal) });
  });

  child.on('error', (error: Error) => {
    gone = true;
    disarmGrace();
    finish({
      ok: false,
      error: new AgentFailure(`Worker ${input.id} could not be run: ${error.message}`, {
        reported: false,
        cancelled,
      }),
    });
  });

  return {
    id: input.id,
    get pid() {
      return child.pid;
    },
    exited,

    run: (payload: JobPayload): Promise<JobReport> => {
      if (started) {
        return Promise.reject(
          new AgentFailure(`Worker ${input.id} has already been given a job.`, { reported: false }),
        );
      }
      started = true;
      if (gone) {
        return Promise.reject(
          new AgentFailure(`Worker ${input.id} exited before it was given a job.`, {
            reported: false,
            cancelled,
          }),
        );
      }
      return new Promise<JobReport>((resolve, reject) => {
        settle = (outcome) => {
          if (outcome.ok) resolve(outcome.report);
          else reject(outcome.error);
        };
        // A cancel that arrived before the agent was ready means the job is
        // never sent at all: there is nothing to interrupt, and starting one
        // in order to stop it immediately is the one way to lose a file to a
        // half-run flow.
        if (cancelled) return;
        if (ready) post({ type: 'job', payload });
        else pendingPayload = payload;
      });
    },

    cancel: (): void => {
      if (cancelled || gone) return;
      cancelled = true;
      pendingPayload = null;
      // Only meaningful once the agent's handler exists; before `ready` the
      // flag above is what stops the job being sent, and `ready` forwards
      // the cancel itself.
      if (ready) post({ type: 'cancel' });
      // A plugin can ignore an abort, block the event loop, or hold an
      // ffmpeg child that will not die. The grace timer is what guarantees
      // the worker slot comes back regardless. Task 6 owns the policy
      // around this; the mechanism is here so it cannot be forgotten.
      graceTimer = setTimer(() => {
        graceTimer = null;
        killGroup();
      }, cancelGraceMs);
    },

    kill: (): void => {
      disarmGrace();
      killGroup();
    },
  };
};
