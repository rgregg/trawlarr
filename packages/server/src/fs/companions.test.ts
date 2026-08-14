import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
});
