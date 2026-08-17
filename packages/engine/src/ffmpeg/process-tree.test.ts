import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFfmpeg } from './run.js';
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
const unix = process.platform !== 'win32';

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
  return pid;
};

afterEach(async () => {
  // Nothing should survive a test, but a leaked shell loop would spin a core
  // for the rest of the suite, so sweep whatever is still tracked.
  killTrackedProcessGroups();
  await import('node:fs/promises').then((fs) =>
    Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))),
  );
});

describe.runIf(unix)('runFfmpeg cancellation reaches the process tree', () => {
  it('kills a grandchild the spawned process started, not just the process itself', async () => {
    const { script, pidFile } = writeTreeScript();
    const controller = new AbortController();

    const run = runFfmpeg({ ffmpegPath: script, args: [], signal: controller.signal });
    const grandchild = await awaitLiveGrandchild(pidFile);

    controller.abort();
    const result = await run;

    expect(result.cancelled).toBe(true);
    await until('the grandchild process to be gone', () => !alive(grandchild));
    expect(alive(grandchild)).toBe(false);
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
