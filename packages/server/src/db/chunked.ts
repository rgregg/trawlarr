import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Db } from './connection.js';

export const DEFAULT_CHUNK_SIZE = 500;

/**
 * Apply a large batch of writes in bounded transactions, yielding between
 * chunks.
 *
 * better-sqlite3 is synchronous: one transaction wrapping 100,000 inserts
 * blocks the event loop for its whole duration, which freezes the HTTP API
 * and the WebSocket. Chunking keeps any single blocking span short. Each
 * chunk commits independently, so a mid-batch failure leaves earlier chunks
 * durable — scans are resumable, so partial progress is a feature.
 */
export const runChunked = async <T>(input: {
  db: Db;
  items: readonly T[];
  chunkSize?: number;
  apply: (item: T) => void;
  /**
   * Called after each chunk's transaction COMMITS, with the number of rows
   * that transaction applied and how long the commit itself blocked.
   *
   * `elapsedMs` is the duration of the SYNCHRONOUS span — the one in which
   * the event loop, and with it the HTTP API and the WebSocket, could not
   * run — not the interval since the previous commit, which on a scan also
   * contains an `ffprobe` spawn and would make the number look ten times
   * worse than the thing spec §3.3 sets a target for.
   *
   * An observation seam, not a hook: it exists so a test can constrain the
   * size of the blocking spans this function creates, and so `bench:scan`
   * can time them. It deliberately reports committed chunks only — a
   * transaction that threw rolled back and applied nothing, so counting it
   * would overstate what is on disk.
   */
  onTransactionCommitted?: (rows: number, elapsedMs: number) => void;
}): Promise<{ chunks: number; items: number }> => {
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize < 1) throw new Error('chunkSize must be at least 1');

  let chunks = 0;

  for (let offset = 0; offset < input.items.length; offset += chunkSize) {
    const chunk = input.items.slice(offset, offset + chunkSize);
    const commit = input.db.transaction((batch: readonly T[]) => {
      for (const item of batch) input.apply(item);
    });
    const startedAt = performance.now();
    commit(chunk);
    const elapsedMs = performance.now() - startedAt;
    chunks += 1;
    input.onTransactionCommitted?.(chunk.length, elapsedMs);
    await yieldToEventLoop();
  }

  return { chunks, items: input.items.length };
};
