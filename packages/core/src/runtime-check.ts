/**
 * Is a file's length plausible for the title it claims to be?
 *
 * A truncated download, a sample clip filed under the real name and a file
 * whose audio runs long all pass every container and codec check — nothing
 * about the bytes is wrong, only the length. Comparing against what the
 * title is SUPPOSED to run is the only signal that catches them.
 *
 * Pure: expected runtimes come from Radarr/Sonarr/TMDB, which the server
 * asks; this file only decides what to do with the numbers. Time enters as
 * `nowMs`.
 */

export interface RuntimeThreshold {
  /** Percent of the baseline runtime, e.g. 5 for 5%. */
  percent: number;
  /** Floor in minutes, so a short episode is not flagged for a few seconds. */
  minutes: number;
}

/** Flag when the difference exceeds max(5% of expected, 3 minutes). */
export const DEFAULT_RUNTIME_THRESHOLD: RuntimeThreshold = { percent: 5, minutes: 3 };

/** How far a length may drift from the baseline before it is called wrong. */
export const runtimeToleranceMs = (baselineMs: number, threshold: RuntimeThreshold): number =>
  Math.max((baselineMs * threshold.percent) / 100, threshold.minutes * 60_000);

export interface RuntimeAssessment {
  flagged: boolean;
  /** The length the file is measured against: accepted if the person accepted one, else expected. */
  baselineMs: number;
  /** actual - baseline; negative means the file is shorter than it should be. */
  diffMs: number;
  toleranceMs: number;
}

/**
 * Null when there is nothing to compare: no known expected runtime (a failed
 * or empty lookup must never read as a mismatch) or no measured duration.
 *
 * `acceptedMs` is the length the person chose to Ignore. It REPLACES the
 * expected runtime as the baseline, so the file reappears only when its
 * length moves again, not merely because it is still different from the
 * database.
 */
export const assessRuntime = (input: {
  actualMs: number | null;
  expectedMs: number | null;
  acceptedMs: number | null;
  threshold: RuntimeThreshold;
}): RuntimeAssessment | null => {
  const { actualMs, expectedMs, acceptedMs, threshold } = input;
  if (actualMs === null || actualMs <= 0) return null;
  if (expectedMs === null || expectedMs <= 0) return null;
  const baselineMs = acceptedMs ?? expectedMs;
  const toleranceMs = runtimeToleranceMs(baselineMs, threshold);
  const diffMs = actualMs - baselineMs;
  return { flagged: Math.abs(diffMs) > toleranceMs, baselineMs, diffMs, toleranceMs };
};

/** A found runtime is stable for weeks; a miss is retried sooner (the title may be added later). */
export const RUNTIME_REFRESH_MS = 30 * 24 * 3_600_000;
export const RUNTIME_RETRY_MS = 6 * 3_600_000;

/** Whether a file's expected runtime should be looked up (again) now. */
export const runtimeLookupDue = (input: {
  checkedAtMs: number | null;
  expectedMs: number | null;
  nowMs: number;
}): boolean => {
  if (input.checkedAtMs === null) return true;
  const wait = input.expectedMs === null ? RUNTIME_RETRY_MS : RUNTIME_REFRESH_MS;
  return input.nowMs - input.checkedAtMs >= wait;
};

export type ParsedMediaName =
  | { kind: 'movie'; title: string; year: number | null }
  | {
      kind: 'episode';
      title: string;
      year: number | null;
      season: number;
      /** More than one for a multi-episode file (S01E01-E02). */
      episodes: number[];
    };

const QUALITY_TOKEN =
  /[ ._-](?:2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|hdtv|dvdrip|remux|x26[45]|h\.?26[45]|hevc)\b/i;

const clean = (raw: string): string =>
  raw
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–([]+$/, '')
    .replace(/^[\s\-–]+/, '')
    .trim();

const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const stripExtension = (name: string): string => name.replace(/\.[A-Za-z0-9]{2,4}$/, '');
const splitYear = (title: string): { title: string; year: number | null } => {
  const match = /^(.*?)[\s([]*((?:19|20)\d{2})[\s)\]]*$/.exec(title);
  return match === null || match[1]!.trim() === ''
    ? { title, year: null }
    : { title: match[1]!.trim(), year: Number(match[2]) };
};

const EPISODE_PATTERNS: RegExp[] = [
  /S(\d{1,2})[ ._-]?E(\d{1,3})(?:[ ._-]?(?:E|-E?)(\d{1,3}))?/i,
  /(?:^|[ ._[(-])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?(?![\dpi])/i,
];

const isSeasonDir = (dir: string): boolean => /^(season|series|specials?)[ ._-]*\d*$/i.test(dir);

/**
 * Title, year and (for TV) season/episode from a library path.
 *
 * Deliberately conservative: null when no title can be read, because a wrong
 * guess becomes a wrong expected runtime and a false "bad length" flag on a
 * good file. For episodes the series name falls back to the folder above the
 * season folder when the filename carries none ("S01E02 - Pilot.mkv").
 */
export const parseMediaName = (path: string): ParsedMediaName | null => {
  const file = stripExtension(basenameOf(path));
  const dirs = path
    .split('/')
    .filter((part) => part !== '')
    .slice(0, -1);

  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(file);
    if (match === null) continue;
    const season = Number(match[1]);
    const first = Number(match[2]);
    const last = match[3] === undefined ? first : Number(match[3]);
    const episodes: number[] = [];
    for (let n = first; n <= last && n - first < 20; n += 1) episodes.push(n);

    let rawTitle = clean(file.slice(0, match.index));
    if (rawTitle === '') {
      const nonSeason = [...dirs].reverse().find((dir) => !isSeasonDir(dir));
      rawTitle = clean(nonSeason ?? '');
    }
    if (rawTitle === '') return null;
    const { title, year } = splitYear(rawTitle);
    return { kind: 'episode', title, year, season, episodes };
  }

  const cut = QUALITY_TOKEN.exec(file);
  const head = cut === null ? file : file.slice(0, cut.index);
  // Greedy, so the LAST year wins: "Blade Runner 2049 (2017)" is a 2017 film.
  const yearMatch = /^(.*)[ ._([-]+((?:19|20)\d{2})(?:[ ._)\]-]|$)/.exec(head);
  if (yearMatch !== null && clean(yearMatch[1]!) !== '') {
    return { kind: 'movie', title: clean(yearMatch[1]!), year: Number(yearMatch[2]) };
  }
  const title = clean(head);
  return title === '' ? null : { kind: 'movie', title, year: null };
};
