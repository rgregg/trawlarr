import { describe, expect, it } from 'vitest';
import { readArrFolder } from './arr-payload.js';

describe('readArrFolder', () => {
  it('reads the series folder from a Sonarr import', () => {
    expect(
      readArrFolder({
        eventType: 'Download',
        series: { id: 1, title: 'Show', path: '/data/shows/Show' },
        episodeFile: { relativePath: 'Season 1/e1.mkv' },
        isUpgrade: false,
      }),
    ).toEqual({ kind: 'folder', path: '/data/shows/Show' });
  });

  it('reads the movie folder from a Radarr import', () => {
    expect(
      readArrFolder({
        eventType: 'Download',
        movie: { id: 1, title: 'Film', folderPath: '/data/movies/Film (2001)' },
        movieFile: { relativePath: 'Film (2001).mkv' },
      }),
    ).toEqual({ kind: 'folder', path: '/data/movies/Film (2001)' });
  });

  it('reads the artist folder from a Lidarr import', () => {
    expect(
      readArrFolder({ eventType: 'Download', artist: { id: 1, path: '/data/music/Artist' } }),
    ).toEqual({ kind: 'folder', path: '/data/music/Artist' });
  });

  it.each(['Rename', 'EpisodeFileDelete', 'SeriesDelete', 'MovieFileDelete', 'MovieDelete'])(
    'scans the folder for %s, like any other event that names one',
    (eventType) => {
      expect(readArrFolder({ eventType, series: { path: '/data/shows/Show' } })).toEqual({
        kind: 'folder',
        path: '/data/shows/Show',
      });
    },
  );

  // A future *arr release adds an event. Refusing what is not recognised
  // would turn that upgrade into files nobody scans.
  it('scans the folder for an event type it has never heard of', () => {
    expect(
      readArrFolder({ eventType: 'SomethingNew', movie: { folderPath: '/data/movies/Film' } }),
    ).toEqual({ kind: 'folder', path: '/data/movies/Film' });
  });

  it('ignores the Test event, so the Test button in the *arr passes', () => {
    expect(readArrFolder({ eventType: 'Test', series: { path: 'C:\\testpath' } }).kind).toBe(
      'ignore',
    );
  });

  it('ignores Grab: nothing has been imported yet', () => {
    expect(readArrFolder({ eventType: 'Grab', series: { path: '/data/shows/Show' } }).kind).toBe(
      'ignore',
    );
  });

  it('ignores an event that names no folder', () => {
    expect(readArrFolder({ eventType: 'Health', message: 'indexer down' }).kind).toBe('ignore');
  });

  it.each([null, undefined, 'a string', 42, ['a', 'list']])(
    'reports a body that is not an object as invalid: %j',
    (body) => {
      expect(readArrFolder(body).kind).toBe('invalid');
    },
  );

  it('reports a folder that is not a string as invalid', () => {
    expect(readArrFolder({ eventType: 'Download', series: { path: 42 } }).kind).toBe('invalid');
  });

  it('reports a Windows path as invalid, naming it', () => {
    const result = readArrFolder({
      eventType: 'Download',
      movie: { folderPath: 'C:\\Movies\\Film' },
    });
    expect(result).toMatchObject({ kind: 'invalid' });
    expect((result as { why: string }).why).toContain('C:\\Movies\\Film');
  });
});
