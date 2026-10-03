import { join } from 'node:path';
import { until } from '../../test-support/until.js';
import { docker, projectName } from './docker.js';

export interface ClusterOptions {
  /** One entry per node: where that node mounts the library, and its transcode workers (default 1). */
  nodes: { libraryAt: string; workers?: number }[];
  files: number;
  clipSeconds: number;
  /** `nodes.leaseGraceMs`. Default five minutes, so a scenario that never means to expire one cannot. */
  graceMs?: number;
  /** The library's `stagingDir` on the server; null leaves the per-root default. */
  serverStagingDir?: string | null;
  /** The server's own transcode workers. Default 0, so only nodes can take a job. */
  localWorkers?: number;
}

export interface JobRow {
  id: string;
  file_id: string;
  node_id: string | null;
  state: string;
  outcome: string | null;
  lease_state: string | null;
  ended_at: number | null;
}

export interface FileRow {
  id: string;
  path: string;
  state: string;
  attempt_count: number;
}

export interface NodeView {
  id: string;
  name: string;
  online: boolean;
  paused: boolean;
  libraries: { libraryId: string; reachable: boolean; detail: string }[];
  running: string[];
}

export interface ClusterNode {
  id: string;
  name: string;
  container: string;
  view(): Promise<NodeView>;
  /** A real partition: packets are dropped, the socket is not closed. */
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  /** SIGKILL, no shutdown path. */
  kill(): Promise<void>;
  exec(argv: readonly string[]): Promise<string>;
  /** The command line of every process in the container, one per entry. */
  processes(): Promise<string[]>;
  logs(): Promise<string>;
}

export interface Cluster {
  project: string;
  libraryId: string;
  nodes: ClusterNode[];
  /** sha256 of each clip as generated, keyed by server path. */
  originalHashes: Record<string, string>;
  api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T>;
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  jobs(): Promise<JobRow[]>;
  files(): Promise<FileRow[]>;
  stepCount(jobId: string): Promise<number>;
  hashOf(serverPath: string): Promise<string>;
  /** `until`, nudging the supervisor each second and dumping state on timeout. */
  until(what: string, predicate: () => Promise<boolean>, timeoutMs?: number): Promise<void>;
  dumpLogs(): Promise<string>;
  stop(): Promise<void>;
}

const COMPOSE_FILE = join(process.cwd(), 'docker', 'compose.cluster.yml');
const LIBRARY_ROOT = '/library/movies';

const flowNode = (id: string, pluginId: string, inputs: Record<string, string> = {}) => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs,
});

const FLOW_IDS = ['start', 'begin', 'encoder', 'execute', 'verify', 'replace'];

/**
 * Start → Begin Command → Set Video Encoder (libx264) → Execute → Verify →
 * Replace Original File. The clips are mpeg4, so this really encodes.
 */
export const TRANSCODE_FLOW = {
  nodes: [
    flowNode('start', 'trawlarr:start'),
    flowNode('begin', 'trawlarr:beginCommand'),
    flowNode('encoder', 'trawlarr:setVideoEncoder', { encoder: 'libx264', quality: '35' }),
    flowNode('execute', 'trawlarr:execute'),
    flowNode('verify', 'trawlarr:verifyOutput', {
      durationToleranceSeconds: '1',
      minSizeRatio: '0.01',
    }),
    flowNode('replace', 'trawlarr:replaceOriginal', {
      trashRetentionDays: '14',
      allowCrossDevice: 'true',
    }),
  ],
  edges: FLOW_IDS.slice(1).map((toNodeId, index) => ({
    fromNodeId: FLOW_IDS[index]!,
    outputNumber: 1,
    toNodeId,
  })),
};

/**
 * `job_step` gets a row as each flow node finishes. Start, Begin Command and
 * Set Video Encoder are instant, so three rows mean Execute is running now.
 */
export const STEPS_BEFORE_EXECUTE = 3;

const tail = (text: string, lines = 40): string => text.trim().split('\n').slice(-lines).join('\n');

