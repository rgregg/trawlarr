import { afterEach, describe, expect, it } from 'vitest';
import { startCluster, STEPS_BEFORE_EXECUTE, type Cluster, type JobRow } from './cluster.js';
import { dockerAvailableSync } from './docker.js';

const available = dockerAvailableSync();

/** The first job, once its Execute step is the one running. */
const jobMidEncode = async (c: Cluster): Promise<JobRow> => {
  await c.until('the node to be encoding', async () => {
    const [job] = await c.jobs();
    return job !== undefined && (await c.stepCount(job.id)) >= STEPS_BEFORE_EXECUTE;
  });
  return (await c.jobs())[0]!;
};

const jobById = async (c: Cluster, id: string): Promise<JobRow> =>
  (await c.jobs()).find((job) => job.id === id)!;

describe.runIf(available)('a node cut off from the server mid-encode', () => {
  let cluster: Cluster | null = null;

  afterEach(async (context) => {
    if (cluster === null) return;
    if (context.task.result?.state === 'fail') console.error(await cluster.dumpLogs());
    await cluster.stop();
    cluster = null;
  });

  it('finishes the same job after reconnecting inside the grace window', async () => {
    cluster = await startCluster({
      nodes: [{ libraryAt: '/media' }],
      files: 1,
      clipSeconds: 15,
      graceMs: 600_000,
    });
    const c = cluster;
    const node = c.nodes[0]!;
    const job = await jobMidEncode(c);

    await node.disconnect();
    await c.until(
      'the server to notice and hold the claim in grace',
      async () => (await jobById(c, job.id)).lease_state === 'grace',
      180_000,
    );
    // Held, not released: the row is still open and the file still claimed.
    expect((await jobById(c, job.id)).ended_at).toBeNull();
    expect((await c.files())[0]!.state).toBe('running');

    await node.reconnect();
    await c.until(
      'the job to finish after reconnecting',
      async () => (await jobById(c, job.id)).state === 'succeeded',
    );

    const [file] = await c.files();
    // One job, no attempt spent, and the file really was replaced.
    expect((await c.jobs()).map((row) => row.id)).toEqual([job.id]);
    expect(file).toMatchObject({ state: 'good', attempt_count: 0 });
    expect(await c.hashOf(file!.path)).not.toBe(c.originalHashes[file!.path]);
  });

  it('releases the file past the grace window and never installs the late result', async () => {
    cluster = await startCluster({
      nodes: [{ libraryAt: '/media' }],
      files: 1,
      clipSeconds: 15,
      graceMs: 3_000,
    });
    const c = cluster;
    const node = c.nodes[0]!;
    const job = await jobMidEncode(c);
    const path = (await c.files())[0]!.path;

    await node.disconnect();
    await c.until(
      'the claim to be released',
      async () => (await jobById(c, job.id)).ended_at !== null,
      180_000,
    );
    const released = await jobById(c, job.id);
    expect(released.state).toBe('failed');
    expect(released.outcome).toContain('grace window');
    expect(released.lease_state).toBe('expired');
    // The data-safety assertion: the original is untouched.
    expect(await c.hashOf(path)).toBe(c.originalHashes[path]);

    // Paused before it comes back, so it is offered nothing new: anything it
    // does to the file from here would be the abandoned job's doing.
    await c.api('PUT', `/nodes/${node.id}`, { paused: true });
    await node.reconnect();
    await c.until('the node to come back online', async () => (await node.view()).online);
    // The node finished encoding while cut off and is waiting at its commit
    // gate. On reconnect it is told to abandon; its journal then empties.
    await c.until('the node to drop the abandoned job', async () => {
      const listed = await node.exec(['sh', '-c', 'ls /config/journal 2>/dev/null || true']);
      return !listed.includes('.json');
    });

    expect(await c.hashOf(path)).toBe(c.originalHashes[path]);
    const jobs = await c.jobs();
    expect(jobs.map((row) => row.id)).toEqual([job.id]);
    expect(jobs.filter((row) => row.state === 'succeeded')).toEqual([]);
    const [file] = await c.files();
    expect(file!.attempt_count).toBe(1);
    expect(file!.state).not.toBe('running');
    expect(file!.state).not.toBe('good');
  });
});
