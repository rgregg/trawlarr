import { afterEach, describe, expect, it } from 'vitest';
import { startCluster, type Cluster } from './cluster.js';
import { dockerAvailableSync } from './docker.js';

// Synchronous, at collection time: see dockerAvailableSync.
const available = dockerAvailableSync();

describe.runIf(available)('two nodes share one library', () => {
  let cluster: Cluster | null = null;

  afterEach(async (context) => {
    if (cluster === null) return;
    if (context.task.result?.state === 'fail') console.error(await cluster.dumpLogs());
    await cluster.stop();
    cluster = null;
  });

  it('converts every file exactly once, with both nodes doing some of the work', async () => {
    cluster = await startCluster({
      nodes: [{ libraryAt: '/media' }, { libraryAt: '/media' }],
      files: 4,
      clipSeconds: 6,
    });
    const c = cluster;
    // Distinct content, or the scanner would track fewer files than were made.
    expect(new Set(Object.values(c.originalHashes)).size).toBe(4);

    await c.until('every file to be good', async () =>
      (await c.files()).every((file) => file.state === 'good'),
    );

    const files = await c.files();
    const jobs = await c.jobs();
    expect(files).toHaveLength(4);
    for (const file of files) {
      const mine = jobs.filter((job) => job.file_id === file.id);
      // Exactly one job, and it succeeded: no file was claimed twice.
      expect(mine.map((job) => job.state)).toEqual(['succeeded']);
      expect(file.attempt_count).toBe(0);
      expect(await c.hashOf(file.path)).not.toBe(c.originalHashes[file.path]);
    }
    // A cluster where only one node ever connected must not pass.
    expect(new Set(jobs.map((job) => job.node_id))).toEqual(
      new Set(c.nodes.map((node) => node.id)),
    );
  });
});
