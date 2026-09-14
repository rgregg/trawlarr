import { leaseOnClaim, type PathMapping } from '@trawlarr/core';
import type { AgentFactoryInput } from '../daemon/supervisor.js';
import type { JobRepo } from '../db/job-repo.js';
import { AgentFailure, answerDocRequest, type AgentHandle } from '../worker/agent-handle.js';
import type { JobPayload } from '../worker/job-payload.js';
import type { AgentToDaemon, DaemonToAgent } from '../worker/protocol.js';
import type { JobReport } from '../worker/run-payload.js';
import { reportToServer } from './map-payload.js';
import type { ServerFrame } from './node-frames.js';

export interface RemoteJobChannel {
  /** Send to the node now; returns false when the node is offline (caller queues). */
  send(frame: ServerFrame): boolean;
}

export interface RemoteAgentInput extends AgentFactoryInput {
  nodeId: string;
  /** True for a job claimed now; false for one adopted from the job table after a daemon restart. */
  fresh: boolean;
  /**
   * Where the lease and the server-view payload are recorded before the job
   * is sent, and where an operator's cancel is made durable.
   */
  jobs: Pick<JobRepo, 'setRemote' | 'requestCancel'>;
  /**
   * The job row already carries a cancel request (`job.cancel_requested_at`):
   * an adopted job cancelled before a daemon restart. Its commits are refused
   * and the cancel is re-sent when the node reconnects.
   */
  cancelRequested?: boolean;
  /**
   * The path map an ADOPTED job was sent through (`job.path_map_json`). A
   * fresh job takes its map from `prepare` instead, so the map that
   * translated the payload is the one that translates the report back — a
   * map edited mid-run must not be applied to only one direction.
   */
  pathMap?: readonly PathMapping[];
  /** The current welcomed connection for `nodeId`, or null while it is offline. */
  channel: () => RemoteJobChannel | null;
  decideCommit: (request: { kind: 'replace' | 'plugin'; pluginId: string }) => {
    granted: boolean;
    reason: string | null;
  };
  /** A step completed: the hub persists `leaseAfterStep`. */
  onStepLease: () => void;
  /** Fill plugin bundles and map the payload to the node's paths. */
  prepare: (payload: JobPayload) => Promise<{ payload: JobPayload; pathMap: PathMapping[] }>;
  /** Append one line to the server-side job log file. */
  appendLog: (text: string) => void;
}

export interface RemoteAgentHandle extends AgentHandle {
  readonly nodeId: string;
  /** The job this handle runs, once `run` has been called. */
  readonly jobId: string | null;
  /** Hub → handle: a frame for this job arrived. */
  receive(message: AgentToDaemon): void;
  /** Hub → handle: the lease expired or the node reported the job lost. */
  abandon(failure: AgentFailure): void;
  /** Hub → handle: the node reconnected; flush any queued cancel. */
  reconnected(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type Outcome = { ok: true; report: JobReport } | { ok: false; error: AgentFailure };

/**
 * The daemon's view of a job running on a remote node, behind the same
 * `AgentHandle` contract a local fork has.
 *
 * THE POINT OF MIRRORING THE CONTRACT is that the supervisor's settlement
 * path stays the ONLY place a run's outcome is written. A remote handle
 * writes no ledger state of its own: a report resolves `run`, a failure,
 * cancel, lost node or expired lease rejects it with an `AgentFailure`, and
 * the supervisor folds either exactly as it folds a local fork's.
 *
 * There is no kill ladder and no pid: the node host owns the agent's
 * process group, so `cancel` and `kill` are both a message, queued while
 * the node is offline and flushed by `reconnected`.
 */
export const createRemoteAgentHandle = (input: RemoteAgentInput): RemoteAgentHandle => {
  let jobId: string | null = null;
  let pathMap: readonly PathMapping[] = input.pathMap ?? [];
  let started = false;
  let cancelled = input.cancelRequested === true;
  let pendingCancel = cancelled;
  /** An abandon that arrived before `run` (an adopted job whose lease had already expired). */
  let earlyFailure: AgentFailure | null = null;
  let settle: ((outcome: Outcome) => void) | null = null;
  let settledOnce = false;

  let resolveExited: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    resolveExited = resolve;
  });

  const send = (frame: ServerFrame): boolean => {
    const channel = input.channel();
    if (channel === null) return false;
    try {
      return channel.send(frame);
    } catch {
      return false;
    }
  };

  const post = (message: DaemonToAgent): void => {
    if (jobId === null) return;
    send({ type: 'agent', jobId, message });
  };

  const finish = (outcome: Outcome): void => {
    if (settle === null) return; // a run ends exactly once
    const done = settle;
    settle = null;
    settledOnce = true;
    resolveExited(null);
    done(outcome);
  };

  const sendCancel = (): void => {
    if (jobId === null) return;
    pendingCancel = !send({ type: 'agent', jobId, message: { type: 'cancel' } });
  };

  const requestCancel = (): void => {
    if (settledOnce) return;
    cancelled = true;
    // Before the job frame has gone out there is nothing on the node to
    // stop; `run` sees `cancelled` after `prepare` and never sends it.
    if (!started || jobId === null) return;
    try {
      // Durable first: a cancel held only in memory is forgotten by a daemon
      // restart, and the node would then be granted its commit on reconnect.
      input.jobs.requestCancel({ jobId, nowMs: input.nowMs() });
    } catch {
      // The in-memory flag still refuses every commit this handle answers.
    }
    sendCancel();
  };

