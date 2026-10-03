# Node Cluster Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A container suite that runs one trawlarr server and several nodes on one machine, from the image built out of the working tree, and asserts the multi-node guarantees on file bytes, job rows and ledger state.

**Architecture:** A compose file (`docker/compose.cluster.yml`) defines a `server` and a `node` service on a private network. A TypeScript helper (`docker/cluster/cluster.ts`) shells out to `docker compose` to generate media, seed settings, start the server, enrol each node through the real API, and inject faults. Scenarios are vitest files run by their own config, never by `pnpm test`.

**Tech Stack:** Docker Compose v2, vitest, Node 22 `fetch`, `child_process.execFile`. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-10-03-node-cluster-harness-design.md`

## Global Constraints

- No new npm dependency (`pnpm audit:licenses` must stay green).
- No committed media: clips are generated with `lavfi testsrc`.
- No product code changes. Nothing under `packages/*/src` is modified except moving the `until` helper out of a test helper file (Task 3).
- The suite is not part of `pnpm test`: the root vitest config excludes `*.cluster.test.ts`.
- `NODE_ENV=test` appears in `docker/compose.cluster.yml` and in no other compose file.
- Image under test is tagged `trawlarr-cluster:dev`; the harness never pulls and never builds it.
- Only `ENOENT` for `docker` skips the suite; with `TRAWLARR_REQUIRE_DOCKER=1` even that throws.
- Node 22: in an agent shell run commands as `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm …`.
- Do not run the full `pnpm test` locally; scope vitest to the files a task touches.
- Commit messages: `type(scope): a sentence saying what changed and why it matters`, lowercase.
- **Prerequisite:** PR #52 must be merged into the branch this work starts from. Scenario 3 asserts the probe message `staging: no path on this node`, which #52 introduces. Check with `grep -n "no path on this node" packages/server/src/node/node-host.ts`: it must show a line containing `${dir.kind}`.

## Where this plan departs from the spec, and why

Found while reading the code for this plan. The spec has been updated to match.

1. **State is read from the database, not the API.** A small script mounted into the server container runs a read-only SQL query and prints JSON. This is what the existing end-to-end suite does, and it avoids depending on which columns each API route happens to return.
2. **"Mid-encode" is detected by step count, not a progress event.** `job_step` gets a row as each flow node finishes. With the flow used here (Start, Begin Command, Set Video Encoder, Execute, …), three rows mean Execute is running. Progress events are not durable and would need a WebSocket client.
3. **A network cut must last about a minute to be noticed.** `docker network disconnect` drops packets without closing the socket. The server only declares a node offline after 45 s without a pong (`DEFAULT_OFFLINE_AFTER_MS` in `packages/server/src/nodes/hub.ts`). Scenarios 4 and 5 therefore each take over a minute. No product seam is added to shorten this.
4. **A released file is in backoff for 5 minutes.** A failed attempt holds the file (`BACKOFF_MINUTES` in `packages/core/src/ledger.ts`). Scenario 6 asserts the release, then requeues the file through `POST /files/:id/requeue` and asserts the other node finishes it.
5. **Scenario 5 asserts bytes and the node's journal, not the "late result" line.** After release the test pauses the node (so it is offered nothing new), reconnects it, waits for its journal to empty, and asserts the file's hash is still the original's.

## Review Focus

Failure modes the spec implies but no scenario exercises, most likely first. Each has a test in the task named.

1. **The image `trawlarr-cluster:dev` is missing or stale** → the run must stop with one message saying how to build it, not fail six times with a compose error. (Task 2: `assertImagePresent` test.)
2. **Docker is installed but its daemon is down** → the suite must throw, never skip. (Task 2: `dockerAvailableSync` tests.)
3. **A previous run was killed and left a cluster up** → the next run must remove it before starting. (Task 2: `leakedProjects` test; Task 3 wires it into global setup.)
4. **Generated clips are byte-identical** → the scanner treats same-content files as one identity, and the suite would assert on fewer files than it made. (Task 3: `startCluster` throws if the clip hashes are not all distinct; the smoke test asserts the count.)
5. **A node never comes online** → the wait must fail naming that node and print its container log. (Task 3: every `until` in `startCluster` passes a `describe` that returns the container's log tail.)

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `docker/compose.cluster.yml` | The fixture topology. |
| `docker/cluster/in-container/ffmpeg-realtime` | `ffmpeg -re` wrapper, mounted into nodes. |
| `docker/cluster/in-container/seed.mjs` | Writes scan, schedule and grace settings before the daemon starts. |
| `docker/cluster/in-container/query.mjs` | Read-only SQL against the server's database, JSON on stdout. |
| `docker/cluster/docker.ts` | `docker` invocation, availability, image check, leaked-project listing. No cluster knowledge. |
| `docker/cluster/docker.test.ts` | Unit tests for the above. Runs in `pnpm test`. |
| `docker/cluster/cluster.ts` | `startCluster()` and its handles. |
| `docker/cluster/global-setup.ts` | Image check and leaked-cluster cleanup, before and after the run. |
| `docker/cluster/*.cluster.test.ts` | One scenario per file. |
| `vitest.cluster.config.ts` | Runs only `*.cluster.test.ts`, serially, with long timeouts. |
| `test-support/until.ts` | The `until` helper, shared by both end-to-end suites. |

---

### Task 1: The fixture and its guards

**Files:**
- Create: `docker/compose.cluster.yml`
- Create: `docker/cluster/in-container/ffmpeg-realtime`
- Create: `docker/cluster/in-container/seed.mjs`
- Create: `docker/cluster/in-container/query.mjs`
- Create: `vitest.cluster.config.ts`
- Modify: `vitest.config.ts` (add `exclude`)
- Modify: `package.json` (add `test:cluster`)
- Modify: `docker/compose-contract.test.ts`

**Interfaces:**
- Produces: the compose services `server` and `node`; in-container paths `/cluster/seed.mjs`, `/cluster/query.mjs`, `/cluster/ffmpeg-realtime`; the env var `TRAWLARR_CLUSTER_IMAGE` (default `trawlarr-cluster:dev`); `pnpm test:cluster`.

- [ ] **Step 1: Write the failing contract tests**

In `docker/compose-contract.test.ts`, the generic lists must stop including the cluster fixture, and a new block must pin what makes it a fixture. Change the two list definitions:

```ts
// The cluster file is a TEST FIXTURE (docker/cluster/), not a deployment: it
// sets NODE_ENV=test and test-only seams, has no fixed hostname and no drain
// period. It is held to its own contract below, not to a deployment's.
const CLUSTER_FIXTURE = join('docker', 'compose.cluster.yml');

const composeFiles = readdirSync('docker')
  .filter((name) => name.startsWith('compose') && name.endsWith('.yml'))
  .map((name) => join('docker', name))
  .filter((file) => file !== CLUSTER_FIXTURE);
```

(`serverComposeFiles` is derived from `composeFiles` and needs no change.)

Append at the end of the file:

```ts
describe('the cluster test fixture', () => {
  const cluster = readFileSync(CLUSTER_FIXTURE, 'utf8');

  it('is the only compose file that runs the daemon with NODE_ENV=test', () => {
    // NODE_ENV=test is what lets TRAWLARR_TEST_ALLOW_SHORT_GRACE lower the
    // lease grace floor. In a deployment file that would let a setting cut
    // the window a disconnected node has to a few seconds.
    expect(cluster).toMatch(/^\s*- NODE_ENV=test$/m);
    for (const file of composeFiles) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/NODE_ENV=test/);
    }
  });

  it('never builds or pulls: it runs the image the harness was given', () => {
    expect(cluster).not.toMatch(/^\s*build:/m);
    expect(cluster.match(/pull_policy: never/g)).toHaveLength(2);
    expect(cluster.match(/image: \$\{TRAWLARR_CLUSTER_IMAGE:-trawlarr-cluster:dev\}/g)).toHaveLength(2);
  });

  it('gives no node the server staging volume', () => {
    // Scenario 3 depends on it: a staging directory on the server's own disk
    // must be a path a node cannot reach.
    const nodeService = cluster.slice(cluster.indexOf('\n  node:'));
    expect(nodeService).not.toContain('server-staging');
  });

  it('says at the top that it is not a deployment example', () => {
    expect(cluster.split('\n')[0]).toBe('# TEST FIXTURE. Not a deployment example: see compose.node.yml.');
  });
});
```

- [ ] **Step 2: Run the contract tests to verify they fail**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run docker/compose-contract.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open 'docker/compose.cluster.yml'`.

- [ ] **Step 3: Create the compose fixture**

`docker/compose.cluster.yml`:

```yaml
# TEST FIXTURE. Not a deployment example: see compose.node.yml.
#
# Driven by docker/cluster/cluster.ts, never by hand. NODE_ENV=test is what
# lets the two TRAWLARR_TEST_* seams lower the lease grace window and speed up
# the lease sweep; both are ignored under any other NODE_ENV.
services:
  server:
    image: ${TRAWLARR_CLUSTER_IMAGE:-trawlarr-cluster:dev}
    pull_policy: never
    environment:
      - NODE_ENV=test
      - TRAWLARR_TEST_ALLOW_SHORT_GRACE=1
      - TRAWLARR_TEST_LEASE_SWEEP_MS=500
    volumes:
      - config:/config
      - library:/library
      # The server's own disk. No node mounts it, which is the point.
      - server-staging:/staging
      - ./cluster/in-container:/cluster:ro
    ports:
      # An ephemeral host port, so two runs never collide. Read back with
      # `docker compose port server 8265`.
      - '127.0.0.1::8265'

  node:
    image: ${TRAWLARR_CLUSTER_IMAGE:-trawlarr-cluster:dev}
    pull_policy: never
    # Never started by `up`: the harness starts one container per node with
    # `compose run`, each with its own token and its own library mount path.
    profiles: ['node']
    environment:
      - TRAWLARR_MODE=node
      - TRAWLARR_SERVER=http://server:8265
      # Real-time ffmpeg, so an N-second clip takes N seconds on any machine
      # and "mid-encode" is a window a test can hit.
      - TRAWLARR_FFMPEG=/cluster/ffmpeg-realtime
    volumes:
      - ./cluster/in-container:/cluster:ro
    healthcheck:
      disable: true

volumes:
  config:
  library:
  server-staging:
```

- [ ] **Step 4: Create the in-container scripts**

`docker/cluster/in-container/ffmpeg-realtime`:

```sh
#!/bin/sh
# ffmpeg at native frame rate. See TRAWLARR_FFMPEG in compose.cluster.yml.
exec /usr/bin/ffmpeg -re "$@"
```

Then: `chmod +x docker/cluster/in-container/ffmpeg-realtime` and confirm git records it: `git add docker/cluster/in-container/ffmpeg-realtime && git ls-files -s docker/cluster/in-container/ffmpeg-realtime` must start with `100755`.

`docker/cluster/in-container/seed.mjs`:

```js
// Runs INSIDE the server image, before the daemon first starts, against the
// same /config volume the daemon will open. Usage:
//   node /cluster/seed.mjs <leaseGraceMs> <localTranscodeWorkers>
//
// `nodes.leaseGraceMs` cannot be set through the API, and the watcher and
// periodic rescan would race the scenarios, so all three are written here.
// The short grace is accepted only because compose.cluster.yml sets
// NODE_ENV=test and TRAWLARR_TEST_ALLOW_SHORT_GRACE=1.
import { openDatabase } from '/app/dist/db/connection.js';
import { migrate } from '/app/dist/db/migrate.js';
import { createSettingsRepo } from '/app/dist/db/settings-repo.js';

const leaseGraceMs = Number(process.argv[2]);
const localTranscode = Number(process.argv[3]);
if (!Number.isInteger(leaseGraceMs) || !Number.isInteger(localTranscode)) {
  throw new Error('usage: seed.mjs <leaseGraceMs> <localTranscodeWorkers>');
}

const db = openDatabase({ file: '/config/trawlarr.db' });
migrate(db);
const settings = createSettingsRepo({ db });
settings.setScan({ watchEnabled: false, rescanIntervalMs: 0, settleMs: 0 });
settings.setSchedule({
  timezone: 'UTC',
  baseCounts: { transcode: localTranscode, health: 0 },
  windows: [],
});
settings.setNodes({ leaseGraceMs });
db.close();
```

`docker/cluster/in-container/query.mjs`:

```js
// Runs INSIDE the server container. Read-only SQL against the daemon's
// database; rows as JSON on stdout. Usage:
//   node /cluster/query.mjs "<sql>" '<json array of parameters>'
import { createRequire } from 'node:module';

const require = createRequire('/app/');
const Database = require('better-sqlite3');

const db = new Database('/config/trawlarr.db', { readonly: true, fileMustExist: true });
const params = JSON.parse(process.argv[3] ?? '[]');
process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all(...params)));
db.close();
```

- [ ] **Step 5: Keep the suite out of `pnpm test` and give it its own config**

In `vitest.config.ts`, add an `exclude` directly after the `include` array:

```ts
    // The container suite (docker/cluster/) starts a multi-container cluster
    // per file. It has its own config and its own command, `pnpm test:cluster`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.cluster.test.ts'],
```

Create `vitest.cluster.config.ts`:

```ts
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
```

In `package.json` scripts, add after `"test:watch"`:

```json
    "test:cluster": "docker build -t trawlarr-cluster:dev . && vitest run --config vitest.cluster.config.ts",
```

- [ ] **Step 6: Run the contract tests to verify they pass**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run docker`
Expected: PASS, including the four new cases. (`globalSetup` does not exist yet; it is only read by `vitest.cluster.config.ts`, which this command does not use.)

- [ ] **Step 7: Lint**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec eslint docker vitest.cluster.config.ts && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec prettier --check docker vitest.cluster.config.ts vitest.config.ts package.json`
Expected: clean. If eslint reports the `/app/dist/...` imports in `seed.mjs` as unresolved, add `'docker/cluster/in-container/**'` to the `ignores` array in `eslint.config.js` with the comment `// Run inside the image, where /app is the deployed server package.` and re-run.

- [ ] **Step 8: Commit**

```bash
git add docker/compose.cluster.yml docker/cluster/in-container vitest.cluster.config.ts vitest.config.ts package.json docker/compose-contract.test.ts eslint.config.js
git commit -m "test(docker): add the cluster fixture and hold it to its own contract, so NODE_ENV=test can never reach a deployment compose file"
```

---

### Task 2: Docker plumbing

**Files:**
- Create: `docker/cluster/docker.ts`
- Test: `docker/cluster/docker.test.ts`

**Interfaces:**
- Produces:
  - `CLUSTER_IMAGE: string`
  - `PROJECT_PREFIX = 'trawlarr-cluster-'`
  - `type Run = (args: readonly string[]) => Promise<string>`
  - `docker: Run` (runs `docker <args>`, resolves stdout, rejects with stderr in the message)
  - `dockerAvailableSync(env?, spawn?): boolean`
  - `assertImagePresent(run?: Run): Promise<void>`
  - `leakedProjects(run?: Run): Promise<string[]>`
  - `class DockerCheckFailedError extends Error`

- [ ] **Step 1: Write the failing tests**

`docker/cluster/docker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertImagePresent,
  DockerCheckFailedError,
  dockerAvailableSync,
  leakedProjects,
  type SpawnSync,
} from './docker.js';

const enoent = (): never => {
  throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
};

describe('dockerAvailableSync', () => {
  it('is true when `docker version` succeeds', () => {
    const spawn: SpawnSync = () => undefined;
    expect(dockerAvailableSync({}, spawn)).toBe(true);
  });

  it('is false when docker is not installed', () => {
    expect(dockerAvailableSync({}, enoent)).toBe(false);
  });

  it('throws when docker is not installed and CI requires it', () => {
    // A skipped suite is green. CI sets this so the cluster job can never
    // pass by not running.
    expect(() => dockerAvailableSync({ TRAWLARR_REQUIRE_DOCKER: '1' }, enoent)).toThrow(
      DockerCheckFailedError,
    );
  });

  it('throws when docker is installed but its daemon is down', () => {
    const spawn: SpawnSync = () => {
      throw Object.assign(new Error('Cannot connect to the Docker daemon'), { status: 1 });
    };
    expect(() => dockerAvailableSync({}, spawn)).toThrow(/Cannot connect to the Docker daemon/);
  });
});

describe('assertImagePresent', () => {
  it('passes when the image exists', async () => {
    await expect(assertImagePresent(() => Promise.resolve('sha256:abc\n'))).resolves.toBeUndefined();
  });

  it('says how to build the image when it is missing', async () => {
    const run = () => Promise.reject(new Error('No such image: trawlarr-cluster:dev'));
    await expect(assertImagePresent(run)).rejects.toThrow(
      /docker build -t trawlarr-cluster:dev \./,
    );
  });
});

describe('leakedProjects', () => {
  it('lists only compose projects this suite created', async () => {
    const run = () =>
      Promise.resolve(
        JSON.stringify([
          { Name: 'trawlarr-cluster-ab12', Status: 'running(3)' },
          { Name: 'trawlarr', Status: 'running(1)' },
          { Name: 'trawlarr-cluster-cd34', Status: 'exited(2)' },
        ]),
      );
    expect(await leakedProjects(run)).toEqual(['trawlarr-cluster-ab12', 'trawlarr-cluster-cd34']);
  });

  it('is empty when compose lists nothing', async () => {
    expect(await leakedProjects(() => Promise.resolve('[]'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run docker/cluster/docker.test.ts`
Expected: FAIL, cannot resolve `./docker.js`.

- [ ] **Step 3: Implement**

`docker/cluster/docker.ts`:

```ts
import { execFile, execFileSync } from 'node:child_process';

/** The image under test. CI builds and loads it; `pnpm test:cluster` builds it. */
export const CLUSTER_IMAGE = process.env.TRAWLARR_CLUSTER_IMAGE ?? 'trawlarr-cluster:dev';

