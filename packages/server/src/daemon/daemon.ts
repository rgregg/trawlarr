import type { Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApiContext, createApiServer } from '../api/server.js';
import { attachWebSocket, type WsChannel } from '../api/ws.js';
import { openDatabase, type Db } from '../db/connection.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { migrate, SCHEMA_VERSION } from '../db/migrate.js';
import { createSettingsRepo, type SettingsRepo } from '../db/settings-repo.js';
import { applyEnvSettings, type EnvApplication } from '../config/env-settings.js';
import { sweepLibraryTrash } from '../library/trash-sweep.js';
import { sweepJobLogs } from '../job-log/job-log-store.js';
import { reapStalled } from '../worker/reap-stalled.js';
import { createEventBus } from './events.js';
import { checkAllLibraries } from './library-health.js';
import { acquireDaemonLock, type DaemonLock } from './lockfile.js';
import { listEncodersWith, preflightHardware, probeEncoderWith } from './hardware-preflight.js';
import { createScanCoordinator, type ScanCoordinator } from './scan-coordinator.js';
import { createSupervisor, type CreateAgentFn, type Supervisor } from './supervisor.js';
import type { WatchPort } from './watcher.js';

/**
 * The version this build reports through `GET /system/version`, kept equal to
 * `packages/server/package.json`. A literal rather than a runtime read of
 * `package.json`: the built `dist/` is what a real install runs, and
 * resolving a sibling file from it is a path that breaks differently in a
 * bundle, a global install and a test.
 */
export const DAEMON_VERSION = '0.0.0';

/** How often the supervisor reconciles the pool with the schedule and the queue. */
export const SUPERVISOR_TICK_MS = 30_000;

/** How often stalled `running` rows are reclaimed (`reapStalled`'s own threshold is a day). */
export const REAP_INTERVAL_MS = 60 * 60 * 1000;

/** How often each library's trash is swept against its own flow-declared retention. */
export const TRASH_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long `stop()` waits for running jobs before cancelling them.
 *
 * A real Execute step is hours long, so this is not "long enough to finish" —
 * it is the bound on how long a shutdown may take. Past it, the workers are
 * cancelled through the process-group path, which is the only thing that
 * reaches an ffmpeg a plugin spawned for itself. An unbounded wait here would
 * make `systemctl stop` hang for hours; no wait at all would leave that
 * ffmpeg running with nothing to record what it did.
 */
export const DEFAULT_DRAIN_DEADLINE_MS = 5 * 60 * 1000;

/**
 * A startup failure worth reading: the daemon refused to come up, and this
 * says why in one sentence rather than as a stack trace out of a repo.
 */
export class DaemonStartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DaemonStartupError';
  }
}

export interface Daemon {
  /** The port the API is actually listening on — the one recorded in the lock file. */
  readonly port: number;
  readonly bind: string;
  readonly apiKey: string;
  /** True when this start generated the API key, i.e. this is the first run. */
  readonly apiKeyGenerated: boolean;
  /** Resolves when the daemon has fully stopped, however that was triggered. */
  readonly stopped: Promise<void>;
  /** What each seed-once environment variable did on this start. */
  readonly envApplications: EnvApplication[];
  stop: () => Promise<void>;
}

export interface StartDaemonInput {
  dataDir: string;
  nowMs?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Overrides the stored `daemon.port` for this run. 0 asks the kernel for a free one. */
  port?: number;
  /** Overrides the stored `daemon.bind` for this run. */
  bind?: string;
  /** How long `stop()` drains before cancelling. Injected so a test need not wait minutes. */
  drainDeadlineMs?: number;
  /** Install SIGINT/SIGTERM handlers. Off in tests, which own the process's signals. */
  installSignalHandlers?: boolean;
  /** Where background failures are reported. Defaults to stderr. */
  onError?: (error: unknown, context: { phase: string }) => void;
  /** Seams. Production sets none of them. */
  watchPort?: WatchPort;
  createAgent?: CreateAgentFn;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Open and migrate the database, refusing a schema this build does not know.
 *
 * `migrate` already refuses forward — this exists to make the refusal a NAMED
 * startup error instead of a stack trace out of a repo, because the operator
 * reading it has done something specific (run an older binary against a newer
 * database) and the fix is specific too. Applying this build's migrations
 * over a newer schema would corrupt it, so not starting is the only safe
 * answer.
 */
const openAndMigrate = (file: string): Db => {
  const db = openDatabase({ file });
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw new DaemonStartupError(
      `trawlarr did not start: this database was written by a newer build, and its schema ` +
        `version is ahead of the one this build knows (version ${String(SCHEMA_VERSION)}). ` +
        `${messageOf(error)} Nothing was migrated and nothing was written: running this build's ` +
        `migrations over a newer schema would corrupt the database, and every file's history ` +
        `with it. Upgrade trawlarr, or restore the backup that matches this build.`,
      { cause: error },
    );
  }
  return db;
};

