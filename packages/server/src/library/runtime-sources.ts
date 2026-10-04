import { parseMediaName, type ParsedMediaName } from '@trawlarr/core';

/**
 * Clients for the services that know how long a title is SUPPOSED to run.
 * Network lives here, in `server`; `@trawlarr/core` only compares the numbers.
 */

export type RuntimeSourceName = 'radarr' | 'sonarr' | 'tmdb';

export interface RuntimeLookup {
  expectedMs: number;
  source: RuntimeSourceName;
}

export type RuntimeFetch = (
  url: string,
  init: { headers: Record<string, string>; redirect: 'manual' },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * The source could not answer (down, refused the key, bad response). Distinct
 * from "answered, and does not know this title", which is a plain null: only
 * the second is evidence about the file, and neither is ever a mismatch.
 */
export class RuntimeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSourceError';
  }
}

const MINUTE_MS = 60_000;
const TMDB_BASE = 'https://api.themoviedb.org/3';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A positive whole-ish number of minutes, or null: 0 means "not known", not "zero long". */
const minutes = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const getJson = async (
  fetchImpl: RuntimeFetch,
  url: string,
  headers: Record<string, string>,
  label: string,
): Promise<unknown> => {
  let response;
  try {
    // `manual`: a followed redirect re-sends custom headers such as
    // `X-Api-Key` to the new host (fetch only strips `Authorization` across
    // origins), so a source that redirects would be handed the key. A 3xx is
    // reported as a failed lookup instead.
    response = await fetchImpl(url, { headers, redirect: 'manual' });
  } catch (error) {
    throw new RuntimeSourceError(`${label} did not answer: ${(error as Error).message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new RuntimeSourceError(`${label} answered HTTP ${String(response.status)}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new RuntimeSourceError(`${label} sent something that is not JSON.`);
  }
};

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export interface ArrConfig {
  kind: 'radarr' | 'sonarr';
  url: string;
  apiKey: string;
}

/**
 * Radarr/Sonarr already match files to titles, so this asks THEM
 * (`/api/v3/parse`) rather than re-deriving a match from the filename. A file
 * the instance does not know comes back with no movie/series: null.
 */
export const arrRuntime = async (
  config: ArrConfig,
  filePath: string,
  fetchImpl: RuntimeFetch,
): Promise<RuntimeLookup | null> => {
  const base = config.url.replace(/\/+$/, '');
  const body = asRecord(
    await getJson(
      fetchImpl,
      `${base}/api/v3/parse?title=${encodeURIComponent(basename(filePath))}`,
      { 'X-Api-Key': config.apiKey },
      config.kind === 'radarr' ? 'Radarr' : 'Sonarr',
    ),
  );
  if (body === null) return null;

  if (config.kind === 'radarr') {
    const runtime = minutes(asRecord(body.movie)?.runtime);
    return runtime === null ? null : { expectedMs: runtime * MINUTE_MS, source: 'radarr' };
  }

  const seriesRuntime = minutes(asRecord(body.series)?.runtime);
  const episodes = Array.isArray(body.episodes) ? body.episodes : [];
  if (episodes.length === 0) return null;
  let total = 0;
  for (const episode of episodes) {
    const each = minutes(asRecord(episode)?.runtime) ?? seriesRuntime;
    // One episode of unknown length makes the sum meaningless; say so.
    if (each === null) return null;
    total += each;
  }
  return { expectedMs: total * MINUTE_MS, source: 'sonarr' };
};

/** A v4 "read access token" is a JWT (has dots); a v3 key is a bare hex string. */
const tmdbAuth = (apiKey: string): { headers: Record<string, string>; query: string } =>
  apiKey.includes('.')
    ? { headers: { Authorization: `Bearer ${apiKey}` }, query: '' }
    : { headers: {}, query: `&api_key=${encodeURIComponent(apiKey)}` };

const firstId = (body: unknown): number | null => {
  const results = asRecord(body)?.results;
  if (!Array.isArray(results)) return null;
  const id = asRecord(results[0])?.id;
  return typeof id === 'number' ? id : null;
};

/**
 * TMDB by parsed filename. Conservative on purpose: the first search hit is
 * taken, and a name that cannot be parsed or found is null, never a guess.
 * A year that finds nothing is retried without it, since a year in a filename
 * is sometimes part of the title.
 */
export const tmdbRuntime = async (
  apiKey: string,
  parsed: ParsedMediaName,
  fetchImpl: RuntimeFetch,
): Promise<RuntimeLookup | null> => {
  const { headers, query } = tmdbAuth(apiKey);
  const get = (path: string): Promise<unknown> =>
    getJson(
      fetchImpl,
      // `query` is "&api_key=…" (or empty); a path with no query string yet
      // needs the "?" in place of that leading "&".
      `${TMDB_BASE}${path}${path.includes('?') ? query : query.replace('&', '?')}`,
      headers,
      'TMDB',
    );
  const q = encodeURIComponent(parsed.title);

  if (parsed.kind === 'movie') {
    const yearParam = parsed.year === null ? '' : `&year=${String(parsed.year)}`;
    let id = firstId(await get(`/search/movie?query=${q}${yearParam}`));
    if (id === null && parsed.year !== null) id = firstId(await get(`/search/movie?query=${q}`));
    if (id === null) return null;
    const runtime = minutes(asRecord(await get(`/movie/${String(id)}`))?.runtime);
    return runtime === null ? null : { expectedMs: runtime * MINUTE_MS, source: 'tmdb' };
  }

  const yearParam = parsed.year === null ? '' : `&first_air_date_year=${String(parsed.year)}`;
  let id = firstId(await get(`/search/tv?query=${q}${yearParam}`));
  if (id === null && parsed.year !== null) id = firstId(await get(`/search/tv?query=${q}`));
  if (id === null) return null;

  let showRuntime: number | null | undefined;
  let total = 0;
  for (const episode of parsed.episodes) {
    let each = minutes(
      asRecord(
        await get(`/tv/${String(id)}/season/${String(parsed.season)}/episode/${String(episode)}`),
      )?.runtime,
    );
    if (each === null) {
      if (showRuntime === undefined) {
        const typical = asRecord(await get(`/tv/${String(id)}`))?.episode_run_time;
        showRuntime = Array.isArray(typical) ? minutes(typical[0]) : null;
      }
      each = showRuntime;
    }
    if (each === null) return null;
    total += each;
  }
  return { expectedMs: total * MINUTE_MS, source: 'tmdb' };
};

/**
 * The expected runtime for one file: Radarr/Sonarr first where the library has
 * one, TMDB otherwise. Throws RuntimeSourceError only when NOTHING answered
 * and at least one source was down, so a caller can tell "unknown title"
 * (null) from "could not ask".
 */
export const lookupExpectedRuntime = async (input: {
  path: string;
  arr: ArrConfig | null;
  tmdbApiKey: string;
  fetchImpl: RuntimeFetch;
}): Promise<RuntimeLookup | null> => {
  let failure: RuntimeSourceError | null = null;

  if (input.arr !== null) {
    try {
      const found = await arrRuntime(input.arr, input.path, input.fetchImpl);
      if (found !== null) return found;
    } catch (error) {
      if (!(error instanceof RuntimeSourceError)) throw error;
      failure = error;
    }
  }

  if (input.tmdbApiKey !== '') {
    const parsed = parseMediaName(input.path);
    if (parsed !== null) {
      try {
        return await tmdbRuntime(input.tmdbApiKey, parsed, input.fetchImpl);
      } catch (error) {
        if (!(error instanceof RuntimeSourceError)) throw error;
        failure = error;
      }
    }
  }

  if (failure !== null) throw failure;
  return null;
};
