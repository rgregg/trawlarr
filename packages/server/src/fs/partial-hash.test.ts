import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HASH_WINDOW_BYTES, partialHashFile, readWindow, type ReadFn } from './partial-hash.js';

const write = (name: string, contents: Buffer | string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-hash-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
};

const filled = (size: number, byte: number): Buffer => Buffer.alloc(size, byte);

describe('partialHashFile', () => {
  it('reports the exact size alongside the digests', async () => {
    const parts = await partialHashFile(write('a.bin', filled(1000, 1)));
    expect(parts.sizeBytes).toBe(1000);
    expect(parts.headHex).toHaveLength(64);
    expect(parts.tailHex).toHaveLength(64);
  });

  it('is stable for identical content', async () => {
    const a = await partialHashFile(write('a.bin', filled(5000, 7)));
    const b = await partialHashFile(write('b.bin', filled(5000, 7)));
    expect(a).toEqual(b);
  });

  it('differs when the head differs', async () => {
    const base = filled(200_000, 0);
    const changed = Buffer.from(base);
    changed[0] = 255;
    const a = await partialHashFile(write('a.bin', base));
    const b = await partialHashFile(write('b.bin', changed));
    expect(a.headHex).not.toBe(b.headHex);
  });

  it('differs when the tail differs', async () => {
    // The interesting case: a file whose only change is far past the head
    // window. A head-only hash would call these identical.
    const base = filled(200_000, 0);
    const changed = Buffer.from(base);
    changed[changed.length - 1] = 255;
    const a = await partialHashFile(write('a.bin', base));
    const b = await partialHashFile(write('b.bin', changed));
    expect(a.headHex).toBe(b.headHex);
    expect(a.tailHex).not.toBe(b.tailHex);
  });

  it('handles a file smaller than the window without reading past its end', async () => {
    const parts = await partialHashFile(write('small.bin', filled(10, 3)));
    expect(parts.sizeBytes).toBe(10);
    expect(parts.headHex).toHaveLength(64);
    expect(parts.tailHex).toHaveLength(64);
  });

  it('handles an empty file', async () => {
    const parts = await partialHashFile(write('empty.bin', Buffer.alloc(0)));
    expect(parts.sizeBytes).toBe(0);
    expect(parts.headHex).toHaveLength(64);
  });

  it('exposes the window size it reads', () => {
    expect(HASH_WINDOW_BYTES).toBe(65536);
  });

  it('rejects a path that does not exist, naming it', async () => {
    await expect(partialHashFile('/nope/missing.bin')).rejects.toThrow(/missing\.bin/);
  });
});

describe('readWindow', () => {
  // A reader that never fills more than `chunkLimit` bytes per call, to
  // simulate interrupted syscalls / network filesystems that hand back
  // fewer bytes than requested.
  const shortReadingReaderFor = (content: Buffer, chunkLimit: number): ReadFn => {
    return async (buffer, offset, length, position) => {
      const remaining = content.length - position;
      if (remaining <= 0) return { bytesRead: 0 };
      const n = Math.min(chunkLimit, length, remaining);
      content.copy(buffer, offset, position, position + n);
      return { bytesRead: n };
    };
  };

  it('assembles the full window across many short reads', async () => {
    const content = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(200));
    const result = await readWindow(shortReadingReaderFor(content, 3), content.length, 0);
    expect(result).toEqual(content);
  });

  it('produces the same digest whether the source reads in one call or many short ones', async () => {
    const content = Buffer.alloc(10_000, 42);
    const fullRead = await readWindow(shortReadingReaderFor(content, content.length), 10_000, 0);
    const chunkyRead = await readWindow(shortReadingReaderFor(content, 7), 10_000, 0);

    const digestOf = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    expect(digestOf(chunkyRead)).toBe(digestOf(fullRead));
  });

  it('stops at EOF without zero-padding when the source is shorter than the requested window', async () => {
    const content = Buffer.from('short');
    const result = await readWindow(shortReadingReaderFor(content, 2), 100, 0);
    // Not zero-padded to 100 bytes -- only the 5 real bytes came back.
    expect(result).toEqual(content);
    expect(result).toHaveLength(5);
  });

  it('reads starting at the given position', async () => {
    const content = Buffer.from('0123456789');
    const result = await readWindow(shortReadingReaderFor(content, 2), 4, 6);
    expect(result).toEqual(Buffer.from('6789'));
  });
});