const listen = async (server: Server, port: number, bind: string): Promise<number> =>
  await new Promise<number>((resolveListen, rejectListen) => {
    const onError = (error: unknown): void => {
      rejectListen(
        new DaemonStartupError(
          `trawlarr did not start: its API could not bind ${bind}:${String(port)}. ` +
            `${messageOf(error)} Nothing else was started. Either something else is already on ` +
            `that port (another trawlarr, most likely), or this address is not one this host ` +
            `owns; change it with "trawlarr daemon --port <n> --bind <addr>".`,
          { cause: error },
        ),
      );
    };
    server.once('error', onError);
    server.listen(port, bind, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectListen(
          new DaemonStartupError(
            `trawlarr did not start: its API server reported no TCP address after listening, so ` +
              `the port recorded in the lock file would have been a guess and every CLI ` +
              `invocation would have called the wrong one.`,
          ),
        );
        return;
      }
      resolveListen(address.port);
    });
  });

/**
 * Everything the daemon is, composed and started in one place.
 *
 * The ORDER is the design, and every step of it is a bug if moved:
 *
 *  1. Open and migrate the database, refusing a newer schema by name.
 *  2. Build the settings repo, the event bus, the supervisor and the scan
 *     coordinator; `createApiContext` registers this node, so `job.node_id`
 *     has a row to point at from the very first job.
 *  3. The hardware preflight, which CHECKS the operator's declaration
 *     against the configured ffmpeg and says once, by name, when it does not
 *     hold — it never edits the declaration, and never pauses anything.
 *  4. `checkAllLibraries`, BEFORE any work is attempted: a library whose
 *     flow cannot run is paused with the reason recorded, rather than
 *     producing one identical failure per file.
 *  5. Start the HTTP server and the WebSocket, and only then take the lock —
 *     so the port it advertises is the port something is really listening
 *     on, which matters the moment `--port 0` is used.
 *  6. Request a startup scan for every enabled library, then start the
 *     watcher and the periodic rescan.
 *  7. Start the supervisor tick, the daily trash purge (each library's own
 *     flow-declared retention, exactly as `trawlarr run` does it) and the
 *     hourly stall reaper.
 *  8. Install the signal handlers that call `stop()`.
 *
 * Anything that fails part way through unwinds what it already started: a
 * daemon that threw out of `startDaemon` must leave no listening socket, no
 * lock file and no open database, or the next start would refuse itself.
 */
