import { execFileSync } from 'node:child_process';
import {
  assertImageCurrent,
  CLUSTER_IMAGE,
  docker,
  dockerAvailableSync,
  leakedProjects,
  projectsOwnedBy,
} from './docker.js';

/** Read by `startCluster` in every worker: the pid its project names carry. */
export const OWNER_ENV = 'TRAWLARR_CLUSTER_OWNER';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, and belongs to someone else. Only ESRCH is "gone".
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const remove = async (projects: string[]): Promise<void> => {
  for (const project of projects) {
    await docker(['compose', '-p', project, 'down', '-v', '--remove-orphans', '--timeout', '0']);
  }
};

/**
 * Before any scenario: the image must be this checkout's, and a cluster a
 * KILLED run left up is removed. After the last: this run's own clusters,
 * and only those — another worktree may be mid-run on the same machine.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (!dockerAvailableSync()) return async () => {};
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const revision = await assertImageCurrent(head);
  console.log(`[cluster] testing ${CLUSTER_IMAGE}, built from ${revision.slice(0, 12)}`);
  // Set before any worker starts, so every test file's clusters carry it.
  process.env[OWNER_ENV] = String(process.pid);
  await remove(await leakedProjects(isAlive));
  return async () => {
    await remove(await projectsOwnedBy(process.pid));
  };
}
