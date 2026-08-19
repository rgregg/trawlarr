import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What a running daemon advertises about itself: enough for a CLI in another
 * process to become its client without guessing anything.
 *
 * `port` is the port the HTTP server is ACTUALLY listening on, which is not
 * necessarily `daemon.port` in settings — a daemon told to bind port 0 gets
 * one from the kernel, and a client that read the setting instead would call
 * the wrong one. Hence the lock is written only after the socket is up.
 */
export interface DaemonRecord {
  pid: number;
  bind: string;
  port: number;
  apiKey: string;
  startedAtMs: number;
  schemaVersion: number;
}

/** The file a daemon advertises itself in, inside its own data directory. */
export const DAEMON_LOCK_FILENAME = 'daemon.json';

/**
 * The marker held for the few milliseconds a takeover takes.
 *
 * See `acquireDaemonLock`: it is the mutex that keeps two daemons from both
 * deciding an abandoned lock file is theirs to remove.
 */
export const DAEMON_TAKEOVER_FILENAME = 'daemon.takeover.json';

/** How many times `acquireDaemonLock` re-reads a directory that changed under it. */
const MAX_ATTEMPTS = 5;

export class DaemonAlreadyRunningError extends Error {
  readonly record: DaemonRecord;

  constructor(record: DaemonRecord, message?: string) {
    super(
      message ??
        `A trawlarr daemon (pid ${String(record.pid)}) already owns this data directory and is ` +
          `serving its API on ${record.bind}:${String(record.port)}. Only one daemon may own a ` +
          `data directory: two of them would each hold the same SQLite file open, claim the ` +
          `same queued files, and start two workers on one media file — which is how a ` +
          `replacement destroys data. Stop that daemon first, or point this one at a different ` +
          `--data-dir.`,
    );
    this.name = 'DaemonAlreadyRunningError';
    this.record = record;
  }
}

/** The real liveness test: signal 0 delivers nothing and only asks whether the pid exists. */
const defaultIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process EXISTS and belongs to someone else — a daemon
    // started by another user is still a daemon, and taking its data
    // directory over would be exactly the double-ownership this prevents.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const isRecord = (value: unknown): value is DaemonRecord => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === 'number' &&
    Number.isInteger(candidate.pid) &&
    typeof candidate.bind === 'string' &&
    typeof candidate.port === 'number' &&
    typeof candidate.apiKey === 'string' &&
    typeof candidate.startedAtMs === 'number' &&
    typeof candidate.schemaVersion === 'number'
  );
};

const codeOf = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Read a lock file, returning null for every way it can fail to name a
 * daemon: absent, unreadable, not JSON, or JSON of the wrong shape.
 *
 * A half-written or hand-edited file must never throw out of here. It is
 * read on the CLI's hottest path — the routing decision every command makes
 * — and an exception there would turn one corrupt byte into a tool that
 * cannot run any command at all.
 */
const readRecordFile = async (path: string): Promise<DaemonRecord | null> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export interface ReadDaemonRecordInput {
  dataDir: string;
  /** Seam for tests; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Who owns this data directory right now — or null when nobody does.
 *
 * NULL MEANS "NO LIVE DAEMON", not "no file". A record naming a pid that no
 * longer exists is a daemon that was killed, and reporting it would leave
 * the CLI talking to a port nothing is listening on and refusing to open a
 * database nothing holds. That is the "one crash bricks the installation"
 * failure, and it is prevented here rather than at every call site.
 */
export const readDaemonRecord = async (
  input: ReadDaemonRecordInput,
): Promise<DaemonRecord | null> => {
  const isAlive = input.isAlive ?? defaultIsAlive;
  const record = await readRecordFile(join(input.dataDir, DAEMON_LOCK_FILENAME));
  if (record === null) return null;
  return isAlive(record.pid) ? record : null;
};

export interface AcquireDaemonLockInput {
  dataDir: string;
  record: Omit<DaemonRecord, 'pid'>;
  /** Defaults to `process.pid`. */
  pid?: number;
  /** Seam for tests; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

export interface DaemonLock {
  readonly record: DaemonRecord;
  /** Remove the lock — but only while it still names this daemon. Idempotent. */
  release: () => Promise<void>;
}

/** Create `path` with `content`, failing (EEXIST) rather than overwriting. */
const createExclusive = async (path: string, content: string): Promise<void> => {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
};

const removeIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
};