export const startDaemon = async (input: StartDaemonInput): Promise<Daemon> => {
  const nowMs = input.nowMs ?? ((): number => Date.now());
  const setTimer =
    input.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const handle = setTimeout(fn, ms);
      // A pending timer must not by itself keep the process alive: the
      // daemon stays up because its server socket is listening, and an
      // unref'd timer is what lets `stop()` be the only thing that decides
      // when the process may exit.
      handle.unref();
      return handle;
    });
  const clearTimer =
    input.clearTimer ??
    ((handle: unknown): void => {
      clearTimeout(handle as NodeJS.Timeout);
    });
  const onError =
    input.onError ??
    ((error: unknown, context: { phase: string }): void => {
      console.error(`[daemon] ${context.phase} failed: ${messageOf(error)}`);
    });

  const dataDir = resolve(input.dataDir);
  await mkdir(dataDir, { recursive: true });

  const db = openAndMigrate(join(dataDir, 'trawlarr.db'));

  const settings: SettingsRepo = createSettingsRepo({ db });
  // Read the raw row BEFORE anything calls `getDaemon()` (which mints the
  // key on first read), so "was this key generated by THIS start?" is
  // answerable — it is printed exactly once, on first run, and lives in the
  // database from then on.
  const apiKeyGenerated =
    db.prepare(`SELECT value FROM setting WHERE key = 'daemon.apiKey'`).get() === undefined;

  // Seed-once environment variables, before anything else reads settings:
  // TZ/NUMBER_OF_WORKERS/etc. only ever fill a setting that has never been
  // written, so a value the operator changed in the UI survives a restart.
  const envApplications = applyEnvSettings({ settings, env: process.env });

  if (input.bind !== undefined) settings.setDaemon({ bind: input.bind });
  // Port 0 is "ask the kernel", which is a request about THIS run and must
  // never be persisted as the configured port — a stored 0 would make every
  // later start pick a different port than the one anybody configured.
  if (input.port !== undefined && input.port > 0) settings.setDaemon({ port: input.port });

  const daemonSettings = settings.getDaemon();
  const bind = input.bind ?? daemonSettings.bind;
  const wantedPort = input.port ?? daemonSettings.port;

  const bus = createEventBus();
  const supervisor: Supervisor = createSupervisor({
    db,
    bus,
    settings,
    dataDir,
    nowMs,
    createAgent: input.createAgent,
  });
  const scans: ScanCoordinator = createScanCoordinator({
    db,
    bus,
    settings,
    nowMs,
    watchPort: input.watchPort,
    setTimer,
    clearTimer,
    onError: (error, context) => {
      onError(error, { phase: `scan:${context.phase}` });
    },
  });

  // Check the operator's hardware DECLARATION against the ffmpeg that will
  // have to honour it — once, here, rather than one failed job per file for
  // ever. Nothing is corrected: `hardware.available` is what the operator
  // said, and it stays what the operator said.
  const ffmpegPath = settings.getBinaries().ffmpeg;
  const hardwareFindings = await preflightHardware({
    available: settings.getHardware().available,
    listEncoders: async () => await listEncodersWith(ffmpegPath),
    tryEncode: async (hardwareType) => await probeEncoderWith(ffmpegPath, hardwareType),
  });
  for (const finding of hardwareFindings) {
    console.warn(
      `[trawlarr] hardware.available declares "${finding.hardwareType}", but ffmpeg at ` +
        `"${ffmpegPath}" could not encode a single frame with "${finding.expectedEncoder}" on ` +
        `this machine. Nothing has been changed for you — the declaration stands, so every job ` +
        `a flow routes to that hardware will be attempted and will fail, three attempts each, ` +
        `one file at a time. In Docker this is almost always one of: the container was started ` +
        `without "runtime: nvidia", or NVIDIA_DRIVER_CAPABILITIES does not include "video" ` +
        `(its default, "compute,utility", does not, and without it the encoder library is ` +
        `never injected). Fix that, or drop "${finding.hardwareType}" from TRAWLARR_HARDWARE.`,
    );
  }

  const ctx = createApiContext({
    db,
    settings,
    bus,
    supervisor,
    scans,
    nowMs,
    version: DAEMON_VERSION,
    envApplications,
    hardwareFindings,
  });

  // Before any work is attempted, and before the API can be asked: a library
  // whose flow cannot be run is paused here, with the reason recorded, so the
  // first thing an operator sees is the explanation rather than silence.
  checkAllLibraries({ db, bus });

  const server = createApiServer(ctx, {
    onError: (error, context) => {
      onError(error, { phase: `api:${context.method} ${context.path}` });
    },
  });
  let ws: WsChannel | null = null;
  let lock: DaemonLock | null = null;

  const unwind = async (): Promise<void> => {
    if (lock !== null) await lock.release();
    if (ws !== null) await ws.close();
    await new Promise<void>((resolveClose) => {
      server.closeAllConnections();
      server.close(() => {
        resolveClose();
      });
    });
    db.close();
  };

  let port: number;
  try {
    ws = attachWebSocket({ server, bus, settings });
    port = await listen(server, wantedPort, bind);
    // Only now is the recorded port a fact rather than a hope.
    lock = await acquireDaemonLock({
      dataDir,
      record: {
        bind,
        port,
        apiKey: daemonSettings.apiKey,
        startedAtMs: nowMs(),
        schemaVersion: SCHEMA_VERSION,
      },
    });
    if (lock.exclusivity === 'pid-liveness') {
      // Worth a line in the log every start: on this filesystem the daemon
      // cannot be protected by a kernel lock, so "is the other daemon still
      // running?" is back to being a guess about a pid — which is wrong in
      // exactly the way that matters if this directory is ever shared, or if
      // the daemon is PID 1 in a container.
      console.warn(
        `[daemon] "${dataDir}" is on a filesystem that cannot hold a lock ` +
          `(${lock.degradedReason ?? 'unknown reason'}), so ownership of it falls back to ` +
          `checking whether the recorded pid still exists. That check cannot tell a restarted ` +
          `container from a running one; keep the data directory on local storage if you can, ` +
          `and never point two daemons at this one.`,
      );
    }
  } catch (error) {
    await unwind();
    throw error;
  }

  const timers = new Set<unknown>();
  let stopping = false;

  /**
   * A repeating job as a re-armed timeout rather than an interval.
   *
   * Re-armed in a `finally`, so no failure of any kind can leave the daemon
   * without its reaper or its trash sweep — the same asymmetry the scan
   * coordinator's rescan is built on: one failed pass is one hour; a dead
   * timer is for ever, and looks exactly like a healthy idle system.
   */
  const every = (ms: number, phase: string, run: () => void | Promise<void>): void => {
    const arm = (): void => {
      if (stopping) return;
      const handle = setTimer(() => {
        timers.delete(handle);
        void (async () => {
          try {
            await run();
          } catch (error) {
            onError(error, { phase });
          } finally {
            arm();
          }
        })();
      }, ms);
      timers.add(handle);
    };
    arm();
  };

  const libraryRepo = createLibraryRepo(db);

  // A startup walk per enabled library. A paused library is deliberately
  // still scanned by the periodic rescan (discovery is not claiming), but
  // the startup burst is spent on the libraries that can actually converge.
  // Skippable via RUN_FULL_SCAN_ON_START=false for a large network mount
  // where every restart re-walking everything is itself the cost.
  if (settings.getScan().scanOnStart) {
    for (const library of libraryRepo.list()) {
      if (!library.enabled) continue;
      scans.request(library.id, 'startup');
    }
  }
  scans.start();

  every(SUPERVISOR_TICK_MS, 'supervisor tick', async () => {
    await supervisor.tick();
  });

  every(REAP_INTERVAL_MS, 'stall reaper', () => {
    reapStalled({ db, nowMs: nowMs() });
  });

  every(TRASH_PURGE_INTERVAL_MS, 'trash purge', async () => {
    for (const library of libraryRepo.list()) {
      // Sequential, and each library independently: one library whose trash
      // directory is unreachable must not cost the others their sweep.
      try {
        await sweepLibraryTrash({ db, library, nowMs: nowMs() });
      } catch (error) {
        onError(error, { phase: `trash purge:${library.name}` });
      }
    }

    // Same retention principle as the trash sweep, same interval so it
    // costs nothing extra: a job log an operator will never look at again
    // is exactly the kind of thing that fills the `/config` volume if
    // nothing ever removes it. One failure here costs one day's sweep, not
    // the reaper or the trash purge that share this callback.
    try {
      await sweepJobLogs({ dataDir, nowMs: nowMs() });
    } catch (error) {
      onError(error, { phase: 'job log purge' });
    }
  });

  // Claim whatever is already queued rather than waiting a whole tick for it.
  void supervisor.tick().catch((error: unknown) => {
    onError(error, { phase: 'supervisor tick' });
  });

  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolveIt) => {
    resolveStopped = resolveIt;
  });
  let stopPromise: Promise<void> | null = null;

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const removeSignalHandlers = (): void => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    signalHandlers.clear();
  };

  /**
   * Shut down in the exact reverse of the start order, and the part most
   * worth reading:
   *
   *   stop starting work → stop the watcher, the rescan and every interval →
   *   `drain()` with a deadline → on the deadline, `supervisor.stop()`, which
   *   cancels through the process-group path → close the WebSocket and the
   *   HTTP server → release the lock → close the database.
   *
   * The deadline is the whole point. A worker is a CHILD PROCESS in its own
   * process group, and it may have spawned ffmpeg itself; a daemon that
   * exited while one was running would leave an ffmpeg writing into a
   * library nothing is watching, with no daemon left to record what it did
   * or to move its output into place. `supervisor.stop()` cancels each
   * worker, and a cancelled worker that does not exit has its whole GROUP
   * signalled (`ffmpeg/process-group.ts`), which is the only thing that
   * reaches a grandchild ffmpeg.
   *
   * The lock is released after the server is closed and before the database
   * is: a CLI that read the lock a moment ago must find either a daemon that
   * still answers, or no lock at all — never a lock pointing at a port that
   * has stopped listening.
   */
  const stop = async (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      removeSignalHandlers();

      for (const handle of timers) clearTimer(handle);
      timers.clear();
      await scans.stop();

      let deadlineHandle: unknown = null;
      const deadline = new Promise<'deadline'>((resolveDeadline) => {
        deadlineHandle = setTimer(() => {
          resolveDeadline('deadline');
        }, input.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS);
      });
      const outcome = await Promise.race([
        supervisor.drain().then((): 'drained' => 'drained'),
        deadline,
      ]);
      if (deadlineHandle !== null) clearTimer(deadlineHandle);
      if (outcome === 'deadline') {
        // Past the bound: cancel, which goes through the process group and
        // therefore reaches an ffmpeg the worker spawned for itself.
        await supervisor.stop();
      }

      if (ws !== null) await ws.close();
      await new Promise<void>((resolveClose) => {
        // Without this, a client holding a keep-alive connection open keeps
        // `close()`'s callback from ever firing, and the shutdown hangs on a
        // socket nobody is using.
        server.closeAllConnections();
        server.close(() => {
          resolveClose();
        });
      });

      if (lock !== null) await lock.release();
      db.close();
      resolveStopped();
    })();
    return stopPromise;
  };

  if (input.installSignalHandlers !== false) {
    for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
      const handler = (): void => {
        void stop().catch((error: unknown) => {
          onError(error, { phase: 'shutdown' });
        });
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  return {
    port,
    bind,
    apiKey: daemonSettings.apiKey,
    apiKeyGenerated,
    envApplications,
    stopped,
    stop,
  };
};
