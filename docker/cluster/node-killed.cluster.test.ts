import { afterEach, describe, expect, it } from 'vitest';
import { startCluster, STEPS_BEFORE_EXECUTE, type Cluster } from './cluster.js';
import { dockerAvailableSync } from './docker.js';

const available = dockerAvailableSync();

describe.runIf(available)('a node that dies mid-job', () => {
  let cluster: Cluster | null = null;

  afterEach(async (context) => {
    if (cluster === null) return;
    if (context.task.result?.state === 'fail') console.error(await cluster.dumpLogs());
    await cluster.stop();
    cluster = null;
  });

  it('releases its file untouched, and the other node finishes it', async () => {
    cluster = await startCluster({
      nodes: [{ libraryAt: '/media' }, { libraryAt: '/media' }],
      files: 2,
      clipSeconds: 12,
      graceMs: 3_000,
    });
    const c = cluster;

    await c.until('a node to be encoding', async () => {
      const [job] = await c.jobs();
      return job !== undefined && (await c.stepCount(job.id)) >= STEPS_BEFORE_EXECUTE;
    });
    const doomed = (await c.jobs())[0]!;
    const victim = c.nodes.find((node) => node.id === doomed.node_id)!;
    const survivor = c.nodes.find((node) => node.id !== doomed.node_id)!;
    const path = (await c.files()).find((file) => file.id === doomed.file_id)!.path;

    await victim.kill();
    await c.until(
      "the dead node's claim to be released",
      async () => (await c.jobs()).find((job) => job.id === doomed.id)!.ended_at !== null,
      120_000,
    );

    const released = (await c.jobs()).find((job) => job.id === doomed.id)!;
    expect(released.state).toBe('failed');
    const held = (await c.files()).find((file) => file.id === doomed.file_id)!;
    // Out of `running`, one attempt spent, original bytes intact.
    expect(held.state).not.toBe('running');
    expect(held.attempt_count).toBe(1);
    expect(await c.hashOf(path)).toBe(c.originalHashes[path]);

    // Backoff holds a failed file for minutes; requeue is the way out.
    await c.api('POST', `/files/${doomed.file_id}/requeue`);
    await c.until('every file to be good', async () =>
      (await c.files()).every((file) => file.state === 'good'),
    );

    const jobs = await c.jobs();
    const finisher = jobs.find(
      (job) => job.file_id === doomed.file_id && job.state === 'succeeded',
    );
    expect(finisher?.node_id).toBe(survivor.id);
    expect(await c.hashOf(path)).not.toBe(c.originalHashes[path]);
    // Nothing is left claimed by the dead node.
    expect(jobs.filter((job) => job.ended_at === null)).toEqual([]);
  });
});