/** Every compose project this suite creates starts with this, so a leaked one can be found. */
export const PROJECT_PREFIX = 'trawlarr-cluster-';

export type Run = (args: readonly string[]) => Promise<string>;

/** `docker <args>`. Resolves stdout; a non-zero exit rejects with stderr in the message. */
export const docker: Run = (args) =>
  new Promise((resolve, reject) => {
    execFile('docker', [...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`docker ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });

/**
 * The availability check could not be trusted, or CI required Docker and it
 * is absent. Thrown rather than answered `false`, for the reason
 * `test-support/tool-availability.ts` gives: the caller is a
 * `describe.runIf` condition, and a skipped suite is green.
 */
export class DockerCheckFailedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DockerCheckFailedError';
    this.cause = cause;
  }
}

export type SpawnSync = (file: string, args: readonly string[]) => unknown;

const defaultSpawn: SpawnSync = (file, args) =>
  execFileSync(file, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });

/**
 * Can this machine run the cluster suite? Synchronous, because
 * `describe.runIf` reads its condition at collection time.
 *
 * `docker version` talks to the daemon, so a client with no daemon behind it
 * fails here rather than in the first scenario. Only ENOENT answers `false`,
 * and not even that when `TRAWLARR_REQUIRE_DOCKER=1`.
 */
export const dockerAvailableSync = (
  env: Record<string, string | undefined> = process.env,
  spawn: SpawnSync = defaultSpawn,
): boolean => {
  try {
    spawn('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (error.code === 'ENOENT') {
      if (env.TRAWLARR_REQUIRE_DOCKER === '1') {
        throw new DockerCheckFailedError(
          'TRAWLARR_REQUIRE_DOCKER=1, but docker is not installed. The cluster suite would be ' +
            'skipped, and a skipped suite is green.',
          cause,
        );
      }
      return false;
    }
    const detail = error.stderr === undefined ? error.message : String(error.stderr).trim();
    throw new DockerCheckFailedError(
      `docker is installed but \`docker version\` failed: ${detail || error.message}`,
      cause,
    );
  }
};

/** Stop with one clear message when the image under test has not been built. */
export const assertImagePresent = async (run: Run = docker): Promise<void> => {
  try {
    await run(['image', 'inspect', '--format', '{{.Id}}', CLUSTER_IMAGE]);
  } catch (cause) {
    throw new Error(
      `The image "${CLUSTER_IMAGE}" does not exist, so there is nothing to test. Build it from ` +
        `the working tree first: docker build -t ${CLUSTER_IMAGE} . (or run \`pnpm test:cluster\`, ` +
        `which does).`,
      { cause },
    );
  }
};

/** Compose projects a killed run left behind. */
export const leakedProjects = async (run: Run = docker): Promise<string[]> => {
  const listed = JSON.parse(await run(['compose', 'ls', '--all', '--format', 'json'])) as {
    Name: string;
  }[];
  return listed.map((project) => project.Name).filter((name) => name.startsWith(PROJECT_PREFIX));
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run docker/cluster/docker.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm typecheck && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec eslint docker/cluster && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec prettier --check docker/cluster`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add docker/cluster/docker.ts docker/cluster/docker.test.ts
git commit -m "test(docker): check docker, the image under test and leaked clusters up front, so the cluster suite fails once with a reason instead of skipping green"
```

---

### Task 3: `startCluster`, and two nodes sharing a library

**Files:**
- Create: `test-support/until.ts`
- Modify: `packages/server/test/helpers/daemon-harness.ts` (re-export `until`)
- Create: `docker/cluster/cluster.ts`
- Create: `docker/cluster/global-setup.ts`
- Test: `docker/cluster/two-nodes.cluster.test.ts`

**Interfaces:**
- Consumes: `docker`, `Run`, `CLUSTER_IMAGE`, `PROJECT_PREFIX`, `assertImagePresent`, `leakedProjects`, `dockerAvailableSync` from `./docker.js`.
- Produces (all from `docker/cluster/cluster.ts`):

```ts
export interface ClusterOptions {
  nodes: { libraryAt: string; workers?: number }[];
  files: number;
  clipSeconds: number;
  graceMs?: number; // default 300_000
  serverStagingDir?: string | null; // default null
  localWorkers?: number; // default 0
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
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  kill(): Promise<void>;
  exec(argv: readonly string[]): Promise<string>;
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
export const startCluster: (options: ClusterOptions) => Promise<Cluster>;
export const TRANSCODE_FLOW: unknown;
/** Number of `job_step` rows that means Execute is the step now running. */
export const STEPS_BEFORE_EXECUTE = 3;
```

- [ ] **Step 1: Move `until` to `test-support`**

Create `test-support/until.ts` containing the `until` function exactly as it is in `packages/server/test/helpers/daemon-harness.ts` (lines 112–140: the doc comment beginning "Waits for a condition about observable state" and the whole `export const until = async (…) => { … };` block). Then in `daemon-harness.ts` delete that block and put in its place:

```ts
// Shared with the container suite in docker/cluster/.
export { until } from '../../../../test-support/until.js';
```

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm typecheck`
Expected: clean (every existing importer of `until` from the harness still resolves it).

- [ ] **Step 2: Write the failing scenario**

`docker/cluster/two-nodes.cluster.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `docker build -t trawlarr-cluster:dev . && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run --config vitest.cluster.config.ts docker/cluster/two-nodes.cluster.test.ts`
Expected: FAIL, cannot resolve `./cluster.js` (or `./global-setup.ts`).

- [ ] **Step 4: Implement global setup**

`docker/cluster/global-setup.ts`:

```ts
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
```

- [ ] **Step 5: Implement `startCluster`**

`docker/cluster/cluster.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { until } from '../../test-support/until.js';
import { CLUSTER_IMAGE, docker, PROJECT_PREFIX } from './docker.js';

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
  logs(): Promise<string>;
}

export interface Cluster {
  project: string;
  libraryId: string;
  nodes: ClusterNode[];
  originalHashes: Record<string, string>;
  api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T>;
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  jobs(): Promise<JobRow[]>;
  files(): Promise<FileRow[]>;
  stepCount(jobId: string): Promise<number>;
  hashOf(serverPath: string): Promise<string>;
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
  const project = `${PROJECT_PREFIX}${randomBytes(4).toString('hex')}`;
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
    const serverLogs = async (): Promise<string> => tail(await compose(['logs', '--no-color', 'server']));
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
          return probe !== undefined && (probe.reachable || probe.detail !== 'no path on this node');
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
        (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM job_step WHERE job_id = ?`, [jobId]))[0]!.n,
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

