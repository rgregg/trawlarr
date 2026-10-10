import { describe, expect, it } from 'vitest';
import { mapFromRows, rowsFromMap } from './notification-paths-model.js';

describe('notification paths model', () => {
  it('shows the sender path first and trawlarr path second', () => {
    expect(rowsFromMap([{ serverPath: '/library', nodePath: '/data' }])).toEqual([
      { key: '/data\u0000/library', theirs: '/data', ours: '/library' },
    ]);
  });

  it('round-trips a map through rows', () => {
    const map = [
      { serverPath: '/library/movies', nodePath: '/data/movies' },
      { serverPath: '/library/shows', nodePath: '/data/shows' },
    ];
    expect(mapFromRows(rowsFromMap(map))).toEqual(map);
  });

  it('drops a row left entirely blank, so an unused "Add row" does not fail the save', () => {
    expect(
      mapFromRows([
        { key: 'a', theirs: '/data', ours: '/library' },
        { key: 'b', theirs: '  ', ours: '' },
      ]),
    ).toEqual([{ serverPath: '/library', nodePath: '/data' }]);
  });

  it('keeps a half-filled row, so the server can say what is wrong with it', () => {
    expect(mapFromRows([{ key: 'a', theirs: '/data', ours: '' }])).toEqual([
      { serverPath: '', nodePath: '/data' },
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(mapFromRows([{ key: 'a', theirs: ' /data ', ours: ' /library ' }])).toEqual([
      { serverPath: '/library', nodePath: '/data' },
    ]);
  });
});
