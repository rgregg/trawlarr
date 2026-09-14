import { mkdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import type { HardwareType } from '@trawlarr/core';
import type { DocumentPort } from '@trawlarr/engine';
import { osFileLock } from '../daemon/os-file-lock.js';
import { DAEMON_VERSION } from '../daemon/version.js';
import {
  parseServerFrame,
  type NodeConfigFrame,
  type NodeFrame,
  type NodeLibraryProbe,
  type ServerFrame,
} from '../nodes/node-frames.js';
import {
  AgentFailure,
  createAgentHandle,
  type AgentHandle,
  type CommitPort,
} from '../worker/agent-handle.js';
import type { JobPayload } from '../worker/job-payload.js';
import { PROTOCOL_VERSION, type AgentToDaemon, type DaemonToAgent } from '../worker/protocol.js';
import { createBundleCache } from './bundle-cache.js';
import { createJournal } from './journal.js';
import { readNodeState, writeNodeState, type NodeState } from './node-state.js';

/**
 * The remote node process: `trawlarr node`.
 *
 * WHAT THIS IS NOT ALLOWED TO BE IS A SECOND IMPLEMENTATION OF A WORKER. Every
 * job runs through the unchanged `createAgentHandle`, forking the unchanged
 * `worker/agent.ts`, exactly as a local daemon's worker does; this module only
 * carries the agent's messages over one outbound WebSocket inside `agent`
 * frames. The two things it adds are the two things a separate machine needs:
 *
 *  - a JOURNAL, so a node killed between "the job finished" and "the server
 *    heard" still delivers the result: every final report is written to disk
 *    BEFORE it is sent, and forgotten only on `ack-report`;
 *  - a RE-ATTACH, so a dropped socket is a pause rather than a loss: requests
 *    the agent is waiting on (documents, and above all commits) stay pending
 *    and are re-sent once the server says the job continues.
 *
 * It never grants a commit. The server alone decides whether this node still
 * owns the file, and a node that decided that for itself while offline is
 * exactly how two workers write one file (AGENTS.md).
 *
 * This module must not reach `src/db/` at runtime — a node has no database —
 * and a module-graph test in `worker/agent-handle.test.ts` holds it to that.
 */

export interface NodeHostInput {
  dataDir: string;
  /** Required on first run (with enrollToken). */
  serverUrl?: string;
  enrollToken?: string;
  ffmpegPath: string;
  ffprobePath: string;
  hardware: { available: HardwareType[]; caps: Partial<Record<HardwareType, number>> };
  nowMs?: () => number;
  /** Seams for tests. */
  createAgent?: typeof createAgentHandle;
  WebSocketImpl?: typeof WebSocket;
  fetchFn?: typeof fetch;
  /** Default [1_000, 2_000, 5_000, 10_000, 30_000]; the last value repeats. */
  reconnectDelaysMs?: readonly number[];
  /** Default 300_000. */
  libraryProbeIntervalMs?: number;
  /** Where operator-facing lines go. Defaults to the console. */
  log?: (line: string) => void;
}

export interface NodeHost {
  /** Resolves once connected at least once, or rejects on a refusal it cannot retry (enrollment refused). */
  started: Promise<void>;
  status(): { connected: boolean; nodeId: string | null; running: string[] };
  /** Cancels running agents, closes the socket, releases the lock. */
  stop(): Promise<void>;
}

/** The kernel-locked file that makes a data directory one node's. */
export const NODE_LOCK_FILENAME = 'node.lock';

export const ENROLLMENT_REFUSED_MESSAGE =
  "The enrollment token was refused: it is wrong, expired, or already used. Create a new one on the server's Nodes page.";

/**
 * A node that cannot run as configured, and retrying will not change that: no
 * enrollment to use, or a token the server refused. The CLI exits 2 for it.
 */
export class NodeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeSetupError';
  }
}

export class NodeAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeAlreadyRunningError';
  }
}

const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
const DEFAULT_LIBRARY_PROBE_INTERVAL_MS = 300_000;

