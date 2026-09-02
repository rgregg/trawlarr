import { useEffect, useRef, useState } from 'react';
import { eventsUrl } from '../api/client.js';
import { initialLiveState, reduceLive, type LiveState, type TrawlarrEvent } from '../api/events.js';

/**
 * The three members of `WebSocket` this hook touches, declared STRUCTURALLY
 * for the same reason `KeyStorage` and `pageUrl()` are: these `.ts` files are
 * typechecked by the root `tsconfig.typecheck.json` (lib ES2023, types node)
 * so `pnpm test` covers them in the one gate, and naming a DOM type here
 * would break that pass. It also makes the socket injectable, which is what
 * lets this be exercised without a browser.
 */
export interface LiveSocket {
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export type LiveSocketFactory = (url: string) => LiveSocket;

const browserSocket: LiveSocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: new (url: string) => LiveSocket }).WebSocket;
  if (ctor === undefined) {
    throw new Error(
      'useLive() needs a WebSocket. There is none on this globalThis; pass a socket factory ' +
        'explicitly when there is no browser.',
    );
  }
  return new ctor(url);
};

/**
 * Backoff, capped. The daemon this is talking to is usually busy transcoding;
 * a tab that reconnects in a tight loop while the daemon restarts is a tab
 * that makes the restart slower.
 */
const RECONNECT_MS = [500, 1_000, 2_000, 5_000, 10_000];

/**
 * The live channel.
 *
 * NOTHING IS EVER REPLAYED on reconnect, and nothing asks for it. Every frame
 * describes a write the daemon has already made, so a client that missed some
 * is stale and re-fetches; one that demanded a replay would be asking the
 * daemon to keep a per-client backlog, which is the thing that turns a slow
 * browser tab into a memory leak in the process supervising transcodes.
 *
 * Recovery is therefore a RESET, not a resume: state goes back to
 * `initialLiveState`, every staleness counter returns to zero, and the
 * screens re-fetch because their effect dependencies changed. A gap costs
 * liveness — a progress bar that was moving stops until the next frame — and
 * never correctness, because nothing durable was ever read from here.
 *
 * A malformed frame is dropped rather than allowed to unmount the app: the
 * socket is the disposable half of this design and must not be able to take
 * the fetched half down with it.
 */
export const useLive = (
  apiKey: string | undefined,
  createSocket: LiveSocketFactory = browserSocket,
): { live: LiveState; connected: boolean } => {
  const [live, setLive] = useState<LiveState>(initialLiveState);
  const [connected, setConnected] = useState(false);
  const attempt = useRef(0);

  useEffect(() => {
    let socket: LiveSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const open = (): void => {
      socket = createSocket(eventsUrl({ apiKey }));
      socket.onopen = () => {
        attempt.current = 0;
        setConnected(true);
      };
      socket.onmessage = (message) => {
        let frame: TrawlarrEvent;
        try {
          frame = JSON.parse(String(message.data)) as TrawlarrEvent;
        } catch {
          return;
        }
        setLive((current) => reduceLive(current, frame));
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        // A reconnect starts from the initial state on purpose. Keeping the
        // old jobs would leave rows on screen for jobs that may have
        // finished during the gap, and there is no frame coming to remove
        // them — the re-fetch is what tells the truth.
        setLive(initialLiveState);
        const delay = RECONNECT_MS[Math.min(attempt.current, RECONNECT_MS.length - 1)]!;
        attempt.current += 1;
        timer = setTimeout(open, delay);
      };
    };
    open();

    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.close();
    };
  }, [apiKey, createSocket]);

  return { live, connected };
};
