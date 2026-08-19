import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireDaemonLock,
  DAEMON_LOCK_FILENAME,
  DaemonAlreadyRunningError,
  readDaemonRecord,
  type DaemonRecord,
} from './lockfile.js';

const newDataDir = (): string => mkdtempSync(join(tmpdir(), 'trawlarr-lock-'));

const RECORD: Omit<DaemonRecord, 'pid'> = {
  bind: '127.0.0.1',
  port: 8265,
  apiKey: 'key-abc',
  startedAtMs: 1_700_000_000_000,
  schemaVersion: 4,
};

const lockPath = (dataDir: string): string => join(dataDir, DAEMON_LOCK_FILENAME);

describe('daemon lock file', () => {
  it('creates the lock exclusively and refuses a second live daemon', async () => {
    const dataDir = newDataDir();
    const first = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 111,
      isAlive: () => true,
    });

    await expect(
      acquireDaemonLock({ dataDir, record: RECORD, pid: 222, isAlive: () => true }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);

    // The incumbent's record is untouched: the loser never wrote anything.
    expect((await readDaemonRecord({ dataDir, isAlive: () => true }))!.pid).toBe(111);
    await first.release();
  });

  it('carries the incumbent record on the error, so a caller can name the pid and port', async () => {
    const dataDir = newDataDir();
    await acquireDaemonLock({ dataDir, record: RECORD, pid: 111, isAlive: () => true });

    const error = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 222,
      isAlive: () => true,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((error as DaemonAlreadyRunningError).record.pid).toBe(111);
    expect((error as DaemonAlreadyRunningError).record.port).toBe(8265);
    expect((error as DaemonAlreadyRunningError).message).toContain('111');
  });

  it('takes over a lock whose recorded pid is dead', async () => {
    const dataDir = newDataDir();
    await acquireDaemonLock({ dataDir, record: RECORD, pid: 111, isAlive: () => true });

    const second = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 222,
      isAlive: () => false,
    });

    expect((await readDaemonRecord({ dataDir, isAlive: () => true }))!.pid).toBe(222);
    await second.release();
  });

  it('takes over a corrupt lock rather than refusing to start for ever', async () => {
    const dataDir = newDataDir();
    await writeFile(lockPath(dataDir), 'not json');

    const lock = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 222,
      isAlive: () => true,
    });
    expect((await readDaemonRecord({ dataDir, isAlive: () => true }))!.pid).toBe(222);
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

  it('reports no daemon when the recorded pid is dead', async () => {
    const dataDir = newDataDir();
    await acquireDaemonLock({ dataDir, record: RECORD, pid: 111, isAlive: () => true });
    expect(await readDaemonRecord({ dataDir, isAlive: () => false })).toBeNull();
  });

  it('records the port and api key the daemon is actually serving on', async () => {
    const dataDir = newDataDir();
    const lock = await acquireDaemonLock({
      dataDir,
      record: { ...RECORD, port: 45_123 },
      pid: 111,
      isAlive: () => true,
    });

    const onDisk = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as DaemonRecord;
    expect(onDisk).toEqual({ ...RECORD, port: 45_123, pid: 111 });
    await lock.release();
  });

  it('removes the lock on release', async () => {
    const dataDir = newDataDir();
    const lock = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 111,
      isAlive: () => true,
    });
    await lock.release();
    expect(existsSync(lockPath(dataDir))).toBe(false);
  });

  it('release is idempotent and never deletes a successor daemon lock', async () => {
    const dataDir = newDataDir();
    const first = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 111,
      isAlive: () => true,
    });
    await first.release();

    const second = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 222,
      isAlive: () => true,
    });
    // A late release from the dead daemon's shutdown path must not unlink
    // the lock its successor now owns — the successor would then be
    // invisible, and a third daemon would start beside it.
    await first.release();
    expect((await readDaemonRecord({ dataDir, isAlive: () => true }))!.pid).toBe(222);
    await second.release();
  });

  it('creates the data directory if it does not exist yet', async () => {
    const dataDir = join(newDataDir(), 'nested', 'data');
    const lock = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 111,
      isAlive: () => true,
    });
    expect(existsSync(lockPath(dataDir))).toBe(true);
    await lock.release();
  });

  it('lets exactly one of two daemons take over the same stale lock', async () => {
    const dataDir = newDataDir();
    await acquireDaemonLock({ dataDir, record: RECORD, pid: 111, isAlive: () => true });

    // Both starters see pid 111 dead, and both see each other alive — the
    // shape of two daemons racing to take over one abandoned data
    // directory. Exactly one may end up holding the lock.
    const isAlive = (pid: number): boolean => pid !== 111;
    const results = await Promise.allSettled([
      acquireDaemonLock({ dataDir, record: RECORD, pid: 222, isAlive }),
      acquireDaemonLock({ dataDir, record: RECORD, pid: 333, isAlive }),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const holder = (await readDaemonRecord({ dataDir, isAlive: () => true }))!;
    expect([222, 333]).toContain(holder.pid);
    // The loser was told who won, rather than failing obscurely.
    const lost = results.find((result) => result.status === 'rejected');
    expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it('leaves no takeover marker behind after a successful takeover', async () => {
    const dataDir = newDataDir();
    await acquireDaemonLock({ dataDir, record: RECORD, pid: 111, isAlive: () => true });
    const lock = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 222,
      isAlive: (pid) => pid !== 111,
    });
    // A marker left behind is a data directory nothing can ever take over
    // again — the "one crash bricks the installation" failure this whole
    // file exists to avoid.
    expect(existsSync(join(dataDir, 'daemon.takeover.json'))).toBe(false);
    await lock.release();
  });

  it('takes over when a takeover marker was left by a start that died', async () => {
    const dataDir = newDataDir();
    writeFileSync(
      join(dataDir, 'daemon.takeover.json'),
      JSON.stringify({ ...RECORD, pid: 111 }),
      'utf8',
    );
    writeFileSync(lockPath(dataDir), JSON.stringify({ ...RECORD, pid: 111 }), 'utf8');

    const lock = await acquireDaemonLock({
      dataDir,
      record: RECORD,
      pid: 222,
      isAlive: (pid) => pid !== 111,
    });
    expect((await readDaemonRecord({ dataDir, isAlive: () => true }))!.pid).toBe(222);
    await lock.release();
  });

  it('refuses when another process is mid-takeover and still alive', async () => {
    const dataDir = newDataDir();
    writeFileSync(
      join(dataDir, 'daemon.takeover.json'),
      JSON.stringify({ ...RECORD, pid: 999 }),
      'utf8',
    );
    writeFileSync(lockPath(dataDir), JSON.stringify({ ...RECORD, pid: 111 }), 'utf8');

    await expect(
      acquireDaemonLock({ dataDir, record: RECORD, pid: 222, isAlive: (pid) => pid !== 111 }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it('defaults to this process: a lock it wrote is reported live', async () => {
    const dataDir = newDataDir();
    const lock = await acquireDaemonLock({ dataDir, record: RECORD });
    const raw = JSON.parse(await readFile(lockPath(dataDir), 'utf8')) as DaemonRecord;
    expect(raw.pid).toBe(process.pid);
    // No `isAlive` seam either: the real `process.kill(pid, 0)` must agree
    // that this very process is alive, or every CLI invocation would decide
    // its own daemon was dead.
    expect((await readDaemonRecord({ dataDir }))!.pid).toBe(process.pid);
    await lock.release();
  });
});
