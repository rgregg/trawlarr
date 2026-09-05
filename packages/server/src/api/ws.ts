import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventBus, TrawlarrEvent } from '../daemon/events.js';
import type { SettingsRepo } from '../db/settings-repo.js';
import type { AccountRepo } from '../db/account-repo.js';
import { MAX_LOG_EXCERPT_CHARS } from '../db/job-repo.js';
import { API_KEY_HEADER, isAuthorised } from './auth.js';
import { SESSION_COOKIE_NAME, parseCookies, verifySessionToken } from './session.js';

/** Where the socket lives, on the SAME port as the REST API (spec 3.5). */
export const DEFAULT_WS_PATH = '/api/v1/events';

/**
 * Above this much unflushed data, a client stops being sent `job.log` and
 * `job.progress`.
 *
 * Those two are the high-rate, purely cosmetic events: a transcode emits
 * them for hours, and nothing durable depends on any one of them arriving
 * (see `worker/protocol.ts` — `progress` and `log` are LIVENESS ONLY).
 * A client that has stopped reading is a client nobody is watching, so the
 * daemon spends no more memory rendering an animation for it. State
 * transitions keep flowing, because those are the frames that tell a UI to
 * go and re-fetch.
 */
export const SLOW_CLIENT_DROP_BYTES = 1024 * 1024;

/**
 * Above this much unflushed data, the client is disconnected outright.
 *
 * Dropping the cosmetic events bounds the common case, but a client wedged
 * hard enough will back up on state transitions alone, and "bounded" has to
 * mean bounded. Terminating is safe precisely because of the rule this
 * channel is built on: everything the client missed is still in the
 * database, so its reconnect is a refresh, never a resync.
 */
export const SLOW_CLIENT_TERMINATE_BYTES = 8 * 1024 * 1024;

/**
 * The event types dropped from a backed-up client's stream.
 *
 * Deliberately a closed set of two, not a rate class computed at runtime: a
 * mistake here is silently withholding a state transition, and the whole
 * "dropped socket costs liveness, never correctness" argument depends on the
 * transitions still arriving while the client is up.
 */
const DROPPABLE_EVENT_TYPES = new Set<TrawlarrEvent['type']>(['job.log', 'job.progress']);

/** `ws`'s OPEN readyState, as a plain number so a test stub need not import `ws`. */
export const WS_OPEN = 1;

/**
 * ONE message for every way an upgrade can fail to authenticate — the same
 * rule, and the same reasoning, as `auth.ts`'s single 401 body.
 */
export const WS_UNAUTHORIZED_MESSAGE =
  `This WebSocket upgrade was not authorised. Send the daemon's API key either in the ` +
  `"X-Api-Key" header or as an "apiKey" query parameter on the URL — a browser's WebSocket ` +
  `constructor cannot set headers, so the query parameter is the browser's only option. The key ` +
  `is stored as the "daemon.apiKey" setting and is generated on first start. A signed-in ` +
  `browser may instead rely on its session cookie, which travels on the upgrade request the ` +
  `same as any other request to this origin.`;

/**
 * The minimum a socket has to be for this channel to push to it.
 *
 * Narrow on purpose: this channel only ever SENDS. Naming exactly that much
 * is what lets the backpressure and unsubscribe rules be driven directly in
 * a test, instead of being asserted against a real kernel buffer that no
 * test can fill deterministically.
 */
export interface PushSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Drop the connection now, without waiting for a close handshake. */
  terminate(): void;
  readonly bufferedAmount: number;
  readonly readyState: number;
  on(event: 'close' | 'error', listener: () => void): void;
}

export interface WsChannel {
  close: () => Promise<void>;
  clientCount: () => number;
  /**
   * Subscribe an ALREADY-AUTHORISED socket to the bus.
   *
   * The real upgrade path calls this after checking the key; it is public
   * because it is the seam the backpressure and unsubscribe rules are
   * tested through. It performs no authentication of its own — anything
   * handed to it is in-process code that has already decided.
   */
  accept: (socket: PushSocket) => void;
}

