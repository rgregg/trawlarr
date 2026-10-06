import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { identityFromStat, partialHashFile } from '../fs/partial-hash.js';
import { swapNotePath } from '../worker/swap-note.js';
import { recoverInterruptedSwaps } from './swap-recovery.js';

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Stranded {
  db: Db;
  dataDir: string;
  base: string;
  root: string;
  dir: string;
  original: string;
  trashDir: string;
  trashed: string;
  library: LibraryRecord;
  jobId: string;
  fileId: string;
  notePath: string;
}

/**
 * The state a worker killed between "original moved to trash" and "replacement
 * installed" leaves: the library path empty, the original in trash under the
 * name the swap gave it, the job ended (as the reaper closes it), and a note in
 * the daemon's data directory.
 */
const stranded = async (options?: {
  trashDir?: string | null;
  open?: boolean;
}): Promise<Stranded> => {
  const base = mkdtempSync(join(tmpdir(), 'trawlarr-swap-recovery-'));
  dirs.push(base);
  const root = join(base, 'library');
  const dataDir = join(base, 'config');
  const dir = join(root, 'Film');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dataDir);
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  const library = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv', 'mp4'],
    trashDir: options?.trashDir ?? null,
    nowMs: NOW,
  });
  const original = join(dir, 'Film.mkv');
  writeFileSync(original, 'the original');
  const stat = statSync(original);
  const files = createMediaFileRepo(db);
  const fileId = files.upsertScanned({
    libraryId: library.id,
    identity: identityFromStat({ stat, hash: await partialHashFile(original) }),
    path: original,
    nlink: 1,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    container: 'mkv',
    nowMs: NOW,
  });
  const jobs = createJobRepo(db);
  const jobId = jobs.start({ fileId, flowId: 'flow', flowHash: 'hash', nowMs: NOW });
  if (options?.open !== true) jobs.finish({ jobId, state: 'failed', outcome: 'x', nowMs: NOW });

  const trashDir = options?.trashDir ?? join(root, '.trawlarr', 'trash');
  mkdirSync(trashDir, { recursive: true });
  const trashed = join(trashDir, `Film.${String(NOW)}.mkv`);
  linkSync(original, trashed);
  rmSync(original);

  const notePath = swapNotePath({ dataDir, jobId });
  mkdirSync(join(dataDir, 'swaps'), { recursive: true });
  writeFileSync(notePath, JSON.stringify({ trashNowMs: NOW }));
  return {
    db,
    dataDir,
    base,
    root,
    dir,
    original,
    trashDir,
    trashed,
    library,
    jobId,
    fileId,
    notePath,
  };
};

const recover = (s: Stranded, extra?: { beforeUse?: () => Promise<void> }) => {
  const events: string[] = [];
  const done = recoverInterruptedSwaps({
    db: s.db,
    dataDir: s.dataDir,
    onEvent: (message) => events.push(message),
    ...extra,
  });
  return { done, events };
};

