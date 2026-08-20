import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { osFileLock, type OsLockProvider } from './os-file-lock.js';

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
  /**
   * How the daemon that wrote this record is being kept unique, so that a
   * READER knows which question to ask about it.
   *
   * `'os'` — it holds a kernel lock on `daemon.lock`; liveness is that lock,
   * and the pid below is only for humans to read. `'pid'` — the filesystem
   * could not lock (see `os-file-lock.ts`), so liveness falls back to asking
   * whether the pid still exists, with all the ambiguity that carries.
   *
   * Optional because a record written by an older build has neither field
   * nor lock file, and must still be readable rather than discarded.
   */
  lockMode?: 'os' | 'pid';
}

/** The file a daemon advertises itself in, inside its own data directory. */
export const DAEMON_LOCK_FILENAME = 'daemon.json';

/**
 * The file the kernel lock is held on, beside the record.
 *
 * TWO FILES, ON PURPOSE. The lock must be held by an open descriptor for the
 * daemon's whole life, and its contents are meaningless; the record must be
 * readable and re-writable by other processes (the CLI reads the pid, bind
 * and port from it to become an API client) and is replaced on every
 * takeover. A file that is both would have to be unlinked and recreated
 * under the lock that lives in it — two holders, two inodes, one path.
 *
 * It is created once and NEVER removed, including on clean shutdown: an
 * empty 8KB file is the entire cost, and unlinking it is the one operation
 * that can lose the mutual exclusion it exists to provide.
 */
export const DAEMON_OS_LOCK_FILENAME = 'daemon.lock';

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

/**
 * The FALLBACK liveness test: signal 0 delivers nothing and only asks whether
 * the pid exists.
 *
 * This is no longer how a daemon is normally found to be alive — see
 * `os-file-lock.ts` for why a pid cannot answer that question inside a
 * container, where every daemon is PID 1 and each one recognises the last
 * one's pid as itself. It is used only when the filesystem holding the data
 * directory cannot lock at all, and by records written by builds that
 * predate the lock file.
 */
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
    typeof candidate.schemaVersion === 'number' &&
    (candidate.lockMode === undefined ||
      candidate.lockMode === 'os' ||
      candidate.lockMode === 'pid')
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

/**
 * `readRecordFile`, allowing for the milliseconds in which a takeover has
 * unlinked one record and not yet written the next: read again before
 * concluding that the daemon holding the lock is anonymous.
 */
const readRecordFileSettling = async (path: string): Promise<DaemonRecord | null> => {
  const first = await readRecordFile(path);
  if (first !== null) return first;
  await new Promise<void>((settle) => setTimeout(settle, 25));
  return await readRecordFile(path);
};

export interface ReadDaemonRecordInput {
  dataDir: string;
  /** Seam for tests, and the fallback path; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Seam for tests; defaults to the real kernel lock on `daemon.lock`. */
  osLock?: OsLockProvider;
}

/**
 * Is the daemon this record describes still running?
 *
 * A record that says it is holding a kernel lock is answered BY that lock,
 * from any process: the probe opens `daemon.lock` read-only and asks the
 * kernel, so the CLI gets the same answer as the daemon itself would, without
 * writing anything and without needing to be the descriptor's owner.
 *
 * The pid is consulted only for a record that never claimed a lock (an older
 * build, or a daemon on a mount that cannot lock), or when the mount stops
 * being able to answer. Anything else would reintroduce the failure this
 * exists to remove: pid 1 in one container is pid 1 in the next.
 */
const isDaemonLive = (input: {
  dataDir: string;
  record: DaemonRecord;
  isAlive: (pid: number) => boolean;
  osLock: OsLockProvider;
}): boolean => {
  if (input.record.lockMode === 'os') {
    const probe = input.osLock.probe(join(input.dataDir, DAEMON_OS_LOCK_FILENAME));
    if (probe !== 'unsupported') return probe === 'held';
  }
  return input.isAlive(input.record.pid);
};

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
  const osLock = input.osLock ?? osFileLock;
  const record = await readRecordFile(join(input.dataDir, DAEMON_LOCK_FILENAME));
  if (record === null) return null;
  return isDaemonLive({ dataDir: input.dataDir, record, isAlive, osLock }) ? record : null;
};

export interface AcquireDaemonLockInput {
  dataDir: string;
  record: Omit<DaemonRecord, 'pid' | 'lockMode'>;
  /** Defaults to `process.pid`. */
  pid?: number;
  /** Seam for tests, and the fallback path; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Seam for tests; defaults to the real kernel lock on `daemon.lock`. */
  osLock?: OsLockProvider;
}

