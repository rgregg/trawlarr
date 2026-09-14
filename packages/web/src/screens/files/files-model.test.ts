import { describe, expect, it } from 'vitest';
import {
  fileStateLabel,
  filtersToQuery,
  formatBytes,
  formatDuration,
  formatUpdated,
  libraryOptions,
  sortRows,
  toFileRows,
} from './files-model.js';

const apiFile = {
  id: 'f1',
  libraryId: 'lib-1',
  path: '/library/shows/Foundation (2021)/Season 2/S02E02.mkv',
  state: 'good',
  videoCodec: 'hevc',
  audioCodec: 'aac,eac3',
  durationMs: 3_231_457,
  sizeBytes: 1_900_000_000,
  updatedAt: 1_000,
};

describe('toFileRows', () => {
  it('distinguishes review holds from retry backoff without changing the state filter', () => {
    const [row] = toFileRows([
      { ...apiFile, state: 'held', reviewReason: 'Check the video quality.' },
    ]);
    expect(row!.state).toBe('held');
    expect(row!.reviewReason).toBe('Check the video quality.');
    expect(fileStateLabel(row!)).toBe('Held for review');
    expect(fileStateLabel({ state: 'held', reviewReason: null })).toBe('held');
    expect(fileStateLabel({ state: 'queued', reviewReason: 'Stale reason' })).toBe('queued');
  });

  it('shows the file name, keeping the full path for the title', () => {
    const [row] = toFileRows([apiFile]);
    expect(row!.name).toBe('S02E02.mkv');
    expect(row!.path).toBe(apiFile.path);
  });

  it('renders a missing codec as a dash rather than "null"', () => {
    const [row] = toFileRows([{ ...apiFile, videoCodec: null, audioCodec: null }]);
    expect(row!.video).toBe('—');
    expect(row!.audio).toBe('—');
  });
});

describe('sortRows', () => {
  const rows = toFileRows([
    { ...apiFile, id: 'b', path: '/x/b.mkv', sizeBytes: 300, updatedAt: 2 },
    { ...apiFile, id: 'a', path: '/x/a.mkv', sizeBytes: 100, updatedAt: 3 },
    { ...apiFile, id: 'c', path: '/x/c.mkv', sizeBytes: 200, updatedAt: 1 },
  ]);

  it('sorts by name ascending', () => {
    expect(sortRows(rows, 'name', 'asc').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by size descending', () => {
    expect(sortRows(rows, 'size', 'desc').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by state, the column an operator sorts by to see the trouble together', () => {
    const states = toFileRows([
      { ...apiFile, id: 'q', path: '/x/q.mkv', state: 'queued' },
      { ...apiFile, id: 'f', path: '/x/f.mkv', state: 'failed' },
      { ...apiFile, id: 'g', path: '/x/g.mkv', state: 'good' },
    ]);
    expect(sortRows(states, 'state', 'asc').map((r) => r.id)).toEqual(['f', 'g', 'q']);
    expect(sortRows(states, 'state', 'desc').map((r) => r.id)).toEqual(['q', 'g', 'f']);
  });

  it('sorts by updated, newest last ascending and newest first descending', () => {
    expect(sortRows(rows, 'updated', 'asc').map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(sortRows(rows, 'updated', 'desc').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('reverses a name sort rather than only reversing numbers', () => {
    expect(sortRows(rows, 'name', 'desc').map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts by duration with unprobed files last in either direction', () => {
    const timed = toFileRows([
      { ...apiFile, id: 'long', path: '/x/long.mkv', durationMs: 7_200_000 },
      { ...apiFile, id: 'none', path: '/x/none.mkv', durationMs: null },
      { ...apiFile, id: 'short', path: '/x/short.mkv', durationMs: 60_000 },
    ]);
    expect(sortRows(timed, 'duration', 'asc').map((r) => r.id)).toEqual(['short', 'long', 'none']);
    expect(sortRows(timed, 'duration', 'desc').map((r) => r.id)).toEqual(['long', 'short', 'none']);
  });

  it('does not mutate the array it was given', () => {
    const before = rows.map((r) => r.id);
    sortRows(rows, 'size', 'desc');
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1_900_000_000)).toBe('1.9 GB');
    expect(formatBytes(8_400_000_000_000)).toBe('8.4 TB');
  });
});

describe('formatDuration', () => {
  it('always prints hours, so a column of lengths is fixed-width', () => {
    expect(formatDuration(3_231_457)).toBe('0:53:51');
    expect(formatDuration(7_450_000)).toBe('2:04:10');
    expect(formatDuration(0)).toBe('0:00:00');
  });

  it('renders an unprobed or nonsensical duration as a dash', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('filtersToQuery', () => {
  it('omits absent filters and always carries paging', () => {
    expect(filtersToQuery({ library: null, state: null, q: null }, 200, 0)).toBe(
      '?limit=200&offset=0',
    );
  });

  it('maps the UI filter names onto the API parameter names', () => {
    expect(filtersToQuery({ library: 'lib-1', state: 'failed', q: 'found' }, 200, 400)).toBe(
      '?libraryId=lib-1&state=failed&q=found&limit=200&offset=400',
    );
  });
});

describe('formatUpdated', () => {
  it('renders a fixed-width date, so thousands of rows can be scanned by eye', () => {
    expect(formatUpdated(Date.UTC(2026, 7, 27, 13, 45))).toBe('2026-08-27');
  });

  it('says nothing rather than 1970 for a row with no timestamp', () => {
    expect(formatUpdated(0)).toBe('—');
    expect(formatUpdated(Number.NaN)).toBe('—');
  });

  // The same range `formatTimestamp` refuses, for the same reason: this one
  // is reached with `updatedAt`, but both end at `Date.prototype.toISOString`.
  it('says nothing for a value outside the range a Date can represent', () => {
    expect(formatUpdated(8.64e15 + 1)).toBe('—');
  });
});

describe('libraryOptions', () => {
  const libraries = [
    { id: 'shows-id', name: 'Shows' },
    { id: 'movies-id', name: 'Movies' },
  ];

  it('offers every library first, then each by name', () => {
    expect(libraryOptions(libraries, null)).toEqual([
      { value: '', label: 'All libraries' },
      { value: 'movies-id', label: 'Movies' },
      { value: 'shows-id', label: 'Shows' },
    ]);
  });

  it('keeps a filter for a library that no longer exists visible, instead of pretending "All"', () => {
    const options = libraryOptions(libraries, 'gone-id');
    expect(options.at(-1)).toEqual({ value: 'gone-id', label: 'Unknown library (gone-id)' });
  });

  it('shows the current filter even before the library list has loaded', () => {
    expect(libraryOptions([], 'movies-id').map((option) => option.value)).toEqual([
      '',
      'movies-id',
    ]);
  });
});