/** Re-exported so a scenario needs one import. */
export { CLUSTER_IMAGE };
```

- [ ] **Step 6: Run the scenario to verify it passes**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run --config vitest.cluster.config.ts docker/cluster/two-nodes.cluster.test.ts`
Expected: PASS, 1 test, in roughly a minute.

If `startCluster` fails, read the dumped logs before changing anything. Three places are assumptions about behaviour this plan could not run; fix the harness, not the product, if one is wrong:
- `docker compose port` prints `127.0.0.1:<port>`.
- `POST /libraries/:id/scan` takes no body.
- A `compose run` container can resolve `server` on `${project}_default`.

- [ ] **Step 7: Confirm no containers are left behind**

Run: `docker compose ls --all --format json`
Expected: no project whose name starts with `trawlarr-cluster-`.

- [ ] **Step 8: Typecheck, lint, and confirm `pnpm test` does not pick the scenario up**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm typecheck && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec eslint docker test-support packages/server/test/helpers && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec prettier --check docker test-support && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run docker 2>&1 | grep -c "cluster.test"`
Expected: typecheck, eslint and prettier clean; the final count is `0`.

- [ ] **Step 9: Commit**

```bash
git add test-support/until.ts packages/server/test/helpers/daemon-harness.ts docker/cluster/cluster.ts docker/cluster/global-setup.ts docker/cluster/two-nodes.cluster.test.ts
git commit -m "test(docker): run a server and two nodes from the real image and prove every file is converted exactly once between them"
```

---

### Task 4: Per-node mount paths, and staging a node cannot reach

**Files:**
- Test: `docker/cluster/mount-paths.cluster.test.ts`
- Test: `docker/cluster/unreachable-staging.cluster.test.ts`

**Interfaces:**
- Consumes: `startCluster`, `Cluster` from `./cluster.js`; `dockerAvailableSync` from `./docker.js`.

- [ ] **Step 1: Write the mount-paths scenario**

`docker/cluster/mount-paths.cluster.test.ts`:

```ts
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
```

- [ ] **Step 2: Write the unreachable-staging scenario**

`docker/cluster/unreachable-staging.cluster.test.ts`:

```ts
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
```

- [ ] **Step 3: Run both**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run --config vitest.cluster.config.ts docker/cluster/mount-paths.cluster.test.ts docker/cluster/unreachable-staging.cluster.test.ts`
Expected: PASS, 2 tests.

