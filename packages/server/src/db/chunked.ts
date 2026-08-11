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
}): Promise<{ chunks: number; items: number }> => {
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize < 1) throw new Error('chunkSize must be at least 1');

  let chunks = 0;

  for (let offset = 0; offset < input.items.length; offset += chunkSize) {
    const chunk = input.items.slice(offset, offset + chunkSize);
    const commit = input.db.transaction((batch: readonly T[]) => {
      for (const item of batch) input.apply(item);
    });
    commit(chunk);
    chunks += 1;
    await yieldToEventLoop();
  }

  return { chunks, items: input.items.length };
};
