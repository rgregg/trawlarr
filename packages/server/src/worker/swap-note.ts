import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SwapNote } from '@trawlarr/engine';

/**
 * Swap notes live under the daemon's OWN data directory, one per job, named by
 * job id: `<dataDir>/swaps/<jobId>.json`.
 *
 * Never beside the media. A library directory can be written by anyone with
 * access to the share, and an earlier design that kept the note there let a
 * planted file name paths for a recovery to move files between. The note now
 * holds one integer (the timestamp the original's trash name was built from)
 * and the recovery derives every PATH from its own database: the job id gives
 * the file row, the row gives the original's path and its library, the library
 * gives its trash directory.
 */
export const swapNotePath = (input: { dataDir: string; jobId: string }): string =>
  join(input.dataDir, 'swaps', `${input.jobId}.json`);

export const swapNotesDir = (dataDir: string): string => join(dataDir, 'swaps');

const MAX_NOTE_BYTES = 1024;

/** The engine's seam, writing the note atomically so a kill never leaves half of one. */
export const createSwapNote = (path: string): SwapNote => ({
  begin: async ({ trashNowMs }) => {
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    await writeFile(partial, JSON.stringify({ trashNowMs }));
    await rename(partial, path);
  },
  end: async () => {
    await unlink(path).catch(() => {});
  },
});

/** The note's one number, or a reason it cannot be trusted. */
export const readSwapNote = async (
  path: string,
): Promise<{ trashNowMs: number } | { error: string }> => {
  try {
    const stats = await stat(path);
    if (!stats.isFile() || stats.size > MAX_NOTE_BYTES) return { error: 'not a small file' };
    const value = JSON.parse(await readFile(path, 'utf8')) as { trashNowMs?: unknown };
    if (typeof value !== 'object' || value === null || !Number.isSafeInteger(value.trashNowMs)) {
      return { error: 'trashNowMs is missing or not an integer' };
    }
    return { trashNowMs: value.trashNowMs as number };
  } catch (error) {
    return { error: `unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
};
