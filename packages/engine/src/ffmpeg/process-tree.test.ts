import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { runFfmpeg, type SpawnFn } from './run.js';
import {
  hostExitHandlerInstalled,
  killTrackedProcessGroups,
  trackedProcessGroupLeaders,
  HOST_EXIT_SIGNALS,
} from './process-group.js';

/**
 * Cancellation has to reach the whole process TREE, not just the pid we
 * spawned. In P1 the child WAS ffmpeg, so killing the pid was enough; a
 * third-party plugin that shells out to ffmpeg itself makes the process we
 * spawn a parent, and the transcode we are cancelling a grandchild.
 *
 * Everything here is asserted on observable process state — `process.kill(pid,
 * 0)`, which throws ESRCH once a pid is gone — never on log text, and never on
 * the child's own claims about what it did.
 *
 * Unix only: process groups and signal 0 have no equivalent on Windows, and
 * the condition is computed synchronously at collection time (an async check
 * behind `beforeAll` would make `runIf` read as false and skip silently).
 */
const posixProcessGroups = process.platform !== 'win32';

/**
 * The suite is skipped on exactly ONE condition — a platform with no POSIX
 * process groups, where `kill(-pgid)`, `detached` and signal 0 have no meaning
 * at all. Everything else this suite needs is asserted rather than detected:
 * `/bin/sh` missing on a POSIX host is a broken environment, so it throws here
 * instead of quietly removing the coverage (a silently skipped suite is a
 * recurring failure in this repo).
 */
if (posixProcessGroups && !existsSync('/bin/sh')) {
  throw new Error(
    '/bin/sh does not exist on a POSIX platform: refusing to skip this suite silently.',
  );
}

