import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createSettingsRepo } from '../../src/db/settings-repo.js';
import { startDaemon, type Daemon } from '../../src/daemon/daemon.js';
import { DAEMON_LOCK_FILENAME, type DaemonRecord } from '../../src/daemon/lockfile.js';
import { API_KEY_HEADER } from '../../src/api/auth.js';
import { fakeFfprobe } from './fake-ffprobe.js';

export interface TestDaemon {
  /** The port the kernel gave this run. */
  readonly port: number;
  /** JSON round trip against `/api/v1`, throwing on a non-2xx. */
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  /** The raw `Response`, so a status can be asserted rather than thrown away. */
  raw: (method: string, path: string, body?: unknown) => Promise<Response>;
  /** The id of the first library this daemon knows about, or `''` if none yet. */
  readonly libraryId: string;
  stop: () => Promise<void>;
}

/**
 * An in-process daemon for suites that need a REAL API answering while
 * something expensive happens underneath it.
 *
 * NOT a replacement for `daemon-end-to-end.test.ts`, which deliberately runs
 * `node dist/cli.js daemon` as a separate process and observes it only from
 * outside — that restraint is what makes it evidence about the shipped
 * artifact. This is the cheaper harness for the opposite question: not "does
 * the product work" but "does the HTTP server stay responsive", which needs
 * the server in a process a test can drive precisely and tear down fast.
 *
 * Two settings are written before the daemon opens the database, because
 * there is no API to write them to yet:
 *
 *  - `binaries.ffprobe` points at the fake, since a scan of thousands of
 *    files under real ffprobe would measure ffprobe.
 *  - the watcher is off and the periodic rescan disabled, so the only scan
 *    that ever runs is the one the test asked for. A second, overlapping
 *    trigger would make "is it still scanning?" mean something else.
 */
export const startDaemonForTest = async (dataDir: string): Promise<TestDaemon> => {
  {
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const settings = createSettingsRepo({ db });
    settings.setBinaries({ ffprobe: fakeFfprobe() });
    settings.setScan({ watchEnabled: false, rescanIntervalMs: 0, settleMs: 0 });
    db.close();
  }

  const daemon: Daemon = await startDaemon({
    dataDir,
    port: 0,
    installSignalHandlers: false,
    drainDeadlineMs: 5_000,
  });

  const base = `http://127.0.0.1:${String(daemon.port)}/api/v1`;

  const raw = async (method: string, path: string, body?: unknown): Promise<Response> =>
    await fetch(`${base}${path}`, {
      method,
      headers: {
        [API_KEY_HEADER]: daemon.apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await raw(method, path, body);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} answered ${String(response.status)}: ${text}`);
    }
    return (text === '' ? null : JSON.parse(text)) as T;
  };

  let libraryId = '';

  return {
    port: daemon.port,
    raw,
    api: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const result = await api<T>(method, path, body);
      if (method === 'POST' && path === '/libraries') {
        libraryId = (result as { id: string }).id;
      }
      return result;
    },
    get libraryId(): string {
      return libraryId;
    },
    stop: async (): Promise<void> => {
      await daemon.stop();
    },
  };
};

// ===========================================================================
// Out-of-process helpers: a REAL built daemon, a REAL `trawlarr node`, and a
// TCP proxy between them that a test can cut.
// ===========================================================================

/** The server CLI, run from its BUILT output exactly as an install runs it. */
export const BUILT_CLI_PATH = join(process.cwd(), 'packages/server/dist/cli.js');

/**
 * Waits for a condition about observable state. The deadline only turns a
 * hang into a message naming what was awaited and what was seen instead.
 */
export const until = async (
  what: string,
  predicate: () => boolean | Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    describe?: () => string | Promise<string>;
  } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      const detail =
        options.describe === undefined ? '' : `\nLast seen: ${await options.describe()}`;
      throw new Error(
        `Timed out after ${String(timeoutMs)}ms waiting for: ${what}.${detail}\n` +
          `(The deadline is a hang detector, not an expectation about speed.)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25));
  }
};

export interface SpawnedProcess {
  readonly child: ChildProcess;
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string;
  exited(): boolean;
  /**
   * Stops the process: `signal` to its whole process group first, then
   * SIGKILL to the group if the leader has not exited within `graceMs`.
   */
  stop(signal?: NodeJS.Signals, graceMs?: number): Promise<void>;
}

const spawnGroup = (args: string[], env: NodeJS.ProcessEnv): SpawnedProcess => {
  // `detached` makes the child a process-group leader, so a cleanup reaches
  // whatever it forked (a node's agents) with one signal to the group.
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env,
  });
  let text = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    text += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    text += chunk;
  });
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const exit = new Promise<void>((resolve) => {
    if (exited()) resolve();
    else child.once('exit', () => resolve());
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // the group is already gone
    }
  };
  return {
    child,
    output: () => text,
    exited,
    stop: async (signal = 'SIGTERM', graceMs = 10_000): Promise<void> => {
      if (!exited()) {
        signalGroup(signal);
        const timedOut = await Promise.race([
          exit.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs).unref()),
        ]);
        if (timedOut) {
          signalGroup('SIGKILL');
          await exit;
        }
      }
      // Anything the leader left behind in its group goes too.
      signalGroup('SIGKILL');
    },
  };
};

