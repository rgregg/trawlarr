import { describe, expect, it } from 'vitest';
import {
  assertImageCurrent,
  DockerCheckFailedError,
  dockerAvailableSync,
  leakedProjects,
  ownerOf,
  projectName,
  projectsOwnedBy,
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

describe('assertImageCurrent', () => {
  const HEAD = 'a'.repeat(40);

  it('passes when the image was built from the checked-out commit', async () => {
    await expect(assertImageCurrent(HEAD, () => Promise.resolve(`${HEAD}\n`))).resolves.toBe(HEAD);
  });

  it('says how to build the image when it is missing', async () => {
    const run = () => Promise.reject(new Error('No such image: trawlarr-cluster:dev'));
    await expect(assertImageCurrent(HEAD, run)).rejects.toThrow(/pnpm test:cluster/);
  });

  it('refuses an image built from another commit, naming both', async () => {
    // The tag is machine-wide and the direct vitest command does not build:
    // without this, a fix is "tested" against the image from before it.
    const other = 'b'.repeat(40);
    await expect(assertImageCurrent(HEAD, () => Promise.resolve(`${other}\n`))).rejects.toThrow(
      new RegExp(`${other.slice(0, 12)}.*${HEAD.slice(0, 12)}`, 's'),
    );
  });

  it('refuses an image that records no commit at all', async () => {
    await expect(assertImageCurrent(HEAD, () => Promise.resolve('\n'))).rejects.toThrow(
      /records no commit/,
    );
  });
});

describe('project names', () => {
  it('carry the pid of the run that owns them', () => {
    const name = projectName(4242);
    expect(name).toMatch(/^trawlarr-cluster-4242-[0-9a-f]{8}$/);
    expect(ownerOf(name)).toBe(4242);
  });

  it('have no owner when they are not in that form', () => {
    expect(ownerOf('trawlarr-cluster-ab12')).toBeNull();
    expect(ownerOf('trawlarr')).toBeNull();
  });
});

const listing = (names: string[]) => () =>
  Promise.resolve(JSON.stringify(names.map((Name) => ({ Name, Status: 'running(3)' }))));

describe('leakedProjects', () => {
  it("lists clusters whose owning run is dead, and never a live run's", async () => {
    // Another worktree's run is live: removing its containers mid-test made
    // it fail with docker errors that named nothing useful.
    const run = listing([
      'trawlarr-cluster-100-aaaaaaaa',
      'trawlarr-cluster-200-bbbbbbbb',
      'trawlarr',
    ]);
    expect(await leakedProjects((pid) => pid === 200, run)).toEqual([
      'trawlarr-cluster-100-aaaaaaaa',
    ]);
  });

  it('lists a cluster whose name carries no owner, which nothing else will ever remove', async () => {
    expect(await leakedProjects(() => true, listing(['trawlarr-cluster-ab12']))).toEqual([
      'trawlarr-cluster-ab12',
    ]);
  });

  it('is empty when compose lists nothing', async () => {
    expect(
      await leakedProjects(
        () => true,
        () => Promise.resolve('[]'),
      ),
    ).toEqual([]);
  });
});

describe('projectsOwnedBy', () => {
  it('lists only the clusters this run started', async () => {
    const run = listing(['trawlarr-cluster-100-aaaaaaaa', 'trawlarr-cluster-200-bbbbbbbb']);
    expect(await projectsOwnedBy(200, run)).toEqual(['trawlarr-cluster-200-bbbbbbbb']);
  });
});
