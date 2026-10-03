import { defineWorkspace } from 'vitest/config';

/**
 * The cluster suite's own workspace, holding its one project.
 *
 * It exists because vitest picks up the root `vitest.workspace.ts` whatever
 * `--config` says, and that workspace's projects exclude `*.cluster.test.ts`:
 * with `--config` alone the run found no test files at all. `--workspace`
 * naming this file is what makes `vitest.cluster.config.ts` the project.
 */
export default defineWorkspace(['./vitest.cluster.config.ts']);