/**
 * How long the socket may be silent before it is presumed dead.
 *
 * The hub pings every 15 s. A half-open TCP connection (a NAS switch reboot,
 * a laptop suspending) otherwise looks connected for as long as the kernel's
 * retransmission timeout, and every commit the agent waits on waits for it
 * too, on a socket that will never answer.
 */
const SERVER_SILENCE_MS = 60_000;

/**
 * How long `stop()` waits for cancelled agents to settle. Longer than the
 * handle's own ladder (30 s cancel grace, then 5 s of SIGTERM before SIGKILL),
 * so a stop normally sees every run end and journals its report.
 */
const STOP_GRACE_MS = 40_000;

const API_PREFIX = '/api/v1/nodes';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeOf = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

const rawToString = (data: RawData): string => {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
};

/**
 * The `protocolVersion` this node says hello with.
 *
 * TEST-ONLY SEAM. The end-to-end suite has to prove a version mismatch is
 * refused by a REAL server talking to a REAL node process, and there is no
 * other way to build a node that disagrees with its own tree. Gated on
 * `NODE_ENV === 'test'` so that a stray variable in a production container
 * can never make a node lie about the protocol it speaks — a node claiming a
 * version it does not implement is how the commit gate gets skipped.
 */
const helloProtocolVersion = (): number => {
  if (process.env.NODE_ENV !== 'test') return PROTOCOL_VERSION;
  const raw = process.env.TRAWLARR_PROTOCOL_VERSION_OVERRIDE;
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : PROTOCOL_VERSION;
};

type DocRequest = Extract<AgentToDaemon, { type: 'doc-request' }>;
type CommitRequest = Extract<AgentToDaemon, { type: 'commit-request' }>;

/** A request the agent is waiting on; answered only by the server, or refused on abandon. */
interface PendingRequest {
  jobId: string;
  message: DocRequest | CommitRequest;
  /** Consumes a matching reply; false when the reply is not for this kind of request. */
  answer: (reply: DaemonToAgent) => boolean;
  abandon: (reason: string) => void;
}

