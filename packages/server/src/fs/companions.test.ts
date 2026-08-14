import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { companionTargetFor, findCompanions, moveCompanions } from './companions.js';

const EXTENSIONS = ['srt', 'nfo', 'ass'];

const libraryDir = (names: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-comp-'));
  for (const name of names) writeFileSync(join(dir, name), 'x');
  return dir;
};

describe('findCompanions', () => {
  it('finds sidecars sharing the media basename, including language-tagged ones', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.srt', 'movie.en.srt', 'movie.nfo']);
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: EXTENSIONS,
    });
    expect(found.map((p) => p.slice(dir.length + 1)).sort()).toEqual([
      'movie.en.srt',
      'movie.nfo',
      'movie.srt',
    ]);
  });

  it('does not claim a different film whose name merely starts the same', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.srt', 'movie2.srt', 'movie-extended.srt']);
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: EXTENSIONS,
    });
    expect(found.map((p) => p.slice(dir.length + 1))).toEqual(['movie.srt']);
  });

  it('ignores extensions the library does not list', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.txt']);
    expect(
      await findCompanions({ filePath: join(dir, 'movie.mkv'), companionExtensions: EXTENSIONS }),
    ).toEqual([]);
  });

  it('never returns the media file itself', async () => {
    const dir = libraryDir(['movie.mkv']);
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: ['mkv', 'srt'],
    });
    expect(found).toEqual([]);
  });

  it('does not treat a directory sharing the media stem as a companion', async () => {
    // A directory literally named "movie.nfo" beside "movie.mkv" is not a
    // sidecar file — without a type guard it would be returned and later
    // handed to `rename`, which silently moves the whole directory.
    const dir = libraryDir(['movie.mkv', 'movie.srt']);
    mkdirSync(join(dir, 'movie.nfo'));
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: EXTENSIONS,
    });
    expect(found.map((p) => p.slice(dir.length + 1))).toEqual(['movie.srt']);
  });

  it('finds a companion that is itself a symlink to a regular file', async () => {
    // Users plausibly share a subtitle file across libraries via a
    // symlink. `Dirent.isFile()` is false for a symlink regardless of what
    // it points at, so this only passes if symlinks are followed rather
    // than rejected outright.
    const dir = libraryDir(['movie.mkv']);
    const realFile = join(dir, 'shared.srt');
    writeFileSync(realFile, 'subs');
    symlinkSync(realFile, join(dir, 'movie.srt'));
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: EXTENSIONS,
    });
    expect(found.map((p) => p.slice(dir.length + 1))).toEqual(['movie.srt']);
  });

  it('does not treat a symlink to a directory as a companion', async () => {
    const dir = libraryDir(['movie.mkv']);
    const realDir = join(dir, 'real-dir');
    mkdirSync(realDir);
    symlinkSync(realDir, join(dir, 'movie.nfo'));
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: EXTENSIONS,
    });
    expect(found).toEqual([]);
  });

  it('does not treat a dangling symlink as a companion', async () => {
    const dir = libraryDir(['movie.mkv']);
    symlinkSync(join(dir, 'nonexistent-target.srt'), join(dir, 'movie.srt'));
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: EXTENSIONS,
    });
    expect(found).toEqual([]);
  });
});

describe('companionTargetFor', () => {
  it('carries the language tag across a container change', () => {
    expect(
      companionTargetFor({
        companionPath: '/m/movie.en.srt',
        oldMediaPath: '/m/movie.mkv',
        newMediaPath: '/m/movie.mp4',
      }),
    ).toBe('/m/movie.en.srt');
  });

  it('follows a basename change', () => {
    expect(
      companionTargetFor({
        companionPath: '/m/movie.en.srt',
        oldMediaPath: '/m/movie.mkv',
        newMediaPath: '/m/Movie (2016).mkv',
      }),
    ).toBe('/m/Movie (2016).en.srt');
  });
});

describe('moveCompanions', () => {
  it('renames each companion alongside the media file', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.en.srt', 'movie.nfo']);
    await moveCompanions({
      companions: [join(dir, 'movie.en.srt'), join(dir, 'movie.nfo')],
      oldMediaPath: join(dir, 'movie.mkv'),
      newMediaPath: join(dir, 'film.mkv'),
    });
    expect(existsSync(join(dir, 'film.en.srt'))).toBe(true);
    expect(existsSync(join(dir, 'film.nfo'))).toBe(true);
    expect(existsSync(join(dir, 'movie.en.srt'))).toBe(false);
  });

  it('does nothing when the media path is unchanged', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.srt']);
    await moveCompanions({
      companions: [join(dir, 'movie.srt')],
      oldMediaPath: join(dir, 'movie.mkv'),
      newMediaPath: join(dir, 'movie.mkv'),
    });
    expect(existsSync(join(dir, 'movie.srt'))).toBe(true);
  });

  it('disambiguates instead of overwriting when the target already exists', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.srt', 'film.srt']);
    writeFileSync(join(dir, 'movie.srt'), 'incoming');
    writeFileSync(join(dir, 'film.srt'), 'already-here');
    await moveCompanions({
      companions: [join(dir, 'movie.srt')],
      oldMediaPath: join(dir, 'movie.mkv'),
      newMediaPath: join(dir, 'film.mkv'),
    });
    // The pre-existing film.srt must survive untouched, WITH its own
    // content — not merely exist under that name, which an implementation
    // that swapped the two files' contents would also satisfy.
    expect(existsSync(join(dir, 'film.srt'))).toBe(true);
    expect(readFileSync(join(dir, 'film.srt'), 'utf8')).toBe('already-here');
    // ...and the incoming companion must still exist somewhere, under a
    // disambiguated name rather than being dropped, carrying its own
    // content along with it.
    expect(existsSync(join(dir, 'movie.srt'))).toBe(false);
    expect(existsSync(join(dir, 'film (1).srt'))).toBe(true);
    expect(readFileSync(join(dir, 'film (1).srt'), 'utf8')).toBe('incoming');
  });

  it('does not destroy a dangling symlink sitting at the destination name', async () => {
    // `stat` follows symlinks, so a *dangling* one fails `stat` the same
    // way an empty destination does — the destination check must use
    // `lstat` (or otherwise treat the link itself as "something is here"),
    // or this renames straight over the symlink and destroys it.
    const dir = libraryDir(['movie.mkv', 'movie.srt']);
    symlinkSync(join(dir, 'nonexistent-target.srt'), join(dir, 'film.srt'));

    await moveCompanions({
      companions: [join(dir, 'movie.srt')],
      oldMediaPath: join(dir, 'movie.mkv'),
      newMediaPath: join(dir, 'film.mkv'),
    });

    // The dangling symlink itself must survive as a symlink, untouched...
    expect(lstatSync(join(dir, 'film.srt')).isSymbolicLink()).toBe(true);
    // ...and the incoming companion must land at a disambiguated name.
    expect(existsSync(join(dir, 'film (1).srt'))).toBe(true);
  });
});