export interface AttachWebSocketInput {
  server: Server;
  bus: EventBus;
  settings: SettingsRepo;
  /** Every signed-in operator this daemon knows — checked for a cookie upgrade. */
  accounts: AccountRepo;
  /** Defaults to `/api/v1/events`. */
  path?: string;
}

/**
 * The same cap `job_step.log_excerpt` already applies, applied again here.
 *
 * A plugin that echoes ffmpeg's output line by line can put megabytes into
 * one `jobLog` call. The database refuses to store that; the socket refuses
 * to frame it. Truncating rather than dropping keeps the tail useful — a
 * log line is worth showing even when only its first pages fit.
 */
export const capLogText = (text: string): string => {
  if (text.length <= MAX_LOG_EXCERPT_CHARS) return text;
  const omitted = text.length - MAX_LOG_EXCERPT_CHARS;
  return `${text.slice(0, MAX_LOG_EXCERPT_CHARS)}\n… [truncated, ${String(omitted)} more characters]`;
};

const serialise = (event: TrawlarrEvent): string =>
  JSON.stringify(event.type === 'job.log' ? { ...event, text: capLogText(event.text) } : event);

const denyUpgrade = (socket: Duplex, status: number, code: string, message: string): void => {
  const body = JSON.stringify({ error: { code, message } });
  socket.write(
    `HTTP/1.1 ${String(status)} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\n` +
      `content-type: application/json; charset=utf-8\r\n` +
      `content-length: ${String(Buffer.byteLength(body))}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
  socket.destroy();
};

/**
 * The daemon's push channel, mounted on the REST API's own `http.Server`.
 *
 * One port, so one thing to expose and one thing to reverse-proxy. What it
 * carries is spec 3.5's list — worker progress, job state transitions, log
 * tails, scan progress — and the rule that governs every line of this file
 * is the sentence that follows it there: *it is strictly a push channel for
 * things that change second-to-second; everything durable is fetched over
 * REST, so a dropped socket degrades liveness and never correctness.*
 *
 * Concretely, that rule means: NOTHING IS OBTAINABLE ONLY FROM HERE. Every
 * frame is a `TrawlarrEvent`, which the bus's own contract already defines
 * as a notification of a write that has already happened. `job.finished`
 * announces a `job` row that `GET /api/v1/jobs/:id` will return; `job.step`
 * announces a `job_step` row on the same resource; `library.paused`
 * announces a column `GET /api/v1/libraries` reports. So a client that
 * misses every frame it was ever sent is stale, never wrong, and its
 * reconnect is a re-fetch rather than a replay protocol. That is also why
 * there is no message id, no backfill and no queue: a channel with no
 * durability claim owes the client nothing on reconnect.
 *
 * `ws` (MIT, no runtime dependencies) does the framing. Hand-rolling RFC
 * 6455 would not be "just send frames": the handshake key digest, the
 * client→server MASK that every inbound frame carries, continuation
 * frames, and the ping/close control frames a proxy will send are all
 * required to be a conforming peer even for a send-only channel, and
 * getting any of them wrong is a wire bug no test in this repo would catch.
 */
export const attachWebSocket = (input: AttachWebSocketInput): WsChannel => {
  const path = input.path ?? DEFAULT_WS_PATH;
  const wss = new WebSocketServer({
    noServer: true,
    // No compression: permessage-deflate keeps a zlib context per
    // connection, which is memory this channel has just spent a cap
    // bounding. These frames are small JSON objects on a LAN.
    perMessageDeflate: false,
    // This channel never reads anything meaningful from a client. A small
    // cap means a client cannot make the daemon buffer by talking to it.
    maxPayload: 16 * 1024,
  });

  const clients = new Map<PushSocket, () => void>();

  const drop = (socket: PushSocket): void => {
    const unsubscribe = clients.get(socket);
    if (unsubscribe === undefined) return;
    clients.delete(socket);
    unsubscribe();
  };

  const accept = (socket: PushSocket): void => {
    const unsubscribe = input.bus.subscribe((event) => {
      if (socket.readyState !== WS_OPEN) return;

      const buffered = socket.bufferedAmount;
      if (buffered > SLOW_CLIENT_TERMINATE_BYTES) {
        // Past dropping the cosmetic events and still growing: this client
        // is not reading at all. Let it go and let it re-fetch.
        drop(socket);
        socket.terminate();
        return;
      }
      if (buffered > SLOW_CLIENT_DROP_BYTES && DROPPABLE_EVENT_TYPES.has(event.type)) return;

      try {
        socket.send(serialise(event));
      } catch {
        // A socket that died between the readyState check and the write is
        // this listener's problem, never the emitter's: `emit` runs on a
        // job-completion path that must not unwind. The 'close' handler
        // does the unsubscribing.
      }
    });

    const forget = (): void => {
      // Idempotent by construction: `clients` is keyed by the socket, and
      // 'close' and 'error' both fire on a broken connection. A leaked bus
      // listener per reconnect is a leak that only shows up after a week.
      const existing = clients.get(socket);
      if (existing === undefined) return;
      clients.delete(socket);
      existing();
    };

    clients.set(socket, unsubscribe);
    socket.on('close', forget);
    socket.on('error', forget);
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      denyUpgrade(
        socket,
        404,
        'not-found',
        `No WebSocket endpoint at "${url.pathname}". The daemon's event stream is at ${path}.`,
      );
      return;
    }

    void (async () => {
      const header = req.headers[API_KEY_HEADER];
      const fromHeader = Array.isArray(header) ? header[0] : header;
      // The query parameter is not a weaker door, it is the SAME door: a
      // browser's `new WebSocket(url)` cannot set a header, so without it the
      // UI could not authenticate at all. It is safe here because the key
      // grants no ambient authority — a cross-origin page cannot read it, and
      // nothing about this connection is authenticated by a cookie, so a
      // hostile page opening this URL has nothing to send. Rejecting BEFORE
      // the handshake keeps a rejected client from ever seeing an open
      // socket, which is the difference between a 401 it can report and a
      // mystery disconnect it will retry forever.
      const provided = fromHeader ?? url.searchParams.get('apiKey') ?? undefined;
      const apiKeyOk = isAuthorised({ provided, expected: input.settings.getDaemon().apiKey });
      // A signed-in browser has no API key at all (see `App.tsx`/`useApi.ts`
      // once they move to session cookies), so the upgrade also accepts the
      // same session cookie ordinary requests do — a browser's WebSocket
      // constructor cannot set a header, but it DOES send this origin's
      // cookies on the upgrade request, same as any other fetch.
      const sessionOk = apiKeyOk
        ? false
        : await (async () => {
            const cookies = parseCookies(req.headers.cookie);
            const token = cookies[SESSION_COOKIE_NAME];
            if (token === undefined) return false;
            const accountId = await verifySessionToken({
              token,
              secret: input.settings.getAuth().sessionSecret,
            });
            if (accountId === null) return false;
            return input.accounts.getById(accountId) !== null;
          })();
      if (!apiKeyOk && !sessionOk) {
        denyUpgrade(socket, 401, 'unauthorized', WS_UNAUTHORIZED_MESSAGE);
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        accept({
          send: (data) => {
            ws.send(data);
          },
          close: (code, reason) => {
            ws.close(code, reason);
          },
          terminate: () => {
            ws.terminate();
          },
          get bufferedAmount() {
            return ws.bufferedAmount;
          },
          get readyState() {
            return ws.readyState;
          },
          on: (event, listener) => {
            ws.on(event, listener);
          },
        });
      });
    })();
  };

  input.server.on('upgrade', onUpgrade);

  return {
    accept,
    clientCount: () => clients.size,
    close: async () => {
      input.server.removeListener('upgrade', onUpgrade);
      for (const socket of [...clients.keys()]) {
        drop(socket);
        // 1001 "going away": the daemon is shutting down, and the client
        // should reconnect-and-refetch rather than treat this as an error.
        socket.close(1001, 'daemon shutting down');
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
  };
};
