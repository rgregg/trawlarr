import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalisePathsOnce, canonicalPath, createSubtreeMatcher } from './path-contains.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-subtree-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('createSubtreeMatcher', () => {
  it('matches a subtree itself and everything beneath it', () => {
    const matches = createSubtreeMatcher({
      roots: ['/library'],
      subtrees: ['/library/.trawlarr'],
    });

    expect(matches('/library/.trawlarr')).toBe(true);
    expect(matches('/library/.trawlarr/trash/deleted.mkv')).toBe(true);
    expect(matches('/library/movies/real.mkv')).toBe(false);
  });

  it('compares path segments, so a sibling that shares a string prefix is outside', () => {
    const matches = createSubtreeMatcher({
      roots: ['/library'],
      subtrees: ['/library/.trawlarr'],
    });

    expect(matches('/library/.trawlarr-old/movie.mkv')).toBe(false);
  });

  // The defect this exists for: the watcher's ignore predicate ran
  // `realpathSync` on every event path. A replacement copying onto an NFS
  // library produces a stream of events for the file being written, and each
  // stat of that file waits behind the write — on the daemon's only thread.
  // The API and the event socket froze for up to 29 seconds at a time.
  it('touches the filesystem when it is built and never again per path', () => {
    const canonicalised: string[] = [];
    const matches = createSubtreeMatcher({
      roots: ['/library'],
      subtrees: ['/library/.trawlarr', '/staging'],
      canonicalise: (path) => {
        canonicalised.push(path);
        return path;
      },
    });
    const whileBuilding = canonicalised.length;

    matches('/library/movies/Some Film (2001)/Some Film (2001).mkv');
    matches('/library/.trawlarr/trash/deleted.mkv');
    matches('/staging/job/part.mkv');

    expect(canonicalised.length).toBe(whileBuilding);
  });

  it('sees through a root that is a symlink alias of where a subtree really is', () => {
    const real = join(base, 'mnt', 'media');
    const staging = join(real, 'staging');
    mkdirSync(staging, { recursive: true });
    const alias = join(base, 'media');
    symlinkSync(real, alias);

    // The root is spelled through the alias and the subtree through the real
    // path — a Docker `/media -> /mnt/media` stack — and events arrive spelled
    // the way the root was.
    const matches = createSubtreeMatcher({ roots: [alias], subtrees: [staging] });

    expect(matches(join(alias, 'staging', 'part.mkv'))).toBe(true);
    expect(matches(join(alias, 'movies', 'real.mkv'))).toBe(false);
  });

  it('matches a subtree that does not exist yet, by the spelling it was given', () => {
    const root = join(base, 'media');
    mkdirSync(root);

    const matches = createSubtreeMatcher({
      roots: [root],
      subtrees: [join(root, '.trawlarr')],
    });

    expect(matches(join(root, '.trawlarr', 'staging', 'part.mkv'))).toBe(true);
  });
});

describe('canonicalisePathsOnce', () => {
  it('answers as canonicalPath does for every path it was given', async () => {
    const real = join(base, 'mnt', 'media');
    mkdirSync(real, { recursive: true });
    const alias = join(base, 'media');
    symlinkSync(real, alias);
    const absent = join(alias, '.trawlarr');

    const canonicalise = await canonicalisePathsOnce([alias, real, absent]);

    expect(canonicalise(alias)).toBe(realpathSync(real));
    for (const path of [alias, real, absent]) {
      expect(canonicalise(path)).toBe(canonicalPath(path));
    }
  });

  // Reading a path it was not told about is the synchronous read it exists to
  // remove, so such a path is only normalised.
  it('only resolves a path it was not given', async () => {
    const real = join(base, 'mnt');
    mkdirSync(real);
    const alias = join(base, 'media');
    symlinkSync(real, alias);

    const canonicalise = await canonicalisePathsOnce([real]);

    expect(canonicalise(alias)).toBe(alias);
    expect(canonicalise(join(base, 'a', '..', 'b'))).toBe(join(base, 'b'));
  });

  it('builds a matcher that sees through an aliased root, as the default does', async () => {
    const real = join(base, 'mnt', 'media');
    const staging = join(real, 'staging');
    mkdirSync(staging, { recursive: true });
    const alias = join(base, 'media');
    symlinkSync(real, alias);

    const matches = createSubtreeMatcher({
      roots: [alias],
      subtrees: [staging],
      canonicalise: await canonicalisePathsOnce([alias, staging]),
    });

    expect(matches(join(alias, 'staging', 'part.mkv'))).toBe(true);
    expect(matches(join(alias, 'movies', 'real.mkv'))).toBe(false);
  });
});
