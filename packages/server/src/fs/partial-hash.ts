import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import {
  buildIdentityCandidate,
  type IdentityCandidate,
  type PartialHashParts,
} from '@trawlarr/core';

/**
 * Bytes read from each end of the file.
 *
 * Deliberately not the whole file: identity is consulted on every scan, and
 * hashing a whole library would be hours of IO. A window from each end plus
 * the exact size distinguishes real media files cheaply — two different
 * encodes share neither their header nor their trailing index.
 */
export const HASH_WINDOW_BYTES = 65_536;

const digest = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

export const partialHashFile = async (path: string): Promise<PartialHashParts> => {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (cause) {
    throw new Error(`Cannot hash ${path}: ${(cause as Error).message}`, { cause });
  }

  const handle = await open(path, 'r');
  try {
    const window = Math.min(HASH_WINDOW_BYTES, size);
    const head = Buffer.alloc(window);
    if (window > 0) await handle.read(head, 0, window, 0);

    // For a file at or below one window, head and tail cover the same bytes.
    // That is correct rather than wasteful: the pair still identifies it.
    const tail = Buffer.alloc(window);
    if (window > 0) await handle.read(tail, 0, window, Math.max(0, size - window));

    return { sizeBytes: size, headHex: digest(head), tailHex: digest(tail) };
  } finally {
    await handle.close();
  }
};

/**
 * `fs.stat` reports `dev`/`ino` as numbers here; large inode values would lose
 * precision as doubles, so identity keys are built from their string forms in
 * `@trawlarr/core`.
 */
export const identityFromStat = (input: {
  stat: Stats;
  hash: PartialHashParts;
}): IdentityCandidate =>
  buildIdentityCandidate({
    deviceId: input.stat.dev,
    inode: input.stat.ino,
    hash: input.hash,
  });
