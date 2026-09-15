import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  decideCommit,
  leaseAfterStep,
  leaseIsExpired,
  leaseOnDaemonStart,
  leaseOnDisconnect,
  leaseOnReconnect,
  type HardwareType,
  type Lease,
  type PathMapping,
  type ScheduleConfig,
} from '@trawlarr/core';
import {
  claimUpgradePath,
  denyUpgrade,
  releaseUpgradePath,
  upgradeHandledElsewhere,
} from '../api/ws.js';
import type { EventBus } from '../daemon/events.js';
import type { AgentFactoryInput } from '../daemon/supervisor.js';
import type { Db } from '../db/connection.js';
import { createJobRepo, type JobRow } from '../db/job-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import type { NodeRecord, NodeRepo } from '../db/node-repo.js';
import type { SettingsRepo } from '../db/settings-repo.js';
import { createJobLogWriter, type JobLogWriter } from '../job-log/job-log-writer.js';
import { createPluginRepo } from '../plugins/plugin-repo.js';
import { AgentFailure } from '../worker/agent-handle.js';
import type { JobPayload } from '../worker/job-payload.js';
import { PROTOCOL_VERSION, type AgentToDaemon } from '../worker/protocol.js';
import { DEFAULT_STALE_AFTER_MS } from '../worker/reap-stalled.js';
import type { BundleStore } from './bundles.js';
import { libraryRootsForNode, payloadToNode, UnmappedPathError } from './map-payload.js';
import {
  MAX_FRAME_BYTES,
  parseNodeFrame,
  type HelloFrame,
  type NodeConfigFrame,
  type ServerFrame,
} from './node-frames.js';
import {
  createRemoteAgentHandle,
  type RemoteAgentHandle,
  type RemoteAgentInput,
  type RemoteJobChannel,
} from './remote-agent.js';

/** Where nodes connect, on the SAME port as the REST API and the event stream. */
export const NODE_SOCKET_PATH = '/api/v1/nodes/connect';

/** How long a node refused for a protocol mismatch should wait before retrying. */
const PROTOCOL_REFUSAL_RETRY_MS = 300_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_OFFLINE_AFTER_MS = 45_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** Close codes a node host acts on. */
export const NODE_CLOSE_REPLACED = 4000;
export const NODE_CLOSE_NO_HELLO = 4001;
export const NODE_CLOSE_PROTOCOL = 4002;
export const NODE_CLOSE_DISCONNECTED = 4003;
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_GOING_AWAY = 1001;

const NODE_UNAUTHORIZED_MESSAGE =
  `This node socket upgrade was not authorised. Send "X-Trawlarr-Node: <nodeId>" and ` +
  `"Authorization: Bearer <secret>" — the secret returned when the node enrolled.`;

export interface OnlineNode {
  nodeId: string;
  schedule: ScheduleConfig;
  paused: boolean;
  hardware: { available: HardwareType[]; caps: Partial<Record<HardwareType, number>> };
  reachableLibraryIds: ReadonlySet<string>;
}

/** An adopted job: the handle to settle it through, and the server-view payload to settle. */
export interface AdoptedJob {
  payload: JobPayload;
  agent: RemoteAgentHandle;
  nodeId: string;
}

/**
 * Remote-node connection management: the REST layer's three calls
 * (`isOnline`, `pushConfig`, `disconnect`) plus what the daemon needs to run
 * jobs on nodes.
 */
export interface NodeHub {
  attach(server: Server): void;
  isOnline(nodeId: string): boolean;
  onlineNodes(): OnlineNode[];
  pushConfig(nodeId: string): void;
  /** Push config to every online node: what a library create/edit/delete needs. */
  pushConfigAll(): void;
  disconnect(nodeId: string, reason: string): void;
  createAgent(input: AgentFactoryInput & { nodeId: string }): RemoteAgentHandle;
  /**
   * Daemon start: rebuild a handle for every leased job, moving leases to
   * grace from now. `inputFor` supplies the supervisor's sinks for each one,
   * exactly as `createAgent`'s input does for a fresh job — without them an
   * adopted job's steps and heartbeats would have nowhere to go.
   */
  adoptLeasedJobs(
    inputFor: (payload: JobPayload, nodeId: string) => AgentFactoryInput,
  ): AdoptedJob[];
  sweepLeases(): void;
  close(): Promise<void>;
}

