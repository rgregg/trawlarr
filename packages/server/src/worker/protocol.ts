import type { StepRecord } from '@trawlarr/engine';
import type { JobPayload } from './job-payload.js';
import type { JobReport } from './run-payload.js';

/**
 * The wire format between the daemon and one worker agent.
 *
 * ONE definition, used by both ends, and deliberately written as a WIRE
 * format rather than an internal convenience: in v1.2 the same messages
 * become the WebSocket payload for a remote node, so every message here is
 * plain JSON — no `Date`, no `Buffer`, no `Map`, no class instance, nothing
 * that only survives structured clone. `child_process` IPC serialises with
 * `JSON.stringify` by default, which means an accidentally non-JSON field
 * would not fail loudly here; it would arrive as `{}` or vanish. Keep every
 * addition to this file to values `JSON.parse(JSON.stringify(x))` returns
 * unchanged.
 *
 * Nothing in this file imports a transport. The channel is chosen by the
 * two ends (`agent.ts` uses `process.send`, `agent-handle.ts` uses
 * `child.send`); a socket would substitute for both without touching this
 * module.
 */

/** Messages the daemon sends down to one agent. */
export type DaemonToAgent =
  | { type: 'job'; payload: JobPayload }
  | { type: 'cancel' }
  | { type: 'doc-result'; id: number; ok: true; value: unknown }
  | { type: 'doc-result'; id: number; ok: false; error: string };

/**
 * Messages one agent sends up to the daemon.
 *
 * The three kinds are worth telling apart, because they have different
 * durability rules:
 *
 *  - `ready`, `done` and `failed` are the LIFECYCLE. Exactly one of `done`
 *    or `failed` ends a run, and the daemon writes the outcome from it. A
 *    lost lifecycle message is indistinguishable from a vanished child, and
 *    the daemon treats it as one — see `AgentFailure.reported`.
 *  - `step` and `heartbeat` are DURABLE-ISH: the daemon records them as they
 *    arrive, but the authoritative copy of every step is also carried in the
 *    final `JobReport`, so a lost one costs detail, never correctness.
 *  - `progress` and `log` are LIVENESS ONLY. Nothing durable may ever depend
 *    on one arriving; a transcode that runs for hours streams these so a UI
 *    can show it moving, and dropping every single one of them must still
 *    produce the same database rows.
 */
export type AgentToDaemon =
  | { type: 'ready'; pid: number }
  | { type: 'step'; step: StepRecord }
  | { type: 'heartbeat'; nowMs: number }
  | { type: 'progress'; percent: number | null; stage: string }
  | { type: 'log'; text: string }
  | {
      type: 'doc-request';
      id: number;
      method: 'get' | 'insert' | 'update' | 'removeOne';
      collection: string;
      docId: string;
      data?: Record<string, unknown>;
      nowMs?: number;
    }
  | { type: 'done'; report: JobReport }
  | { type: 'failed'; error: string };

/**
 * Bumped whenever a message shape changes incompatibly.
 *
 * A forked child is built from the same tree as its daemon, so a mismatch
 * cannot happen locally — but a v1.2 remote node is a SEPARATE INSTALL that
 * can be older or newer than the daemon it connects to, and a silent
 * protocol skew there presents as jobs that never report. The version is
 * therefore checked at startup rather than assumed: `agent-handle.ts` puts
 * it in the child's environment and `agent.ts` refuses to run under a
 * different one.
 */
export const PROTOCOL_VERSION = 1;

/** Environment variable carrying `PROTOCOL_VERSION` to a forked agent. */
export const PROTOCOL_VERSION_ENV = 'TRAWLARR_PROTOCOL_VERSION';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Narrow something that arrived on the channel to a protocol message.
 *
 * The channel carries third-party plugin code's process: a plugin can call
 * `process.send` itself, and a hostile or merely buggy one can send
 * anything at all. Everything the daemon acts on therefore goes through
 * here first, and anything unrecognised is dropped rather than
 * duck-typed — an unvalidated `{ type: 'done' }` with no report would
 * otherwise complete a job that never ran.
 */
export const parseAgentMessage = (raw: unknown): AgentToDaemon | null => {
  if (!isRecord(raw)) return null;
  switch (raw['type']) {
    case 'ready':
      return typeof raw['pid'] === 'number' ? { type: 'ready', pid: raw['pid'] } : null;
    case 'step':
      return isRecord(raw['step'])
        ? { type: 'step', step: raw['step'] as unknown as StepRecord }
        : null;
    case 'heartbeat':
      return typeof raw['nowMs'] === 'number' ? { type: 'heartbeat', nowMs: raw['nowMs'] } : null;
    case 'progress':
      return (raw['percent'] === null || typeof raw['percent'] === 'number') &&
        typeof raw['stage'] === 'string'
        ? { type: 'progress', percent: raw['percent'] as number | null, stage: raw['stage'] }
        : null;
    case 'log':
      return typeof raw['text'] === 'string' ? { type: 'log', text: raw['text'] } : null;
    case 'doc-request': {
      const method = raw['method'];
      const valid =
        method === 'get' || method === 'insert' || method === 'update' || method === 'removeOne';
      if (
        !valid ||
        typeof raw['id'] !== 'number' ||
        typeof raw['collection'] !== 'string' ||
        typeof raw['docId'] !== 'string'
      ) {
        return null;
      }
      return {
        type: 'doc-request',
        id: raw['id'],
        method,
        collection: raw['collection'],
        docId: raw['docId'],
        data: isRecord(raw['data']) ? (raw['data'] as Record<string, unknown>) : undefined,
        nowMs: typeof raw['nowMs'] === 'number' ? raw['nowMs'] : undefined,
      };
    }
    case 'done': {
      const report = raw['report'];
      if (!isRecord(report)) return null;
      if (report['held'] !== undefined && typeof report['held'] !== 'boolean') return null;
      if (report['reviewReason'] != null && typeof report['reviewReason'] !== 'string') return null;
      return { type: 'done', report: report as unknown as JobReport };
    }
    case 'failed':
      return typeof raw['error'] === 'string' ? { type: 'failed', error: raw['error'] } : null;
    default:
      return null;
  }
};

/** The mirror of `parseAgentMessage` for the agent's own inbound channel. */
export const parseDaemonMessage = (raw: unknown): DaemonToAgent | null => {
  if (!isRecord(raw)) return null;
  switch (raw['type']) {
    case 'job':
      return isRecord(raw['payload'])
        ? { type: 'job', payload: raw['payload'] as unknown as JobPayload }
        : null;
    case 'cancel':
      return { type: 'cancel' };
    case 'doc-result': {
      if (typeof raw['id'] !== 'number') return null;
      if (raw['ok'] === true)
        return { type: 'doc-result', id: raw['id'], ok: true, value: raw['value'] };
      if (raw['ok'] === false && typeof raw['error'] === 'string') {
        return { type: 'doc-result', id: raw['id'], ok: false, error: raw['error'] };
      }
      return null;
    }
    default:
      return null;
  }
};