/** A spawned daemon's or node's environment: this process's, in test mode, plus overrides. */
const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  NODE_ENV: 'test',
  ...extra,
});

export interface DaemonProcess extends SpawnedProcess {
  readonly port: number;
  readonly apiKey: string;
  /** JSON round trip against `/api/v1`, throwing on a non-2xx. */
  api: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
  raw: (method: string, path: string, body?: unknown) => Promise<Response>;
}

/**
 * `node dist/cli.js daemon` as its own process, on a kernel-chosen port.
 * Anything that must be set before it opens its database is the caller's to
 * write first.
 */
export const spawnDaemonProcess = async (input: {
  dataDir: string;
  env?: Record<string, string>;
}): Promise<DaemonProcess> => {
  const spawned = spawnGroup(
    [BUILT_CLI_PATH, 'daemon', '--data-dir', input.dataDir, '--port', '0'],
    childEnv(input.env),
  );
  const lockPath = join(input.dataDir, DAEMON_LOCK_FILENAME);
  let record: DaemonRecord | null = null;
  await until(
    `the daemon to advertise itself in ${lockPath}`,
    () => {
      if (spawned.exited()) {
        throw new Error(`The daemon exited instead of starting. Its output:\n${spawned.output()}`);
      }
      if (!existsSync(lockPath)) return false;
      try {
        record = JSON.parse(readFileSync(lockPath, 'utf8')) as DaemonRecord;
      } catch {
        return false; // partially written
      }
      return typeof record.port === 'number' && record.port > 0;
    },
    { describe: () => spawned.output() },
  );
  const { port, apiKey } = record!;
  const base = `http://127.0.0.1:${String(port)}/api/v1`;
  const raw = async (method: string, path: string, body?: unknown): Promise<Response> =>
    await fetch(`${base}${path}`, {
      method,
      headers: {
        [API_KEY_HEADER]: apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await raw(method, path, body);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} answered ${String(response.status)}: ${text}`);
    }
    return (text === '' ? null : JSON.parse(text)) as T;
  };
  return { ...spawned, port, apiKey, api, raw };
};

/**
 * `node dist/cli.js node` as its own process. `serverUrl` is whatever the
 * node dials — in the remote-node suite the proxy, never the daemon itself.
 */
export const spawnNodeProcess = (input: {
  dataDir: string;
  serverUrl: string;
  token?: string;
  ffmpegPath?: string;
  env?: Record<string, string>;
}): SpawnedProcess => {
  const args = [BUILT_CLI_PATH, 'node', '--server', input.serverUrl, '--data-dir', input.dataDir];
  if (input.token !== undefined) args.push('--token', input.token);
  if (input.ffmpegPath !== undefined) args.push('--ffmpeg', input.ffmpegPath);
  return spawnGroup(args, childEnv(input.env));
};

export interface TcpProxy {
  readonly port: number;
  /** Destroys every connection in flight, both halves. New connections are still accepted unless paused. */
  sever(): void;
  /** Refuses (destroys on accept) every new connection until `resume`. */
  pause(): void;
  resume(): void;
  /**
   * The path of every HTTP request line seen client → server, in order.
   * Sniffed from the byte stream: plain HTTP/1.1 on loopback, keep-alive and
   * the node's WebSocket upgrade sharing one port.
   */
  readonly requests: readonly string[];
  /** Connections destroyed on accept because the proxy was paused. */
  readonly refusedConnections: number;
  close(): Promise<void>;
}

/**
 * A tiny TCP proxy in front of the daemon: the only way to make a REAL node
 * process lose its connection without killing either process.
 */
export const startTcpProxy = async (targetPort: number): Promise<TcpProxy> => {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let paused = false;
  let refused = 0;
  const REQUEST_LINE = /(?:GET|POST|PUT|PATCH|DELETE|HEAD) (\S+) HTTP\/1\.1\r\n/g;

  const server = createServer((client) => {
    if (paused) {
      refused += 1;
      client.destroy();
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    // Without this every small request relayed through here waits out a
    // delayed ACK (~40 ms): hundreds of bundle-file fetches take half a
    // minute through the proxy and a second without it.
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    // A request line can straddle two chunks: re-scan a short tail, counting
    // only matches that end in the new bytes.
    let tail = '';
    client.on('data', (chunk: Buffer) => {
      const text = tail + chunk.toString('latin1');
      for (const match of text.matchAll(REQUEST_LINE)) {
        if (match.index + match[0].length > tail.length) requests.push(match[1]!);
      }
      tail = text.slice(-512);
    });
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  const sever = (): void => {
    for (const socket of [...sockets]) socket.destroy();
    sockets.clear();
  };
  return {
    port,
    sever,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    requests,
    get refusedConnections(): number {
      return refused;
    },
    close: async () => {
      sever();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};
