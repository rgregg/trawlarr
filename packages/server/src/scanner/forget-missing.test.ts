import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { identityFromStat, partialHashFile } from '../fs/partial-hash.js';
import { forgetMissing } from './forget-missing.js';

/**
 * Forgetting a missing row: the only operation in this system that discards
 * history, so its refusals matter more than its deletions.
 */

const NOW = 1_700_000_000_000;

const dirs: string[] = [];
let db: Db;
let root: string;
let library: LibraryRecord;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trawlarr-forget-'));
  dirs.push(root);
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  library = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv'],
    nowMs: NOW,
  });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Upsert whatever is at `path` the way a scan would. */
const upsert = async (path: string): Promise<string> => {
  const stat = statSync(path);
  const fileId = createMediaFileRepo(db).upsertScanned({
    libraryId: library.id,
    identity: identityFromStat({ stat, hash: await partialHashFile(path) }),
    path,
    nlink: stat.nlink,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    container: 'mkv',
    nowMs: NOW,
  });
  return fileId;
};

/** Track a real file the way a scan would, and give it a job row. */
const track = async (path: string, contents: string): Promise<string> => {
  writeFileSync(path, contents);
  const fileId = await upsert(path);
  createJobRepo(db).start({ fileId, flowId: 'flow', flowHash: 'hash', nowMs: NOW });
  return fileId;
};

const markMissing = (fileId: string, path: string): void => {
  createMediaFileRepo(db).markMissing({ fileId, expectPath: path, nowMs: NOW });
};

const jobCount = (fileId: string): number => createJobRepo(db).listForFile(fileId).length;

const forget = (over: Parameters<typeof forgetMissing>[0] extends never ? never : object = {}) =>
  forgetMissing({ db, library, ...over });

describe('forgetMissing', () => {
  it('discards a confirmed-missing row and the job history hanging off it', async () => {
    const path = join(root, 'gone.mkv');
    const fileId = await track(path, 'gone');
    expect(jobCount(fileId)).toBe(1);
    unlinkSync(path);
    markMissing(fileId, path);

    const summary = await forget();

    expect(summary.forgotten).toBe(1);
    expect(createMediaFileRepo(db).getById(fileId)).toBeNull();
    // The job rows go with it — that is the point of saying so out loud.
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM job WHERE file_id = ?').get(fileId) as { c: number })
        .c,
    ).toBe(0);
    expect(summary.files[0]?.jobCount).toBe(1);
  });

  it('forgets a row whose path is now occupied by a DIFFERENT file, leaving that file alone', async () => {
    const path = join(root, 'm2.mkv');
    const oldId = await track(path, 'the old rip');
    // A better rip lands at the same path: different bytes, so it is
    // correctly a different row. Created as a sibling BEFORE the old file
    // is deleted and renamed into place afterwards — a file created at a
    // just-freed path gets the freed inode straight back from tmpfs, and
    // would be matched onto the very row this test needs it to rival.
    const arriving = join(root, 'incoming.mkv');
    const newId = await track(arriving, 'the better rip');
    expect(newId).not.toBe(oldId);

    unlinkSync(path);
    markMissing(oldId, path);
    renameSync(arriving, path);
    expect(await upsert(path)).toBe(newId);

    const summary = await forget();

    expect(summary.forgotten).toBe(1);
    expect(createMediaFileRepo(db).getById(oldId)).toBeNull();
    expect(createMediaFileRepo(db).getById(newId)?.path).toBe(path);
  });

  it('refuses a row whose own file is back, and clears its mark instead', async () => {
    const path = join(root, 'back.mkv');
    const fileId = await track(path, 'same bytes');
    markMissing(fileId, path); // marked, but the file is right there

    const summary = await forget();

    expect(summary.forgotten).toBe(0);
    expect(summary.restored).toBe(1);
    expect(createMediaFileRepo(db).getById(fileId)?.missing_since_ms).toBeNull();
  });

  it('never touches a row that is not marked missing', async () => {
    const path = join(root, 'present.mkv');
    const fileId = await track(path, 'here');
    unlinkSync(path); // gone from disk, but no scan has confirmed it

    const summary = await forget();

    expect(summary.forgotten).toBe(0);
    expect(createMediaFileRepo(db).getById(fileId)).not.toBeNull();
  });

  it('leaves a terminal row for inspection unless it is asked for explicitly', async () => {
    const path = join(root, 'failed.mkv');
    const fileId = await track(path, 'failed');
    const repo = createMediaFileRepo(db);
    repo.setState({ fileId, state: 'failed' });
    unlinkSync(path);
    markMissing(fileId, path);

    const kept = await forget();
    expect(kept.forgotten).toBe(0);
    expect(kept.keptTerminal).toBe(1);
    expect(repo.getById(fileId)).not.toBeNull();

    // Named explicitly, it goes.
    const taken = await forgetMissing({ db, library, fileIds: [fileId] });
    expect(taken.forgotten).toBe(1);
    expect(repo.getById(fileId)).toBeNull();
  });

  it('refuses a row whose path cannot be examined at all', async () => {
    const sub = join(root, 'sub');
    mkdirSync(sub);
    const path = join(sub, 'unreadable.mkv');
    const fileId = await track(path, 'x');
    unlinkSync(path);
    markMissing(fileId, path);
    chmodSync(sub, 0o000);

    try {
      const summary = await forget();
      expect(summary.forgotten).toBe(0);
      expect(summary.unconfirmed).toBe(1);
      expect(createMediaFileRepo(db).getById(fileId)).not.toBeNull();
    } finally {
      chmodSync(sub, 0o755);
    }
  });

  it('changes nothing under dryRun', async () => {
    const path = join(root, 'gone.mkv');
    const fileId = await track(path, 'gone');
    unlinkSync(path);
    markMissing(fileId, path);

    const summary = await forgetMissing({ db, library, dryRun: true });

    expect(summary.forgotten).toBe(1);
    expect(createMediaFileRepo(db).getById(fileId)).not.toBeNull();
    expect(jobCount(fileId)).toBe(1);
  });
});