If the staging scenario's probe is `reachable: true`, PR #52 is not in this branch: stop and merge it first (see Global Constraints). Do not weaken the assertion.

- [ ] **Step 4: Prove the staging scenario can fail**

Temporarily change `serverStagingDir: '/staging'` to `serverStagingDir: null`, re-run that one file, and confirm it FAILS on the probe assertion (`reachable: true`). Restore the line.

- [ ] **Step 5: Lint and commit**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm typecheck && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec eslint docker/cluster && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec prettier --check docker/cluster`

```bash
git add docker/cluster/mount-paths.cluster.test.ts docker/cluster/unreachable-staging.cluster.test.ts
git commit -m "test(docker): prove results come back in the server view from nodes with different mounts, and that a node is refused a library whose staging it cannot reach"
```

---

### Task 5: A network cut, inside and past the grace window

**Files:**
- Test: `docker/cluster/network-cut.cluster.test.ts`

**Interfaces:**
- Consumes: `startCluster`, `Cluster`, `STEPS_BEFORE_EXECUTE` from `./cluster.js`.

Background for the implementer: `docker network disconnect` drops packets without closing the socket. The server pings each node every 15 s and declares it offline after 45 s without a pong, and only then does the job's lease move to `grace`. So both tests wait about a minute for that, by design. The clip is long enough that the node is still encoding when the cut is made; the node then finishes encoding on its own and waits at the commit gate, which needs the server.

- [ ] **Step 1: Write both scenarios**

`docker/cluster/network-cut.cluster.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run --config vitest.cluster.config.ts docker/cluster/network-cut.cluster.test.ts`
Expected: PASS, 2 tests, about three minutes in total.

If the first test times out waiting for `succeeded`: read the node's log in the dump. The node must notice its dead socket and redial; if it never does, that is a product finding. Report it with the log, and do not paper over it in the test.

- [ ] **Step 3: Prove the release test can fail**

Temporarily change the second test's `graceMs: 3_000` to `graceMs: 600_000` and re-run that test only (`-t 'releases the file'`). Confirm it FAILS by timing out on `the claim to be released`. Restore the line.

- [ ] **Step 4: Lint and commit**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm typecheck && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec eslint docker/cluster && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec prettier --check docker/cluster`

