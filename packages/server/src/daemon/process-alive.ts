/**
 * Does a process with this pid exist on THIS host right now?
 *
 * `kill(pid, 0)` delivers no signal and only performs the permission and
 * existence checks, which is the only way to ask the question without a
 * process table walk.
 *
 * THE ERROR THIS MUST NEVER MAKE IS SAYING "DEAD" ABOUT A LIVE PROCESS, so
 * every ambiguity resolves to alive:
 *
 *  - `EPERM` means the process EXISTS and belongs to another user. Alive.
 *  - A pid that has been REUSED by an unrelated process answers alive, which
 *    is wrong about identity and right about the only thing callers act on:
 *    they treat "alive" as "I know nothing", and fall back to whatever
 *    slower, safer rule they already had.
 *
 * Only `ESRCH` — no process with this pid at all — is reported as dead, and
 * that one is a fact rather than an inference.
 */
export const processIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