export const startCluster = async (options: ClusterOptions): Promise<Cluster> => {
  // The owner is the vitest main process (global-setup.ts), so its teardown
  // can find this cluster and no other run's sweep will take it.
  const project = projectName(Number(process.env.TRAWLARR_CLUSTER_OWNER ?? process.pid));
  const graceMs = options.graceMs ?? 300_000;
  const localWorkers = options.localWorkers ?? 0;
  const compose = async (args: readonly string[]): Promise<string> =>
    await docker(['compose', '-p', project, '-f', COMPOSE_FILE, ...args]);
  const nodeContainers: string[] = [];

  const stop = async (): Promise<void> => {
    // Node containers were made by `compose run`; removed by name first so
    // `down` never has to guess whether they count as orphans.
    for (const container of nodeContainers) {
      await docker(['rm', '-f', '-v', container]).catch(() => undefined);
    }
    await compose(['down', '-v', '--remove-orphans', '--timeout', '0']);
  };

  try {
    // ---- media ------------------------------------------------------------
    // As root with no entrypoint: a fresh named volume is root-owned, and the
    // entrypoint only chowns /config. Each clip gets its own hue so no two
    // are byte-identical — the scanner treats same-content files as one.
    const generate =
      `set -e; mkdir -p ${LIBRARY_ROOT}; i=1; ` +
      `while [ "$i" -le ${String(options.files)} ]; do ` +
      `ffmpeg -hide_banner -loglevel error -y -f lavfi ` +
      `-i "testsrc=duration=${String(options.clipSeconds)}:size=160x120:rate=25,hue=h=$((i * 37))" ` +
      `-c:v mpeg4 -q:v 5 ${LIBRARY_ROOT}/clip-$i.mkv; i=$((i + 1)); done; ` +
      `chown -R 1000:1000 /library /staging`;
    await compose(['run', '--rm', '--no-deps', '--user', 'root', '--entrypoint', 'sh', 'server', '-c', generate]); // prettier-ignore

    // ---- settings, before the daemon first opens its database -----------------
    await compose(['run', '--rm', '--no-deps', 'server', 'node', '/cluster/seed.mjs', String(graceMs), String(localWorkers)]); // prettier-ignore

    // ---- server -----------------------------------------------------------
    await compose(['up', '-d', 'server']);
    const serverLogs = async (): Promise<string> =>
      tail(await compose(['logs', '--no-color', 'server']));
    const hostPort = (await compose(['port', 'server', '8265'])).trim().split(':').pop()!;
    const base = `http://127.0.0.1:${hostPort}/api/v1`;
    await until(
      'the server to answer its health check',
      async () => {
        try {
          return (await fetch(`${base}/system/health`)).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 120_000, intervalMs: 500, describe: serverLogs },
    );
    const apiKey = (
      JSON.parse(await compose(['exec', '-T', 'server', 'cat', '/config/daemon.json'])) as {
        apiKey: string;
      }
    ).apiKey;

    const api = async <T>(
      method: 'GET' | 'POST' | 'PUT',
      path: string,
      body?: unknown,
    ): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${method} ${path} answered ${String(response.status)}: ${text}`);
      }
      return (text === '' ? undefined : JSON.parse(text)) as T;
    };

    const serverExec = async (argv: readonly string[]): Promise<string> =>
      await compose(['exec', '-T', 'server', ...argv]);
    const query = async <T>(sql: string, params: readonly unknown[] = []): Promise<T[]> =>
      JSON.parse(
        await serverExec(['node', '/cluster/query.mjs', sql, JSON.stringify(params)]),
      ) as T[];
    const hashOf = async (serverPath: string): Promise<string> =>
      (await serverExec(['sha256sum', serverPath])).split(/\s+/)[0]!;
    const jobs = async (): Promise<JobRow[]> =>
      await query<JobRow>(
        `SELECT id, file_id, node_id, state, outcome, lease_state, ended_at
           FROM job ORDER BY started_at, id`,
      );
    const files = async (): Promise<FileRow[]> =>
      await query<FileRow>(`SELECT id, path, state, attempt_count FROM media_file ORDER BY path`);

    const originalHashes: Record<string, string> = {};
    for (let index = 1; index <= options.files; index += 1) {
      const path = `${LIBRARY_ROOT}/clip-${String(index)}.mkv`;
      originalHashes[path] = await hashOf(path);
    }
    if (new Set(Object.values(originalHashes)).size !== options.files) {
      throw new Error(
        `The ${String(options.files)} generated clips are not all distinct, so the scanner would ` +
          `track fewer files than the test made.`,
      );
    }

    // ---- library and flow ---------------------------------------------------
    const flow = await api<{ id: string }>('POST', '/flows', {
      name: 'Cluster',
      definition: TRANSCODE_FLOW,
    });
    const library = await api<{ id: string }>('POST', '/libraries', {
      name: 'Movies',
      roots: [LIBRARY_ROOT],
      flowId: flow.id,
      stagingDir: options.serverStagingDir ?? null,
    });

    // ---- nodes --------------------------------------------------------------
    const nodes: ClusterNode[] = [];
    for (const [index, spec] of options.nodes.entries()) {
      const name = `node-${String(index + 1)}`;
      const container = `${project}-${name}`;
      const created = await api<{ node: { id: string }; enrollToken: string }>('POST', '/nodes', {
        name,
      });
      const id = created.node.id;
      await compose([
        'run', '-d', '--no-deps', '--name', container,
        '-e', `TRAWLARR_NODE_TOKEN=${created.enrollToken}`,
        // The project's own library volume, at this node's own path.
        '-v', `${project}_library:${spec.libraryAt}`,
        'node',
      ]); // prettier-ignore
      nodeContainers.push(container);

      const logs = async (): Promise<string> => await docker(['logs', container]);
      const view = async (): Promise<NodeView> =>
        (await api<NodeView[]>('GET', '/nodes')).find((entry) => entry.id === id)!;
      const describe = async (): Promise<string> => `${name}:\n${tail(await logs())}`;

      await until(`${name} to come online`, async () => (await view()).online, {
        timeoutMs: 120_000,
        intervalMs: 500,
        describe,
      });
      await api('PUT', `/nodes/${id}`, {
        pathMap: [{ serverPath: '/library', nodePath: spec.libraryAt }],
        schedule: {
          timezone: 'UTC',
          baseCounts: { transcode: spec.workers ?? 1, health: 0 },
          windows: [],
        },
      });
      // The probe taken BEFORE the map says every root has no path. Wait for
      // the one taken after: reachable, or unreachable for another reason.
      await until(
        `${name} to probe the library through its path map`,
        async () => {
          const probe = (await view()).libraries.find((entry) => entry.libraryId === library.id);
          return (
            probe !== undefined && (probe.reachable || probe.detail !== 'no path on this node')
          );
        },
        { timeoutMs: 120_000, intervalMs: 500, describe },
      );

      nodes.push({
        id,
        name,
        container,
        view,
        logs,
        disconnect: async () => {
          await docker(['network', 'disconnect', `${project}_default`, container]);
        },
        reconnect: async () => {
          await docker(['network', 'connect', `${project}_default`, container]);
        },
        kill: async () => {
          await docker(['kill', container]);
        },
        exec: async (argv) => await docker(['exec', container, ...argv]),
        // From /proc, because the image has no `ps`. A process can exit
        // between the glob and the read; that one is simply not listed.
        processes: async () =>
          (
            await docker([
              'exec', container, 'sh', '-c',
              'for f in /proc/[0-9]*/cmdline; do { tr "\\0" " " < "$f"; echo; } 2>/dev/null; done',
            ])
          )
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''), // prettier-ignore
      });
    }

    const dumpLogs = async (): Promise<string> => {
      const parts = [`--- server ---\n${await serverLogs()}`];
      for (const node of nodes) {
        parts.push(`--- ${node.name} ---\n${tail(await node.logs().catch(String))}`);
      }
      parts.push(`--- jobs ---\n${JSON.stringify(await jobs().catch(String), null, 2)}`);
      parts.push(`--- files ---\n${JSON.stringify(await files().catch(String), null, 2)}`);
      return parts.join('\n');
    };

    let lastKick = 0;
    const cluster: Cluster = {
      project,
      libraryId: library.id,
      nodes,
      originalHashes,
      api,
      query,
      jobs,
      files,
      hashOf,
      stepCount: async (jobId) =>
        (
          await query<{ n: number }>(`SELECT COUNT(*) AS n FROM job_step WHERE job_id = ?`, [jobId])
        )[0]!.n,
      until: async (what, predicate, timeoutMs = 300_000) => {
        await until(
          what,
          async () => {
            if (await predicate()) return true;
            if (Date.now() - lastKick > 1_000) {
              lastKick = Date.now();
              // Awaits a full supervisor tick; the local count is unchanged.
              await api('PUT', '/workers/counts', { transcode: localWorkers });
            }
            return false;
          },
          { timeoutMs, intervalMs: 250, describe: dumpLogs },
        );
      },
      dumpLogs,
      stop,
    };

    // ---- scan, last: nothing is claimable until every node is ready -------------
    await api('POST', `/libraries/${library.id}/scan`);
    await cluster.until(
      `the scan to find ${String(options.files)} files`,
      async () => (await files()).length === options.files,
      120_000,
    );
    return cluster;
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
};
