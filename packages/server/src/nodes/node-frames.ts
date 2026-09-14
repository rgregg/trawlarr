import {
  HARDWARE_TYPES,
  type HardwareType,
  type PathMapping,
  type ScheduleConfig,
} from '@trawlarr/core';
import {
  parseAgentMessage,
  parseDaemonMessage,
  type AgentToDaemon,
  type DaemonToAgent,
} from '../worker/protocol.js';
import type { JobPayload } from '../worker/job-payload.js';

/**
 * The wire format on the node socket: a remote node is a SEPARATE PROCESS,
 * on a separate install, so — same rule as `worker/protocol.ts` — every
 * frame here must be plain JSON. `NodeFrame`/`ServerFrame` are a distinct
 * envelope from `AgentToDaemon`/`DaemonToAgent`, not a replacement for it:
 * a node multiplexes many jobs over one socket, where a forked agent has
 * exactly one, so an `agent` frame carries a `jobId` alongside the message
 * so the daemon (or node host) can route it. A `job` payload travels in its
 * own frame rather than inside an `agent` envelope, because a job start
 * isn't a lifecycle message about an already-assigned job — see
 * `parseServerFrame`, which rejects an enveloped `job` for exactly this
 * reason.
 *
 * This module must never import anything under `../db/` — it is loaded by
 * the node host process, which has no database, and a module-graph test
 * enforces the boundary. `NodeLibraryProbe` therefore lives HERE, and
 * `../db/node-repo.ts` imports the type from here instead of the reverse,
 * so there is exactly one definition either side can use.
 */

/** One library's reachability as probed by a node (Task 2). */
export interface NodeLibraryProbe {
  libraryId: string;
  reachable: boolean;
  detail: string;
}

/**
 * A job's status in the node's own journal, independent of what the daemon
 * currently believes: `held-report` is a completed run whose report the
 * daemon has not yet acknowledged (`ack-report`), and `lost` is a job the
 * node can no longer account for (process died mid-run, journal missing) —
 * both need the daemon's decision, not just its notice.
 */
export type JournalState = 'running' | 'held-report' | 'lost';

const JOURNAL_STATES: ReadonlySet<JournalState> = new Set(['running', 'held-report', 'lost']);

/**
 * The node's opening handshake: identity, capabilities and every job its
 * journal still knows about, so the daemon can decide continue/abandon/
 * apply-report/lost per job in its `welcome` reply rather than guessing
 * from silence.
 */
export interface HelloFrame {
  type: 'hello';
  protocolVersion: number;
  buildVersion: string;
  hardwareTypes: HardwareType[];
  hardwareCaps: Partial<Record<HardwareType, number>>;
  ffmpegPath: string;
  ffprobePath: string;
  jobs: { jobId: string; state: JournalState; logLineCount: number }[];
}

/** Messages a node sends up to the daemon. */
export type NodeFrame =
  | HelloFrame
  | { type: 'agent'; jobId: string; message: AgentToDaemon }
  | { type: 'libraries'; libraries: NodeLibraryProbe[] }
  | { type: 'job-state'; jobId: string; state: JournalState }
  | { type: 'log-backfill'; jobId: string; fromLine: number; lines: string[] };

/**
 * Node-scoped configuration the daemon pushes down: the node's own schedule
 * and pause state, its path map, and every library's roots ALREADY mapped
 * to the node's paths (Task 1's `mapPath`) — the node never maps paths
 * itself, so a path-map edit can't be applied inconsistently between the
 * two sides mid-run.
 */
export interface NodeConfigFrame {
  type: 'config';
  nodeId: string;
  schedule: ScheduleConfig;
  paused: boolean;
  pathMap: PathMapping[];
  /** Server-side roots per library, already mapped to node paths; null when unmapped. */
  libraries: { libraryId: string; name: string; nodeRoots: (string | null)[] }[];
}

/** Messages the daemon sends down to a node. */
export type ServerFrame =
  | {
      type: 'welcome';
      config: NodeConfigFrame;
      jobs: {
        jobId: string;
        action: 'continue' | 'abandon' | 'apply-report' | 'lost';
        logLinesHave: number;
      }[];
    }
  | { type: 'refused'; reason: string; retryAfterMs: number }
  | NodeConfigFrame
  | { type: 'job'; jobId: string; payload: JobPayload }
  | { type: 'agent'; jobId: string; message: DaemonToAgent }
  | { type: 'abandon'; jobId: string; reason: string }
  | { type: 'ack-report'; jobId: string };

