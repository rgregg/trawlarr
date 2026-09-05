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
import { toIsoInstant } from '../../shell/time.js';

export interface ApiFile {
  id: string;
  libraryId: string;
  path: string;
  state: string;
  reviewReason?: string | null;
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
  reviewReason?: string | null;
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
    reviewReason: item.reviewReason,
    // A codec the daemon has not probed yet is `null`, not the string
    // "null" — a dash says "not known" without inventing a fact.
    video: item.videoCodec ?? '—',
    audio: item.audioCodec ?? '—',
    sizeBytes: item.sizeBytes,
    updatedAt: item.updatedAt,
  }));

export const fileStateLabel = (file: { state: string; reviewReason?: string | null }): string =>
  file.state === 'held' && file.reviewReason != null ? 'Held for review' : file.state;

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
export const formatUpdated = (updatedAt: number): string =>
  toIsoInstant(updatedAt)?.slice(0, 10) ?? '—';
