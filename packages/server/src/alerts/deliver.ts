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

  const queue: Array<{ target: DeliveryTarget; body: unknown }> = [];
  const results = new Map<string, DeliveryResult>();
  let epoch = new AbortController();
  let stopped = false;
  let pumping: Promise<void> | null = null;
  let inFlight = false;
  let dropped = 0;

  // `error.message` from fetch can embed the request URL (and undici puts the
  // host in its cause), and a URL is where a webhook's secret lives. So the
  // message is never read: only the error's class survives into a log line.
  const classify = (error: unknown, timedOut: boolean): Failure => {
    if (timedOut) return { status: null, error: 'timeout', retry: true };
    if (epoch.signal.aborted) return { status: null, error: 'aborted', retry: false };
    const name = error instanceof Error ? error.name : 'Error';
    return { status: null, error: `network error (${name})`, retry: true };
  };

  const attempt = async (
    target: DeliveryTarget,
    body: unknown,
  ): Promise<{ ok: true; status: number } | ({ ok: false } & Failure)> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onEpochAbort = (): void => controller.abort();
    epoch.signal.addEventListener('abort', onEpochAbort);
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
      const label = response.status >= 300 && response.status < 400 ? 'redirect refused' : 'HTTP';
      return {
        ok: false,
        status: response.status,
        error: label === 'HTTP' ? `HTTP ${response.status}` : `${label} (HTTP ${response.status})`,
        retry,
      };
    } catch (error) {
      return { ok: false, ...classify(error, timedOut) };
    } finally {
      clearTimeout(timer);
      epoch.signal.removeEventListener('abort', onEpochAbort);
    }
  };

  const deliver = async (target: DeliveryTarget, body: unknown): Promise<DeliveryResult> => {
    let last: Failure = { status: null, error: 'aborted', retry: false };
    for (let i = 0; i <= retries; i++) {
      const outcome = await attempt(target, body);
      if (outcome.ok) {
        const result = { ok: true, status: outcome.status, error: null, atMs: nowMs() };
        results.set(target.name, result);
        return result;
      }
      last = outcome;
      if (!outcome.retry || i === retries || epoch.signal.aborted) break;
      await sleep(backoff[Math.min(i, backoff.length - 1)] ?? 0, epoch.signal);
      if (epoch.signal.aborted) {
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

  const pump = async (): Promise<void> => {
    while (!stopped) {
      const next = queue.shift();
      if (next === undefined) break;
      inFlight = true;
      try {
        await deliver(next.target, next.body);
      } catch {
        // deliver reports through its result; a throw here must not strand the queue.
      } finally {
        inFlight = false;
      }
    }
  };

  const startPump = (): void => {
    if (pumping !== null || stopped) return;
    // Deferred so a burst of enqueues is trimmed to maxQueue before the first
    // request leaves, and so enqueue itself never does work.
    pumping = Promise.resolve().then(async () => {
      try {
        await pump();
      } finally {
        pumping = null;
        if (queue.length > 0) startPump();
      }
    });
  };

  return {
    enqueue: (target, body) => {
      if (stopped) return;
      queue.push({ target, body });
      while (queue.length > maxQueue) {
        queue.shift();
        dropped += 1;
      }
      startPump();
    },
    sendNow: (target, body) =>
      stopped
        ? Promise.resolve({ ok: false, status: null, error: 'aborted', atMs: nowMs() })
        : deliver(target, body),
    drain: async (deadlineMs) => {
      if (pumping !== null) {
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<'late'>((resolve) => {
          timer = setTimeout(() => resolve('late'), deadlineMs);
        });
        const outcome = await Promise.race([pumping.then(() => 'done' as const), expired]);
        clearTimeout(timer);
        if (outcome === 'late') {
          dropped += queue.length + (inFlight ? 1 : 0);
          queue.length = 0;
          epoch.abort();
          await pumping;
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
      queue.length = 0;
      epoch.abort();
    },
  };
};