export interface DaemonLock {
  readonly record: DaemonRecord;
  /**
   * What is actually keeping this daemon unique: a kernel lock the OS
   * releases when this process dies, or — only where the filesystem cannot
   * lock — the old pid heuristic. The daemon prints a warning for the second,
   * because the operator is then running with a weaker guarantee than the
   * one this project promises.
   */
  readonly exclusivity: 'os-lock' | 'pid-liveness';
  /** Why the kernel lock was unavailable, when `exclusivity` is `pid-liveness`. */
  readonly degradedReason?: string;
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
 * THE ARBITER IS A KERNEL LOCK ON `daemon.lock`, held by an open descriptor
 * for as long as this daemon lives (see `os-file-lock.ts`). Two daemons
 * starting in the same millisecond both ask the kernel; exactly one is given
 * the lock, and the other is told who has it. Two daemons on one library
 * means two workers on one file — the same check-then-act shape that
 * `replace-original.ts` reserves its destination against, for the same
 * reason and at the same cost if it is wrong.
 *
 * A LOCK NOBODY HOLDS IS TAKEN OVER, NOT OBEYED. A daemon killed with
 * SIGKILL (or a host that lost power, or a container that was `docker
 * kill`ed) never ran its shutdown path, so its `daemon.json` outlives it —
 * but its kernel lock does not, because the kernel drops that when the
 * process dies. Refusing to start on a leftover record would mean one crash
 * bricks the installation until someone finds and deletes a file they were
 * never told about, and inside a container it WOULD have: the record says
 * pid 1, and the replacement daemon is pid 1 too. Ownership is decided by
 * the lock, so the pid in the record decides nothing.
 *
 * The `open(path, 'wx')` on `daemon.json` remains, and still does the same
 * job one level down: it keeps a fallback-mode daemon (on a mount that
 * cannot lock) from overwriting a record it did not write.
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
  const osLock = input.osLock ?? osFileLock;

  const lockPath = join(input.dataDir, DAEMON_LOCK_FILENAME);
  const takeoverPath = join(input.dataDir, DAEMON_TAKEOVER_FILENAME);
  const osLockPath = join(input.dataDir, DAEMON_OS_LOCK_FILENAME);

  await mkdir(input.dataDir, { recursive: true });

  // ---- the arbiter -------------------------------------------------------
  // Everything below this point is bookkeeping for humans and for the CLI.
  // THIS is what makes two daemons on one data directory impossible.
  const attempt = osLock.acquire(osLockPath);
  if (attempt.status === 'held') {
    // Someone's live process holds the lock. Name them if their record is
    // readable — during the few milliseconds of a takeover it may not be
    // yet, which is worth one retry rather than an unhelpful error.
    const incumbent = await readRecordFileSettling(lockPath);
    if (incumbent !== null) throw new DaemonAlreadyRunningError(incumbent);
    throw new DaemonAlreadyRunningError(
      { pid: 0, ...input.record, lockMode: 'os' },
      `Another trawlarr daemon holds the lock on this data directory ("${osLockPath}") and has ` +
        `not finished advertising itself yet. Only one daemon may own a data directory, so this ` +
        `one did not start: two of them would hold the same SQLite file open, claim the same ` +
        `queued files, and start two workers on one media file. Wait for that start to finish, ` +
        `or point this daemon at a different --data-dir.`,
    );
  }

  const holdsOsLock = attempt.status === 'acquired';
  const releaseOsLock = holdsOsLock ? attempt.lock.release : (): void => {};

  // HOLDING THE LOCK MEANS NOBODY ELSE IS. Not "no other pid that looks like
  // the one written down" — nobody, because no other process could have
  // taken this lock. So every record and every takeover marker still lying
  // here is a corpse, whatever pid it names, INCLUDING this process's own
  // pid: that is the container case, where the daemon this replaces was also
  // PID 1. Only when the filesystem cannot lock does the old pid heuristic
  // come back, with all its ambiguity, because refusing to run at all on an
  // NFS mount would be a worse answer than the one it replaces.
  const isAlive = holdsOsLock ? (): boolean => false : (input.isAlive ?? defaultIsAlive);
  const record: DaemonRecord = { pid, ...input.record, lockMode: holdsOsLock ? 'os' : 'pid' };
  const serialised = JSON.stringify(record, null, 2);
  const degradedReason = attempt.status === 'unsupported' ? attempt.reason : undefined;

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

  try {
    for (let attemptNo = 0; attemptNo < MAX_ATTEMPTS; attemptNo += 1) {
      if (await claim()) {
        let released = false;
        return {
          record,
          exclusivity: holdsOsLock ? 'os-lock' : 'pid-liveness',
          degradedReason,
          release: async (): Promise<void> => {
            if (released) return;
            released = true;
            try {
              // Only while it is still OURS: a successor that already took
              // this directory over must not have its lock unlinked by the
              // shutdown path of the daemon it replaced.
              const current = await readRecordFile(lockPath);
              if (current !== null && current.pid !== pid) return;
              await removeIfPresent(lockPath);
            } finally {
              // The record goes first and the kernel lock last, so there is
              // no instant in which the directory is unlocked while a record
              // that names this daemon is still lying in it.
              releaseOsLock();
            }
          },
        };
      }

      const incumbent = await readRecordFile(lockPath);
      if (incumbent !== null && isAlive(incumbent.pid))
        throw new DaemonAlreadyRunningError(incumbent);

      // The lock is stale (dead owner) or corrupt. Take it over, one starter
      // at a time. While we hold the kernel lock this loop cannot race
      // anyone at all; it is kept because the fallback path has no such
      // guarantee, and because a directory can be shared with a build that
      // predates the kernel lock.
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
              `daemon may own a data directory, so this one did not start. Wait for that start ` +
              `to finish, or point this daemon at a different --data-dir.`,
          );
        }
        // A marker whose own owner is dead: a start that died mid-takeover.
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
  } catch (error) {
    // Nothing was started, so nothing may keep the directory locked: a
    // failed start that held on to the kernel lock would brick the directory
    // exactly as thoroughly as the stale pid file this replaces.
    releaseOsLock();
    throw error;
  }

  releaseOsLock();
  throw new Error(
    `Could not take ownership of "${input.dataDir}" after ${String(MAX_ATTEMPTS)} attempts: its ` +
      `daemon lock file kept changing underneath. That means daemons are repeatedly starting and ` +
      `dying against this directory; look at why the last one exited before starting another.`,
  );
};