describe('recoverInterruptedSwaps', () => {
  it('puts the original back from the library trash, byte for byte', async () => {
    const s = await stranded();

    const summary = await recover(s).done;

    expect(summary.restored).toBe(1);
    expect(readFileSync(s.original, 'utf8')).toBe('the original');
    expect(existsSync(s.trashed)).toBe(false);
    expect(statSync(s.original).nlink).toBe(1);
    expect(existsSync(s.notePath)).toBe(false);
  });

  it('uses the library configured trash directory, not whatever else holds a matching name', async () => {
    const configured = mkdtempSync(join(tmpdir(), 'trawlarr-configured-trash-'));
    dirs.push(configured);
    const s = await stranded({ trashDir: configured });
    // A decoy with the right name in the DEFAULT trash location.
    const decoyDir = join(s.root, '.trawlarr', 'trash');
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(join(decoyDir, `Film.${String(NOW)}.mkv`), 'decoy');

    await recover(s).done;

    expect(readFileSync(s.original, 'utf8')).toBe('the original');
  });

  it('is not steered by anything planted in the library tree', async () => {
    const s = await stranded();
    const victim = join(s.base, 'victim.mkv');
    // Files a writer on the share could drop beside the media: the old
    // note format, naming paths, and a decoy trash entry with the right name
    // but the wrong identity. None of it is read.
    writeFileSync(
      join(s.dir, '.trawlarr-swap-1.json'),
      JSON.stringify({ version: 1, originalPath: victim, finalPath: victim, trashDir: s.dir }),
    );
    // Keep the real inode alive elsewhere so the decoy cannot be handed its number.
    linkSync(s.trashed, join(s.base, 'kept-alive.mkv'));
    rmSync(s.trashed);
    writeFileSync(s.trashed, 'a different file with the right name');

    const { done, events } = recover(s);
    const summary = await done;

    expect(summary.restored).toBe(0);
    expect(summary.refused).toBe(1);
    expect(existsSync(victim)).toBe(false);
    expect(existsSync(s.original)).toBe(false);
    expect(readFileSync(s.trashed, 'utf8')).toBe('a different file with the right name');
    expect(existsSync(s.notePath)).toBe(true);
    expect(events.join('\n')).toMatch(/not in/);
  });

  it('leaves a job that has not ended alone', async () => {
    const s = await stranded({ open: true });

    const summary = await recover(s).done;

    expect(summary.retained).toBe(1);
    expect(existsSync(s.original)).toBe(false);
    expect(existsSync(s.trashed)).toBe(true);
  });

  it('only removes the note when the library path is occupied again', async () => {
    const s = await stranded();
    writeFileSync(s.original, 'someone else put this here');

    const summary = await recover(s).done;

    expect(summary.settled).toBe(1);
    expect(readFileSync(s.original, 'utf8')).toBe('someone else put this here');
    expect(existsSync(s.trashed)).toBe(true);
    expect(existsSync(s.notePath)).toBe(false);
  });

  it('never takes a sibling for the replacement: refuses, keeps the note, restores nothing', async () => {
    const s = await stranded();
    // Could be the replacement under a new container, a different title, or a
    // partial download: nothing recorded says which.
    writeFileSync(join(s.dir, 'Film.mp4'), 'something with the same stem');

    const { done, events } = recover(s);
    const summary = await done;

    expect(summary.refused).toBe(1);
    expect(summary.settled).toBe(0);
    expect(existsSync(s.notePath)).toBe(true);
    expect(existsSync(s.original)).toBe(false);
    expect(existsSync(s.trashed)).toBe(true);
    expect(events.join('\n')).toMatch(/cannot be established/);
  });

  it('does not settle on a directory at the original path', async () => {
    const s = await stranded();
    mkdirSync(s.original);

    const summary = await recover(s).done;

    expect(summary.refused).toBe(1);
    expect(summary.settled).toBe(0);
    expect(existsSync(s.notePath)).toBe(true);
    expect(existsSync(s.trashed)).toBe(true);
  });

  it('does not settle on a symlink at the original path', async () => {
    const s = await stranded();
    symlinkSync(join(s.base, 'nowhere'), s.original);

    const summary = await recover(s).done;

    expect(summary.refused).toBe(1);
    expect(existsSync(s.notePath)).toBe(true);
  });

  it('restores for a job that ended any way at all: failed, cancelled or reaped', async () => {
    for (const state of ['failed', 'cancelled', 'succeeded'] as const) {
      const s = await stranded();
      createJobRepo(s.db).finish({ jobId: s.jobId, state, outcome: state, nowMs: NOW + 1 });

      const summary = await recover(s).done;

      expect(summary.restored).toBe(1);
      expect(readFileSync(s.original, 'utf8')).toBe('the original');
    }
  });

  it('leaves it alone when the file has since been claimed again by a live job', async () => {
    const s = await stranded();
    createJobRepo(s.db).start({ fileId: s.fileId, flowId: 'flow', flowHash: 'hash', nowMs: NOW });

    const summary = await recover(s).done;

    expect(summary.retained).toBe(1);
    expect(existsSync(s.original)).toBe(false);
    expect(existsSync(s.trashed)).toBe(true);
    expect(existsSync(s.notePath)).toBe(true);
  });

  it('leaves it alone when the row is claimed running, whatever its job rows say', async () => {
    const s = await stranded();
    s.db.prepare(`UPDATE media_file SET state = 'running' WHERE id = ?`).run(s.fileId);

    const summary = await recover(s).done;

    expect(summary.retained).toBe(1);
    expect(existsSync(s.original)).toBe(false);
  });

  it('leaves a remote job that still holds its lease alone', async () => {
    const s = await stranded({ open: true });
    s.db
      .prepare(`UPDATE job SET lease_state = 'held' WHERE id = ?`)
      .run(s.jobId);

    const summary = await recover(s).done;

    expect(summary.retained).toBe(1);
    expect(existsSync(s.original)).toBe(false);
  });

  it('clears the missing mark a scan left in the empty window, and keeps the row describing the original', async () => {
    const s = await stranded();
    createMediaFileRepo(s.db).markMissing({
      fileId: s.fileId,
      expectPath: s.original,
      nowMs: NOW + 5,
    });
    const before = createMediaFileRepo(s.db).getById(s.fileId)!;

    await recover(s).done;

    const after = createMediaFileRepo(s.db).getById(s.fileId)!;
    expect(after.missing_since_ms).toBeNull();
    expect(after.inode_key).toBe(before.inode_key);
    expect(after.content_key).toBe(before.content_key);
    expect(after.path).toBe(s.original);
    expect(`${String(statSync(s.original).dev)}:${String(statSync(s.original).ino)}`).toBe(
      after.inode_key,
    );
  });

  it('refuses, keeping the note, when the original is no longer in trash', async () => {
    const s = await stranded();
    rmSync(s.trashed);

    const summary = await recover(s).done;

    expect(summary.refused).toBe(1);
    expect(existsSync(s.notePath)).toBe(true);
  });

  it('refuses a file row whose path is outside the library roots', async () => {
    const s = await stranded();
    const outside = join(s.base, 'elsewhere');
    mkdirSync(outside);
    s.db
      .prepare(`UPDATE media_file SET path = ? WHERE id = ?`)
      .run(join(outside, 'Film.mkv'), s.fileId);

    const summary = await recover(s).done;

    expect(summary.refused).toBe(1);
    expect(existsSync(join(outside, 'Film.mkv'))).toBe(false);
  });

  it('refuses a malformed note and a note for a job it has never heard of', async () => {
    const s = await stranded();
    writeFileSync(s.notePath, '{nope');
    writeFileSync(join(s.dataDir, 'swaps', 'no-such-job.json'), JSON.stringify({ trashNowMs: 1 }));

    const summary = await recover(s).done;

    expect(summary.refused).toBe(2);
    expect(existsSync(s.original)).toBe(false);
    expect(existsSync(s.trashed)).toBe(true);
  });

  it('refuses when the trash entry is swapped for a symlink between check and use', async () => {
    const s = await stranded();
    const secret = join(s.base, 'secret.mkv');
    writeFileSync(secret, 'not yours');

    const { done } = recover(s, {
      beforeUse: async () => {
        rmSync(s.trashed);
        symlinkSync(secret, s.trashed);
      },
    });
    const summary = await done;

    expect(summary.restored).toBe(0);
    expect(summary.refused).toBe(1);
    expect(existsSync(s.original)).toBe(false);
    expect(readFileSync(secret, 'utf8')).toBe('not yours');
  });

  it('refuses when the library directory is swapped for a symlink out of the root', async () => {
    const s = await stranded();
    const outside = join(s.base, 'elsewhere');
    mkdirSync(outside);

    const { done } = recover(s, {
      beforeUse: async () => {
        renameSync(s.dir, join(s.root, 'Film.moved'));
        symlinkSync(outside, s.dir);
      },
    });
    const summary = await done;

    expect(summary.restored).toBe(0);
    expect(summary.refused).toBe(1);
    expect(existsSync(join(outside, 'Film.mkv'))).toBe(false);
  });

  it('refuses a library directory that is itself a symlink out of the root', async () => {
    const s = await stranded();
    const outside = join(s.base, 'elsewhere');
    mkdirSync(outside);
    const linkDir = join(s.root, 'Linked');
    symlinkSync(outside, linkDir);
    s.db
      .prepare(`UPDATE media_file SET path = ? WHERE id = ?`)
      .run(join(linkDir, 'Film.mkv'), s.fileId);

    const summary = await recover(s).done;

    expect(summary.refused).toBe(1);
    expect(existsSync(join(outside, 'Film.mkv'))).toBe(false);
  });
});
