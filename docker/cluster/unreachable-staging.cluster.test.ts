import { afterEach, describe, expect, it } from 'vitest';
import { startCluster, type Cluster } from './cluster.js';
import { dockerAvailableSync } from './docker.js';

const available = dockerAvailableSync();

describe.runIf(available)('a library that stages on a disk only the server has', () => {
  let cluster: Cluster | null = null;

  afterEach(async (context) => {
    if (cluster === null) return;
    if (context.task.result?.state === 'fail') console.error(await cluster.dumpLogs());
    await cluster.stop();
    cluster = null;
  });

  it('offers the node nothing and says why, while the server converts the files itself', async () => {
    cluster = await startCluster({
      nodes: [{ libraryAt: '/media' }],
      files: 2,
      clipSeconds: 2,
      // The server's own volume: compose.cluster.yml gives no node this mount.
      serverStagingDir: '/staging',
      localWorkers: 1,
    });
    const c = cluster;
    const node = c.nodes[0]!;

    // What the node's card prints. Before #49 this probed reachable, the node
    // was claimed, failed to map, and looped without ever running a job.
    const probe = (await node.view()).libraries.find((entry) => entry.libraryId === c.libraryId);
    expect(probe).toEqual({
      libraryId: c.libraryId,
      reachable: false,
      detail: 'staging: no path on this node',
    });

    await c.until('the server to convert every file itself', async () =>
      (await c.files()).every((file) => file.state === 'good'),
    );

    const jobs = await c.jobs();
    expect(jobs).toHaveLength(2);
    // Per node, not a stall: the files were done, and none of it by the node.
    expect(jobs.filter((job) => job.node_id === node.id)).toEqual([]);
    expect(jobs.map((job) => job.state)).toEqual(['succeeded', 'succeeded']);
  });
});
