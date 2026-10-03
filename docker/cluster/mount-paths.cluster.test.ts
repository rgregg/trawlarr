import { afterEach, describe, expect, it } from 'vitest';
import { startCluster, type Cluster } from './cluster.js';
import { dockerAvailableSync } from './docker.js';

const available = dockerAvailableSync();

describe.runIf(available)('nodes that mount the library at different paths', () => {
  let cluster: Cluster | null = null;

  afterEach(async (context) => {
    if (cluster === null) return;
    if (context.task.result?.state === 'fail') console.error(await cluster.dumpLogs());
    await cluster.stop();
    cluster = null;
  });

  it('records every result in the server view, whichever node ran it', async () => {
    cluster = await startCluster({
      nodes: [{ libraryAt: '/media' }, { libraryAt: '/mnt/nas' }],
      files: 4,
      clipSeconds: 6,
    });
    const c = cluster;

    await c.until('every file to be good', async () =>
      (await c.files()).every((file) => file.state === 'good'),
    );

    const files = await c.files();
    const jobs = await c.jobs();
    // Both views really were used.
    expect(new Set(jobs.map((job) => job.node_id))).toEqual(
      new Set(c.nodes.map((node) => node.id)),
    );
    for (const file of files) {
      // A report that came back in a node's view would put its mount path here.
      expect(file.path.startsWith('/library/movies/')).toBe(true);
      expect(await c.hashOf(file.path)).not.toBe(c.originalHashes[file.path]);
    }
    for (const job of jobs) {
      expect(job.outcome ?? '').not.toMatch(/\/media\/|\/mnt\/nas\//);
    }
    // And the replaced files really are where each node sees them.
    expect(await c.nodes[0]!.exec(['ls', '/media/movies'])).toContain('clip-1.mkv');
    expect(await c.nodes[1]!.exec(['ls', '/mnt/nas/movies'])).toContain('clip-1.mkv');
  });
});