/**
 * Claim a data directory for this daemon, or fail naming whoever holds it.
 *
 * THE ARBITER IS `open(path, 'wx')` AND NOTHING ELSE. Two daemons starting
 * in the same millisecond both find no lock file; a "does it exist? then
 * write it" check hands the directory to both of them, and two daemons on
 * one library means two workers on one file — the same check-then-act shape
 * that `replace-original.ts` reserves its destination against, for the same
 * reason and at the same cost if it is wrong.
 *
 * A DEAD PID IS TAKEN OVER, NOT OBEYED. A daemon killed with SIGKILL (or a
 * host that lost power) never ran its shutdown path, so its lock file
 * outlives it. Refusing to start on such a file would mean one crash bricks
 * the installation until someone finds and deletes a file they were never
 * told about.
 *
 * But the takeover itself is a read-then-remove, which is the very
 * check-then-act this file refuses to allow: two daemons could both read the
 * dead pid and both remove the lock, and then one of them could remove the
 * OTHER's freshly created lock. So the removal is serialised behind a second
 * exclusive-create — the takeover marker — which exactly one starter can
 * hold. A starter that finds a marker held by a LIVE pid is looking at
 * another daemon coming up right now and steps aside; a marker whose own pid
 * is dead was left by a start that died inside those few milliseconds, and
 * is itself taken over, because a stuck marker would brick the directory
 * just as thoroughly as a stuck lock.
 *
 * After creating the lock, the record is read back and its pid checked. That
 * is what closes the last window: a straggler that removed our file and
 * created its own is detected here rather than being left to run beside us.
 */
export const acquireDaemonLock = async (input: AcquireDaemonLockInput): Promise<DaemonLock> => {
  const pid = input.pid ?? process.pid;
  const isAlive = input.isAlive ?? defaultIsAlive;
  const record: DaemonRecord = { pid, ...input.record };
  const serialised = JSON.stringify(record, null, 2);

  const lockPath = join(input.dataDir, DAEMON_LOCK_FILENAME);
  const takeoverPath = join(input.dataDir, DAEMON_TAKEOVER_FILENAME);

  await mkdir(input.dataDir, { recursive: true });

  const claim = async (): Promise<boolean> => {
    try {
      await createExclusive(lockPath, serialised);
    } catch (error) {
      if (codeOf(error) === 'EEXIST') return false;
      throw error;
    }
    // Read back before believing it. See the note above.
    const written = await readRecordFile(lockPath);
    if (written === null || written.pid !== pid) {
      throw new DaemonAlreadyRunningError(
        written ?? record,
        `Another trawlarr daemon replaced this data directory's lock while this one was ` +
          `starting${written === null ? '' : ` (it now names pid ${String(written.pid)})`}. ` +
          `Nothing was started here: two daemons sharing a data directory would claim the same ` +
          `files and start two workers on one of them. Start again once the other daemon has ` +
          `settled.`,
      );
    }
    return true;
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (await claim()) {
      let released = false;
      return {
        record,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          // Only while it is still OURS: a successor that already took this
          // directory over must not have its lock unlinked by the shutdown
          // path of the daemon it replaced.
          const current = await readRecordFile(lockPath);
          if (current !== null && current.pid !== pid) return;
          await removeIfPresent(lockPath);
        },
      };
    }

    const incumbent = await readRecordFile(lockPath);
    if (incumbent !== null && isAlive(incumbent.pid))
      throw new DaemonAlreadyRunningError(incumbent);

    // The lock is stale (dead pid) or corrupt. Take it over, one starter at
    // a time.
    try {
      await createExclusive(takeoverPath, serialised);
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
      const marker = await readRecordFile(takeoverPath);
      if (marker !== null && isAlive(marker.pid)) {
        throw new DaemonAlreadyRunningError(
          marker,
          `Another trawlarr daemon (pid ${String(marker.pid)}) is taking this data directory ` +
            `over right now, because the daemon that owned it is no longer running. Only one ` +
            `daemon may own a data directory, so this one did not start. Wait for that start to ` +
            `finish, or point this daemon at a different --data-dir.`,
        );
      }
      // A marker whose own pid is dead: a start that died mid-takeover.
      // Removing it is safe in the way removing the lock is not — the
      // marker grants no ownership, and whoever creates the next one wins.
      await removeIfPresent(takeoverPath);
      continue;
    }

    try {
      // Re-read INSIDE the marker: between the check above and here, the
      // rightful owner may have been restarted by a supervisor.
      const current = await readRecordFile(lockPath);
      if (current !== null && isAlive(current.pid)) throw new DaemonAlreadyRunningError(current);
      await removeIfPresent(lockPath);
    } finally {
      await removeIfPresent(takeoverPath);
    }
  }

  throw new Error(
    `Could not take ownership of "${input.dataDir}" after ${String(MAX_ATTEMPTS)} attempts: its ` +
      `daemon lock file kept changing underneath. That means daemons are repeatedly starting and ` +
      `dying against this directory; look at why the last one exited before starting another.`,
  );
};
