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

  it('words duplicates without "mapped", since the api echoes the message into the Nodes tab', () => {
    const messageOf = (map: unknown): string => {
      try {
        validatePathMap(map);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    const server = messageOf([
      { serverPath: '/media', nodePath: '/x' },
      { serverPath: '/media', nodePath: '/y' },
    ]);
    const node = messageOf([
      { serverPath: '/media', nodePath: '/x' },
      { serverPath: '/other', nodePath: '/x' },
    ]);
    expect(server).toBe('Server path "/media" is listed more than once.');
    expect(node).toBe('Node path "/x" is listed more than once.');
  });

  it('rejects a duplicate node path, naming the path, so toServer lookups do not depend on array order', () => {
    expect(() =>
      validatePathMap([
        { serverPath: '/media', nodePath: '/mnt/nas' },
        { serverPath: '/other', nodePath: '/mnt/nas' },
      ]),
    ).toThrow(/\/mnt\/nas/);
  });

  it('rejects a node path nested inside another when the server paths are not nested the same way, naming both', () => {
    // /media/movies/tv/x -> /mnt/tv/x -> back to /media/tv/x: a report would
    // land on a different file than the one the node was sent.
    const map = [
      { serverPath: '/media/movies', nodePath: '/mnt' },
      { serverPath: '/media/tv', nodePath: '/mnt/tv' },
    ];
    expect(() => validatePathMap(map)).toThrow(PathMapError);
    expect(() => validatePathMap(map)).toThrow(/\/media\/movies[\s\S]*\/media\/tv/);
  });

  it('rejects a server path nested inside another when the node paths are not nested', () => {
    expect(() =>
      validatePathMap([
        { serverPath: '/media', nodePath: '/mnt/a' },
        { serverPath: '/media/tv', nodePath: '/srv/tv' },
      ]),
    ).toThrow(PathMapError);
  });

  it('rejects nested entries whose suffix differs between the sides, naming both entries and both suffixes', () => {
    // /media/shows/x -> /mnt/shows/x -> back to /media/tv/x: another file's
    // identity would be recorded on the row.
    const map = [
      { serverPath: '/media', nodePath: '/mnt' },
      { serverPath: '/media/tv', nodePath: '/mnt/shows' },
    ];
    expect(() => validatePathMap(map)).toThrow(PathMapError);
    expect(() => validatePathMap(map)).toThrow(/"\/media" -> "\/mnt"/);
    expect(() => validatePathMap(map)).toThrow(/"\/media\/tv" -> "\/mnt\/shows"/);
    expect(() => validatePathMap(map)).toThrow(/"tv"[\s\S]*"shows"/);
    // Order in the list does not matter.
    expect(() => validatePathMap([...map].reverse())).toThrow(PathMapError);
  });

  it('rejects a mismatched suffix at a deeper level of nesting', () => {
    expect(() =>
      validatePathMap([
        { serverPath: '/media', nodePath: '/mnt' },
        { serverPath: '/media/tv/kids', nodePath: '/mnt/kids/tv' },
      ]),
    ).toThrow(/"tv\/kids"[\s\S]*"kids\/tv"/);
    expect(() =>
      validatePathMap([
        { serverPath: '/media', nodePath: '/mnt' },
        { serverPath: '/media/tv', nodePath: '/mnt/tv' },
        { serverPath: '/media/tv/kids', nodePath: '/mnt/tv/children' },
      ]),
    ).toThrow(PathMapError);
  });

  it('accepts consistent nesting several levels deep, and every mapped path round-trips', () => {
    const map = validatePathMap([
      { serverPath: '/media', nodePath: '/mnt' },
      { serverPath: '/media/tv', nodePath: '/mnt/tv' },
      { serverPath: '/media/tv/kids/cartoons', nodePath: '/mnt/tv/kids/cartoons' },
    ]);
    for (const path of [
      '/media/a',
      '/media/tv/b',
      '/media/tv/kids/c',
      '/media/tv/kids/cartoons/d',
    ]) {
      const onNode = mapPath(map, path, 'toNode');
      expect(onNode).not.toBeNull();
      expect(mapPath(map, onNode!, 'toServer')).toBe(path);
    }
  });

  it('applies the same rule to a root "/" entry on either side', () => {
    expect(
      validatePathMap([
        { serverPath: '/', nodePath: '/mnt' },
        { serverPath: '/media', nodePath: '/mnt/media' },
      ]),
    ).toHaveLength(2);
    expect(
      validatePathMap([
        { serverPath: '/data', nodePath: '/' },
        { serverPath: '/data/media', nodePath: '/media' },
      ]),
    ).toHaveLength(2);
    expect(() =>
      validatePathMap([
        { serverPath: '/', nodePath: '/mnt' },
        { serverPath: '/media', nodePath: '/mnt/library' },
      ]),
    ).toThrow(/"media"[\s\S]*"library"/);
    expect(() =>
      validatePathMap([
        { serverPath: '/data', nodePath: '/' },
        { serverPath: '/data/media', nodePath: '/library' },
      ]),
    ).toThrow(PathMapError);
  });

  it('accepts nesting that is the same on both sides', () => {
    expect(
      validatePathMap([
        { serverPath: '/media', nodePath: '/mnt' },
        { serverPath: '/media/tv', nodePath: '/mnt/tv' },
      ]),
    ).toHaveLength(2);
  });
});