/** True while `pid` exists: signal 0 performs the permission/existence check only. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const DEADLINE_MS = 10_000;

/** Polls until `predicate` holds, or fails the test with `what` after DEADLINE_MS. */
const until = async (what: string, predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const dirs: string[] = [];
/**
 * Every pid this suite has caused to exist, so cleanup does not depend on the
 * code under test having worked. If the kill being tested is broken, the tree
 * it failed to kill is exactly what is still running when the assertion fails.
 */
const spawnedPids: number[] = [];

/**
 * A stand-in for "ffmpeg, if ffmpeg spawned its own worker": a shell script
 * that ignores every argument it is given (runFfmpeg prepends its `-progress`
 * arguments, which are meaningless here), starts a grandchild, writes the
 * GRANDCHILD's pid where the test can read it, and then waits forever. The
 * grandchild is a plain shell loop rather than `sleep`, so nothing but a
 * signal ends it.
 */
const writeTreeScript = (): { script: string; pidFile: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-proc-tree-'));
  dirs.push(dir);
  const pidFile = join(dir, 'grandchild.pid');
  const script = join(dir, 'fake-ffmpeg.sh');
  writeFileSync(
    script,
    `#!/bin/sh\n` +
      `sh -c 'echo $$ > "${pidFile}.tmp"; mv "${pidFile}.tmp" "${pidFile}"; while : ; do sleep 0.2; done' &\n` +
      `wait\n`,
    'utf8',
  );
  chmodSync(script, 0o755);
  return { script, pidFile };
};

/**
 * The real `spawn`, wrapped only to record the pid `runFfmpeg` actually got, so
 * the direct child's liveness can be asserted alongside the grandchild's. The
 * options `runFfmpeg` builds — `detached` included — are passed through
 * untouched, so this observes production behaviour rather than substituting for
 * it.
 */
const recordingSpawn = (): { spawnFn: SpawnFn; childPid: () => number } => {
  let pid: number | undefined;
  const spawnFn = ((command: string, args: string[], options: never) => {
    const child = spawn(command, args, options);
    pid = child.pid;
    if (pid !== undefined) spawnedPids.push(pid);
    return child;
  }) as unknown as SpawnFn;
  return {
    spawnFn,
    childPid: () => {
      if (pid === undefined) throw new Error('The child never got a pid.');
      return pid;
    },
  };
};

const readGrandchildPid = (pidFile: string): number => {
  const text = readFileSync(pidFile, 'utf8').trim();
  const pid = Number.parseInt(text, 10);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Unusable grandchild pid: "${text}"`);
  return pid;
};

/** Started, wrote its pid, and is really running right now. */
const awaitLiveGrandchild = async (pidFile: string): Promise<number> => {
  let pid = 0;
  await until('the grandchild to report its pid', () => {
    try {
      pid = readGrandchildPid(pidFile);
      return true;
    } catch {
      return false;
    }
  });
  expect(alive(pid)).toBe(true);
  spawnedPids.push(pid);
  return pid;
};

afterEach(async () => {
  // Nothing should survive a test, but a leaked shell loop would spin a core
  // for the rest of the suite, so sweep whatever is still tracked — and then
  // sweep what the suite itself recorded, which is what covers a FAILING run
  // where the kill under test did not work.
  killTrackedProcessGroups();
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone, or never a group leader: nothing to clean up.
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await import('node:fs/promises').then((fs) =>
    Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))),
  );
});

describe.runIf(posixProcessGroups)('runFfmpeg cancellation reaches the process tree', () => {
  /**
   * The behaviour, not the shape. `detached: true` with `kill(pid)` and
   * `detached: true` with `kill(-pid)` are the bug and the fix, and they are
   * indistinguishable to any assertion about the spawn options — only process
   * liveness separates them:
   *
   *   after kill(-pid):     child dead,  grandchild dead   <- the fix
   *   after kill(pid) only: child dead,  grandchild ALIVE  <- the old bug
   *
   * The grandchild is checked BEFORE the run promise is awaited on purpose.
   * Under the bug the grandchild keeps the inherited stdio pipes open, so the
   * promise never settles and awaiting it first would turn a specific "the
   * grandchild is still alive" failure into an unexplained suite timeout.
   */
  it('kills a grandchild the spawned process started, not just the process itself', async () => {
    const { script, pidFile } = writeTreeScript();
    const { spawnFn, childPid } = recordingSpawn();
    const controller = new AbortController();

    const run = runFfmpeg({ ffmpegPath: script, args: [], signal: controller.signal, spawnFn });
    const grandchild = await awaitLiveGrandchild(pidFile);
    const child = childPid();
    expect(alive(child)).toBe(true);
    expect(grandchild).not.toBe(child);

    controller.abort();

    await until('the grandchild the spawned process started to be gone', () => !alive(grandchild));
    await until('the spawned process itself to be gone', () => !alive(child));
    expect(alive(grandchild)).toBe(false);
    expect(alive(child)).toBe(false);

    // Only now: with the whole tree dead the inherited pipes are closed, so the
    // run resolves. Under a pid-only kill this is where the suite would hang,
    // which is why the liveness assertions come first.
    const result = await run;
    expect(result.cancelled).toBe(true);
  }, 30_000);

  it('puts the spawned process in its own group, so the kill cannot reach ours', async () => {
    const { script, pidFile } = writeTreeScript();
    const controller = new AbortController();

    const run = runFfmpeg({ ffmpegPath: script, args: [], signal: controller.signal });
    await awaitLiveGrandchild(pidFile);

    // A tracked leader whose pid is its own pgid is the whole safety property:
    // the group we SIGKILL contains the child and its descendants and nothing
    // else — in particular not this test process, whose group id differs.
    const [leader] = trackedProcessGroupLeaders();
    expect(leader).toBeGreaterThan(1);
    expect(leader).not.toBe(process.pid);

    controller.abort();
    await run;
    expect(alive(process.pid)).toBe(true);
  }, 30_000);

  it('stops tracking a group once its process has closed', async () => {
    const { script, pidFile } = writeTreeScript();
    const controller = new AbortController();

    const run = runFfmpeg({ ffmpegPath: script, args: [], signal: controller.signal });
    await awaitLiveGrandchild(pidFile);
    expect(trackedProcessGroupLeaders()).toHaveLength(1);
    for (const signal of HOST_EXIT_SIGNALS) {
      expect(hostExitHandlerInstalled(signal)).toBe(true);
    }

    controller.abort();
    await run;

    expect(trackedProcessGroupLeaders()).toEqual([]);
    for (const signal of HOST_EXIT_SIGNALS) {
      expect(hostExitHandlerInstalled(signal)).toBe(false);
    }
  }, 30_000);

  /**
   * The other half of giving the child its own group: it no longer dies of the
   * SIGINT a terminal delivers to the foreground group, so a host that is
   * itself exiting has to take the group down explicitly. Without this, Ctrl-C
   * on `trawlarr run` would leave a transcode running with nothing left to
   * finish or record it.
   */
  it('kills tracked groups when the host process is going away', async () => {
    const { script, pidFile } = writeTreeScript();
    const run = runFfmpeg({ ffmpegPath: script, args: [] });
    const grandchild = await awaitLiveGrandchild(pidFile);

    killTrackedProcessGroups();

    await run;
    await until('the grandchild process to be gone', () => !alive(grandchild));
    expect(alive(grandchild)).toBe(false);
    expect(trackedProcessGroupLeaders()).toEqual([]);
  }, 30_000);
});