/** A frame this large cannot be a legitimate log-backfill or job payload; refuse it before it reaches `JSON.parse`. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isJournalState = (value: unknown): value is JournalState =>
  typeof value === 'string' && JOURNAL_STATES.has(value as JournalState);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isHardwareTypeArray = (value: unknown): value is HardwareType[] =>
  Array.isArray(value) && value.every((entry) => HARDWARE_TYPES.includes(entry as HardwareType));

const isHardwareCaps = (value: unknown): value is Partial<Record<HardwareType, number>> =>
  isRecord(value) &&
  Object.entries(value).every(
    ([key, count]) => HARDWARE_TYPES.includes(key as HardwareType) && typeof count === 'number',
  );

const parseHello = (raw: Record<string, unknown>): HelloFrame | null => {
  if (typeof raw['protocolVersion'] !== 'number') return null;
  if (typeof raw['buildVersion'] !== 'string') return null;
  if (!isHardwareTypeArray(raw['hardwareTypes'])) return null;
  if (!isHardwareCaps(raw['hardwareCaps'])) return null;
  if (typeof raw['ffmpegPath'] !== 'string' || typeof raw['ffprobePath'] !== 'string') return null;
  if (!Array.isArray(raw['jobs'])) return null;
  const jobs: HelloFrame['jobs'] = [];
  for (const entry of raw['jobs']) {
    if (
      !isRecord(entry) ||
      typeof entry['jobId'] !== 'string' ||
      !isJournalState(entry['state']) ||
      typeof entry['logLineCount'] !== 'number'
    ) {
      return null;
    }
    jobs.push({
      jobId: entry['jobId'],
      state: entry['state'],
      logLineCount: entry['logLineCount'],
    });
  }
  return {
    type: 'hello',
    protocolVersion: raw['protocolVersion'],
    buildVersion: raw['buildVersion'],
    hardwareTypes: raw['hardwareTypes'],
    hardwareCaps: raw['hardwareCaps'],
    ffmpegPath: raw['ffmpegPath'],
    ffprobePath: raw['ffprobePath'],
    jobs,
  };
};

const parseLibraryProbes = (value: unknown): NodeLibraryProbe[] | null => {
  if (!Array.isArray(value)) return null;
  const libraries: NodeLibraryProbe[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry['libraryId'] !== 'string' ||
      typeof entry['reachable'] !== 'boolean' ||
      typeof entry['detail'] !== 'string'
    ) {
      return null;
    }
    libraries.push({
      libraryId: entry['libraryId'],
      reachable: entry['reachable'],
      detail: entry['detail'],
    });
  }
  return libraries;
};

const parseConfigFrame = (raw: Record<string, unknown>): NodeConfigFrame | null => {
  if (typeof raw['nodeId'] !== 'string') return null;
  if (!isRecord(raw['schedule'])) return null;
  if (typeof raw['paused'] !== 'boolean') return null;
  if (!Array.isArray(raw['pathMap'])) return null;
  for (const entry of raw['pathMap']) {
    if (
      !isRecord(entry) ||
      typeof entry['serverPath'] !== 'string' ||
      typeof entry['nodePath'] !== 'string'
    ) {
      return null;
    }
  }
  if (!Array.isArray(raw['libraries'])) return null;
  const libraries: NodeConfigFrame['libraries'] = [];
  for (const entry of raw['libraries']) {
    if (
      !isRecord(entry) ||
      typeof entry['libraryId'] !== 'string' ||
      typeof entry['name'] !== 'string' ||
      !Array.isArray(entry['nodeRoots']) ||
      !entry['nodeRoots'].every((root) => root === null || typeof root === 'string')
    ) {
      return null;
    }
    libraries.push({
      libraryId: entry['libraryId'],
      name: entry['name'],
      nodeRoots: entry['nodeRoots'] as (string | null)[],
    });
  }
  return {
    type: 'config',
    nodeId: raw['nodeId'],
    schedule: raw['schedule'] as unknown as ScheduleConfig,
    paused: raw['paused'],
    pathMap: raw['pathMap'] as PathMapping[],
    libraries,
  };
};

/**
 * Narrow a raw string off the node socket to a `NodeFrame`.
 *
 * Follows `worker/protocol.ts`'s rule of dropping rather than duck-typing:
 * the socket carries a third-party install's process, so anything
 * unrecognised — bad JSON, an oversized frame, an inner `agent` message
 * that fails `parseAgentMessage` — comes back `null` rather than a
 * partially-trusted object. The size check runs BEFORE `JSON.parse`
 * because `JSON.parse` itself is the expensive, attacker-controllable step
 * for a many-megabyte string.
 */
