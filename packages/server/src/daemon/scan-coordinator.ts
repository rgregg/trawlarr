import type { Db } from '../db/connection.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import type { SettingsRepo } from '../db/settings-repo.js';
import { reservedDirsForLibrary } from '../library/paths.js';
import { scanLibrary, type ScanLibraryInput, type ScanSummary } from '../scanner/scan-library.js';
import type { EventBus } from './events.js';
import { createChokidarWatchPort, type WatchHandle, type WatchPort } from './watcher.js';

/** Why a scan was asked for. Carried only for diagnostics and tests. */
export type ScanReason = 'manual' | 'watch' | 'interval' | 'startup';

/**
 * The scanner, as the coordinator calls it.
 *
 * `scanLibrary` is assignable to this: a function that accepts
 * `ScanLibraryInput` accepts an input that also carries `reason`. The extra
 * field exists so a test's fake scanner can see WHICH trigger produced a
 * scan — the difference between "the interval fired" and "a watch event
 * settled" is exactly what the rules here are about, and a fake that could
 * not tell them apart could not constrain them.
 */
export type ScanFn = (input: ScanLibraryInput & { reason: ScanReason }) => Promise<ScanSummary>;

export interface ScanCoordinatorErrorContext {
  /** Null when the failure was not attributable to one library. */
  libraryId: string | null;
  phase: 'scan' | 'rescan' | 'watch';
}

export interface ScanCoordinator {
  /** Scan now if this library is not already scanning; otherwise mark it dirty and scan when the current one ends. */
  request(libraryId: string, reason: ScanReason): void;
  /** Resolves when no scan is running and no library is dirty. Tests only. */
  idle(): Promise<void>;
  /**
   * Make the live filesystem watches equal the set of libraries.
   *
   * Called by `start()`, and by every API mutation that adds, edits or
   * removes a library — a library created after the daemon started is
   * otherwise never watched at all. Idempotent: an unchanged library keeps
   * the watch it already has.
   */
  syncWatchers(): void;
  start(): void;
  stop(): Promise<void>;
  scanning(): string[];
}

export interface CreateScanCoordinatorInput {
  db: Db;
  bus: EventBus;
  settings: SettingsRepo;
  nowMs: () => number;
  /** Defaults to chokidar. */
  watchPort?: WatchPort;
  /** Seam for tests. Production never sets it. */
  scanFn?: ScanFn;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Where a scan's — or the rescan timer's — failure goes. Defaults to
   * stderr. See `runScan` for why this exists at all rather than a bare
   * `catch {}`.
   */
  onError?: (error: unknown, context: ScanCoordinatorErrorContext) => void;
}

/**
 * Shortest gap between two `scan.progress` events for one scan.
 *
 * `scanLibrary` calls `onProgress` once per walked file. On a 100,000-file
 * library that is 100,000 synchronous fan-outs through the bus to every
 * websocket subscriber, for a number that changes meaninglessly between
 * consecutive files. Throttled against the INJECTED clock, so a test pins
 * the rate exactly rather than hoping about wall time.
 */
const PROGRESS_INTERVAL_MS = 250;

/** A live watch, and the `watchKeyOf` value it was built from. */
interface WatchEntry {
  key: string;
  handle: WatchHandle;
}