export interface CreateNodeHubInput {
  db: Db;
  nodes: NodeRepo;
  bundles: BundleStore;
  settings: SettingsRepo;
  bus: EventBus;
  nowMs: () => number;
  buildVersion: string;
  /** Hook the supervisor tick so a node coming online (or its config changing) starts work promptly. */
  onNodesChanged: () => void;
  pingIntervalMs?: number;
  offlineAfterMs?: number;
  helloTimeoutMs?: number;
  /**
   * Where a failure that must not take a node's connection down is reported
   * (an unwritable job log, a rejected upgrade). Defaults to stderr.
   */
  onError?: (context: string, error: unknown) => void;
  /** Seam for tests: how a replaced path is stat'd on this server (`RemoteAgentInput.statPath`). */
  statPath?: RemoteAgentInput['statPath'];
}

/** A hub with no nodes: what an API context built without the daemon's real hub gets. */
export const createNoopNodeHub = (): NodeHub => ({
  attach: () => {},
  isOnline: () => false,
  onlineNodes: () => [],
  pushConfig: () => {},
  pushConfigAll: () => {},
  disconnect: () => {},
  createAgent: () => {
    throw new Error('No node hub is running, so no job can be sent to a remote node.');
  },
  adoptLeasedJobs: () => [],
  sweepLeases: () => {},
  close: () => Promise.resolve(),
});

interface Connection {
  ws: WebSocket;
  nodeId: string;
  helloSeen: boolean;
  /** Handshake complete: jobs and config may be sent. */
  welcomed: boolean;
  lastPongAt: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
  /**
   * A `libraries` probe has arrived since the last config this socket was
   * sent (welcome included). Until one does, the stored probe describes the
   * library list and map the node HAD, and a claim made from it can fail to
   * map — so no library counts as reachable on this node.
   */
  probeFresh: boolean;
}

type WelcomeJob = Extract<ServerFrame, { type: 'welcome' }>['jobs'][number];

const rawToString = (data: RawData): string => {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
};

/** A WebSocket close reason is capped at 123 bytes, and `ws` throws past it. */
const closeReason = (text: string): string => {
  let reason = text;
  while (Buffer.byteLength(reason, 'utf8') > 123) reason = reason.slice(0, -1);
  return reason;
};

const leaseOf = (row: JobRow): Lease | null =>
  row.leaseState === null ? null : { state: row.leaseState, expiresAtMs: row.leaseExpiresAt };

const sameLease = (a: Lease, b: Lease): boolean =>
  a.state === b.state && a.expiresAtMs === b.expiresAtMs;

/** Lines already in the server's copy of a job log: what a reconnecting node need not resend. */
const countLogLines = (path: string | null): number => {
  if (path === null) return 0;
  try {
    const bytes = readFileSync(path);
    let lines = 0;
    for (const byte of bytes) if (byte === 0x0a) lines += 1;
    return lines;
  } catch {
    return 0;
  }
};

/**
 * The daemon side of the node socket.
 *
 * WHAT THIS OWNS IS THE GUARANTEE THAT A FILE IS NEVER WRITTEN BY TWO
 * WORKERS. A remote node can go quiet for reasons that say nothing about its
 * encode, so a disconnect only moves its jobs' leases to `grace`; the job
 * keeps running on the node. When grace runs out the file is released (the
 * handle's `run` rejects and the supervisor stalls the attempt), and from
 * that moment `decideCommit` refuses the old node, so if it comes back it
 * cannot install over whatever the next worker does.
 *
 * It writes no ledger state. Every outcome is delivered to a
 * `RemoteAgentHandle`, and the supervisor settles that exactly as it settles
 * a local fork. The only direct job-row writes here are leases, and the
 * appended note for a result that arrived after its job was released.
 */
