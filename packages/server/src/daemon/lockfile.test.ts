import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireDaemonLock,
  DAEMON_LOCK_FILENAME,
  DAEMON_OS_LOCK_FILENAME,
  DAEMON_TAKEOVER_FILENAME,
  DaemonAlreadyRunningError,
  readDaemonRecord,
  type DaemonRecord,
} from './lockfile.js';
import type { OsLockProvider } from './os-file-lock.js';

const newDataDir = (): string => mkdtempSync(join(tmpdir(), 'trawlarr-lock-'));

const RECORD: Omit<DaemonRecord, 'pid' | 'lockMode'> = {
  bind: '127.0.0.1',
  port: 8265,
  apiKey: 'key-abc',
  startedAtMs: 1_700_000_000_000,
  schemaVersion: 4,
};

const lockPath = (dataDir: string): string => join(dataDir, DAEMON_LOCK_FILENAME);
const osLockPath = (dataDir: string): string => join(dataDir, DAEMON_OS_LOCK_FILENAME);
const takeoverPath = (dataDir: string): string => join(dataDir, DAEMON_TAKEOVER_FILENAME);

/**
 * What a daemon that DIED leaves behind: its advertisement, and no lock.
 *
 * This is the whole shape of the bug this file exists to prevent — the file
 * is written directly rather than by acquiring and releasing, because
 * releasing is what a daemon that was SIGKILLed never got to do.
 */
const leaveStaleRecord = (dataDir: string, record: Partial<DaemonRecord> & { pid: number }): void =>
  writeFileSync(
    lockPath(dataDir),
    JSON.stringify({ ...RECORD, lockMode: 'os', ...record }),
    'utf8',
  );

/** A mount that cannot lock at all: NFS without `lockd`, some SMB and FUSE mounts. */
const unlockableFilesystem: OsLockProvider = {
  acquire: () => ({ status: 'unsupported', reason: 'SQLITE_IOERR_LOCK: disk I/O error' }),
  probe: () => 'unsupported',
};

