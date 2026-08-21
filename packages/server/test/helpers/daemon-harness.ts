import { join } from 'node:path';
import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createSettingsRepo } from '../../src/db/settings-repo.js';
import { startDaemon, type Daemon } from '../../src/daemon/daemon.js';
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
