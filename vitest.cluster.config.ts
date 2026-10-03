import { defineConfig } from 'vitest/config';
import { workspaceAlias } from './vitest.alias.js';

/**
 * The container suite: one server and several nodes per test file, from the
 * image tagged `trawlarr-cluster:dev`. Run with `pnpm test:cluster`.
 *
 * One file at a time: each cluster is three or four containers running real
 * encodes, and a network cut takes most of a minute to be noticed.
 */
export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    name: 'cluster',
    include: ['docker/cluster/**/*.cluster.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 300_000,
    globalSetup: ['./docker/cluster/global-setup.ts'],
  },
});