export const parseNodeFrame = (raw: string): NodeFrame | null => {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value['type']) {
    case 'hello':
      return parseHello(value);
    case 'agent': {
      if (typeof value['jobId'] !== 'string') return null;
      const message = parseAgentMessage(value['message']);
      return message === null ? null : { type: 'agent', jobId: value['jobId'], message };
    }
    case 'libraries': {
      const libraries = parseLibraryProbes(value['libraries']);
      return libraries === null ? null : { type: 'libraries', libraries };
    }
    case 'job-state':
      return typeof value['jobId'] === 'string' && isJournalState(value['state'])
        ? { type: 'job-state', jobId: value['jobId'], state: value['state'] }
        : null;
    case 'log-backfill':
      return typeof value['jobId'] === 'string' &&
        typeof value['fromLine'] === 'number' &&
        isStringArray(value['lines'])
        ? {
            type: 'log-backfill',
            jobId: value['jobId'],
            fromLine: value['fromLine'],
            lines: value['lines'],
          }
        : null;
    default:
      return null;
  }
};

/**
 * Narrow a raw string off the node socket to a `ServerFrame`.
 *
 * `job` frames are ONLY valid at the top level: an enveloped `{type:'job'}`
 * inside an `agent` message is rejected here even though
 * `parseDaemonMessage` would itself reject it too (`DaemonToAgent` has no
 * `commit-request`/`job` overlap issue) — the explicit check documents that
 * this is a deliberate shape rule, not an accident of what
 * `parseDaemonMessage` happens to allow today.
 */
export const parseServerFrame = (raw: string): ServerFrame | null => {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value['type']) {
    case 'welcome': {
      if (!isRecord(value['config'])) return null;
      const config = parseConfigFrame(value['config']);
      if (config === null) return null;
      if (!Array.isArray(value['jobs'])) return null;
      const jobs: {
        jobId: string;
        action: 'continue' | 'abandon' | 'apply-report' | 'lost';
        logLinesHave: number;
      }[] = [];
      for (const entry of value['jobs']) {
        const action = isRecord(entry) ? entry['action'] : undefined;
        const validAction =
          action === 'continue' ||
          action === 'abandon' ||
          action === 'apply-report' ||
          action === 'lost';
        if (
          !isRecord(entry) ||
          typeof entry['jobId'] !== 'string' ||
          !validAction ||
          typeof entry['logLinesHave'] !== 'number'
        ) {
          return null;
        }
        jobs.push({ jobId: entry['jobId'], action, logLinesHave: entry['logLinesHave'] });
      }
      return { type: 'welcome', config, jobs };
    }
    case 'refused':
      return typeof value['reason'] === 'string' && typeof value['retryAfterMs'] === 'number'
        ? { type: 'refused', reason: value['reason'], retryAfterMs: value['retryAfterMs'] }
        : null;
    case 'config':
      return parseConfigFrame(value);
    case 'job': {
      if (typeof value['jobId'] !== 'string') return null;
      if (!isRecord(value['payload']) || value['payload']['jobId'] !== value['jobId']) return null;
      return {
        type: 'job',
        jobId: value['jobId'],
        payload: value['payload'] as unknown as JobPayload,
      };
    }
    case 'agent': {
      if (typeof value['jobId'] !== 'string') return null;
      const inner = value['message'];
      if (isRecord(inner) && inner['type'] === 'job') return null;
      const message = parseDaemonMessage(inner);
      return message === null ? null : { type: 'agent', jobId: value['jobId'], message };
    }
    case 'abandon':
      return typeof value['jobId'] === 'string' && typeof value['reason'] === 'string'
        ? { type: 'abandon', jobId: value['jobId'], reason: value['reason'] }
        : null;
    case 'ack-report':
      return typeof value['jobId'] === 'string'
        ? { type: 'ack-report', jobId: value['jobId'] }
        : null;
    default:
      return null;
  }
};