  const answerCommit = (request: Extract<AgentToDaemon, { type: 'commit-request' }>): void => {
    // A cancelled job must never install, whatever its lease says. Without
    // this, a cancel queued while the node was offline could lose the race
    // to a commit-request the node sends the moment it reconnects.
    if (cancelled) {
      post({
        type: 'commit-result',
        id: request.id,
        granted: false,
        reason: 'This job was cancelled, so it may not write to the library.',
      });
      return;
    }
    let decision: { granted: boolean; reason: string | null };
    try {
      decision = input.decideCommit({ kind: request.kind, pluginId: request.pluginId });
    } catch (error) {
      // An error is never a grant.
      decision = { granted: false, reason: messageOf(error) };
    }
    post({
      type: 'commit-result',
      id: request.id,
      granted: decision.granted,
      reason: decision.reason,
    });
  };

  const receive = (message: AgentToDaemon): void => {
    if (settle === null) return; // not running, or already settled: nothing to route to
    switch (message.type) {
      case 'ready':
        return;
      case 'step':
        input.onStep(message.step);
        input.onStepLease();
        return;
      case 'heartbeat':
        // The SERVER's clock, never the node's: the 24 h floor compares
        // `heartbeat_at` against the server clock, so a node whose clock is a
        // day behind would be released on the first sweep, and one ahead
        // would never be caught.
        input.onHeartbeat(input.nowMs());
        return;
      case 'progress':
        input.onProgress({ percent: message.percent, stage: message.stage });
        return;
      case 'log':
        input.onLog(message.text);
        input.appendLog(message.text);
        return;
      case 'doc-request':
        answerDocRequest(input.documents, message, post);
        return;
      case 'commit-request':
        answerCommit(message);
        return;
      case 'done': {
        let report: JobReport;
        try {
          report = reportToServer(message.report, pathMap);
        } catch (error) {
          finish({
            ok: false,
            error: new AgentFailure(
              `Node ${input.nodeId} reported a result the server cannot map back: ${messageOf(error)}`,
              { reported: true, cancelled },
            ),
          });
          return;
        }
        finish({ ok: true, report });
        return;
      }
      case 'failed':
        finish({
          ok: false,
          error: new AgentFailure(
            `Worker ${input.id} on node ${input.nodeId} reported failure: ${message.error}`,
            { reported: true, superseded: message.superseded === true, cancelled },
          ),
        });
        return;
    }
  };

  const runFresh = async (payload: JobPayload): Promise<void> => {
    let prepared: { payload: JobPayload; pathMap: PathMapping[] };
    try {
      prepared = await input.prepare(payload);
    } catch (error) {
      finish({
        ok: false,
        error: new AgentFailure(
          `This job could not be sent to node ${input.nodeId}: ${messageOf(error)}`,
          { reported: true, cancelled },
        ),
      });
      return;
    }
    if (settle === null) return; // abandoned while preparing
    if (cancelled) {
      finish({
        ok: false,
        error: new AgentFailure('Cancelled before the job was sent to its node.', {
          reported: false,
          cancelled: true,
        }),
      });
      return;
    }
    pathMap = prepared.pathMap;
    // The lease and the server-view payload are written BEFORE the job
    // leaves: a report can only be applied (or refused) against a leased row,
    // and one arriving after a daemon restart needs this payload to fold.
    input.jobs.setRemote({
      jobId: payload.jobId,
      nodeId: input.nodeId,
      lease: leaseOnClaim(),
      payloadJson: JSON.stringify(payload),
      pathMapJson: JSON.stringify(prepared.pathMap),
    });
    if (!send({ type: 'job', jobId: payload.jobId, payload: prepared.payload })) {
      finish({
        ok: false,
        error: new AgentFailure(
          `Node ${input.nodeId} went offline before this job could be sent to it.`,
          { reported: false, cancelled },
        ),
      });
    }
  };

  /**
   * Nothing thrown while starting a fresh run may escape: it is called as
   * `void`, so a throw (a database error in `setRemote`) would be an
   * unhandled rejection that takes the daemon down AND a `run` that never
   * settles, stranding the file in `running`.
   */
  const startFresh = (payload: JobPayload): void => {
    runFresh(payload).catch((error: unknown) => {
      finish({
        ok: false,
        error: new AgentFailure(
          `This job could not be sent to node ${input.nodeId}: ${messageOf(error)}`,
          { reported: true, cancelled },
        ),
      });
    });
  };

  return {
    id: input.id,
    nodeId: input.nodeId,
    pid: undefined,
    exited,
    get jobId() {
      return jobId;
    },

    run: (payload: JobPayload): Promise<JobReport> => {
      if (started) {
        return Promise.reject(
          new AgentFailure(`Worker ${input.id} has already been given a job.`, { reported: false }),
        );
      }
      started = true;
      jobId = payload.jobId;
      return new Promise<JobReport>((resolve, reject) => {
        settle = (outcome) => {
          if (outcome.ok) resolve(outcome.report);
          else reject(outcome.error);
        };
        if (earlyFailure !== null) {
          finish({ ok: false, error: earlyFailure });
          return;
        }
        if (input.fresh) {
          startFresh(payload);
          return;
        }
        // Adopted: the node already has this job. A cancel requested before
        // `run` is delivered now that the job id is known.
        if (cancelled) sendCancel();
      });
    },

    cancel: requestCancel,
    // The daemon cannot signal a remote pid; the node host owns the group.
    kill: requestCancel,

    receive,

    abandon: (failure: AgentFailure): void => {
      if (settledOnce) return;
      if (jobId !== null) send({ type: 'abandon', jobId, reason: failure.message });
      if (!started) {
        earlyFailure ??= failure;
        return;
      }
      finish({ ok: false, error: failure });
    },

    reconnected: (): void => {
      if (pendingCancel && !settledOnce) sendCancel();
    },

    settled: (): void => {
      if (jobId !== null) send({ type: 'ack-report', jobId });
    },
  };
};
