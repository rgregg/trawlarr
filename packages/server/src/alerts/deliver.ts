export interface DeliveryTarget {
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  /** A short error CLASS ("timeout", "network", "HTTP 503"), never a message: see `classify`. */
  error: string | null;
  atMs: number;
}

export interface Deliverer {
  /** Returns immediately and never throws; the request is sent off the caller's path. */
  enqueue: (target: DeliveryTarget, body: unknown) => void;
  /** One attempt chain outside the queue, for the "send test" button. */
  sendNow: (target: DeliveryTarget, body: unknown) => Promise<DeliveryResult>;
  /** Waits for the queue up to `deadlineMs`, then aborts what is left and counts it. */
  drain: (deadlineMs: number) => Promise<{ dropped: number }>;
  lastResult: (name: string) => DeliveryResult | undefined;
  /** Abort everything; anything enqueued afterwards is dropped silently. */
  stop: () => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000];
const DEFAULT_MAX_QUEUE = 1_000;

/** Why an attempt ended, without the text of the error. */
type Failure = { status: number | null; error: string; retry: boolean };

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });

/**
 * Sends alerts without ever being on the path of a job, a scan or a shutdown.
 *
 * One queue and one pump per destination name: a receiver that never answers
 * costs its own alerts ~a minute per message, and must not bury the message that
 * matters to a healthy destination (spec 1.3).
 *
 * Three rules keep a dead receiver from hurting the daemon: every attempt has
 * a timeout (a receiver that accepts and never answers would otherwise hold a
 * socket and the queue forever), the queue is bounded and sheds the OLDEST
 * (the newest alert is the one still true), and `drain` has a deadline that
 * aborts in-flight requests (a stop must not wait on someone else's server).
 */