export const createNodeHub = (input: CreateNodeHubInput): NodeHub => {
  const { db, nodes, bundles, settings, bus, nowMs } = input;
  const reportError =
    input.onError ??
    ((context: string, error: unknown) => {
      console.error(
        `[nodes] ${context}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  const jobRepo = createJobRepo(db);
  const mediaFileRepo = createMediaFileRepo(db);
  const libraryRepo = createLibraryRepo(db);
  const pluginRepo = createPluginRepo(db);
  const pingIntervalMs = input.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const offlineAfterMs = input.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
  const helloTimeoutMs = input.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });

  /** The CURRENT socket per node. A replaced socket is no longer in here. */
  const connections = new Map<string, Connection>();
  /** Every job with a live (unsettled) remote handle. */
  const handles = new Map<string, RemoteAgentHandle>();
  /** The server-view `payload.logPath` of each live job. */
  const logPaths = new Map<string, string | null>();
  const logWriters = new Map<string, JobLogWriter>();

  let server: Server | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let closing = false;

  const nodeName = (nodeId: string): string => nodes.getById(nodeId)?.name ?? nodeId;

  const sendFrame = (conn: Connection, frame: ServerFrame): boolean => {
    if (conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };

  const welcomedConnection = (nodeId: string): Connection | null => {
    const conn = connections.get(nodeId);
    return conn !== undefined && conn.welcomed ? conn : null;
  };

  const channelFor = (nodeId: string): RemoteJobChannel | null => {
    const conn = welcomedConnection(nodeId);
    if (conn === null) return null;
    return { send: (frame) => sendFrame(conn, frame) };
  };

  // ---- job logs -----------------------------------------------------------

  /** Jobs whose server log could not be written: reported once, then skipped. */
  const failedLogs = new Set<string>();

  /**
   * NEVER THROWS. Logs are liveness only (worker/protocol.ts), and this runs
   * inside a node's frame handler: a full disk or an unwritable log directory
   * that escaped here would close the node's socket, which moves every one of
   * its leases to grace and stalls work that has nothing wrong with it.
   */
  const appendLogLines = (jobId: string, lines: readonly string[]): void => {
    if (lines.length === 0 || failedLogs.has(jobId)) return;
    let writer = logWriters.get(jobId);
    let transient = false;
    try {
      if (writer === undefined) {
        const path = logPaths.get(jobId) ?? jobRepo.getById(jobId)?.logPath ?? null;
        if (path === null) return;
        writer = createJobLogWriter({ path });
        // A live job keeps its writer until it settles; a backfill for a job
        // with no live handle opens, writes and closes.
        if (handles.has(jobId)) logWriters.set(jobId, writer);
        else transient = true;
      }
      for (const line of lines) writer.append(line);
    } catch (error) {
      failedLogs.add(jobId);
      closeLogWriter(jobId);
      reportError(`the server log for job ${jobId} could not be written`, error);
    } finally {
      if (transient) {
        try {
          writer?.close();
        } catch {
          // already reported, or nothing left to close
        }
      }
    }
  };

  const closeLogWriter = (jobId: string): void => {
    const writer = logWriters.get(jobId);
    logWriters.delete(jobId);
    try {
      writer?.close();
    } catch (error) {
      reportError(`the server log for job ${jobId} could not be closed`, error);
    }
  };

  // ---- leases -------------------------------------------------------------

  const setLeaseIfChanged = (jobId: string, current: Lease, next: Lease): void => {
    if (!sameLease(current, next)) jobRepo.setLease({ jobId, lease: next });
  };

  /**
   * Release a job's claim: the lease is marked `expired` (which is also what
   * tells a late result apart from a duplicate of one already applied), the
   * handle's run rejects so the supervisor stalls the attempt, and the node
   * is told to stop if it is connected.
   */
  const release = (row: { jobId: string; nodeId: string; lease: Lease }, message: string): void => {
    jobRepo.setLease({
      jobId: row.jobId,
      lease: { state: 'expired', expiresAtMs: row.lease.expiresAtMs },
    });
    const handle = handles.get(row.jobId);
    if (handle !== undefined) {
      handle.abandon(new AgentFailure(message, { reported: false }));
      return;
    }
    const conn = welcomedConnection(row.nodeId);
    if (conn !== null) sendFrame(conn, { type: 'abandon', jobId: row.jobId, reason: message });
  };

  const graceMessage = (nodeId: string): string =>
    `Node ${nodeName(nodeId)} was offline for longer than the ` +
    `${String(Math.round(settings.getNodes().leaseGraceMs / 60_000))}-minute grace window, ` +
    `so this file was released.`;

  const lostMessage = (nodeId: string): string =>
    `Node ${nodeName(nodeId)} restarted while running this job.`;

  const decideCommitFor = (
    jobId: string,
    request: { kind: 'replace' | 'plugin' },
  ): { granted: boolean; reason: string | null } => {
    const row = jobRepo.getById(jobId);
    const lease = row === null ? null : leaseOf(row);
    if (row === null || row.endedAt !== null || lease === null) {
      return { granted: false, reason: 'This job is no longer running on the server.' };
    }
    // Read from the row, not only the handle's memory: a cancel made before
    // a daemon restart must still stop the install after it.
    if (row.cancelRequestedAt !== null) {
      return {
        granted: false,
        reason: 'This job was cancelled, so it may not write to the library.',
      };
    }
    const file = mediaFileRepo.getById(row.fileId);
    const latest = jobRepo.listForFile(row.fileId)[0];
    const stillClaimed =
      file !== null &&
      file.state === 'running' &&
      latest !== undefined &&
      latest.id === jobId &&
      latest.endedAt === null;
    const decision = decideCommit({ lease, nowMs: nowMs(), stillClaimed, kind: request.kind });
    if (!decision.granted) return { granted: false, reason: decision.reason };
    // A granted `committing` lease is never expired by grace. If the node
    // vanishes mid-install it is reclaimed only by the 24 h floor, BY DESIGN:
    // it may be halfway through swapping the file, and handing that file to
    // another worker on a shorter clock is exactly the two-writer case.
    setLeaseIfChanged(jobId, lease, decision.lease);
    return { granted: true, reason: null };
  };

  const stepLeaseFor = (jobId: string): void => {
    const row = jobRepo.getById(jobId);
    const lease = row === null ? null : leaseOf(row);
    if (row === null || row.endedAt !== null || lease === null) return;
    setLeaseIfChanged(jobId, lease, leaseAfterStep(lease));
  };

  // ---- handles ------------------------------------------------------------

  const register = (handle: RemoteAgentHandle, payload: JobPayload): void => {
    const { jobId } = payload;
    handles.set(jobId, handle);
    logPaths.set(jobId, payload.logPath);
    handle.exited
      .then(() => {
        // Only unsettled handles live here, so a frame for a settled job is
        // routed by its row (a late result, or a duplicate) instead.
        if (handles.get(jobId) === handle) handles.delete(jobId);
        logPaths.delete(jobId);
        failedLogs.delete(jobId);
        closeLogWriter(jobId);
      })
      .catch((error: unknown) => {
        reportError(`cleaning up after job ${jobId} failed`, error);
      });
  };

  const prepareFor = async (
    nodeId: string,
    payload: JobPayload,
  ): Promise<{ payload: JobPayload; pathMap: PathMapping[] }> => {
    const node = nodes.getById(nodeId);
    if (node === null) throw new Error(`Node "${nodeId}" is not registered on this server.`);
    const ids = [...new Set(payload.flow.definition.nodes.map((flowNode) => flowNode.pluginId))];
    const pluginBundles: JobPayload['pluginBundles'] = {};
    for (const [id, { root, relPath }] of Object.entries(pluginRepo.resolveBundleRoots(ids))) {
      const { hash } = await bundles.manifestFor(root);
      pluginBundles[id] = { bundle: hash, relPath };
    }
    return {
      payload: payloadToNode({ ...payload, pluginBundles }, node.pathMap),
      pathMap: node.pathMap,
    };
  };

  const buildHandle = (
    factory: AgentFactoryInput,
    options: {
      nodeId: string;
      fresh: boolean;
      pathMap?: readonly PathMapping[];
      cancelRequested?: boolean;
    },
  ): RemoteAgentHandle => {
    const remoteInput: RemoteAgentInput = {
      ...factory,
      nodeId: options.nodeId,
      fresh: options.fresh,
      ...(options.pathMap === undefined ? {} : { pathMap: options.pathMap }),
      cancelRequested: options.cancelRequested === true,
      jobs: jobRepo,
      channel: () => channelFor(options.nodeId),
      decideCommit: (request) =>
        handle.jobId === null
          ? { granted: false, reason: 'This job has not started.' }
          : decideCommitFor(handle.jobId, request),
      onStepLease: () => {
        if (handle.jobId !== null) stepLeaseFor(handle.jobId);
      },
      prepare: async (payload) => {
        register(handle, payload);
        try {
          return await prepareFor(options.nodeId, payload);
        } catch (error) {
          // The node's probe no longer matches what a claim would send it.
          // Without this, a requeued file is claimed straight back onto the
          // same node, fails to map again, and loops without spending an
          // attempt; stale, the node takes no claim until it re-probes.
          if (error instanceof UnmappedPathError) {
            const conn = connections.get(options.nodeId);
            if (conn !== undefined) conn.probeFresh = false;
          }
          throw error;
        }
      },
      appendLog: (text) => {
        if (handle.jobId !== null) appendLogLines(handle.jobId, [text]);
      },
      ...(input.statPath === undefined ? {} : { statPath: input.statPath }),
    };
    const handle = createRemoteAgentHandle(remoteInput);
    return handle;
  };

  // ---- handshake ----------------------------------------------------------

  const configFrame = (node: NodeRecord): NodeConfigFrame => ({
    type: 'config',
    nodeId: node.id,
    schedule: node.schedule,
    paused: node.paused,
    pathMap: node.pathMap,
    libraries: libraryRepo.list().map((library) => ({
      libraryId: library.id,
      name: library.name,
      nodeRoots: libraryRootsForNode(library, node.pathMap),
    })),
  });

  /**
   * The spec's re-attach table, one journal entry at a time. Abandons made
   * here send nothing themselves (the connection is not welcomed yet); the
   * welcome's per-job action carries the decision to the node.
   */
  const reconcile = (
    nodeId: string,
    journal: HelloFrame['jobs'],
    now: number,
  ): { jobs: WelcomeJob[]; reconnect: RemoteAgentHandle[]; cancelWithoutHandle: string[] } => {
    const jobs: WelcomeJob[] = [];
    const reconnect: RemoteAgentHandle[] = [];
    const cancelWithoutHandle: string[] = [];
    const mentioned = new Set<string>();

    for (const entry of journal) {
      mentioned.add(entry.jobId);
      const row = jobRepo.getById(entry.jobId);
      if (row === null || row.nodeId !== nodeId) {
        // Not a job this server gave this node: nothing to continue or apply.
        jobs.push({ jobId: entry.jobId, action: 'abandon', logLinesHave: 0 });
        continue;
      }
      const logLinesHave = countLogLines(logPaths.get(row.id) ?? row.logPath);
      const lease = leaseOf(row);
      const live = row.endedAt === null && lease !== null && lease.state !== 'expired';
      const handle = handles.get(row.id);

      switch (entry.state) {
        case 'running': {
          if (live) {
            const next = leaseOnReconnect(lease, now);
            if (next.state !== 'expired') {
              setLeaseIfChanged(row.id, lease, next);
              if (handle !== undefined) reconnect.push(handle);
              else if (row.cancelRequestedAt !== null) cancelWithoutHandle.push(row.id);
              jobs.push({ jobId: row.id, action: 'continue', logLinesHave });
              break;
            }
            // Grace ran out and the sweep has not noticed yet: release now,
            // before the node can reach its commit gate.
            release({ jobId: row.id, nodeId, lease }, graceMessage(nodeId));
          }
          jobs.push({ jobId: row.id, action: 'abandon', logLinesHave });
          break;
        }
        case 'held-report': {
          // The run finished while the node held its claim (every commit it
          // made was granted), so a still-claimed job's report is applied.
          // An ENDED job's report is also requested: it arrives as a late
          // result, appended to the closed row with no ledger change.
          // No clock check before moving grace → connected: the report is
          // already finished, and every commit it made was granted under a
          // then-valid lease. What remains is delivering it, and a grace
          // lease that ran out mid-delivery must not refuse a result whose
          // file is still claimed by this very job.
          if (live && lease.state === 'grace') {
            jobRepo.setLease({ jobId: row.id, lease: { state: 'connected', expiresAtMs: null } });
          }
          if (live && handle !== undefined) reconnect.push(handle);
          jobs.push({ jobId: row.id, action: 'apply-report', logLinesHave });
          break;
        }
        case 'lost': {
          if (live) release({ jobId: row.id, nodeId, lease }, lostMessage(nodeId));
          jobs.push({ jobId: row.id, action: 'lost', logLinesHave });
          break;
        }
      }
    }

    // A leased job the node no longer knows about was lost with it.
    for (const leased of jobRepo.listLeased()) {
      if (leased.nodeId !== nodeId || mentioned.has(leased.jobId)) continue;
      if (leased.lease.state === 'expired') continue;
      release(leased, lostMessage(nodeId));
    }

    return { jobs, reconnect, cancelWithoutHandle };
  };

  const handleHello = (conn: Connection, hello: HelloFrame): void => {
    conn.helloSeen = true;
    if (conn.helloTimer !== null) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      sendFrame(conn, {
        type: 'refused',
        reason:
          `This server speaks node protocol version ${String(PROTOCOL_VERSION)}, but this node ` +
          `speaks version ${String(hello.protocolVersion)}. Upgrade whichever is older so they match.`,
        retryAfterMs: PROTOCOL_REFUSAL_RETRY_MS,
      });
      conn.ws.close(NODE_CLOSE_PROTOCOL, 'protocol version mismatch');
      return;
    }

    const now = nowMs();
    nodes.recordHello(conn.nodeId, {
      buildVersion: hello.buildVersion,
      hardwareTypes: hello.hardwareTypes,
      hardwareCaps: hello.hardwareCaps,
      ffmpegPath: hello.ffmpegPath,
      ffprobePath: hello.ffprobePath,
      nowMs: now,
    });
    const node = nodes.getById(conn.nodeId);
    if (node === null) {
      conn.ws.close(NODE_CLOSE_DISCONNECTED, 'node removed');
      return;
    }

    const { jobs, reconnect, cancelWithoutHandle } = reconcile(conn.nodeId, hello.jobs, now);
    conn.welcomed = true;
    // The welcome carries config; the node re-probes on receiving it.
    conn.probeFresh = false;
    sendFrame(conn, { type: 'welcome', config: configFrame(node), jobs });
    // After the welcome, so a cancel queued while the node was away reaches
    // a node that already knows the job continues.
    for (const handle of reconnect) handle.reconnected();
    for (const jobId of cancelWithoutHandle) {
      sendFrame(conn, { type: 'agent', jobId, message: { type: 'cancel' } });
    }
    input.onNodesChanged();
    bus.emit({ type: 'nodes.changed', nodeId: conn.nodeId, online: true });
  };

  // ---- frames -------------------------------------------------------------

  const handleAgentFrame = (conn: Connection, jobId: string, message: AgentToDaemon): void => {
    const row = jobRepo.getById(jobId);
    // A node speaks only for its own jobs.
    if (row === null || row.nodeId !== conn.nodeId) return;

    const handle = handles.get(jobId);
    if (handle !== undefined) {
      handle.receive(message);
      return;
    }

    switch (message.type) {
      case 'done':
      case 'failed': {
        // Not ended and no handle: nothing here can settle it yet. The node
        // keeps holding the report and offers it again on reconnect.
        if (row.endedAt === null) return;
        if (row.leaseState === 'expired') {
          const result = message.type === 'done' ? message.report.outcome : message.error;
          jobRepo.appendOutcome({
            jobId,
            text:
              `A late result arrived from node ${nodeName(conn.nodeId)} after this job was ` +
              `released: ${result}`,
          });
        }
        // Otherwise this is a duplicate of a report already applied, whose
        // ack was lost with the connection: acknowledged, never re-applied.
        sendFrame(conn, { type: 'ack-report', jobId });
        return;
      }
      case 'commit-request':
        // Answered, never left waiting — and never granted.
        sendFrame(conn, {
          type: 'agent',
          jobId,
          message: {
            type: 'commit-result',
            id: message.id,
            granted: false,
            reason: 'This job is no longer running on the server.',
          },
        });
        return;
      case 'doc-request':
        sendFrame(conn, {
          type: 'agent',
          jobId,
          message: {
            type: 'doc-result',
            id: message.id,
            ok: false,
            error: 'This job is no longer running on the server.',
          },
        });
        return;
      default:
        return;
    }
  };

  const handleMessage = (conn: Connection, data: RawData): void => {
    // Checked before ANYTHING, hello included: a replaced socket no longer
    // speaks for its node, and a hello it sent late would otherwise record its
    // stale journal and reconcile leases over the current connection's.
    if (connections.get(conn.nodeId) !== conn) return;
    const frame = parseNodeFrame(rawToString(data));
    if (!conn.helloSeen) {
      if (frame === null || frame.type !== 'hello') {
        conn.ws.close(NODE_CLOSE_NO_HELLO, 'the first frame must be hello');
        return;
      }
      handleHello(conn, frame);
      return;
    }
    // Nothing but a welcomed socket may act on jobs.
    if (frame === null || !conn.welcomed) return;

    switch (frame.type) {
      case 'hello':
        return;
      case 'agent':
        handleAgentFrame(conn, frame.jobId, frame.message);
        return;
      case 'libraries':
        nodes.recordLibraries(conn.nodeId, frame.libraries);
        conn.probeFresh = true;
        input.onNodesChanged();
        bus.emit({ type: 'nodes.changed', nodeId: conn.nodeId, online: true });
        return;
      case 'log-backfill': {
        const row = jobRepo.getById(frame.jobId);
        if (row === null || row.nodeId !== conn.nodeId) return;
        appendLogLines(
          frame.jobId,
          frame.lines.map((line, index) => (index === 0 ? `[backfill] ${line}` : line)),
        );
        return;
      }
      case 'job-state': {
        if (frame.state !== 'lost') return;
        const row = jobRepo.getById(frame.jobId);
        const lease = row === null ? null : leaseOf(row);
        if (row === null || row.nodeId !== conn.nodeId || row.endedAt !== null) return;
        if (lease === null || lease.state === 'expired') return;
        release({ jobId: row.id, nodeId: conn.nodeId, lease }, lostMessage(conn.nodeId));
        return;
      }
    }
  };

  const handleClose = (conn: Connection): void => {
    if (conn.helloTimer !== null) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    conn.welcomed = false;
    if (closing || connections.get(conn.nodeId) !== conn) return;
    connections.delete(conn.nodeId);

    const now = nowMs();
    const graceMs = settings.getNodes().leaseGraceMs;
    for (const leased of jobRepo.listLeased()) {
      if (leased.nodeId !== conn.nodeId) continue;
      setLeaseIfChanged(leased.jobId, leased.lease, leaseOnDisconnect(leased.lease, now, graceMs));
    }
    nodes.touch(conn.nodeId, now);
    input.onNodesChanged();
    bus.emit({ type: 'nodes.changed', nodeId: conn.nodeId, online: false });
  };

  /** A daemon must never be taken down by one node's frame; the socket is. */
  const guarded =
    <A extends unknown[]>(conn: Connection, fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch {
        try {
          conn.ws.close(CLOSE_INTERNAL_ERROR, 'server error');
        } catch {
          // already closing
        }
      }
    };

  const onConnection = (ws: WebSocket, nodeId: string): void => {
    const conn: Connection = {
      ws,
      nodeId,
      helloSeen: false,
      welcomed: false,
      lastPongAt: nowMs(),
      helloTimer: null,
      probeFresh: false,
    };
    const previous = connections.get(nodeId);
    connections.set(nodeId, conn);
    if (previous !== undefined) {
      // A node that restarted fast must not be refused by its own ghost.
      // The old socket's close no longer moves leases (it is not current);
      // the new hello decides every job.
      previous.welcomed = false;
      previous.ws.close(NODE_CLOSE_REPLACED, 'replaced');
    }
    conn.helloTimer = setTimeout(() => {
      conn.helloTimer = null;
      if (!conn.helloSeen) ws.close(NODE_CLOSE_NO_HELLO, 'no hello');
    }, helloTimeoutMs);
    conn.helloTimer.unref?.();

    ws.on('pong', () => {
      conn.lastPongAt = nowMs();
    });
    ws.on(
      'message',
      guarded(conn, (data: RawData) => {
        handleMessage(conn, data);
      }),
    );
    ws.on(
      'close',
      guarded(conn, () => {
        handleClose(conn);
      }),
    );
    ws.on('error', () => {
      // 'close' follows and does the bookkeeping.
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const attached = server;
    if (attached === null) return;
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== NODE_SOCKET_PATH) {
      if (upgradeHandledElsewhere(attached, pathname, socket)) return;
      denyUpgrade(socket, 404, 'not-found', `No WebSocket endpoint at "${pathname}".`);
      return;
    }

    socket.on('error', () => {
      socket.destroy();
    });
    void (async () => {
      const idHeader = req.headers['x-trawlarr-node'];
      const nodeId = Array.isArray(idHeader) ? idHeader[0] : idHeader;
      const auth = req.headers.authorization;
      let ok = false;
      if (nodeId !== undefined && auth !== undefined && auth.startsWith('Bearer ')) {
        try {
          ok = await nodes.authenticate({ nodeId, secret: auth.slice('Bearer '.length) });
        } catch {
          ok = false;
        }
      }
      if (closing) {
        socket.destroy();
        return;
      }
      // Refused BEFORE the handshake, so a node with a bad secret sees a 401
      // it can report rather than a socket that opens and drops.
      if (!ok || nodeId === undefined) {
        denyUpgrade(socket, 401, 'unauthorized', NODE_UNAUTHORIZED_MESSAGE);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws, nodeId);
      });
    })().catch((error: unknown) => {
      // A backstop: nothing above should throw, but an upgrade handler's
      // rejection would be unhandled, and that takes the whole daemon down.
      reportError('a node socket upgrade failed', error);
      socket.destroy();
    });
  };

  const pushConfigTo = (nodeId: string): void => {
    const conn = welcomedConnection(nodeId);
    const node = nodes.getById(nodeId);
    if (conn !== null && node !== null) {
      conn.probeFresh = false;
      sendFrame(conn, configFrame(node));
    }
  };

  const pingAll = (): void => {
    const now = nowMs();
    for (const conn of connections.values()) {
      if (now - conn.lastPongAt > offlineAfterMs) {
        conn.ws.terminate();
        continue;
      }
      try {
        conn.ws.ping();
      } catch {
        // closing; 'close' handles it
      }
    }
  };

  return {
    attach: (target) => {
      server = target;
      claimUpgradePath(target, NODE_SOCKET_PATH);
      target.on('upgrade', onUpgrade);
      pingTimer = setInterval(pingAll, pingIntervalMs);
      pingTimer.unref();
    },

    isOnline: (nodeId) => welcomedConnection(nodeId) !== null,

    onlineNodes: () => {
      const online: OnlineNode[] = [];
      const libraries = new Map(libraryRepo.list().map((library) => [library.id, library]));
      for (const conn of connections.values()) {
        if (!conn.welcomed) continue;
        const node = nodes.getById(conn.nodeId);
        if (node === null || node.revokedAt !== null) continue;
        // A probe only vouches for the roots the node was sent. Every root
        // must also map under the map as it is NOW, or a claim made on the
        // strength of that probe fails in `prepare` with UnmappedPathError.
        const reachable = conn.probeFresh
          ? node.libraries.filter((probe) => {
              const library = libraries.get(probe.libraryId);
              return (
                probe.reachable &&
                library !== undefined &&
                libraryRootsForNode(library, node.pathMap).every((root) => root !== null)
              );
            })
          : [];
        online.push({
          nodeId: node.id,
          schedule: node.schedule,
          paused: node.paused,
          hardware: { available: node.hardwareTypes, caps: node.hardwareCaps },
          reachableLibraryIds: new Set(reachable.map((probe) => probe.libraryId)),
        });
      }
      return online;
    },

    pushConfig: (nodeId) => {
      pushConfigTo(nodeId);
      input.onNodesChanged();
    },

    pushConfigAll: () => {
      for (const conn of connections.values()) {
        if (conn.welcomed) pushConfigTo(conn.nodeId);
      }
      input.onNodesChanged();
    },

    disconnect: (nodeId, reason) => {
      connections.get(nodeId)?.ws.close(NODE_CLOSE_DISCONNECTED, closeReason(reason));
    },

    createAgent: (factory) => {
      const { nodeId, ...rest } = factory;
      return buildHandle(rest, { nodeId, fresh: true });
    },

    adoptLeasedJobs: (inputFor) => {
      const now = nowMs();
      const graceMs = settings.getNodes().leaseGraceMs;
      return jobRepo.listLeased().map((leased) => {
        const next = leaseOnDaemonStart(leased.lease, now, graceMs);
        setLeaseIfChanged(leased.jobId, leased.lease, next);
        const payload = JSON.parse(leased.payloadJson) as JobPayload;
        const pathMap = JSON.parse(leased.pathMapJson) as PathMapping[];
        const handle = buildHandle(inputFor(payload, leased.nodeId), {
          nodeId: leased.nodeId,
          fresh: false,
          pathMap,
          cancelRequested: jobRepo.getById(leased.jobId)?.cancelRequestedAt != null,
        });
        register(handle, payload);
        if (next.state === 'expired') {
          // Released before the restart, and the daemon died before the
          // attempt was settled: settle it now rather than leave it running.
          handle.abandon(
            new AgentFailure(
              `Node ${nodeName(leased.nodeId)}'s claim on this file had already been released.`,
              { reported: false },
            ),
          );
        }
        return { payload, agent: handle, nodeId: leased.nodeId };
      });
    },

    sweepLeases: () => {
      const now = nowMs();
      for (const leased of jobRepo.listLeased()) {
        if (leased.lease.state === 'expired') continue;
        if (leaseIsExpired(leased.lease, now)) {
          release(leased, graceMessage(leased.nodeId));
          continue;
        }
        if (leased.lease.state !== 'connected' && leased.lease.state !== 'committing') continue;
        const row = jobRepo.getById(leased.jobId);
        if (row === null) continue;
        // The same day-long floor every job has: a connected node that has
        // said nothing about this job for 24 hours is not running it.
        if (now - (row.heartbeatAt ?? row.startedAt) > DEFAULT_STALE_AFTER_MS) {
          release(
            leased,
            `Node ${nodeName(leased.nodeId)} sent no sign of life for this job in ` +
              `${String(Math.round(DEFAULT_STALE_AFTER_MS / 3_600_000))} hours, so this file was released.`,
          );
        }
      }
    },

    close: async () => {
      closing = true;
      if (pingTimer !== null) clearInterval(pingTimer);
      pingTimer = null;
      if (server !== null) {
        server.removeListener('upgrade', onUpgrade);
        releaseUpgradePath(server, NODE_SOCKET_PATH);
      }
      for (const conn of connections.values()) {
        if (conn.helloTimer !== null) clearTimeout(conn.helloTimer);
        conn.welcomed = false;
        try {
          conn.ws.close(CLOSE_GOING_AWAY, 'server shutting down');
        } catch {
          // already closed
        }
        conn.ws.terminate();
      }
      connections.clear();
      for (const jobId of [...logWriters.keys()]) closeLogWriter(jobId);
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
  };
};
