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
    await expect(
      assertImagePresent(() => Promise.resolve('sha256:abc\n')),
    ).resolves.toBeUndefined();
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