describe('daemon lock file', () => {
  it('creates the lock exclusively and refuses a second live daemon', async () => {
    const dataDir = newDataDir();
    const first = await acquireDaemonLock({ dataDir, record: RECORD, pid: 111 });

    await expect(acquireDaemonLock({ dataDir, record: RECORD, pid: 222 })).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );

    // The incumbent's record is untouched: the loser never wrote anything.
    expect((await readDaemonRecord({ dataDir }))!.pid).toBe(111);
    await first.release();
  });

  it('carries the incumbent record on the error, so a caller can name the pid and port', async () => {
    const dataDir = newDataDir();
    const first = await acquireDaemonLock({ dataDir, record: RECORD, pid: 111 });

    const error = await acquireDaemonLock({ dataDir, record: RECORD, pid: 222 }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((error as DaemonAlreadyRunningError).record.pid).toBe(111);
    expect((error as DaemonAlreadyRunningError).record.port).toBe(8265);
    expect((error as DaemonAlreadyRunningError).message).toContain('111');
    await first.release();
  });

  it('takes over a lock whose owner is gone', async () => {
    const dataDir = newDataDir();
    leaveStaleRecord(dataDir, { pid: 111 });

    const second = await acquireDaemonLock({ dataDir, record: RECORD, pid: 222 });

    expect((await readDaemonRecord({ dataDir }))!.pid).toBe(222);
    await second.release();
  });

  it('takes over a corrupt lock rather than refusing to start for ever', async () => {
    const dataDir = newDataDir();
    await writeFile(lockPath(dataDir), 'not json');

    const lock = await acquireDaemonLock({ dataDir, record: RECORD, pid: 222 });
    expect((await readDaemonRecord({ dataDir }))!.pid).toBe(222);
    await lock.release();
  });

  it('treats a corrupt lock file as no daemon rather than throwing', async () => {
    const dataDir = newDataDir();
    await writeFile(lockPath(dataDir), 'not json');
    expect(await readDaemonRecord({ dataDir })).toBeNull();
  });

  it('treats a well-formed JSON file that is not a daemon record as no daemon', async () => {
    const dataDir = newDataDir();
    await writeFile(lockPath(dataDir), JSON.stringify({ pid: 'eleven', port: 8265 }));
    expect(await readDaemonRecord({ dataDir, isAlive: () => true })).toBeNull();
  });

  it('reports no daemon when the data directory has never held one', async () => {
    expect(await readDaemonRecord({ dataDir: newDataDir() })).toBeNull();
  });

  it('reports no daemon when nothing holds the lock the record claims', async () => {
    const dataDir = newDataDir();
    leaveStaleRecord(dataDir, { pid: 111 });
    expect(await readDaemonRecord({ dataDir })).toBeNull();
  });

  it('records the port and api key the daemon is actually serving on', async () => {
    const dataDir = newDataDir();
    const lock = await acquireDaemonLock({
      dataDir,
      record: { ...RECORD, port: 45_123 },
      pid: 111,
    });

    const onDisk = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as DaemonRecord;
    expect(onDisk).toEqual({ ...RECORD, port: 45_123, pid: 111, lockMode: 'os' });
    await lock.release();
  });

  it('removes the record on release and leaves the lock file itself in place', async () => {
    const dataDir = newDataDir();
    const lock = await acquireDaemonLock({ dataDir, record: RECORD, pid: 111 });
    await lock.release();
    expect(existsSync(lockPath(dataDir))).toBe(false);
    // Unlinking the locked file is how two daemons end up holding locks on
    // two different inodes with one path. It stays.
    expect(existsSync(osLockPath(dataDir))).toBe(true);
  });

  it('release frees the kernel lock, so the next daemon starts', async () => {
    const dataDir = newDataDir();
    const first = await acquireDaemonLock({ dataDir, record: RECORD, pid: 111 });
    await first.release();

    const second = await acquireDaemonLock({ dataDir, record: RECORD, pid: 222 });
    expect((await readDaemonRecord({ dataDir }))!.pid).toBe(222);
    await second.release();
  });

  it('release is idempotent and never deletes a successor daemon lock', async () => {
    const dataDir = newDataDir();
    const first = await acquireDaemonLock({ dataDir, record: RECORD, pid: 111 });
    await first.release();

    const second = await acquireDaemonLock({ dataDir, record: RECORD, pid: 222 });
    // A late release from the dead daemon's shutdown path must not unlink
    // the lock its successor now owns — the successor would then be
    // invisible, and a third daemon would start beside it.
    await first.release();
    expect((await readDaemonRecord({ dataDir }))!.pid).toBe(222);
    await second.release();
  });

  it('creates the data directory if it does not exist yet', async () => {
    const dataDir = join(newDataDir(), 'nested', 'data');
    const lock = await acquireDaemonLock({ dataDir, record: RECORD, pid: 111 });
    expect(existsSync(lockPath(dataDir))).toBe(true);
    await lock.release();
  });

  it('lets exactly one of two daemons take over the same stale lock', async () => {
    const dataDir = newDataDir();
    leaveStaleRecord(dataDir, { pid: 111 });

    // Two daemons racing to take over one abandoned data directory. Exactly
    // one may end up holding it.
    const results = await Promise.allSettled([
      acquireDaemonLock({ dataDir, record: RECORD, pid: 222 }),
      acquireDaemonLock({ dataDir, record: RECORD, pid: 333 }),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const holder = (await readDaemonRecord({ dataDir }))!;
    expect([222, 333]).toContain(holder.pid);
    // The loser was told who won, rather than failing obscurely.
    const lost = results.find((result) => result.status === 'rejected');
    expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(DaemonAlreadyRunningError);
    await (won[0] as PromiseFulfilledResult<{ release: () => Promise<void> }>).value.release();
  });

  it('leaves no takeover marker behind after a successful takeover', async () => {
    const dataDir = newDataDir();
    leaveStaleRecord(dataDir, { pid: 111 });
    const lock = await acquireDaemonLock({ dataDir, record: RECORD, pid: 222 });
    // A marker left behind is a data directory nothing can ever take over
    // again — the "one crash bricks the installation" failure this whole
    // file exists to avoid.
    expect(existsSync(takeoverPath(dataDir))).toBe(false);
    await lock.release();
  });

  it('takes over when a takeover marker was left by a start that died', async () => {
    const dataDir = newDataDir();
    writeFileSync(takeoverPath(dataDir), JSON.stringify({ ...RECORD, pid: 111 }), 'utf8');
    leaveStaleRecord(dataDir, { pid: 111 });

    const lock = await acquireDaemonLock({ dataDir, record: RECORD, pid: 222 });
    expect((await readDaemonRecord({ dataDir }))!.pid).toBe(222);
    await lock.release();
  });

  it('defaults to this process: a lock it wrote is reported live', async () => {
    const dataDir = newDataDir();
    const lock = await acquireDaemonLock({ dataDir, record: RECORD });
    const raw = JSON.parse(await readFile(lockPath(dataDir), 'utf8')) as DaemonRecord;
    expect(raw.pid).toBe(process.pid);
    // No seams at all: the real kernel lock, taken by this very process,
    // must be seen as held — or every CLI invocation would decide its own
    // daemon was dead.
    expect((await readDaemonRecord({ dataDir }))!.pid).toBe(process.pid);
    await lock.release();
  });
});

/**
 * The container case, which is the whole reason the pid heuristic was
 * removed: inside a container the daemon is PID 1, so a killed container
 * leaves a record naming a pid that IS alive in the replacement container —
 * it is the replacement itself.
 */
describe('a stale record naming a live pid (the container case)', () => {
  it('is taken over when that pid is this very process', async () => {
    const dataDir = newDataDir();
    // Exactly what `/config/daemon.json` says after `docker kill`: a pid
    // that the liveness check will find alive, because it is the checker.
    leaveStaleRecord(dataDir, { pid: process.pid, port: 8265 });

    const lock = await acquireDaemonLock({ dataDir, record: { ...RECORD, port: 9001 } });

    const onDisk = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as DaemonRecord;
    expect(onDisk.port).toBe(9001);
    expect(lock.exclusivity).toBe('os-lock');
    await lock.release();
  });

  it('is reported as no daemon, so the CLI does not dial a dead port', async () => {
    const dataDir = newDataDir();
    leaveStaleRecord(dataDir, { pid: process.pid });
    expect(await readDaemonRecord({ dataDir })).toBeNull();
  });

  it('is taken over even when a takeover marker names that live pid too', async () => {
    const dataDir = newDataDir();
    // A container killed mid-takeover: both files name pid 1, and pid 1 is
    // the process reading them.
    writeFileSync(takeoverPath(dataDir), JSON.stringify({ ...RECORD, pid: process.pid }), 'utf8');
    leaveStaleRecord(dataDir, { pid: process.pid });

    const lock = await acquireDaemonLock({ dataDir, record: { ...RECORD, port: 9002 } });
    const onDisk = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as DaemonRecord;
    expect(onDisk.port).toBe(9002);
    expect(existsSync(takeoverPath(dataDir))).toBe(false);
    await lock.release();
  });

  it('still refuses when the daemon that pid names is REALLY holding the directory', async () => {
    const dataDir = newDataDir();
    // The same on-disk shape as the case above — a record naming this live
    // process — but the lock is genuinely held. Two live daemons on one data
    // directory must still be refused, or the fix would trade a startup
    // failure for two writers on one SQLite file.
    const live = await acquireDaemonLock({ dataDir, record: RECORD });

    const error = await acquireDaemonLock({ dataDir, record: RECORD, pid: 222 }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((error as DaemonAlreadyRunningError).record.pid).toBe(process.pid);
    expect((await readDaemonRecord({ dataDir }))!.port).toBe(RECORD.port);
    await live.release();
  });
});

/**
 * A filesystem that cannot lock — NFS without `lockd`, and some SMB and FUSE
 * mounts. The daemon does not refuse to start there: it falls back to the pid
 * heuristic and says so, because a data directory that cannot be locked is
 * still a data directory a single daemon can own.
 */
describe('a filesystem that cannot hold a lock', () => {
  it('starts anyway, on the pid heuristic, and records that it did', async () => {
    const dataDir = newDataDir();
    const lock = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 111,
      osLock: unlockableFilesystem,
      isAlive: () => false,
    });

    expect(lock.exclusivity).toBe('pid-liveness');
    expect(lock.degradedReason).toContain('SQLITE_IOERR_LOCK');
    const onDisk = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as DaemonRecord;
    expect(onDisk.lockMode).toBe('pid');
    await lock.release();
  });

  it('still refuses a second daemon whose recorded pid is alive', async () => {
    const dataDir = newDataDir();
    leaveStaleRecord(dataDir, { pid: 111, lockMode: 'pid' });

    await expect(
      acquireDaemonLock({
        dataDir,
        record: RECORD,
        pid: 222,
        osLock: unlockableFilesystem,
        isAlive: (pid) => pid === 111,
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    expect((JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as DaemonRecord).pid).toBe(111);
  });

  it('refuses when another process is mid-takeover and still alive', async () => {
    const dataDir = newDataDir();
    writeFileSync(takeoverPath(dataDir), JSON.stringify({ ...RECORD, pid: 999 }), 'utf8');
    leaveStaleRecord(dataDir, { pid: 111, lockMode: 'pid' });

    await expect(
      acquireDaemonLock({
        dataDir,
        record: RECORD,
        pid: 222,
        osLock: unlockableFilesystem,
        isAlive: (pid) => pid !== 111,
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it('takes over a record whose pid is dead', async () => {
    const dataDir = newDataDir();
    leaveStaleRecord(dataDir, { pid: 111, lockMode: 'pid' });

    const lock = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 222,
      osLock: unlockableFilesystem,
      isAlive: () => false,
    });
    expect((JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as DaemonRecord).pid).toBe(222);
    await lock.release();
  });

  it('judges a pid-mode record by its pid, even where the lock file is free', async () => {
    const dataDir = newDataDir();
    leaveStaleRecord(dataDir, { pid: 111, lockMode: 'pid' });
    expect((await readDaemonRecord({ dataDir, isAlive: () => true }))!.pid).toBe(111);
    expect(await readDaemonRecord({ dataDir, isAlive: () => false })).toBeNull();
  });

  it('judges a record from an older build, which has no lock mode, by its pid', async () => {
    const dataDir = newDataDir();
    writeFileSync(lockPath(dataDir), JSON.stringify({ ...RECORD, pid: 111 }), 'utf8');
    expect((await readDaemonRecord({ dataDir, isAlive: () => true }))!.pid).toBe(111);
    expect(await readDaemonRecord({ dataDir, isAlive: () => false })).toBeNull();
  });
});