export const createDeliverer = (opts: {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number[];
  maxQueue?: number;
  nowMs?: () => number;
  log: (line: string) => void;
}): Deliverer => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  const nowMs = opts.nowMs ?? ((): number => Date.now());

  interface Lane {
    queue: Array<{ target: DeliveryTarget; body: unknown }>;
    pumping: Promise<void> | null;
    inFlight: boolean;
  }
  const lanes = new Map<string, Lane>();
  const sends = new Set<Promise<DeliveryResult>>();
  const results = new Map<string, DeliveryResult>();
  let epoch = new AbortController();
  let stopped = false;
  let dropped = 0;

  // `error.message` from fetch can embed the request URL (and undici puts the
  // host in its cause), and a URL is where a webhook's secret lives. So the
  // message is never read: only the error's class survives into a log line.
  const classify = (error: unknown, timedOut: boolean, signal: AbortSignal): Failure => {
    if (timedOut) return { status: null, error: 'timeout', retry: true };
    if (signal.aborted) return { status: null, error: 'aborted', retry: false };
    const name = error instanceof Error ? error.name : 'Error';
    return { status: null, error: `network error (${name})`, retry: true };
  };

  // The signal is captured once per delivery and passed down. `drain` swaps
  // `epoch` for a fresh controller, so reading `epoch` again later would add a
  // listener to one controller and remove it from another, leaving an attempt
  // that outlives the swap unaborted by a later `stop()`.
  const attempt = async (
    signal: AbortSignal,
    target: DeliveryTarget,
    body: unknown,
  ): Promise<{ ok: true; status: number } | ({ ok: false } & Failure)> => {
    if (signal.aborted) return { ok: false, status: null, error: 'aborted', retry: false };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort);
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: {
          ...Object.fromEntries(target.headers.map((h) => [h.name, h.value])),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // A followed redirect would replay the destination's headers (often an
        // Authorization token) at whatever origin the receiver names. A 3xx is
        // therefore a failed attempt, not a hop.
        redirect: 'manual',
      });
      void response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 300)
        return { ok: true, status: response.status };
      const retry = response.status >= 500 || response.status === 408 || response.status === 429;
      const redirect = response.status >= 300 && response.status < 400;
      return {
        ok: false,
        status: response.status,
        error: redirect ? `redirect refused (HTTP ${response.status})` : `HTTP ${response.status}`,
        retry,
      };
    } catch (error) {
      return { ok: false, ...classify(error, timedOut, signal) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  };

  const deliver = async (target: DeliveryTarget, body: unknown): Promise<DeliveryResult> => {
    const signal = epoch.signal;
    let last: Failure = { status: null, error: 'aborted', retry: false };
    for (let i = 0; i <= retries; i++) {
      const outcome = await attempt(signal, target, body);
      if (outcome.ok) {
        const result = { ok: true, status: outcome.status, error: null, atMs: nowMs() };
        results.set(target.name, result);
        return result;
      }
      last = outcome;
      if (!outcome.retry || i === retries || signal.aborted) break;
      await sleep(backoff[Math.min(i, backoff.length - 1)] ?? 0, signal);
      if (signal.aborted) {
        last = { status: null, error: 'aborted', retry: false };
        break;
      }
    }
    const result = { ok: false, status: last.status, error: last.error, atMs: nowMs() };
    results.set(target.name, result);
    // An abort is our own shutdown, not the receiver's fault: stay quiet.
    if (last.error !== 'aborted') {
      opts.log(`Alert delivery to "${target.name}" failed: ${last.error}`);
    }
    return result;
  };

  const pump = async (lane: Lane): Promise<void> => {
    while (!stopped) {
      const next = lane.queue.shift();
      if (next === undefined) break;
      lane.inFlight = true;
      try {
        await deliver(next.target, next.body);
      } catch {
        // deliver reports through its result; a throw here must not strand the queue.
      } finally {
        lane.inFlight = false;
      }
    }
  };

  const startPump = (name: string, lane: Lane): void => {
    if (lane.pumping !== null || stopped) return;
    // Deferred so a burst of enqueues is trimmed to maxQueue before the first
    // request leaves, and so enqueue itself never does work.
    lane.pumping = Promise.resolve().then(async () => {
      try {
        await pump(lane);
      } finally {
        lane.pumping = null;
        if (lane.queue.length > 0) startPump(name, lane);
        else if (lanes.get(name) === lane) lanes.delete(name);
      }
    });
  };

  const track = (promise: Promise<DeliveryResult>): Promise<DeliveryResult> => {
    sends.add(promise);
    const forget = (): void => {
      sends.delete(promise);
    };
    promise.then(forget, forget);
    return promise;
  };

  return {
    enqueue: (target, body) => {
      if (stopped) return;
      let lane = lanes.get(target.name);
      if (lane === undefined) {
        lane = { queue: [], pumping: null, inFlight: false };
        lanes.set(target.name, lane);
      }
      lane.queue.push({ target, body });
      // The cap is per destination: one dead receiver filling its own queue
      // must not evict a healthy destination's alerts as "oldest".
      while (lane.queue.length > maxQueue) {
        lane.queue.shift();
        dropped += 1;
      }
      startPump(target.name, lane);
    },
    sendNow: (target, body) =>
      stopped
        ? Promise.resolve({ ok: false, status: null, error: 'aborted', atMs: nowMs() })
        : track(deliver(target, body)),
    drain: async (deadlineMs) => {
      const pending: Array<Promise<unknown>> = [
        ...[...lanes.values()].flatMap((lane) => (lane.pumping === null ? [] : [lane.pumping])),
        ...sends,
      ];
      if (pending.length > 0) {
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<'late'>((resolve) => {
          timer = setTimeout(() => resolve('late'), deadlineMs);
        });
        const outcome = await Promise.race([
          Promise.all(pending).then(() => 'done' as const),
          expired,
        ]);
        clearTimeout(timer);
        if (outcome === 'late') {
          for (const lane of lanes.values()) {
            dropped += lane.queue.length + (lane.inFlight ? 1 : 0);
            lane.queue.length = 0;
          }
          // Abort, settle, THEN swap. Swapping first would hand a live signal
          // to anything enqueued while the aborted request settles (its lane's
          // pump would send for real and hold this drain past its deadline).
          // Work that starts in the window sees the aborted signal instead and
          // ends as `aborted` without a request.
          epoch.abort();
          await Promise.all(pending);
          epoch = new AbortController();
        }
      }
      const count = dropped;
      dropped = 0;
      return { dropped: count };
    },
    lastResult: (name) => results.get(name),
    stop: () => {
      stopped = true;
      for (const lane of lanes.values()) lane.queue.length = 0;
      epoch.abort();
    },
  };
};
