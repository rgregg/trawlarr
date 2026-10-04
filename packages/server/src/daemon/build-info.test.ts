import { describe, expect, it } from 'vitest';
import { buildCommitFrom } from './build-info.js';
import { versionFrom } from './version.js';

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

describe('versionFrom', () => {
  it('reads the version the build stamped', () => {
    expect(versionFrom('{"version":"0.1.0+5.g1a2b3c4"}\n')).toBe('0.1.0+5.g1a2b3c4');
  });

  it('treats a missing, damaged or empty stamp as no version', () => {
    expect(versionFrom(null)).toBeNull();
    expect(versionFrom('not json')).toBeNull();
    expect(versionFrom('{"version":""}')).toBeNull();
    expect(versionFrom('{"version":3}')).toBeNull();
  });
});
