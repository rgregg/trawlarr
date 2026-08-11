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

  it('yields to the macrotask queue between chunks, not just the microtask queue', async () => {
    const db = setup();
    const insert = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);

    // This test asserts *ordering*, not *timing*. Counting wall-clock timer
    // ticks (the previous version of this test) is inherently racy: a tiny
    // in-memory batch can finish in well under a millisecond, so a 1ms timer
    // may never fire before runChunked resolves, even though the yield is
    // working correctly. That made the test flake under load without ever
    // detecting a real regression.
    //
    // Instead, record the interleaving of a self-rescheduling `setImmediate`
    // chain against the `apply` calls. `setImmediate` callbacks run in the
    // event loop's check phase in FIFO queue order, which is deterministic
    // regardless of machine speed. If runChunked's yield between chunks were
    // downgraded to a microtask-only yield (e.g. `await Promise.resolve()`)
    // or removed entirely, the tick chain would never get a turn between
    // chunk boundaries and no 'tick' marker would ever land between two
    // `item:*` markers.
    const events: string[] = [];
    let running = true;
    const scheduleTick = () => {
      if (!running) return;
      events.push('tick');
      setImmediate(scheduleTick);
    };
    setImmediate(scheduleTick);

    const chunkSize = 5;
    const items = Array.from({ length: 50 }, (_, i) => i);

    await runChunked({
      db,
      items,
      chunkSize,
      apply: (i) => {
        insert.run(i, `v${i}`);
        events.push(`item:${i}`);
      },
    });
    running = false;

    // For each chunk boundary (last item of chunk N, first item of chunk
    // N+1), check whether a 'tick' marker landed strictly between them.
    let boundariesWithTick = 0;
    for (let lastOfChunk = chunkSize - 1; lastOfChunk < items.length - 1; lastOfChunk += chunkSize) {
      const lastIdx = events.indexOf(`item:${lastOfChunk}`);
      const nextIdx = events.indexOf(`item:${lastOfChunk + 1}`);
      const between = events.slice(lastIdx + 1, nextIdx);
      if (between.includes('tick')) boundariesWithTick += 1;
    }

    expect(boundariesWithTick).toBeGreaterThan(0);
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
