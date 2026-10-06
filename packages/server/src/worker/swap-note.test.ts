import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSwapNote, readSwapNote, swapNotePath } from './swap-note.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const dataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-swap-note-'));
  dirs.push(dir);
  return dir;
};

describe('swap note', () => {
  it('is written under the data directory, carries one number and no path, and ends cleanly', async () => {
    const dir = dataDir();
    const path = swapNotePath({ dataDir: dir, jobId: 'job-1' });
    const note = createSwapNote(path);

    await note.begin({ trashNowMs: 1234 });

    expect(path.startsWith(dir)).toBe(true);
    expect(await readSwapNote(path)).toEqual({ trashNowMs: 1234 });
    expect(readdirSync(join(dir, 'swaps'))).toEqual(['job-1.json']);

    await note.end();
    expect(existsSync(path)).toBe(false);
    await note.end(); // ending twice is harmless
  });

  it('refuses a note that is not exactly an integer timestamp', async () => {
    const dir = dataDir();
    const path = swapNotePath({ dataDir: dir, jobId: 'job-2' });
    await createSwapNote(path).begin({ trashNowMs: 1 });

    for (const body of ['{', '[]', '{"trashNowMs":"1"}', '{"trashNowMs":1.5}', 'x'.repeat(5000)]) {
      writeFileSync(path, body);
      expect('error' in (await readSwapNote(path))).toBe(true);
    }
  });
});
