import { describe, expect, it } from 'vitest';
import { PathMapError, mapPath, validatePathMap } from './path-map.js';

const map = [
  { serverPath: '/media', nodePath: '/mnt/nas' },
  { serverPath: '/media/movies', nodePath: '/mnt/movies' },
];

describe('mapPath', () => {
  it('uses the longest matching prefix', () => {
    expect(mapPath(map, '/media/movies/a.mkv', 'toNode')).toBe('/mnt/movies/a.mkv');
    expect(mapPath(map, '/media/shows/b.mkv', 'toNode')).toBe('/mnt/nas/shows/b.mkv');
  });

  it('matches whole path segments only', () => {
    // "/media/movies2" must not be read as inside "/media/movies".
    expect(mapPath(map, '/media/movies2/a.mkv', 'toNode')).toBe('/mnt/nas/movies2/a.mkv');
    expect(mapPath([{ serverPath: '/media', nodePath: '/x' }], '/mediax/a', 'toNode')).toBeNull();
  });

  it('maps the root itself', () => {
    expect(mapPath(map, '/media/movies', 'toNode')).toBe('/mnt/movies');
  });

  it('reverses', () => {
    expect(mapPath(map, '/mnt/movies/a.mkv', 'toServer')).toBe('/media/movies/a.mkv');
  });

  it('returns null for an unmapped path instead of passing it through', () => {
    // Passing it through would run a job against whatever happens to live at
    // the server's path on the node — possibly a different file entirely.
    expect(mapPath(map, '/srv/other.mkv', 'toNode')).toBeNull();
  });

  it('an empty map is the identity for the local node only when asked: still null', () => {
    expect(mapPath([], '/media/a.mkv', 'toNode')).toBeNull();
  });
});

describe('validatePathMap', () => {
  it('accepts absolute, normalised paths and strips trailing slashes', () => {
    expect(validatePathMap([{ serverPath: '/media/', nodePath: '/mnt/nas/' }])).toEqual([
      { serverPath: '/media', nodePath: '/mnt/nas' },
    ]);
  });

  it('rejects relative paths, dot segments, and duplicate server paths', () => {
    expect(() => validatePathMap([{ serverPath: 'media', nodePath: '/x' }])).toThrow(PathMapError);
    expect(() => validatePathMap([{ serverPath: '/media/../etc', nodePath: '/x' }])).toThrow(
      PathMapError,
    );
    expect(() =>
      validatePathMap([
        { serverPath: '/media', nodePath: '/x' },
        { serverPath: '/media', nodePath: '/y' },
      ]),
    ).toThrow(PathMapError);
  });

  it('rejects a duplicate node path, naming the path, so toServer lookups do not depend on array order', () => {
    expect(() =>
      validatePathMap([
        { serverPath: '/media', nodePath: '/mnt/nas' },
        { serverPath: '/other', nodePath: '/mnt/nas' },
      ]),
    ).toThrow(/\/mnt\/nas/);
  });
});
