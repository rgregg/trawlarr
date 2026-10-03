import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

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

const BUILD_HINT =
  'Build it from this checkout: `pnpm test:cluster` (which builds, then runs), or ' +
  '`docker build --build-arg TRAWLARR_COMMIT=$(git rev-parse HEAD) -t trawlarr-cluster:dev .`';

/**
 * The image under test must exist AND have been built from `head`, the commit
 * checked out here. Resolves the revision it carries.
 *
 * The tag is machine-wide and only `pnpm test:cluster` builds. Running the
 * vitest command directly after a fix — the natural way to re-run one
 * scenario — tested the image from before it, and another worktree's build
 * replaced the image under this one. Either way the suite reported on code
 * that was not the code in front of the person reading the result.
 *
 * It compares commits, so uncommitted product changes are still on whoever
 * runs it: the Dockerfile records `TRAWLARR_COMMIT`, not a tree hash.
 */
export const assertImageCurrent = async (head: string, run: Run = docker): Promise<string> => {
  let revision: string;
  try {
    revision = (
      await run([
        'image', 'inspect', '--format',
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
        CLUSTER_IMAGE,
      ])
    ).trim(); // prettier-ignore
  } catch (cause) {
    throw new Error(
      `The image "${CLUSTER_IMAGE}" does not exist, so there is nothing to test. ${BUILD_HINT}`,
      { cause },
    );
  }
  if (revision === '') {
    throw new Error(
      `The image "${CLUSTER_IMAGE}" records no commit, so it cannot be shown to be this ` +
        `checkout's code. ${BUILD_HINT}`,
    );
  }
  if (revision !== head) {
    throw new Error(
      `The image "${CLUSTER_IMAGE}" was built from ${revision.slice(0, 12)}, but this checkout ` +
        `is at ${head.slice(0, 12)}: the suite would test other code. ${BUILD_HINT}`,
    );
  }
  return revision;
};

/**
 * A compose project name that says which run owns it: the pid of the vitest
 * main process. Several runs can share a machine (one per worktree), and a
 * sweep must be able to tell a killed run's leftovers from a live run's
 * cluster.
 */
export const projectName = (ownerPid: number): string =>
  `${PROJECT_PREFIX}${String(ownerPid)}-${randomBytes(4).toString('hex')}`;

/** The owning pid in a name `projectName` made; null for any other name. */
export const ownerOf = (name: string): number | null => {
  const match = /^trawlarr-cluster-(\d+)-[0-9a-f]{8}$/.exec(name);
  return match === null ? null : Number(match[1]);
};

const clusterProjects = async (run: Run): Promise<string[]> => {
  const listed = JSON.parse(await run(['compose', 'ls', '--all', '--format', 'json'])) as {
    Name: string;
  }[];
  return listed.map((project) => project.Name).filter((name) => name.startsWith(PROJECT_PREFIX));
};

/**
 * Clusters a killed run left behind: the owner is no longer alive, or the
 * name carries no owner at all (nothing else would ever remove it). A live
 * run's cluster is never listed — sweeping every `trawlarr-cluster-*` project
 * deleted the containers out from under a run in another worktree.
 */
export const leakedProjects = async (
  isAlive: (pid: number) => boolean,
  run: Run = docker,
): Promise<string[]> =>
  (await clusterProjects(run)).filter((name) => {
    const owner = ownerOf(name);
    return owner === null || !isAlive(owner);
  });

/** The clusters one run started, for that run's own teardown. */
export const projectsOwnedBy = async (ownerPid: number, run: Run = docker): Promise<string[]> =>
  (await clusterProjects(run)).filter((name) => ownerOf(name) === ownerPid);
