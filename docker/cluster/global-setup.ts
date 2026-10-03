import { assertImagePresent, docker, dockerAvailableSync, leakedProjects } from './docker.js';

const removeLeaked = async (): Promise<void> => {
  for (const project of await leakedProjects()) {
    await docker(['compose', '-p', project, 'down', '-v', '--remove-orphans', '--timeout', '0']);
  }
};

/**
 * Before any scenario: the image must exist, and a cluster a killed run left
 * up is removed. After the last: the same sweep, for this run's own leaks.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (!dockerAvailableSync()) return async () => {};
  await assertImagePresent();
  await removeLeaked();
  return removeLeaked;
}