```bash
git add docker/cluster/network-cut.cluster.test.ts
git commit -m "test(docker): cut a node's network mid-encode and prove the job survives inside grace and the original file survives past it"
```

---

### Task 6: A node killed mid-job

**Files:**
- Test: `docker/cluster/node-killed.cluster.test.ts`

**Interfaces:**
- Consumes: `startCluster`, `Cluster`, `STEPS_BEFORE_EXECUTE` from `./cluster.js`.

Background: `docker kill` closes the socket at once, so the lease goes to `grace` immediately and is released after `graceMs`. A released file is a failed attempt and is held in backoff for five minutes, so the test requeues it through the API (the documented way out) to see the other node take it.

- [ ] **Step 1: Write the scenario**

`docker/cluster/node-killed.cluster.test.ts`:

```ts
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
    const finisher = jobs.find((job) => job.file_id === doomed.file_id && job.state === 'succeeded');
    expect(finisher?.node_id).toBe(survivor.id);
    expect(await c.hashOf(path)).not.toBe(c.originalHashes[path]);
    // Nothing is left claimed by the dead node.
    expect(jobs.filter((job) => job.ended_at === null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run --config vitest.cluster.config.ts docker/cluster/node-killed.cluster.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 3: Run the whole suite and record how long it takes**

Run: `time PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm test:cluster`
Expected: 5 files, 6 tests, all PASS. Note the wall-clock time; Task 7 puts it in the CI job's timeout and in the docs. If it exceeds 12 minutes, reduce `files` from 4 to 3 in `two-nodes` and `mount-paths` and re-measure before going on.

- [ ] **Step 4: Lint and commit**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm typecheck && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec eslint docker/cluster && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec prettier --check docker/cluster`

