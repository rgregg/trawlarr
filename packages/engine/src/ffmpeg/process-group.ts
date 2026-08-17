/**
 * Process-group bookkeeping for children we spawn detached.
 *
 * `child.kill()` signals one pid. That was sufficient while the child WAS
 * ffmpeg, but a third-party plugin is free to spawn ffmpeg itself, which makes
 * the process we spawned a parent and the transcode we want to cancel a
 * grandchild. Spawning the child `detached` makes it a process-group LEADER
 * (its pgid equals its pid) and every descendant inherits that group, so one
 * `kill(-pid)` reaches the whole tree — and reaches nothing else, since our own
 * process is in a different group.
 *
 * Detaching has a second consequence that has to be paid for here: the child no
 * longer receives the SIGINT a terminal delivers to its foreground process
 * group, so Ctrl-C on the host would leave a transcode running with nothing
 * left to finish it or record it. Every live group leader is therefore tracked,
 * and the host's own fatal signals (and its exit) take those groups down first.
 */

export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

/** The real kill. Injectable so a test never signals a pid it did not create. */
export const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

/**
 * Host signals that mean "we are going away". SIGKILL is absent because it
 * cannot be caught; a host killed with SIGKILL orphans its children by
 * definition, which is why the group leaders are also swept on `exit`.
 */
export const HOST_EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Leader pid -> the kill to use for it (the one its own runFfmpeg call was given). */
const liveLeaders = new Map<number, KillFn>();

/**
 * Signal the process GROUP led by `leaderPid`.
 *
 * Guarded against the two ways a negative-pid kill goes catastrophically
 * wrong: pgid 0 means "my own group" (which would kill the host and every
 * sibling), and pgid 1 means "every process I am permitted to signal". Neither
 * can ever be a child we spawned, so both are refused rather than translated.
 * Returns whether the signal was actually delivered.
 */
export const killProcessGroup = (
  leaderPid: number | undefined,
  signal: NodeJS.Signals = 'SIGKILL',
  kill: KillFn = defaultKill,
): boolean => {
  if (leaderPid === undefined || !Number.isInteger(leaderPid) || leaderPid <= 1) return false;
  try {
    kill(-leaderPid, signal);
    return true;
  } catch {
    // ESRCH: the group is already gone, which is the outcome we wanted. EPERM:
    // it is not ours to signal, and the caller's direct `child.kill` fallback
    // is the best remaining option.
    return false;
  }
};

// Created once so their identity is stable, which is what makes removal
// (and `hostExitHandlerInstalled`) possible.
const hostSignalHandlers = new Map<NodeJS.Signals, () => void>(
  HOST_EXIT_SIGNALS.map((signal) => [
    signal,
    () => {
      killTrackedProcessGroups();
      // Our listener is what suppressed the default disposition, so restore it
      // and re-raise: the host must still die of the signal it was sent, with
      // the exit status that implies, rather than surviving because a listener
      // existed.
      removeHostExitHandlers();
      process.kill(process.pid, signal);
    },
  ]),
);

const hostExitHandler = (): void => {
  killTrackedProcessGroups();
};

const installHostExitHandlers = (): void => {
  for (const [signal, handler] of hostSignalHandlers) {
    if (!process.listeners(signal).includes(handler)) process.on(signal, handler);
  }
  if (!process.listeners('exit').includes(hostExitHandler)) process.on('exit', hostExitHandler);
};

const removeHostExitHandlers = (): void => {
  for (const [signal, handler] of hostSignalHandlers) process.removeListener(signal, handler);
  process.removeListener('exit', hostExitHandler);
};

/**
 * Whether this module's handler for `signal` is registered on the process right
 * now — read from `process.listeners`, not from a flag of our own.
 */
export const hostExitHandlerInstalled = (signal: NodeJS.Signals): boolean => {
  const handler = hostSignalHandlers.get(signal);
  return handler !== undefined && process.listeners(signal).includes(handler);
};

/**
 * Start tracking a detached child as a group leader. Idempotent per pid.
 *
 * The handlers are installed lazily and removed again once nothing is tracked,
 * so a host that never transcodes never has its signal handling altered, and a
 * long-lived host does not accumulate a listener per job.
 */
export const trackProcessGroupLeader = (
  leaderPid: number | undefined,
  kill: KillFn = defaultKill,
): void => {
  if (leaderPid === undefined || !Number.isInteger(leaderPid) || leaderPid <= 1) return;
  liveLeaders.set(leaderPid, kill);
  installHostExitHandlers();
};

/** Stop tracking a child that has closed; the last one out removes the handlers. */
export const untrackProcessGroupLeader = (leaderPid: number | undefined): void => {
  if (leaderPid === undefined) return;
  liveLeaders.delete(leaderPid);
  if (liveLeaders.size === 0) removeHostExitHandlers();
};

/** The leaders currently tracked, for assertions and diagnostics. */
export const trackedProcessGroupLeaders = (): number[] => [...liveLeaders.keys()];

/**
 * SIGKILL every tracked group and forget them. Called for the host's own exit
 * paths, where nothing is going to be around to wait for a polite shutdown.
 */
export const killTrackedProcessGroups = (): void => {
  for (const [leaderPid, kill] of [...liveLeaders]) {
    killProcessGroup(leaderPid, 'SIGKILL', kill);
  }
  liveLeaders.clear();
  removeHostExitHandlers();
};