export const startNodeHost = async (input: NodeHostInput): Promise<NodeHost> => {
  const log = input.log ?? ((line: string) => console.log(line));
  const nowMs = input.nowMs ?? (() => Date.now());
  const createAgent = input.createAgent ?? createAgentHandle;
  const WebSocketImpl = input.WebSocketImpl ?? WebSocket;
  const fetchFn = input.fetchFn ?? fetch;
  const reconnectDelaysMs =
    input.reconnectDelaysMs !== undefined && input.reconnectDelaysMs.length > 0
      ? input.reconnectDelaysMs
      : DEFAULT_RECONNECT_DELAYS_MS;
  const libraryProbeIntervalMs = input.libraryProbeIntervalMs ?? DEFAULT_LIBRARY_PROBE_INTERVAL_MS;
  const { dataDir } = input;

  // ---- the lock -----------------------------------------------------------
  // Two node processes on one data directory would share one journal and one
  // identity: each would say hello for the other's jobs, and the server would
  // replace one socket with the other on every reconnect. The same kernel lock
  // the daemon holds, for the same reason (AGENTS.md), on its own file.
  await mkdir(dataDir, { recursive: true });
  const lockPath = join(dataDir, NODE_LOCK_FILENAME);
  const attempt = osFileLock.acquire(lockPath);
  if (attempt.status === 'held') {
    throw new NodeAlreadyRunningError(
      `Another trawlarr node already holds the lock on this data directory ("${lockPath}"). ` +
        `Only one node may use a data directory: two would share one journal and one identity. ` +
        `Stop that node first, or point this one at a different --data-dir.`,
    );
  }
  if (attempt.status === 'unsupported') {
    log(
      `[node] Warning: the filesystem holding "${dataDir}" cannot take a file lock ` +
        `(${attempt.reason}), so nothing stops a second node from using this data directory.`,
    );
  }
  const releaseLock = attempt.status === 'acquired' ? attempt.lock.release : (): void => {};

  let state: NodeState | null;
  try {
    state = await readNodeState(dataDir);
    if (state === null && (input.serverUrl === undefined || input.enrollToken === undefined)) {
      throw new NodeSetupError(
        `This node is not enrolled yet. Pass --server <url> and --token <token> ` +
          `(or TRAWLARR_SERVER and TRAWLARR_NODE_TOKEN); the server's Nodes page shows both.`,
      );
    }
  } catch (error) {
    releaseLock();
    throw error;
  }

  const journal = createJournal(join(dataDir, 'journal'));
  /**
   * `load()` runs ONCE: it is the only moment a `running` entry means "no
   * agent survives" (lost). Every later hello is built from memory, where a
   * `running` entry has a live agent behind it.
   */
  const startupEntries = journal.load();
  /** Every job the journal holds, in the order hello lists them. */
  const known = new Set(startupEntries.map((entry) => entry.jobId));
  const lostAtStartup = new Set(
    startupEntries.filter((entry) => entry.state === 'lost').map((entry) => entry.jobId),
  );

  // ---- state ----------------------------------------------------------------
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let socket: WebSocket | null = null;
  let welcomed = false;
  let backoffIndex = 0;
  let refusedRetryMs: number | null = null;
  let config: NodeConfigFrame | null = null;
  /** Set by the first welcome: later ones are reconnects. */
  let announcedConnection = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Jobs between their `job` frame and their report being held. */
  const running = new Set<string>();
  const agents = new Map<string, AgentHandle>();
  const runs = new Map<string, Promise<void>>();
  /** Jobs the server abandoned: their commit requests are refused locally from now on. */
  const abandoned = new Map<string, string>();
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  const sleepers = new Set<() => void>();

  let resolveStarted: () => void = () => {};
  let rejectStarted: (error: Error) => void = () => {};
  const started = new Promise<void>((resolveP, rejectP) => {
    resolveStarted = resolveP;
    rejectStarted = rejectP;
  });
  // A caller that never awaits `started` must not turn a refusal into an
  // unhandled rejection that takes the process down; one that does still sees it.
  started.catch(() => {});

  const sleep = async (ms: number): Promise<void> =>
    await new Promise<void>((done) => {
      const wake = (): void => {
        clearTimeout(timer);
        sleepers.delete(wake);
        done();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });

  const nextBackoff = (): number => {
    const delay = reconnectDelaysMs[Math.min(backoffIndex, reconnectDelaysMs.length - 1)]!;
    backoffIndex += 1;
    return delay;
  };

  const baseUrl = (): string => (input.serverUrl ?? state!.serverUrl).replace(/\/+$/, '');

  const nodeHeaders = (): Record<string, string> => ({
    'x-trawlarr-node': state!.nodeId,
    authorization: `Bearer ${state!.secret}`,
  });

  // ---- sending --------------------------------------------------------------

  const sendRaw = (frame: NodeFrame): boolean => {
    const ws = socket;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };

  /** Only a welcomed socket carries job traffic: before `welcome`, the server has not decided our jobs. */
  const send = (frame: NodeFrame): boolean => (welcomed ? sendRaw(frame) : false);

  const sendAgent = (jobId: string, message: AgentToDaemon): boolean =>
    send({ type: 'agent', jobId, message });

  // ---- remote ports ---------------------------------------------------------

  const request = (entry: PendingRequest): void => {
    pending.set(entry.message.id, entry);
    // Sent now if the socket is welcomed; otherwise it stays pending and the
    // next `welcome` that continues this job sends it.
    sendAgent(entry.jobId, entry.message);
  };

  const remoteDocuments = (jobId: string): DocumentPort => {
    const call = async (
      method: DocRequest['method'],
      collection: string,
      docId: string,
      data?: Record<string, unknown>,
      at?: number,
    ): Promise<unknown> =>
      await new Promise<unknown>((resolveCall, rejectCall) => {
        const reason = abandoned.get(jobId);
        if (reason !== undefined) {
          rejectCall(new Error(`This job was abandoned by the server: ${reason}`));
          return;
        }
        const id = nextRequestId++;
        const message: DocRequest = { type: 'doc-request', id, method, collection, docId };
        if (data !== undefined) message.data = data;
        if (at !== undefined) message.nowMs = at;
        request({
          jobId,
          message,
          answer: (reply) => {
            if (reply.type !== 'doc-result') return false;
            if (reply.ok) resolveCall(reply.value);
            else rejectCall(new Error(reply.error));
            return true;
          },
          abandon: (why) => {
            rejectCall(new Error(`This job was abandoned by the server: ${why}`));
          },
        });
      });
    return {
      get: async (collection, docId) =>
        (await call('get', collection, docId)) as Record<string, unknown> | undefined,
      insert: async (collection, docId, data, at) => {
        await call('insert', collection, docId, data, at);
      },
      update: async (collection, docId, patch, at) => {
        await call('update', collection, docId, patch, at);
      },
      removeOne: async (collection, docId) => {
        await call('removeOne', collection, docId);
      },
    };
  };

  /**
   * NEVER GRANTS. A commit waits — across disconnects, for as long as it
   * takes — for a real `commit-result` from the server. The only local answer
   * is a refusal, for a job the server has already abandoned, and a refusal
   * is always safe because it never writes.
   */
  const remoteCommits =
    (jobId: string): CommitPort =>
    async ({ kind, pluginId }) =>
      await new Promise((resolveCommit) => {
        const reason = abandoned.get(jobId);
        if (reason !== undefined) {
          resolveCommit({ granted: false, reason: `This job was abandoned: ${reason}` });
          return;
        }
        const id = nextRequestId++;
        request({
          jobId,
          message: { type: 'commit-request', id, kind, pluginId },
          answer: (reply) => {
            if (reply.type !== 'commit-result') return false;
            resolveCommit({ granted: reply.granted, reason: reply.reason });
            return true;
          },
          abandon: (why) => {
            resolveCommit({ granted: false, reason: `This job was abandoned: ${why}` });
          },
        });
      });

  const pendingFor = (jobId: string): [number, PendingRequest][] =>
    [...pending].filter(([, entry]) => entry.jobId === jobId);

  const resendPending = (jobId: string): void => {
    for (const [, entry] of pendingFor(jobId)) sendAgent(jobId, entry.message);
  };

  const abandonPending = (jobId: string, reason: string): void => {
    for (const [id, entry] of pendingFor(jobId)) {
      pending.delete(id);
      entry.abandon(reason);
    }
  };

  // ---- jobs -----------------------------------------------------------------

  /**
   * Durable FIRST, then sent. A report sent before it is on disk can be lost
   * twice over — the socket drops the frame and a crash drops the memory —
   * and a job whose report never arrives is stalled as vanished even when it
   * replaced the file.
   */
  const holdAndSend = (jobId: string, final: AgentToDaemon): void => {
    running.delete(jobId);
    // The agent is gone: nothing is left to deliver an answer to.
    abandonPending(jobId, 'the run has ended');
    // An entry removed by a welcome's `abandon` or `lost` has nothing to hold:
    // the server has already decided this job, and a report would only be
    // appended to a row that is closed.
    if (journal.get(jobId) === null) return;
    try {
      journal.hold(jobId, final);
    } catch (error) {
      log(`[node] Could not journal the report for job ${jobId}: ${messageOf(error)}`);
    }
    sendAgent(jobId, final);
  };

  const failedMessage = (jobId: string, error: unknown): AgentToDaemon => {
    if (!(error instanceof AgentFailure)) return { type: 'failed', error: messageOf(error) };
    // The server wraps a node's failure in its own "Worker … on node …
    // reported failure:" prefix, so the local handle's copy of it is dropped.
    const prefix = `Worker ${jobId} reported failure: `;
    const text =
      error.reported && error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message;
    return error.superseded
      ? { type: 'failed', error: text, superseded: true }
      : { type: 'failed', error: text };
  };

  const bundleCache = createBundleCache({
    dir: join(dataDir, 'bundles'),
    fetchManifest: async (hash) => {
      const response = await fetchFn(
        `${baseUrl()}${API_PREFIX}/bundles/${encodeURIComponent(hash)}`,
        { headers: nodeHeaders() },
      );
      if (!response.ok) {
        throw new Error(`the server answered ${String(response.status)} for its manifest`);
      }
      return (await response.json()) as unknown;
    },
    fetchFile: async (hash, relPath) => {
      const encoded = relPath.split('/').map(encodeURIComponent).join('/');
      const response = await fetchFn(
        `${baseUrl()}${API_PREFIX}/bundles/${encodeURIComponent(hash)}/files/${encoded}`,
        { headers: nodeHeaders() },
      );
      if (!response.ok) {
        throw new Error(`the server answered ${String(response.status)} for "${relPath}"`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
  });

  const runJob = async (jobId: string, payload: JobPayload): Promise<void> => {
    const pluginPaths: Record<string, string> = { ...payload.pluginPaths };
    for (const [pluginId, { bundle, relPath }] of Object.entries(payload.pluginBundles ?? {})) {
      try {
        const root = await bundleCache.ensure(bundle);
        const path = resolve(root, relPath);
        // The relPath is data from the network; it names a place INSIDE the
        // verified bundle, or nothing.
        if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) {
          throw new Error(`its path "${relPath}" leaves the bundle`);
        }
        pluginPaths[pluginId] = join(root, relPath);
      } catch (error) {
        holdAndSend(jobId, {
          type: 'failed',
          error: `Plugin "${pluginId}" could not be loaded from bundle ${bundle}: ${messageOf(error)}`,
        });
        return;
      }
    }

    if (stopping) return; // left `running` in the journal: the next start reports it lost
    const abandonedReason = abandoned.get(jobId);
    if (abandonedReason !== undefined) {
      holdAndSend(jobId, {
        type: 'failed',
        error: `Abandoned before it started: ${abandonedReason}`,
      });
      return;
    }

    const nodePayload: JobPayload = {
      ...payload,
      pluginPaths,
      logPath: join(dataDir, 'logs', 'jobs', `${jobId}.log`),
      ffmpegPath: input.ffmpegPath,
      ffprobePath: input.ffprobePath,
    };

    let agent: AgentHandle;
    try {
      agent = createAgent({
        id: jobId,
        documents: remoteDocuments(jobId),
        commits: remoteCommits(jobId),
        onStep: (step) => {
          sendAgent(jobId, { type: 'step', step });
        },
        onHeartbeat: (at) => {
          sendAgent(jobId, { type: 'heartbeat', nowMs: at });
        },
        onProgress: (progress) => {
          sendAgent(jobId, { type: 'progress', ...progress });
        },
        onLog: (text) => {
          try {
            journal.appendLog(jobId, text);
          } catch {
            // Liveness only: a log line that cannot be journaled costs detail.
          }
          sendAgent(jobId, { type: 'log', text });
        },
        nowMs,
      });
    } catch (error) {
      holdAndSend(jobId, failedMessage(jobId, error));
      return;
    }
    agents.set(jobId, agent);

    let final: AgentToDaemon;
    try {
      final = { type: 'done', report: await agent.run(nodePayload) };
    } catch (error) {
      final = failedMessage(jobId, error);
    } finally {
      agents.delete(jobId);
    }
    holdAndSend(jobId, final);
  };

  const startJob = (jobId: string, payload: JobPayload): void => {
    if (stopping) return;
    // The server claims per node, so the node enforces no counts of its own;
    // it refuses only to run the same job twice.
    if (running.has(jobId) || journal.get(jobId) !== null) {
      log(`[node] Ignoring a second "job" frame for job ${jobId}, which this node already has.`);
      return;
    }
    try {
      journal.begin(jobId, nowMs());
    } catch (error) {
      log(`[node] Refusing job ${JSON.stringify(jobId)}: ${messageOf(error)}`);
      return;
    }
    known.add(jobId);
    running.add(jobId);
    const run = runJob(jobId, payload)
      .catch((error: unknown) => {
        holdAndSend(jobId, failedMessage(jobId, error));
      })
      .finally(() => {
        runs.delete(jobId);
      });
    runs.set(jobId, run);
  };

  const abandonJob = (jobId: string, reason: string, forget: boolean): void => {
    abandoned.set(jobId, reason);
    agents.get(jobId)?.cancel();
    abandonPending(jobId, reason);
    if (forget) {
      journal.remove(jobId);
      known.delete(jobId);
      lostAtStartup.delete(jobId);
    }
  };

  // ---- libraries ------------------------------------------------------------

  const probeLibrary = async (
    library: NodeConfigFrame['libraries'][number],
  ): Promise<NodeLibraryProbe> => {
    const problems: string[] = [];
    if (library.nodeRoots.length === 0) problems.push('no roots');
    for (const root of library.nodeRoots) {
      if (root === null) {
        problems.push('not mapped');
        continue;
      }
      try {
        if (!(await stat(root)).isDirectory()) problems.push(`${root}: ENOTDIR`);
      } catch (error) {
        problems.push(`${root}: ${codeOf(error) ?? messageOf(error)}`);
      }
    }
    return {
      libraryId: library.libraryId,
      reachable: problems.length === 0,
      detail: problems.join('; '),
    };
  };

  const probeLibraries = async (): Promise<void> => {
    const probed = config;
    if (probed === null) return;
    const libraries = await Promise.all(probed.libraries.map(probeLibrary));
    // A newer config's own probe supersedes this one.
    if (config !== probed) return;
    send({ type: 'libraries', libraries });
  };

  const applyConfig = (frame: NodeConfigFrame): void => {
    config = frame;
    void probeLibraries().catch((error: unknown) => {
      log(`[node] Library probe failed: ${messageOf(error)}`);
    });
  };

  // ---- frames ---------------------------------------------------------------

  const backfill = (jobId: string, logLinesHave: number): void => {
    const entry = journal.get(jobId);
    if (entry === null || logLinesHave >= entry.logLineCount) return;
    const { fromLine, lines } = journal.linesFrom(jobId, logLinesHave);
    if (lines.length > 0) send({ type: 'log-backfill', jobId, fromLine, lines });
  };

  const handleWelcome = (frame: Extract<ServerFrame, { type: 'welcome' }>): void => {
    welcomed = true;
    backoffIndex = 0;
    for (const job of frame.jobs) {
      if (!known.has(job.jobId)) continue;
      switch (job.action) {
        case 'continue':
          backfill(job.jobId, job.logLinesHave);
          resendPending(job.jobId);
          break;
        case 'apply-report': {
          backfill(job.jobId, job.logLinesHave);
          // Re-sent every time it is asked for, even for a job the server
          // has already ended: only `ack-report` lets it go.
          const final = journal.get(job.jobId)?.final ?? null;
          if (final !== null) sendAgent(job.jobId, final);
          break;
        }
        case 'abandon':
          abandonJob(job.jobId, 'the server no longer has this job running on this node', true);
          break;
        case 'lost':
          abandonJob(job.jobId, 'this node restarted while running it', true);
          break;
      }
    }
    applyConfig(frame.config);
    if (probeTimer !== null) clearInterval(probeTimer);
    probeTimer = setInterval(() => {
      void probeLibraries().catch(() => {});
    }, libraryProbeIntervalMs);
    probeTimer.unref();
    if (!announcedConnection) {
      announcedConnection = true;
      resolveStarted();
    }
  };

  const handleFrame = (frame: ServerFrame): void => {
    switch (frame.type) {
      case 'welcome':
        handleWelcome(frame);
        return;
      case 'refused':
        log(
          `[node] The server refused this node: ${frame.reason} Retrying in ` +
            `${String(Math.round(frame.retryAfterMs / 1000))} s.`,
        );
        refusedRetryMs = Math.max(0, frame.retryAfterMs);
        socket?.close(1000, 'refused');
        return;
      case 'config':
        if (!welcomed) return;
        applyConfig(frame);
        return;
      case 'job':
        if (!welcomed) return;
        startJob(frame.jobId, frame.payload);
        return;
      case 'agent': {
        if (!welcomed) return;
        const { message, jobId } = frame;
        if (message.type === 'cancel') {
          agents.get(jobId)?.cancel();
          return;
        }
        if (message.type === 'doc-result' || message.type === 'commit-result') {
          const entry = pending.get(message.id);
          if (entry === undefined || entry.jobId !== jobId) return;
          if (entry.answer(message)) pending.delete(message.id);
        }
        return;
      }
      case 'abandon':
        if (!welcomed) return;
        log(`[node] The server abandoned job ${frame.jobId}: ${frame.reason}`);
        abandonJob(frame.jobId, frame.reason, false);
        return;
      case 'ack-report':
        if (!welcomed) return;
        // Only a HELD report is forgotten. Removing a running job's entry
        // would drop it from the next hello, and the server would release a
        // file this node's agent is still working on.
        if (journal.get(frame.jobId)?.state !== 'held-report') return;
        journal.remove(frame.jobId);
        known.delete(frame.jobId);
        return;
    }
  };

  // ---- the socket -----------------------------------------------------------

  const helloJobs = (): Extract<NodeFrame, { type: 'hello' }>['jobs'] => {
    const jobs: Extract<NodeFrame, { type: 'hello' }>['jobs'] = [];
    for (const jobId of known) {
      const entry = journal.get(jobId);
      if (entry === null) {
        known.delete(jobId);
        continue;
      }
      jobs.push({
        jobId,
        state: lostAtStartup.has(jobId) ? 'lost' : entry.state,
        logLineCount: entry.logLineCount,
      });
    }
    return jobs;
  };

  const armSilence = (ws: WebSocket): void => {
    if (silenceTimer !== null) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      log('[node] The server has been silent for too long; reconnecting.');
      ws.terminate();
    }, SERVER_SILENCE_MS);
    silenceTimer.unref();
  };

  const scheduleReconnect = (delayMs: number): void => {
    if (stopping || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  const connect = (): void => {
    if (stopping) return;
    const url = new URL(`${baseUrl()}${API_PREFIX}/connect`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(url, { headers: nodeHeaders(), perMessageDeflate: false });
    } catch (error) {
      log(`[node] Could not open a connection to ${baseUrl()}: ${messageOf(error)}`);
      scheduleReconnect(nextBackoff());
      return;
    }
    socket = ws;

    ws.on('open', () => {
      if (socket !== ws) return;
      armSilence(ws);
      sendRaw({
        type: 'hello',
        protocolVersion: helloProtocolVersion(),
        buildVersion: DAEMON_VERSION,
        hardwareTypes: input.hardware.available,
        hardwareCaps: input.hardware.caps,
        ffmpegPath: input.ffmpegPath,
        ffprobePath: input.ffprobePath,
        jobs: helloJobs(),
      });
    });
    ws.on('ping', () => {
      if (socket === ws) armSilence(ws);
    });
    ws.on('message', (data: RawData) => {
      if (socket !== ws) return;
      armSilence(ws);
      const frame = parseServerFrame(rawToString(data));
      if (frame === null) return;
      try {
        const wasWelcomed = welcomed;
        const connectedBefore = announcedConnection;
        handleFrame(frame);
        // The first connection is announced by whoever awaits `started`.
        if (!wasWelcomed && welcomed && connectedBefore) {
          log(`[node] Reconnected to ${baseUrl()}.`);
        }
      } catch (error) {
        log(`[node] Handling a "${frame.type}" frame failed: ${messageOf(error)}`);
      }
    });
    ws.on('error', (error: Error) => {
      if (socket === ws && !stopping) log(`[node] Connection error: ${error.message}`);
    });
    ws.on('close', (code: number) => {
      if (socket !== ws) return;
      socket = null;
      welcomed = false;
      if (probeTimer !== null) clearInterval(probeTimer);
      probeTimer = null;
      if (silenceTimer !== null) clearTimeout(silenceTimer);
      silenceTimer = null;
      if (stopping) return;
      if (code === 4000) {
        log(
          `[node] Another connection using this node's identity replaced this one. If a second ` +
            `node process is running with a copy of this node's node.json, stop it.`,
        );
      }
      const delayMs = refusedRetryMs ?? nextBackoff();
      refusedRetryMs = null;
      scheduleReconnect(delayMs);
    });
  };

  // ---- enrollment -----------------------------------------------------------

  const enroll = async (serverUrl: string, token: string): Promise<NodeState | null> => {
    const base = serverUrl.replace(/\/+$/, '');
    while (!stopping) {
      let response: Response;
      try {
        response = await fetchFn(`${base}${API_PREFIX}/enroll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
      } catch (error) {
        const delay = nextBackoff();
        log(`[node] Could not reach ${base} to enroll (${messageOf(error)}); retrying.`);
        await sleep(delay);
        continue;
      }
      if (response.status === 401) throw new NodeSetupError(ENROLLMENT_REFUSED_MESSAGE);
      if (!response.ok) {
        const delay = nextBackoff();
        log(`[node] Enrolling with ${base} failed with HTTP ${String(response.status)}; retrying.`);
        await sleep(delay);
        continue;
      }
      const body = (await response.json()) as { nodeId?: unknown; secret?: unknown };
      if (typeof body.nodeId !== 'string' || typeof body.secret !== 'string') {
        throw new NodeSetupError(
          `The server at ${base} answered enrollment with no node identity.`,
        );
      }
      return { serverUrl, nodeId: body.nodeId, secret: body.secret };
    }
    return null;
  };

  const shutdown = async (): Promise<void> => {
    stopping = true;
    for (const wake of [...sleepers]) wake();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;

    for (const agent of agents.values()) agent.cancel();
    const settled = Promise.all(runs.values()).then(() => {});
    const grace = sleep(STOP_GRACE_MS);
    await Promise.race([settled, grace]);
    // The grace timer is still armed when every run settled first, and an
    // armed timer would hold a stopped node's process open for its full length.
    for (const wake of [...sleepers]) wake();

    if (probeTimer !== null) clearInterval(probeTimer);
    probeTimer = null;
    if (silenceTimer !== null) clearTimeout(silenceTimer);
    silenceTimer = null;
    const ws = socket;
    if (ws !== null) {
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          ws.terminate();
          done();
        }, 1_000);
        ws.once('close', () => {
          clearTimeout(timer);
          done();
        });
        try {
          ws.close(1001, 'node stopping');
        } catch {
          clearTimeout(timer);
          done();
        }
      });
    }
    socket = null;
    welcomed = false;
    releaseLock();
  };

  void (async () => {
    if (state === null) {
      state = await enroll(input.serverUrl!, input.enrollToken!);
      if (state === null) return; // stopped while enrolling
      await writeNodeState(dataDir, state);
      log(`[node] Enrolled with ${input.serverUrl!} as ${state.nodeId}.`);
    }
    connect();
  })().catch((error: unknown) => {
    rejectStarted(error instanceof Error ? error : new Error(messageOf(error)));
    // Nothing more this process can do as a node; the directory is free again.
    stopPromise ??= shutdown();
  });

  return {
    started,
    status: () => ({
      connected: welcomed,
      nodeId: state?.nodeId ?? null,
      running: [...running],
    }),
    stop: async () => {
      stopPromise ??= shutdown();
      await stopPromise;
    },
  };
};
