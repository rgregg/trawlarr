import { watch as chokidarWatch } from 'chokidar';
import { pathContains } from '../fs/path-contains.js';

export interface WatchInput {
  libraryId: string;
  /** The library's roots, exactly as the walk would be given them. */
  roots: string[];
  /**
   * Directory subtrees to ignore — always `reservedDirsForLibrary(library)`,
   * the same helper `scanLibrary` prunes its walk with. Never a list
   * re-derived here: see the note on `isIgnored` below.
   */
  ignored: string[];
  /**
   * Called with the path of every filesystem entry that changed. NOT a
   * record of what happened: the path is a hint that something under this
   * library moved, and the only thing the caller may do with it is decide
   * to scan. The scan is what establishes facts.
   */
  onChange: (path: string) => void;
  /**
   * Watcher-level failures (an inotify limit, a root that disappeared, a
   * permission change). Reported rather than thrown: an `error` event on
   * an EventEmitter with no listener is an unhandled exception that would
   * take the daemon down, and a watch is an optimisation — losing it must
   * degrade to "the periodic rescan is now the only trigger", not to a
   * dead process.
   */
  onError?: (error: unknown) => void;
}

export interface WatchHandle {
  close: () => Promise<void>;
}

export interface WatchPort {
  watch(input: WatchInput): WatchHandle;
}

/**
 * A filesystem watch, as a port, because chokidar is the one part of the
 * scan triggers that cannot be driven deterministically from a test: its
 * events come from inotify/kqueue on a real tree, at times the OS chooses.
 * The coordinator's rules (debounce, one-scan-per-library, catch-up) are
 * therefore tested against a fake port and real injected timers, and this
 * implementation is tested on its own against a real temp directory for the
 * one thing only it can answer — that events arrive, and that the paths
 * trawlarr itself writes produce none.
 */
export const createChokidarWatchPort = (): WatchPort => ({
  watch: (input) => {
    /**
     * The watcher must ignore EXACTLY what the walk prunes, so this is
     * `pathContains` against the caller's `reservedDirsForLibrary` list —
     * the same segment-aware, symlink-canonicalising comparison
     * `walkFiles` uses, not a second, weaker copy (a `startsWith`, a
     * basename check, a glob). A watcher that ignored less than the walk
     * would hand the coordinator events for staged transcodes and trashed
     * files, and every scan those events triggered would be a scan the
     * walk correctly refuses to find anything in — pure churn at best,
     * and at worst a trigger storm on the one directory trawlarr writes
     * to constantly.
     */
    const isIgnored = (path: string): boolean =>
      input.ignored.some((reserved) => pathContains(reserved, path));

    const watcher = chokidarWatch(input.roots, {
      // The initial add-storm would say nothing: a scan runs at startup
      // anyway, and it — not the watcher — is what reads the tree.
      ignoreInitial: true,
      persistent: true,
      // Matches `walkFiles`, which never descends a directory symlink: a
      // link pointing at an ancestor makes traversal run forever, and
      // media libraries do contain such links.
      followSymlinks: false,
      // One unreadable directory must not kill the watch for the rest of
      // the library, exactly as it does not abort the walk.
      ignorePermissionErrors: true,
      ignored: (path: string) => isIgnored(path),
    });

    // Every event kind, deliberately, and every one of them reduced to the
    // same "something changed" signal: an `add` is a new file, a `change`
    // is a growing download or an edited sidecar, an `unlink` is a deleted
    // or moved file, and a directory event is a whole season folder
    // arriving or leaving. Distinguishing them here would be the beginning
    // of a second scanner — one that decides from an event what happened
    // to a file. Nothing here decides anything: the walk does.
    watcher.on('all', (_event, path) => {
      input.onChange(path);
    });

    watcher.on('error', (error) => {
      input.onError?.(error);
    });

    return {
      close: async () => {
        await watcher.close();
      },
    };
  },
});