```bash
git add docker/cluster/node-killed.cluster.test.ts
git commit -m "test(docker): kill a node mid-job and prove its file is released untouched and finished by the other node"
```

---

### Task 7: CI and documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `AGENTS.md`
- Modify: `docker/image-contract.test.ts`

**Interfaces:**
- Consumes: `pnpm test:cluster`'s second half (`vitest run --config vitest.cluster.config.ts`), `TRAWLARR_REQUIRE_DOCKER`, `TRAWLARR_CLUSTER_IMAGE`.

- [ ] **Step 1: Write the failing CI contract test**

Append to `docker/image-contract.test.ts` as a new top-level block (the file already reads `.github/workflows/ci.yml` into `ci`):

```ts
describe('the cluster CI job', () => {
  it('runs the cluster suite in a way that cannot pass by skipping', () => {
    expect(ci).toContain('\n  cluster:');
    const job = ci.slice(ci.indexOf('\n  cluster:'), ci.indexOf('\n  image:'));
    // Without this, a runner with no docker reports the suite green.
    expect(job).toMatch(/TRAWLARR_REQUIRE_DOCKER: '1'/);
    // The image under test is built from this commit and loaded, not pulled.
    expect(job).toMatch(/load: true/);
    expect(job).toMatch(/tags: trawlarr-cluster:dev/);
    expect(job).toMatch(/vitest run --config vitest\.cluster\.config\.ts/);
  });
});
```

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run docker/image-contract.test.ts`
Expected: FAIL on `expect(ci).toContain('\n  cluster:')`.

- [ ] **Step 2: Add the CI job**

In `.github/workflows/ci.yml`, add this job after `check` and before `image` (replace `20` with the measured time from Task 6 Step 3, rounded up, plus 10):

```yaml
  # The container suite: one server and several nodes from the image built out
  # of this commit (docker/cluster/). Independent of `check` so neither waits
  # for the other, and `image` does not wait for this.
  cluster:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          load: true
          tags: trawlarr-cluster:dev
          cache-from: type=gha
      # Not `pnpm test:cluster`: that would build the image a second time.
      - run: pnpm exec vitest run --config vitest.cluster.config.ts
        env:
          # A missing docker must fail this job, not skip the suite.
          TRAWLARR_REQUIRE_DOCKER: '1'
