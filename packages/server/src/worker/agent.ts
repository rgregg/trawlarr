/**
 * The worker agent: one job, one process, no database.
 *
 * This module is an ENTRY POINT, not a library — importing it starts a
 * message pump. `agent-handle.ts` forks it (`AGENT_MODULE_URL`), and
 * nothing else should ever import it, which is why it is absent from the
 * package's barrel.
 *
 * WHY THIS LIVES IN `packages/server` AND NOT IN A `@trawlarr/node-agent`
 * PACKAGE. Spec §3.2 sketches `node-agent` as its own package depending on
 * `engine`. The run path genuinely needs `probeFile`, `resolveTrashDir`,
 * `partialHashFile` and the Replace Original File seams, all of which live
 * in `packages/server` today; reaching them from a separate package means
 * either moving them into `engine` or creating a `server <-> node-agent`
 * dependency cycle. Neither is worth doing for a process boundary that is
 * already achieved here. What §3.1 actually requires is the process
 * boundary and the JSON protocol, and both ship in this task. When the
 * transport becomes a WebSocket in v1.2, extracting the package is a move
 * of this file and `protocol.ts`, not a redesign. This is a decision, not
 * an oversight.
 *
 * What this process may touch is deliberately narrow: it runs `runPayload`
 * and nothing else. It imports NOTHING under `../db/` — not a repository,
 * not a connection, not the sqlite driver — and a test walks its runtime
 * module graph to keep it that way. Everything database-shaped it needs
 * (the plugin document store) is a round trip to the daemon over the IPC
 * channel.
 */
import { runPayload } from './run-payload.js';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_ENV, parseDaemonMessage } from './protocol.js';
import type { DocumentPort } from '@trawlarr/engine';
import type { AgentToDaemon } from './protocol.js';
import type { JobPayload } from './job-payload.js';

const send = (message: AgentToDaemon): void => {
  process.send?.(message);
};

/**
 * Send a last message and then leave, without racing the channel.
 *
 * `process.send` is asynchronous; calling `process.exit` straight after it
 * can discard the very message that reports the job's outcome, which the
 * daemon would then read as a vanished child. The callback form is what
 * makes "reported a failure" distinguishable from "died" at all.
 */
const sendAndExit = (message: AgentToDaemon, code: number): void => {
  const leave = (): void => {
    process.disconnect?.();
    process.exit(code);
  };
  if (typeof process.send !== 'function') {
    leave();
    return;
  }
  process.send(message, leave);
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

/** Outstanding document round trips, by request id. */
const waiters = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let nextRequestId = 0;

const request = (
  body: Omit<Extract<AgentToDaemon, { type: 'doc-request' }>, 'type' | 'id'>,
): Promise<unknown> =>
  new Promise<unknown>((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('The worker agent has no IPC channel; it cannot reach the document store.'));
      return;
    }
    nextRequestId += 1;
    const id = nextRequestId;
    waiters.set(id, { resolve, reject });
    send({ type: 'doc-request', id, ...body });
  });

/**
 * The daemon's document store, seen from here.
 *
 * This is the whole reason `DocumentPort` allows promises: a plugin calling
 * `deps.crudTransDBN` in this process reaches the daemon's sqlite database
 * and gets an answer back, and an IPC round trip cannot be synchronous.
 */
const remoteDocuments: DocumentPort = {
  get: (collection, docId) =>
    request({ method: 'get', collection, docId }) as Promise<Record<string, unknown> | undefined>,
  insert: (collection, docId, data, nowMs) =>
    request({ method: 'insert', collection, docId, data, nowMs }) as Promise<void>,
  update: (collection, docId, patch, nowMs) =>
    request({ method: 'update', collection, docId, data: patch, nowMs }) as Promise<void>,
  removeOne: (collection, docId) =>
    request({ method: 'removeOne', collection, docId }) as Promise<void>,
};

const controller = new AbortController();
let started = false;
let ending = false;

const runJobPayload = (payload: JobPayload): void => {
  if (started) return; // one job per process, by construction
  started = true;
  void runPayload({
    payload,
    ports: {
      documents: remoteDocuments,
      onStep: (step) => send({ type: 'step', step }),
      onHeartbeat: (nowMs) => send({ type: 'heartbeat', nowMs }),
      onProgress: (progress) => send({ type: 'progress', ...progress }),
      onLog: (text) => send({ type: 'log', text }),
      nowMs: () => Date.now(),
      signal: controller.signal,
    },
  }).then(
    (report) => {
      ending = true;
      sendAndExit({ type: 'done', report }, 0);
    },
    (error: unknown) => {
      ending = true;
      sendAndExit({ type: 'failed', error: messageOf(error) }, 1);
    },
  );
};

process.on('message', (raw: unknown) => {
  const message = parseDaemonMessage(raw);
  if (message === null) return;
  switch (message.type) {
    case 'job':
      runJobPayload(message.payload);
      return;
    case 'cancel':
      controller.abort();
      // A cancel before any job means there is nothing to interrupt and
      // nothing to report: leave, so the daemon's worker slot comes back
      // without waiting for the grace timer.
      if (!started) {
        process.disconnect?.();
        process.exit(0);
      }
      return;
    case 'doc-result': {
      const waiter = waiters.get(message.id);
      if (waiter === undefined) return;
      waiters.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.error));
      return;
    }
  }
});

/**
 * A plugin can throw from a callback the flow is not awaiting, or reject a
 * promise nothing holds. Without these, that kills the process silently and
 * the daemon can only report "the child vanished" — true, but useless to
 * whoever has to find out why. Converting them into a reported failure
 * keeps the plugin's own error text attached to the job.
 */
const reportFatal = (error: unknown): void => {
  if (ending) return;
  ending = true;
  sendAndExit({ type: 'failed', error: messageOf(error) }, 1);
};
process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', reportFatal);

/**
 * The daemon went away. Nothing will ever read a report from here again,
 * and an orphaned worker holding an ffmpeg process for another hour is
 * exactly what the stall reaper cannot clean up. Exiting runs
 * `process-group.ts`'s own exit hook, which takes any live ffmpeg group
 * down with us.
 */
process.on('disconnect', () => {
  if (ending) return;
  ending = true;
  controller.abort();
  process.exit(1);
});

const declaredVersion = process.env[PROTOCOL_VERSION_ENV];
if (declaredVersion !== undefined && declaredVersion !== String(PROTOCOL_VERSION)) {
  // A local fork is always built from this same tree, so this can only fire
  // for a v1.2 remote node whose install has drifted — which otherwise
  // presents as jobs that are claimed and never reported.
  sendAndExit(
    {
      type: 'failed',
      error:
        `Worker agent speaks protocol ${String(PROTOCOL_VERSION)}, ` +
        `daemon speaks ${declaredVersion}.`,
    },
    1,
  );
} else {
  // Sent only after the message handler above is installed: the daemon
  // sends the job in response to this, and a payload that arrived before
  // there was anything listening for it would be dropped in silence.
  send({ type: 'ready', pid: process.pid });
}
