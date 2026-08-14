import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HASH_WINDOW_BYTES, partialHashFile } from './partial-hash.js';

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