```

On a failed scenario the harness already prints every container's log and the job and file rows into the test output, so no artifact upload is needed.

- [ ] **Step 3: Run the contract test to verify it passes**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run docker/image-contract.test.ts`
Expected: PASS.

- [ ] **Step 4: Document the command**

In `AGENTS.md`, in the Commands code block, add after the `pnpm bench:scan` line:

```
pnpm test:cluster     # build the image, then run a server + nodes in containers (needs docker)
```

And add this paragraph after the one that begins "Suites that need real `ffmpeg`/`ffprobe`":

```markdown
**The cluster suite is separate from `pnpm test`.** `docker/cluster/*.cluster.test.ts` starts
one server and several nodes as containers from the image tagged `trawlarr-cluster:dev`, and
asserts multi-node behaviour on file bytes and database rows: claims shared between nodes,
per-node mount paths, a staging directory a node cannot reach, a network cut inside and past
the grace window, and a node killed mid-job. `pnpm test:cluster` builds the image first. A
network cut takes about a minute to be noticed (the server's 45 s offline timeout), so the
suite takes several minutes. It does not reproduce NFS: containers sharing a volume see the
same device number, so the cross-host identity case stays with unit tests and a real second
machine.
```

- [ ] **Step 5: Final checks**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm typecheck && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm lint && PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" pnpm exec vitest run docker test-support`
Expected: all clean; the `docker` and `test-support` unit tests pass and no `*.cluster.test.ts` file is among them.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml AGENTS.md docker/image-contract.test.ts
git commit -m "ci: run the cluster suite on every pull request, failing rather than skipping when docker is missing"
```

---

## Self-review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| Layout, compose file, `NODE_ENV=test` guard | 1 |
| Not part of `pnpm test`; `pnpm test:cluster` | 1 |
| Docker absent / `TRAWLARR_REQUIRE_DOCKER` | 2, 7 |
| Leaked cluster cleanup | 2, 3 |
| `startCluster` and its handles | 3 |
| `until` moved to `test-support/` | 3 |
| Scenario 1 (two nodes) | 3 |
| Scenarios 2 and 3 | 4 |
| Scenarios 4 and 5 | 5 |
| Scenario 6 | 6 |
| Logs on failure | 3 (`dumpLogs`, used in every `afterEach`) |
| CI job | 7 |
| Run-time risk measured before CI | 6 Step 3 |

Not built, by the spec's own non-goals: NFS, GPU, web UI, file transfer.

**Type consistency.** `Cluster`, `ClusterNode`, `JobRow`, `FileRow`, `NodeView`, `STEPS_BEFORE_EXECUTE` and `TRANSCODE_FLOW` are defined once in Task 3 and used with the same names and field spellings (`node_id`, `file_id`, `lease_state`, `ended_at`, `attempt_count`) in Tasks 4–6. `docker`, `dockerAvailableSync`, `assertImagePresent`, `leakedProjects` and `PROJECT_PREFIX` are defined in Task 2 and consumed in Task 3.

**Things this plan could not run.** The three behaviours listed under Task 3 Step 6, and whether the node redials on its own after a partition (Task 5 Step 2). Each has an explicit instruction for what to do if it is wrong.
