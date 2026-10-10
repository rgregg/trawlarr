import {
  existsSync,
  lstatSync,
  lutimesSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { identityFromStat, partialHashFile } from '../fs/partial-hash.js';
import { scanLibrary } from '../scanner/scan-library.js';
import { sweepWorkingFiles } from './working-file-sweep.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const dirs: string[] = [];
let db: Db;
let root: string;
let library: LibraryRecord;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trawlarr-working-sweep-'));
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch file whose last write was `ageMs` before NOW. */
const scratch = (dir: string, name: string, ageMs: number, body = 'partial'): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  const when = new Date(NOW - ageMs);
  utimesSync(path, when, when);
  return path;
};

/** Track a real media file the way a scan would, with a job row left open or closed. */
const trackWithJob = async (path: string, open: boolean): Promise<string> => {
  writeFileSync(path, 'media');
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
  const jobs = createJobRepo(db);
  const job = jobs.start({ fileId, flowId: 'flow', flowHash: 'hash', nowMs: NOW });
  if (!open) jobs.finish({ jobId: job, state: 'failed', outcome: 'x', nowMs: NOW });
  return fileId;
};

const sweep = (files: string[]) =>
  sweepWorkingFiles({ db, libraryId: library.id, files, roots: [root], nowMs: NOW });

describe('sweepWorkingFiles', () => {
  it('removes an old orphan no job could own', async () => {
    const orphan = scratch(root, '.trawlarr-replace-abc.mkv', 2 * DAY_MS);
    const reserve = scratch(root, '.trawlarr-reserve-movie.mkv', 2 * DAY_MS, '');

    const summary = await sweep([orphan, reserve]);

    expect(summary.removed).toBe(2);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(reserve)).toBe(false);
  });

  it('keeps an orphan that is too young', async () => {
    const young = scratch(root, '.trawlarr-replace-abc.mkv', 60 * 60 * 1000);

    const summary = await sweep([young]);

    expect(summary.removed).toBe(0);
    expect(summary.retained).toBe(1);
    expect(existsSync(young)).toBe(true);
  });

  it('keeps an old file in the directory of a running job, whatever its age', async () => {
    const dir = join(root, 'Movie (2019)');
    mkdirSync(dir);
    await trackWithJob(join(dir, 'Movie (2019).mkv'), true);
    const old = scratch(dir, '.trawlarr-replace-abc.mkv', 30 * DAY_MS);

    const summary = await sweep([old]);

    expect(summary.removed).toBe(0);
    expect(existsSync(old)).toBe(true);
  });

  it('keeps an old file beside a row claimed running that has no job row yet', async () => {
    const dir = join(root, 'Claimed');
    mkdirSync(dir);
    const fileId = await trackWithJob(join(dir, 'Claimed.mkv'), false);
    db.prepare(`UPDATE media_file SET state = 'running' WHERE id = ?`).run(fileId);
    const old = scratch(dir, '.trawlarr-replace-abc.mkv', 30 * DAY_MS);

    await sweep([old]);

    expect(existsSync(old)).toBe(true);
  });

  it('removes an old orphan once the job that owned the directory has ended', async () => {
    const dir = join(root, 'Done');
    mkdirSync(dir);
    await trackWithJob(join(dir, 'Done.mkv'), false);
    const old = scratch(dir, '.trawlarr-replace-abc.mkv', 2 * DAY_MS);

    await sweep([old]);

    expect(existsSync(old)).toBe(false);
  });

  it('leaves other .trawlarr- names alone', async () => {
    const other = scratch(root, '.trawlarr-notes.txt', 30 * DAY_MS);

    const summary = await sweep([other]);

    expect(summary.examined).toBe(0);
    expect(existsSync(other)).toBe(true);
  });
});

describe('scanLibrary', () => {
  it('sweeps orphans it walks past, and never tracks them', async () => {
    const movie = join(root, 'Movie.mkv');
    writeFileSync(movie, 'media');
    const orphan = scratch(root, '.trawlarr-replace-dead.mkv', 3 * DAY_MS);

    const summary = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: () => NOW,
      probeFileImpl: async () => ({ format: {}, streams: [] }) as never,
    });

    expect(summary.seen).toBe(1);
    expect(summary.workingFilesRemoved).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(movie)).toBe(true);
  });
});

describe('sweepWorkingFiles never acts outside what it owns', () => {
  it('ignores a candidate outside the library roots, whatever its name or age', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'trawlarr-elsewhere-'));
    dirs.push(elsewhere);
    const foreign = scratch(elsewhere, '.trawlarr-replace-abc.mkv', 30 * DAY_MS);

    const summary = await sweep([foreign]);

    expect(summary.removed).toBe(0);
    expect(existsSync(foreign)).toBe(true);
  });

  it('does not follow a symlinked directory out of the root', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'trawlarr-elsewhere-'));
    dirs.push(elsewhere);
    const victim = scratch(elsewhere, '.trawlarr-replace-abc.mkv', 30 * DAY_MS);
    symlinkSync(elsewhere, join(root, 'escape'));

    const summary = await sweep([join(root, 'escape', '.trawlarr-replace-abc.mkv')]);

    expect(summary.removed).toBe(0);
    expect(existsSync(victim)).toBe(true);
  });

  it('never removes a name that is not scratch, even when listed', async () => {
    const media = join(root, 'Movie.mkv');
    writeFileSync(media, 'media');
    const old = new Date(NOW - 30 * DAY_MS);
    utimesSync(media, old, old);
    const dotfile = scratch(root, '.trawlarr-notes.txt', 30 * DAY_MS);
    const relative = '.trawlarr-replace-abc.mkv';

    const summary = await sweep([
      media,
      dotfile,
      relative,
      join(root, '..', basename(root), 'Movie.mkv'),
    ]);

    expect(summary.removed).toBe(0);
    expect(existsSync(media)).toBe(true);
    expect(existsSync(dotfile)).toBe(true);
  });

  it('removes a symlink named like scratch never, and its target never', async () => {
    const target = join(root, 'Movie.mkv');
    writeFileSync(target, 'media');
    const link = join(root, '.trawlarr-replace-link.mkv');
    symlinkSync(target, link);
    const old = new Date(NOW - 30 * DAY_MS);
    lutimesSync(link, old, old);

    await sweep([link]);

    expect(existsSync(target)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
