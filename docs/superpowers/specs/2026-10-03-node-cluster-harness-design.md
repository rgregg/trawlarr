# A multi-node test cluster on one machine

Status: design approved in conversation 2026-10-03; this document awaits review.

## Problem

Remote nodes have only ever run with the "second machine" on the same host.
The end-to-end suite (`packages/server/test/remote-node-end-to-end.test.ts`)
runs one built daemon and one `trawlarr node` process over loopback, with the
node seeing the library through a symlink. That proves the protocol. It cannot
show:

- more than one node competing for claims on one library;
- the real image: the entrypoint in node mode, `PUID`/`PGID`, the enrollment
  path the join dialog prints;
- each machine having its own filesystem view — a server-local staging
  directory a node cannot reach (#49), or two nodes mounting the library at
  different paths;
- a real network partition or a node that dies, rather than a proxy the test
  closes.

The first time any of that runs today is on a real second machine (#41).

## Outcome

An automated suite that brings up a server and several nodes as containers on
one machine, from the image built out of the working tree, and asserts the
multi-node guarantees on file bytes, job rows and ledger state.

- `pnpm test:cluster` runs it locally.
- A `cluster` CI job runs it on every pull request, beside `check`.
- It is not part of `pnpm test`.

## Non-goals

- **NFS.** Containers sharing a volume see one device number for a file, so
  the "server and node disagree about a file's identity" case is not
  reproduced here. It stays covered by unit tests and by #41. The storage
  setup lives in one helper so an NFS profile could be added later; nothing is
  built for it now.
- GPU encoding. Nodes declare `cpu` only.
- The web UI.
- File-transfer mode (#39), which does not exist yet.

## Layout

| Path | What it is |
| --- | --- |
| `docker/compose.cluster.yml` | One `server` service and one `node` service, on a private network, both `build:` from the repo `Dockerfile`. |
| `docker/cluster/cluster.ts` | `startCluster()` and the handles it returns. All `docker` invocations live here. |
| `docker/cluster/media.ts` | Generates the test library with `lavfi testsrc`. |
| `docker/cluster/ffmpeg-realtime` | A shell wrapper that runs `ffmpeg -re "$@"`. |
| `docker/cluster/*.cluster.test.ts` | The scenarios. |
| `vitest.cluster.config.ts` | Includes only `docker/cluster/**/*.cluster.test.ts`; long timeouts; files run one at a time. |

The root vitest config excludes `*.cluster.test.ts`, so `pnpm test` never
starts a container.

The compose file is a test fixture, not a deployment example: it sets
`NODE_ENV=test`. A comment at its top says so and points at
`docker/compose.node.yml` for the real thing.

## The compose file

```yaml
services:
  server:
    build: { context: .. }
    environment:
      - NODE_ENV=test
      - TRAWLARR_TEST_ALLOW_SHORT_GRACE=1
      - TRAWLARR_TEST_LEASE_SWEEP_MS=500
    volumes:
      - config:/config
      - library:/library
      - server-staging:/staging # the server's own disk: no node mounts it
    ports: ['127.0.0.1::8265'] # an ephemeral host port, read back with `docker compose port`
  node:
    build: { context: .. }
    profiles: ['node'] # never started by `up`; the harness starts each one
    environment:
      - TRAWLARR_MODE=node
      - TRAWLARR_SERVER=http://server:8265
      - TRAWLARR_FFMPEG=/cluster/ffmpeg-realtime
    volumes:
      - ./cluster/ffmpeg-realtime:/cluster/ffmpeg-realtime:ro
    healthcheck: { disable: true }
```

Node containers are started one per node with `docker compose run -d --name
<project>-node-<n>`, each given its own `TRAWLARR_NODE_TOKEN`, its own
anonymous `/config` volume, and the `library` volume mounted at a path of the
test's choosing. That is what lets two nodes see the same files at different
paths.

## `startCluster`

```ts
const cluster = await startCluster({
  nodes: [{ libraryAt: '/media' }, { libraryAt: '/mnt/nas' }],
  files: 4,
  clipSeconds: 8,
  graceMs: 5_000,
  serverStagingDir: null, // or '/staging' for the unreachable-staging scenario
  localWorkers: 0,
});
```

In order:

1. **Project name.** `trawlarr-cluster-<random>`; every `docker compose` call
   passes `-p` with it, so a run that crashed cannot collide with the next.
2. **Media.** Generate `files` clips of `clipSeconds` seconds into the
   `library` volume through a one-off container (the image already has
   ffmpeg). No media is committed.
3. **Grace window.** `nodes.leaseGraceMs` is not settable through the API, and
   this design does not add that. A one-off `server` container runs a short
   script against the `config` volume that calls the settings repo's
   `setNodes({ leaseGraceMs })`, before the daemon ever starts. The floor is
   lowered only by the two test switches above, which need `NODE_ENV=test`.
4. **Server.** `up -d server`, wait for `GET /system/health`, read the mapped
   host port and the API key (from the server's data directory, by `exec`).
5. **Library and flow.** Through the API: a flow (Start → Set Video Encoder →
   Execute → Replace Original File), a library on `/library` with that flow
   and the requested `stagingDir`, the local worker target, then a scan.
6. **Nodes.** For each: `POST /nodes`, start its container with the returned
   enrollment token, wait for it to be online, then `PUT /nodes/:id` with its
   path map (`/library` → its `libraryAt`) and worker count, and wait for a
   fresh library probe.

It returns:

```ts
interface Cluster {
  api: ClusterApi; // typed GET/POST/PUT against the server, API key applied
  nodes: ClusterNode[];
  serverExec(argv: string[]): Promise<string>;
  /** sha256 of a library file, read inside the server container. */
  hashOf(serverPath: string): Promise<string>;
  stop(): Promise<void>;
}

interface ClusterNode {
  id: string;
  name: string;
  disconnect(): Promise<void>; // docker network disconnect
  reconnect(): Promise<void>;
  kill(): Promise<void>; // docker kill, no grace
  logs(): Promise<string>;
}
```

`stop()` is `docker compose -p <project> down -v --remove-orphans`, called
from `afterEach`. A global teardown also removes any `trawlarr-cluster-*`
project still present, for a run that was killed.

## Determinism

- **Slow encodes.** Node containers run ffmpeg through `ffmpeg-realtime`, so a
  clip of N seconds takes about N seconds on any machine. Cutting the network
  "mid-encode" is then a wait for the job's first progress event, not a race.
  The server's own workers are not slowed.
- **Short grace.** Seconds, set as above, so "past the grace window" does not
  take an hour.
- **Waiting.** Every wait is `until('<what>', predicate, { timeoutMs })` (the
  existing helper from `packages/server/test/helpers/daemon-harness.ts`, moved
  to `test-support/` so both suites import it). A timeout names what it was
  waiting for.

## Scenarios

Each is one test file, with its own cluster.

| # | Scenario | Setup | Asserts |
| --- | --- | --- | --- |
| 1 | Two nodes share a library | 2 nodes, 1 worker each, 4 files, no local workers | Every file ends `good`; each file has exactly one job in state `succeeded`; both node ids appear in `job.node_id`; every file's hash changed |
| 2 | Different mount paths | Node A at `/media`, node B at `/mnt/nas` | As 1, and no path in any job or file row begins with `/media` or `/mnt/nas` |
| 3 | Staging the nodes cannot reach | Library `stagingDir: '/staging'`, 1 node, 1 local worker | The node's library probe is unreachable with detail `staging: no path on this node`; no job has that node's id; the local worker finishes every file |
| 4 | Network cut inside grace | 1 node, `graceMs` longer than the cut | The job's lease goes to `grace`, then back; the job finishes; the file has one job and `attempt_count` 0 at the end |
| 5 | Network cut past grace | 1 node, cut held past `graceMs`, 0 local workers | The file is released with the grace message; after reconnect the node's result is not installed: the file's hash equals the original's until a later job replaces it; the released job row gains the "late result" line |
| 6 | Node killed mid-job | 2 nodes; kill the one running the first job | No file stays `running`; the file is finished by the other node; the killed node's job ends failed |

Scenario 5 is the data-safety case: it is asserted on the bytes of the file,
not on the absence of an error.

Job and file state is read through the API (`/jobs`, `/files`,
`/libraries/:id/stats`, `/nodes`). Scenario 4 needs a job's lease state; the
job row carries it (`leaseState`), and if the jobs route does not return it
the harness reads that one column from the server's database with
`serverExec` rather than widening the API for a test.

## When the harness itself fails

- **Docker absent.** Following `test-support/tool-availability.ts`: only
  `ENOENT` for `docker` skips. Docker present but unusable (daemon down, build
  failure) throws. CI sets `TRAWLARR_REQUIRE_DOCKER=1`, under which even
  `ENOENT` throws, so the CI job can never pass by skipping.
- **A failed test.** Before teardown, the helper writes each container's logs
  and the server's job logs to the test output.
- **A leaked cluster.** Unique project names plus the global teardown above.

## CI

A new `cluster` job in `.github/workflows/ci.yml`, on `pull_request` and on
pushes to `main`:

- independent of `check` (it does not wait for it, and `image` does not wait
  for `cluster`);
- builds the image with buildx and the same `type=gha` cache the `image` job
  uses, loads it into the runner's Docker, and passes its tag to the suite so
  compose does not build it again;
- runs `pnpm test:cluster` with `TRAWLARR_REQUIRE_DOCKER=1`;
- uploads container logs as an artifact on failure.

Whether `cluster` becomes a required check is left for after it has been
green for a while.

## Testing the harness

The scenarios are the test. Two things guard the harness against passing for
the wrong reason:

- Scenario 1 asserts both nodes ran a job, so a cluster where only one node
  ever connected fails.
- `docker/compose-contract.test.ts` gains a case that
  `compose.cluster.yml` sets `NODE_ENV=test`, and that no other compose file
  in `docker/` does.

## Risks

- **Run time.** Six clusters, each starting two or three containers and
  encoding a few 8-second clips in real time. Expected to be several minutes;
  the plan measures it and trims clip counts before adding it to CI.
- **Runner resources.** GitHub's hosted runners have few cores; the slowed
  encodes are light (low resolution `testsrc`), but this is the first suite to
  run several containers there.
- **Flakiness from timing.** Mitigated by event-driven waits; no scenario
  sleeps for a fixed time except to hold a network cut past the grace window.
