/**
 * The Files screen's own shape, built from what `GET /files` returns.
 *
 * Kept separate from `Files.tsx` because this is the half a test can reach:
 * no DOM testing library exists in this repo, so every branch that matters —
 * how a row is derived, how it sorts, how a byte count reads, how a filter
 * becomes a query string — lives here where `files-model.test.ts` can assert
 * it directly, and the component stays a thin renderer over it.
 */
import type { FileFilters } from '../../shell/route.js';

export interface ApiFile {
  id: string;
  libraryId: string;
  path: string;
  state: string;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number;
  updatedAt: number;
}

export interface FileRow {
  id: string;
  path: string;
  name: string;
  state: string;
  video: string;
  audio: string;
  sizeBytes: number;
  updatedAt: number;
}

export type SortColumn = 'name' | 'state' | 'size' | 'updated';

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const toFileRows = (items: ApiFile[]): FileRow[] =>
  items.map((item) => ({
    id: item.id,
    path: item.path,
    name: basename(item.path),
    state: item.state,
    // A codec the daemon has not probed yet is `null`, not the string
    // "null" — a dash says "not known" without inventing a fact.
    video: item.videoCodec ?? '—',
    audio: item.audioCodec ?? '—',
    sizeBytes: item.sizeBytes,
    updatedAt: item.updatedAt,
  }));

export const sortRows = (
  rows: FileRow[],
  column: SortColumn,
  direction: 'asc' | 'desc',
): FileRow[] => {
  const sign = direction === 'asc' ? 1 : -1;
  // A COPY, always: this table re-sorts on every click of a column header,
  // and a sort that mutated the rows it was handed would corrupt whatever
  // still held a reference to the previous order (or the same array, mid
  // React render).
  return [...rows].sort((left, right) => {
    switch (column) {
      case 'name':
        return sign * left.name.localeCompare(right.name);
      case 'state':
        return sign * left.state.localeCompare(right.state);
      case 'size':
        return sign * (left.sizeBytes - right.sizeBytes);
      case 'updated':
        return sign * (left.updatedAt - right.updatedAt);
    }
  });
};

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${UNITS[unit]}`;
};

/**
 * The URL says `library`; the API says `libraryId`. This is the only place
 * that knows, so a filter never has to be translated twice.
 */
export const filtersToQuery = (filters: FileFilters, limit: number, offset: number): string => {
  const params = new URLSearchParams();
  if (filters.library !== null) params.set('libraryId', filters.library);
  if (filters.state !== null) params.set('state', filters.state);
  if (filters.q !== null) params.set('q', filters.q);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `?${params.toString()}`;
};

/**
 * When a row last changed, as a date.
 *
 * The table has a working "Updated" sort button and had no column to sort
 * BY — the one ordering an operator reaches for after a run ("what did
 * tonight touch?") was invisible in the rows it reordered. Date only, and
 * ISO rather than a locale format: this is a table of thousands of rows
 * scanned by eye, so it has to be fixed-width and unambiguous, and the exact
 * timestamp is one click away on the file's own screen.
 */
export const formatUpdated = (updatedAt: number): string => formatTimestamp(updatedAt).slice(0, 10);

/**
 * The largest magnitude a `Date` can represent, in milliseconds.
 *
 * `Date.prototype.toISOString()` does not return something unhelpful beyond
 * this — it THROWS `RangeError: Invalid time value`. ECMA-262 fixes the
 * bound at ±8.64e15 ms (±100,000,000 days), so it is a constant rather than
 * a guess.
 */
const MAX_TIME_VALUE = 8.64e15;

/**
 * An instant, in full, or an em dash when there isn't one.
 *
 * THIS FUNCTION EXISTS BECAUSE ONE FILE COULD BLANK THE WHOLE APPLICATION.
 * `mtimeMs` is not a clock reading the daemon took: it is whatever
 * `fs.stat()` said about the file, stored verbatim (`mtime_ms INTEGER NOT
 * NULL`, written unvalidated by the scanner), so a share that reports a
 * nonsense inode timestamp puts a nonsense number straight in the row. The
 * file screen rendered it with a bare `new Date(ms).toISOString()`, which
 * throws for anything out of range — and a throw DURING RENDER unmounts the
 * entire React tree. One unreadable timestamp on one file, and the operator
 * got a white page: no message, no retry, no way out but editing the URL.
 *
 * So the guard is not politeness about a rare value; it is the difference
 * between a dash in one cell and losing the application. Anything that
 * reaches `toISOString` from a timestamp this UI did not generate itself
 * goes through here.
 *
 * Zero and negative values read as "unset" rather than as 1970 and 1969:
 * that is what an absent timestamp looks like in this schema, and a media
 * file predating the epoch does not exist.
 */
export const formatTimestamp = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0 || Math.abs(ms) > MAX_TIME_VALUE) return '—';
  return new Date(ms).toISOString();
};
