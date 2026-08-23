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

/**
 * The subset of `FileHandle.read` this module depends on, extracted so tests
 * can inject a reader that deliberately returns short reads.
 */
export type ReadFn = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number }>;

/**
 * Fills a `size`-byte buffer starting at `position` in the source, looping
 * over the given `read` until the buffer is full or EOF is reached.
 *
 * A single `read` call is not guaranteed to fill the requested length —
 * interrupted syscalls and network filesystems (NFS/SMB, a realistic
 * deployment target for a library scanner) can return fewer bytes than
 * asked for. Because `Buffer.alloc` pre-zeros memory, failing to loop would
 * silently leave the unfilled remainder as zeros: the digest for identical
 * content could vary between calls (producing duplicate identities for the
 * same file), and a genuinely short tail read could zero-pad into a
 * collision with an unrelated file. Looping and returning only the bytes
 * actually read avoids both.
 */
export const readWindow = async (read: ReadFn, size: number, position: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(size);
  let readSoFar = 0;
  while (readSoFar < size) {
    const { bytesRead } = await read(buffer, readSoFar, size - readSoFar, position + readSoFar);
    if (bytesRead === 0) break; // EOF before the window was filled.
    readSoFar += bytesRead;
  }
  return buffer.subarray(0, readSoFar);
};

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
    const read: ReadFn = (buffer, offset, length, position) =>
      handle.read(buffer, offset, length, position);

    const head = window > 0 ? await readWindow(read, window, 0) : Buffer.alloc(0);

    // For a file at or below one window, head and tail cover the same bytes.
    // That is correct rather than wasteful: the pair still identifies it.
    const tail =
      window > 0 ? await readWindow(read, window, Math.max(0, size - window)) : Buffer.alloc(0);

    return { sizeBytes: size, headHex: digest(head), tailHex: digest(tail) };
  } finally {
    // CLOSING IS CLEANUP, AND CLEANUP DOES NOT GET TO DECIDE THE ANSWER. An
    // `await handle.close()` here would sit in a `finally` wrapping the
    // `return`, so a close that rejects (EIO on a network mount is the
    // realistic one) discards a hash that was computed perfectly well. That
    // is not a cosmetic loss: `runPayload` reads the replaced file's hash
    // inside a `catch` that treats a throw as "that path is gone", so a
    // failed close on the file a run just installed would make the run
    // report that it replaced NOTHING — the row keeps the pre-transcode
    // identity while the disk carries the post-transcode one, which is the
    // stale-identity ghost row this hash exists to prevent. The descriptor
    // is released with the process in the worst case; the identity cannot
    // be recomputed once it has been thrown away.
    await handle.close().catch(() => {});
  }
};

/**
 * `fs.stat` (non-bigint form) reports `dev`/`ino` as JS numbers, which lose
 * precision above `Number.MAX_SAFE_INTEGER`. That narrowing happens before
 * this function ever sees the values — building the identity key from their
 * string form afterward cannot recover precision already lost. The actual
 * mitigation would be reading stats with `{ bigint: true }` and threading
 * bigint device/inode through to `buildIdentityCandidate`; that is not wired
 * up here.
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
