import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * A kernel-held lock on a file, and the only honest answer to "is the daemon
 * that owns this data directory still running?".
 *
 * WHY NOT A PID. The daemon used to advertise its pid and every liveness
 * check asked whether that pid still existed. Inside a container the daemon
 * is PID 1, so a container that is KILLED (`docker kill`, an OOM kill, a host
 * reboot, `docker compose down -t 0`) leaves `daemon.json` on the `/config`
 * volume saying `"pid": 1` — and the replacement container, itself PID 1,
 * asks "is pid 1 alive?", finds itself, and refuses to start for ever. A pid
 * is not an identity; it is a number that another process can be handed.
 *
 * WHAT A KERNEL LOCK GIVES INSTEAD. A lock held for the lifetime of an open
 * file descriptor is released BY THE KERNEL when the holder dies, however it
 * dies — SIGKILL, OOM, power loss, container teardown. Liveness stops being a
 * guess about a number and becomes a fact about the file: if the lock can be
 * taken, nothing is holding it, and the record beside it is a corpse.
 *
 * WHY SQLITE RATHER THAN `flock(2)`. Node 22 exposes no `flock`/`fcntl`
 * binding at all (there is no `fs.lock`, and `FileHandle` has no lock
 * method), so a real advisory lock from Node means either a new native
 * dependency or an existing one. `better-sqlite3` is already a dependency —
 * it is the database this whole lock exists to protect — and SQLite's unix
 * VFS takes POSIX `fcntl` advisory locks, the same kernel machinery `flock`
 * uses and with the same "released when the fd closes or the process dies"
 * guarantee. In `locking_mode=EXCLUSIVE` a connection acquires an EXCLUSIVE
 * lock on its first write and never releases it until the connection closes,
 * which is exactly a held `LOCK_EX`. No new dependency, no native build, and
 * on Windows and macOS it is the platform's own file locking rather than a
 * POSIX-only call.
 *
 * ONLY SQLITE MAY OPEN THIS FILE. POSIX record locks are owned by the
 * (process, inode) pair, not by the descriptor, so closing ANY descriptor on
 * the file drops the process's locks on it. SQLite's unix VFS tracks that
 * itself and is safe as long as nothing else in the process opens the file.
 * Nothing here ever does: the lock file is written and read only through
 * this module, and it is never unlinked (unlinking a lock file is how two
 * holders end up with locks on two different inodes and the same path).
 */
export interface HeldOsLock {
  /** Drop the lock. Idempotent. The file itself is left in place, always. */
  release: () => void;
}

export type OsLockAttempt =
  | { readonly status: 'acquired'; readonly lock: HeldOsLock }
  /** Someone else's live process holds it. */
  | { readonly status: 'held' }
  /** This filesystem cannot lock (NFS without `lockd`, some SMB/FUSE mounts). */
  | { readonly status: 'unsupported'; readonly reason: string };

/** What a NON-owner can learn about the lock without taking it. */
export type OsLockProbe = 'held' | 'free' | 'unsupported';

export interface OsLockProvider {
  /** Take the lock and hold it until `release()` or process death. */
  acquire: (path: string) => OsLockAttempt;
  /** Ask, read-only and from any process, whether a live holder has it. */
  probe: (path: string) => OsLockProbe;
}

/** The one row whose write forces SQLite to take (and keep) the EXCLUSIVE lock. */
const CLAIM_SQL =
  'CREATE TABLE IF NOT EXISTS lock_holder (id INTEGER PRIMARY KEY); ' +
  'DELETE FROM lock_holder; ' +
  'INSERT INTO lock_holder (id) VALUES (1);';

/**
 * How long to wait for the lock before calling it held.
 *
 * Not zero: a CLI in another process probes this same file read-only, and a
 * probe that lands in the microsecond a daemon is starting would otherwise
 * turn "someone ran `trawlarr status`" into "the daemon refused to start".
 * Not long either: when a real second daemon holds it, this is dead time
 * before an error the operator is going to get anyway.
 */
const ACQUIRE_TIMEOUT_MS = 1_000;

const codeOf = (error: unknown): string =>
  typeof (error as { code?: unknown } | undefined)?.code === 'string'
    ? (error as { code: string }).code
    : '';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const closeQuietly = (db: Database.Database | undefined): void => {
  try {
    db?.close();
  } catch {
    // A close that fails cannot make anything worse: the fd goes with the
    // process, and the kernel drops the lock with it.
  }
};

/**
 * SQLite reports a filesystem that cannot lock as an I/O error rather than as
 * a refusal, and those must not be confused: a busy lock means "someone else
 * is running", an I/O error means "this mount cannot answer the question".
 * They lead to opposite decisions, so they are separated here by code.
 */
const isUnlockableFilesystem = (code: string): boolean =>
  code.startsWith('SQLITE_IOERR') ||
  code === 'SQLITE_NOLFS' ||
  code === 'SQLITE_PROTOCOL' ||
  code === 'SQLITE_NOTADB' ||
  code === 'SQLITE_PERM' ||
  code === 'SQLITE_CANTOPEN' ||
  code.startsWith('SQLITE_READONLY');

export const osFileLock: OsLockProvider = {
  acquire: (path: string): OsLockAttempt => {
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { timeout: ACQUIRE_TIMEOUT_MS });
      // WAL would use shared memory and would NOT keep an exclusive lock
      // held, which is the one property this file is opened for.
      db.pragma('journal_mode = delete');
      db.pragma('locking_mode = exclusive');
      db.exec(CLAIM_SQL);
    } catch (error) {
      closeQuietly(db);
      const code = codeOf(error);
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return { status: 'held' };
      if (isUnlockableFilesystem(code))
        return { status: 'unsupported', reason: `${code || 'error'}: ${messageOf(error)}` };
      throw error;
    }

    const held = db;
    let released = false;
    return {
      status: 'acquired',
      lock: {
        release: (): void => {
          if (released) return;
          released = true;
          closeQuietly(held);
        },
      },
    };
  },

  probe: (path: string): OsLockProbe => {
    // No file means nobody ever locked here, and creating one to find that
    // out would write into a data directory this process may only be
    // reading — and would leave it owned by the wrong user for the daemon.
    if (!existsSync(path)) return 'free';

    let db: Database.Database | undefined;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: 0 });
      // A read is enough: a holder's EXCLUSIVE lock excludes readers too.
      db.prepare('SELECT count(*) AS n FROM lock_holder').get();
      return 'free';
    } catch (error) {
      const code = codeOf(error);
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return 'held';
      // `no such table` is a lock file that exists but was never claimed —
      // free, not broken.
      if (code === 'SQLITE_ERROR') return 'free';
      // A hot journal, which a read-only connection may not roll back. It can
      // only have been left by a writer that DIED mid-claim: a live holder
      // would have answered BUSY above, because the lock is taken before the
      // journal is ever consulted. So it is free, and the next daemon's
      // read-write open will roll it back.
      if (code.startsWith('SQLITE_READONLY')) return 'free';
      if (isUnlockableFilesystem(code)) return 'unsupported';
      throw error;
    } finally {
      closeQuietly(db);
    }
  },
};
