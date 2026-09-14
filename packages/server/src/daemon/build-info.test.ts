import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCommitFrom } from './build-info.js';
import { DAEMON_VERSION } from './daemon.js';

describe('buildCommitFrom', () => {
  it('reports the commit the image was built from', () => {
    expect(buildCommitFrom({ TRAWLARR_COMMIT: '40e7cc102c218506a6867cb6e50e246899d288d6' })).toBe(
      '40e7cc102c218506a6867cb6e50e246899d288d6',
    );
  });

  it('reports null, not an empty string, for a build that recorded none', () => {
    // The Dockerfile's ARG defaults to empty, so a local `docker build` with
    // no --build-arg sets the variable to "" — which must not read as a commit.
    expect(buildCommitFrom({})).toBeNull();
    expect(buildCommitFrom({ TRAWLARR_COMMIT: '' })).toBeNull();
    expect(buildCommitFrom({ TRAWLARR_COMMIT: '   ' })).toBeNull();
  });
});

describe('DAEMON_VERSION', () => {
  it('matches packages/server/package.json, which the image workflow checks release tags against', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(DAEMON_VERSION).toBe(manifest.version);
  });
});
