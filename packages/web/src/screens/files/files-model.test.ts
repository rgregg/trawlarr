import { describe, expect, it } from 'vitest';
import {
  filtersToQuery,
  formatBytes,
  formatTimestamp,
  formatUpdated,
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
  sizeBytes: 1_900_000_000,
  updatedAt: 1_000,
};

describe('toFileRows', () => {
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

describe('formatTimestamp', () => {
  it('renders the whole instant, since the file screen has room for it', () => {
    expect(formatTimestamp(Date.UTC(2026, 7, 27, 13, 45))).toBe('2026-08-27T13:45:00.000Z');
  });

  /**
   * THE REASON THIS FUNCTION EXISTS.
   *
   * `mtimeMs` is not a clock reading the daemon took — it is whatever
   * `fs.stat()` reported for the file, stored verbatim (`mtime_ms INTEGER
   * NOT NULL`, written unvalidated by the scanner). A share that reports a
   * garbage inode timestamp therefore puts a garbage number in the row, and
   * `new Date(that).toISOString()` throws `RangeError: Invalid time value`
   * for anything beyond ±8.64e15 ms.
   *
   * Thrown DURING RENDER, that unmounted the entire React tree: one
   * unreadable timestamp on one file blanked the whole application, with no
   * error, no retry, and no way out but editing the URL by hand.
   */
  it('never throws on a timestamp the filesystem made up', () => {
    expect(formatTimestamp(8.64e15 + 1)).toBe('—');
    expect(formatTimestamp(-8.64e15 - 1)).toBe('—');
    expect(formatTimestamp(1.8e19)).toBe('—');
    expect(formatTimestamp(Number.NaN)).toBe('—');
    expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe('—');
    // The field is typed `number`, but the type is a claim about a JSON
    // payload rather than a guarantee about one.
    expect(formatTimestamp(undefined as unknown as number)).toBe('—');
  });

  it('accepts the largest instant a Date can represent', () => {
    expect(formatTimestamp(8.64e15)).toBe('+275760-09-13T00:00:00.000Z');
  });

  it('says nothing for the unset timestamp rather than claiming 1970', () => {
    expect(formatTimestamp(0)).toBe('—');
    expect(formatTimestamp(-1)).toBe('—');
  });
});