interface LibraryScanState {
  /** A scan (and its at-most-one catch-up) is in flight for this library. */
  running: boolean;
  /** A trigger that arrived while a scan was running: one catch-up, whatever its count. */
  pending: ScanReason | null;
  /** Armed settle timer, i.e. a burst of watch events still settling. */
  settle: unknown | null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The single place anything decides to scan.
 *
 * Spec §4.1 gives three triggers — a full walk, a filesystem watch, and a
 * periodic rescan — and ONE code path. This is that path: every trigger
 * ends in `request()`, and `request()` calls `scanLibrary` and nothing
 * else. There is deliberately no "just this one file" fast path for a watch
 * event, however obviously cheaper it looks: identity resolution
 * (`matchIdentity` over the library's lookup), the in-flight-output guard,
 * signature recomputation and reconciliation are one algorithm, and a
 * second copy of it that only ever runs on the newest, least-tested path is
 * the copy that will be wrong. A watch event is a HINT that something moved;
 * the walk is what decides what that means.
 *
 * Four rules, each of which is a bug if dropped:
 *
 *  1. ONE SCAN PER LIBRARY AT A TIME. Copying a season folder produces
 *     hundreds of events; without the lock that is hundreds of concurrent
 *     walks of the same tree, each probing the same files and racing the
 *     others' upserts. A trigger arriving during a scan sets a flag and
 *     produces exactly one catch-up scan afterwards — one, not one per
 *     event, because the flag is a boolean and not a queue.
 *
 *  2. WATCH EVENTS SETTLE. A watch trigger arms a timer for
 *     `scan.settleMs` and every further watch event for that library
 *     RESETS it, so a library is scanned once its tree has been quiet for
 *     the settle period — not once per event, and not while a download or
 *     a remux is still writing. See `armSettle` for what "settled" means
 *     and why it is defined per library rather than per file.
 *
 *  3. THE WATCHER IGNORES EXACTLY WHAT THE WALK PRUNES:
 *     `reservedDirsForLibrary(library)`, the same helper `scanLibrary`
 *     passes to `walkFiles`, never a list re-derived here.
 *
 *  4. THE PERIODIC RESCAN IS NOT OPTIONAL. chokidar over NFS/SMB drops
 *     events — the mounts this product runs on are exactly the ones where
 *     it does — so the interval is not redundancy, it is the correctness
 *     backstop that makes "new files are picked up" true. Which is also
 *     why it is re-armed unconditionally, before the scans it triggers can
 *     fail: see `armRescan`. A rescan that quietly stopped would mean a
 *     library that quietly stopped converging, since `scanLibrary` is the
 *     only thing that moves a file out of `good`.
 */
export const createScanCoordinator = (input: CreateScanCoordinatorInput): ScanCoordinator => {
  const { db, bus, settings, nowMs } = input;
  const scanFn: ScanFn = input.scanFn ?? scanLibrary;
  const setTimer = input.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer =
    input.clearTimer ??
    ((handle: unknown): void => {
      clearTimeout(handle as NodeJS.Timeout);
    });
  const onError =
    input.onError ??
    ((error: unknown, context: ScanCoordinatorErrorContext): void => {
      console.error(
        `[scan] ${context.phase} failed${context.libraryId === null ? '' : ` for library ${context.libraryId}`}: ${messageOf(error)}`,
      );
    });

  const watchPort = input.watchPort ?? createChokidarWatchPort();
  const libraryRepo = createLibraryRepo(db);
  const states = new Map<string, LibraryScanState>();
  const inFlight = new Map<string, Promise<void>>();
  /** One live watch per library, keyed by what it was built from. */
  const watchHandles = new Map<string, WatchEntry>();
  let idleWaiters: (() => void)[] = [];
  let rescanHandle: unknown = null;
  let started = false;
  let stopped = false;

  const stateFor = (libraryId: string): LibraryScanState => {
    const existing = states.get(libraryId);
    if (existing !== undefined) return existing;
    const created: LibraryScanState = { running: false, pending: null, settle: null };
    states.set(libraryId, created);
    return created;
  };

  const isIdle = (): boolean =>
    [...states.values()].every((state) => !state.running && state.pending === null);

  const releaseIdleWaiters = (): void => {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  };

  const executeScan = async (libraryId: string, reason: ScanReason): Promise<void> => {
    let lastProgressMs: number | null = null;

    const summary = await scanFn({
      db,
      libraryId,
      reason,
      ffprobePath: settings.getBinaries().ffprobe,
      nowMs,
      onProgress: (seen) => {
        const at = nowMs();
        if (lastProgressMs !== null && at - lastProgressMs < PROGRESS_INTERVAL_MS) return;
        lastProgressMs = at;
        bus.emit({ type: 'scan.progress', libraryId, seen });
      },
      // `allowEmptyRoots` is deliberately never set. An empty root is what
      // an unmounted share looks like, and a watcher firing `unlink` for
      // every file in a tree that just went away is EXACTLY the storm that
      // would otherwise reconcile a whole library to "missing". The events
      // only ever cause a scan; the scan then refuses to reconcile a root
      // it cannot show to be present, and reports `rootsUnavailable`
      // instead. Nothing here deletes or marks anything itself.
    });

    // Emitted only on success: a scan that threw produced no summary, and
    // inventing a zeroed one would tell subscribers the library was walked
    // and found empty — the same lie the reconcile guard exists to prevent.
    bus.emit({ type: 'scan.finished', libraryId, summary });
  };

  /**
   * Run scans for one library, back to back, until nothing is pending.
   *
   * The failure handling is the whole point of the loop's `try`. A scan
   * that throws must (a) be REPORTED — a silent catch here is a library
   * that stops converging with nothing anywhere saying so — and (b) leave
   * `running` false, so the next trigger is not permanently swallowed by a
   * lock nobody will ever release. The `finally` is what guarantees (b)
   * even for a failure mode this code has not thought of.
   */
  const runScan = (libraryId: string, reason: ScanReason): void => {
    const state = stateFor(libraryId);
    state.running = true;

    const promise = (async () => {
      try {
        let current: ScanReason | null = reason;
        while (current !== null) {
          try {
            await executeScan(libraryId, current);
          } catch (error) {
            onError(error, { libraryId, phase: 'scan' });
          }
          // Read-and-clear: however many triggers landed during the scan,
          // they produce exactly one more pass.
          current = stopped ? null : state.pending;
          state.pending = null;
        }
      } finally {
        state.running = false;
        inFlight.delete(libraryId);
        releaseIdleWaiters();
      }
    })();

    inFlight.set(libraryId, promise);
  };

  /**
   * What "settled" means here: THE LIBRARY'S TREE HAS BEEN QUIET FOR
   * `scan.settleMs`, not "this file's size stopped changing".
   *
   * A file being written produces a steady stream of `change` events for as
   * long as the write lasts — minutes for a download, hours for a remux —
   * and each one resets this timer, so the scan happens after the copy
   * finishes rather than in the middle of it. That is what keeps ffprobe
   * off a half-written container, whose probe would either fail or describe
   * a duration and bitrate that the finished file does not have.
   *
   * Per-library rather than per-file, because the unit of work is a walk:
   * a scan triggered by file A probes every changed file it finds,
   * including B, which is still growing. Settling only A would probe B
   * mid-write anyway — the per-file version of this check is the one that
   * looks right and does not hold. chokidar's own `awaitWriteFinish` has
   * the same shape (per file, by polling size) and the same gap, plus it
   * polls, which is precisely what the network mounts here are bad at.
   *
   * The residual case is a write that never pauses for `settleMs` at all
   * (a long download): the library keeps deferring its watch-triggered
   * scan, and the periodic rescan is what eventually walks it. If that
   * rescan does catch the file mid-write, the probe is either rejected
   * (`ProbeError` -> counted unreadable, nothing converges on it) or
   * recorded against a size/mtime that the finished file no longer matches
   * — and `scanLibrary`'s probe-skip predicate re-probes exactly on
   * changed size/mtime, so the next scan corrects it. The design never
   * depends on a probe being right about a file that was moving.
   */
  const armSettle = (libraryId: string): void => {
    const state = stateFor(libraryId);
    if (state.settle !== null) clearTimer(state.settle);
    state.settle = setTimer(() => {
      state.settle = null;
      if (stopped) return;
      if (state.running) {
        state.pending = 'watch';
        return;
      }
      runScan(libraryId, 'watch');
    }, settings.getScan().settleMs);
  };

  const request = (libraryId: string, reason: ScanReason): void => {
    if (stopped) return;
    const state = stateFor(libraryId);

    // A trigger during a scan can never start a second one. It marks the
    // library dirty instead, and the running scan picks it up when it ends
    // — including a watch trigger, which needs no separate settle timer
    // here: the scan already in flight IS a delay at least as long as one,
    // and the catch-up starts only once it finishes.
    if (state.running) {
      state.pending = reason;
      return;
    }

    if (reason === 'watch') {
      armSettle(libraryId);
      return;
    }

    // An explicit trigger — a human, startup, the interval — is not
    // debounced: it is not evidence that anything is being written, and
    // making an operator wait 30 seconds for "scan now" would be a bug of
    // its own. It does supersede a settling burst, since the scan it is
    // about to run covers everything that burst would have.
    if (state.settle !== null) {
      clearTimer(state.settle);
      state.settle = null;
    }
    runScan(libraryId, reason);
  };

  /**
   * Arm the next periodic rescan.
   *
   * Re-armed from inside the timer callback BEFORE any scan is requested,
   * and in a `finally`, so no failure of any kind — a library row that
   * disappeared, a settings read that threw, a scan that rejects — can
   * leave the daemon with no periodic trigger. That asymmetry is
   * deliberate: a failed scan is one library, one hour; a dead timer is
   * every library, forever, and looks exactly like a healthy idle system.
   *
   * The interval is re-read from settings on every cycle, so changing
   * `scan.rescanIntervalMs` takes effect without a restart, and an interval
   * of 0 disables the rescan explicitly (the setting's validated floor).
   */
  const armRescan = (): void => {
    if (stopped) return;
    const intervalMs = settings.getScan().rescanIntervalMs;
    if (intervalMs <= 0) return;

    rescanHandle = setTimer(() => {
      rescanHandle = null;
      try {
        for (const library of libraryRepo.list()) {
          try {
            request(library.id, 'interval');
          } catch (error) {
            onError(error, { libraryId: library.id, phase: 'rescan' });
          }
        }
      } catch (error) {
        onError(error, { libraryId: null, phase: 'rescan' });
      } finally {
        armRescan();
      }
    }, intervalMs);
  };

  /**
   * What this library's watch is FOR — its roots and the directories the
   * walk prunes. A watch built from a different one of these is the wrong
   * watch, so it is compared rather than assumed unchanged.
   */
  const watchKeyOf = (library: LibraryRecord): string =>
    JSON.stringify([library.roots, reservedDirsForLibrary(library)]);

  const closeWatch = (libraryId: string, entry: WatchEntry): void => {
    watchHandles.delete(libraryId);
    void entry.handle.close().catch((error: unknown) => {
      onError(error, { libraryId, phase: 'watch' });
    });
  };

  /**
   * Make the set of live watches equal the set of libraries — the property
   * this used to get wrong.
   *
   * Watchers were started ONCE, from `start()`, over the libraries that
   * existed at that instant. A library created afterwards — and the API is
   * the only way a UI creates one — therefore had no watch at all until the
   * daemon was restarted, so a file dropped into a brand-new library was
   * found only by the periodic rescan, up to an hour later, with nothing
   * anywhere saying why. The end-to-end daemon suite proved exactly that: a
   * file dropped into an API-created library was still undiscovered five
   * minutes later with the rescan pushed out of reach.
   *
   * It is idempotent and re-entrant-safe by construction: a library whose
   * roots and reserved directories are unchanged keeps the watch it already
   * has (re-creating it would drop inotify registrations and lose events
   * during the gap), one whose roots CHANGED is re-watched, and one that no
   * longer exists has its watch closed — a watch on a deleted library would
   * keep requesting scans of a library id `scanLibrary` refuses by name.
   */
  const syncWatchers = (): void => {
    if (!started || stopped) return;
    if (!settings.getScan().watchEnabled) return;

    const libraries = libraryRepo.list();
    const live = new Set(libraries.map((library) => library.id));

    for (const [libraryId, entry] of [...watchHandles]) {
      if (!live.has(libraryId)) closeWatch(libraryId, entry);
    }

    for (const library of libraries) {
      const key = watchKeyOf(library);
      const existing = watchHandles.get(library.id);
      if (existing !== undefined) {
        if (existing.key === key) continue;
        closeWatch(library.id, existing);
      }
      try {
        watchHandles.set(library.id, {
          key,
          handle: watchPort.watch({
            libraryId: library.id,
            roots: library.roots,
            // The SAME helper the walk prunes with. A watcher that ignored
            // a different set than the walk would either miss real media
            // or fire on trawlarr's own staging and trash writes.
            ignored: reservedDirsForLibrary(library),
            onChange: () => {
              request(library.id, 'watch');
            },
            onError: (error) => {
              onError(error, { libraryId: library.id, phase: 'watch' });
            },
          }),
        });
      } catch (error) {
        // One library whose roots cannot be watched (a mount that is down
        // at startup, an inotify limit) must not cost the others their
        // watch, nor the daemon its start-up. The periodic rescan still
        // covers it.
        onError(error, { libraryId: library.id, phase: 'watch' });
      }
    }
  };

  return {
    request,
    syncWatchers,

    idle: async (): Promise<void> => {
      if (isIdle()) return;
      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    start: (): void => {
      // Deliberately does NOT scan: an initial pass is the caller's
      // `request(id, 'startup')`, so a daemon that wants to come up
      // without walking every library first is free to.
      if (started) return;
      started = true;
      armRescan();
      syncWatchers();
    },

    stop: async (): Promise<void> => {
      stopped = true;
      if (rescanHandle !== null) {
        clearTimer(rescanHandle);
        rescanHandle = null;
      }
      for (const state of states.values()) {
        if (state.settle !== null) clearTimer(state.settle);
        state.settle = null;
        // Catch-ups are abandoned, scans in flight are not: a walk killed
        // halfway leaves rows upserted but unreconciled, and the next scan
        // has to redo it.
        state.pending = null;
      }
      await Promise.all([...watchHandles.values()].map((entry) => entry.handle.close()));
      watchHandles.clear();
      await Promise.all([...inFlight.values()]);
    },

    scanning: (): string[] =>
      [...states.entries()].filter(([, state]) => state.running).map(([libraryId]) => libraryId),
  };
};
