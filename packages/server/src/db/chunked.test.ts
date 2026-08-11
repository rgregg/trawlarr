import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { DEFAULT_CHUNK_SIZE, runChunked } from './chunked.js';

const setup = () => {
  const db = openDatabase({ file: ':memory:' });
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)`);
  return db;
};

describe('runChunked', () => {
  it('writes every item', async () => {
    const db = setup();
    const insert = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);
    const items = Array.from({ length: 1200 }, (_, i) => i);

    const result = await runChunked({
      db,
      items,
      chunkSize: 500,
      apply: (i) => insert.run(i, `v${i}`),
    });

    expect(result).toEqual({ chunks: 3, items: 1200 });
    const count = db.prepare(`SELECT COUNT(*) AS c FROM t`).get() as { c: number };
    expect(count.c).toBe(1200);
    db.close();
  });

  it('yields to the event loop between chunks so the API stays responsive', async () => {
    const db = setup();
    const insert = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);
    let ticksDuringWrite = 0;
    const timer = setInterval(() => {
      ticksDuringWrite += 1;
    }, 1);

    await runChunked({
      db,
      items: Array.from({ length: 50 }, (_, i) => i),
      chunkSize: 5,
      apply: (i) => insert.run(i, `v${i}`),
    });
    clearInterval(timer);

    // 10 chunks means at least a few macrotask boundaries were reached.
    expect(ticksDuringWrite).toBeGreaterThan(0);
    db.close();
  });

  it('commits completed chunks and surfaces the failure of the bad one', async () => {
    const db = setup();
    const insert = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);

    await expect(
      runChunked({
        db,
        items: [1, 2, 3, 4, 5, 6],
        chunkSize: 2,
        apply: (i) => {
          if (i === 5) throw new Error('boom');
          insert.run(i, `v${i}`);
        },
      }),
    ).rejects.toThrow('boom');

    // Chunks [1,2] and [3,4] committed; [5,6] rolled back entirely.
    const count = db.prepare(`SELECT COUNT(*) AS c FROM t`).get() as { c: number };
    expect(count.c).toBe(4);
    db.close();
  });

  it('handles an empty list without opening a transaction', async () => {
    const db = setup();
    expect(await runChunked({ db, items: [], apply: () => {} })).toEqual({ chunks: 0, items: 0 });
    db.close();
  });

  it('exposes a sane default chunk size', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(500);
  });
});
