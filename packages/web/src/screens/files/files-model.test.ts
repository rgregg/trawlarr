import { describe, expect, it } from 'vitest';
import { filtersToQuery, formatBytes, formatUpdated, sortRows, toFileRows } from './files-model.js';

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
});
