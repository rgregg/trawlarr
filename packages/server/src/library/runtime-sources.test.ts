import { describe, expect, it } from 'vitest';
import {
  arrRuntime,
  lookupExpectedRuntime,
  RuntimeSourceError,
  tmdbRuntime,
  type RuntimeFetch,
} from './runtime-sources.js';

const MIN = 60_000;

/** A fetch that answers from a table keyed by URL substring, and records every call. */
const fakeFetch = (
  routes: Record<string, unknown | (() => never)>,
): RuntimeFetch & { calls: { url: string; headers: Record<string, string> }[] } => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl: RuntimeFetch = (url, init) => {
    calls.push({ url, headers: init.headers });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined)
      return Promise.resolve({ ok: false, status: 404, json: () => null as never });
    const value = routes[key];
    if (typeof value === 'function') return Promise.reject(new Error('connect ECONNREFUSED'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });
  };
  return Object.assign(impl, { calls });
};

describe('arrRuntime', () => {
  it('asks Radarr to parse the filename and reads the movie runtime', async () => {
    const f = fakeFetch({ '/api/v3/parse': { movie: { runtime: 117 } } });
    const found = await arrRuntime(
      { kind: 'radarr', url: 'http://r:7878/', apiKey: 'k' },
      '/m/Heat (1995)/Heat.1995.mkv',
      f,
    );
    expect(found).toEqual({ expectedMs: 117 * MIN, source: 'radarr' });
    expect(f.calls[0]!.url).toBe('http://r:7878/api/v3/parse?title=Heat.1995.mkv');
    expect(f.calls[0]!.headers['X-Api-Key']).toBe('k');
  });

  it('sums the episodes Sonarr matched, falling back to the series runtime', async () => {
    const f = fakeFetch({
      '/api/v3/parse': { series: { runtime: 22 }, episodes: [{ runtime: 24 }, {}] },
    });
    const found = await arrRuntime(
      { kind: 'sonarr', url: 'http://s', apiKey: 'k' },
      '/tv/Show.S01E01-E02.mkv',
      f,
    );
    expect(found?.expectedMs).toBe(46 * MIN);
  });

  it('is null for a title the instance does not know', async () => {
    const f = fakeFetch({ '/api/v3/parse': { movie: null } });
    expect(await arrRuntime({ kind: 'radarr', url: 'http://r', apiKey: 'k' }, '/m/x.mkv', f)).toBe(
      null,
    );
  });

  it('throws a source error when the instance is down or refuses the key', async () => {
    const down = fakeFetch({ '/api/v3/parse': () => undefined as never });
    await expect(
      arrRuntime({ kind: 'radarr', url: 'http://r', apiKey: 'k' }, '/m/x.mkv', down),
    ).rejects.toBeInstanceOf(RuntimeSourceError);

    const refused: RuntimeFetch = () =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    await expect(
      arrRuntime({ kind: 'radarr', url: 'http://r', apiKey: 'k' }, '/m/x.mkv', refused),
    ).rejects.toThrow(/401/);
  });
});

describe('tmdbRuntime', () => {
  it('finds a movie by title and year', async () => {
    const f = fakeFetch({
      '/search/movie': { results: [{ id: 949 }] },
      '/movie/949': { runtime: 170 },
    });
    const found = await tmdbRuntime('abc123', { kind: 'movie', title: 'Heat', year: 1995 }, f);
    expect(found).toEqual({ expectedMs: 170 * MIN, source: 'tmdb' });
    expect(f.calls[0]!.url).toBe(
      'https://api.themoviedb.org/3/search/movie?query=Heat&year=1995&api_key=abc123',
    );
  });

  it('retries a movie search without the year', async () => {
    const results: Record<string, unknown>[] = [{ results: [] }, { results: [{ id: 1 }] }];
    const f: RuntimeFetch = (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(url.includes('/search/movie') ? results.shift() : { runtime: 100 }),
      });
    const found = await tmdbRuntime('k', { kind: 'movie', title: 'Blade Runner', year: 2049 }, f);
    expect(found?.expectedMs).toBe(100 * MIN);
  });

  it('uses a bearer header for a v4 token', async () => {
    const f = fakeFetch({ '/search/movie': { results: [] } });
    await tmdbRuntime('aa.bb.cc', { kind: 'movie', title: 'X', year: null }, f);
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer aa.bb.cc');
    expect(f.calls[0]!.url).not.toContain('api_key');
  });

  it('reads an episode runtime, falling back to the show typical length', async () => {
    const f = fakeFetch({
      '/search/tv': { results: [{ id: 7 }] },
      '/season/1/episode/1': { runtime: 50 },
      '/season/1/episode/2': { runtime: null },
      '/tv/7?': { episode_run_time: [45] },
    });
    const found = await tmdbRuntime(
      'k',
      { kind: 'episode', title: 'Show', year: null, season: 1, episodes: [1, 2] },
      f,
    );
    expect(found?.expectedMs).toBe(95 * MIN);
  });
});

describe('lookupExpectedRuntime', () => {
  const arr = { kind: 'radarr' as const, url: 'http://r', apiKey: 'k' };

  it('prefers the arr instance over TMDB', async () => {
    const f = fakeFetch({ '/api/v3/parse': { movie: { runtime: 100 } } });
    const found = await lookupExpectedRuntime({
      path: '/m/Heat.1995.mkv',
      arr,
      tmdbApiKey: 'k',
      fetchImpl: f,
    });
    expect(found?.source).toBe('radarr');
    expect(f.calls).toHaveLength(1);
  });

  it('falls back to TMDB when the arr does not know the title or is down', async () => {
    for (const parse of [{ movie: null }, () => undefined as never]) {
      const f = fakeFetch({
        '/api/v3/parse': parse,
        '/search/movie': { results: [{ id: 1 }] },
        '/movie/1': { runtime: 90 },
      });
      const found = await lookupExpectedRuntime({
        path: '/m/Heat.1995.mkv',
        arr,
        tmdbApiKey: 'k',
        fetchImpl: f,
      });
      expect(found).toEqual({ expectedMs: 90 * MIN, source: 'tmdb' });
    }
  });

  it('is null with no sources, and throws only when a source was down and nothing answered', async () => {
    const none = fakeFetch({});
    expect(
      await lookupExpectedRuntime({
        path: '/m/a.2000.mkv',
        arr: null,
        tmdbApiKey: '',
        fetchImpl: none,
      }),
    ).toBeNull();
    expect(none.calls).toHaveLength(0);

    const down = fakeFetch({ '/api/v3/parse': () => undefined as never });
    await expect(
      lookupExpectedRuntime({ path: '/m/a.2000.mkv', arr, tmdbApiKey: '', fetchImpl: down }),
    ).rejects.toBeInstanceOf(RuntimeSourceError);
  });
});
