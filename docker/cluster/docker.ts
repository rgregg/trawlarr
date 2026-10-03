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
