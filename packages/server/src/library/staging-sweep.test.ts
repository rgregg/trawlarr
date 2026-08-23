import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createJobRepo } from '../db/job-repo.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { DEFAULT_STAGING_STALE_AFTER_MS, sweepStaging } from './staging-sweep.js';
import { workDirPrefix } from './staging-dir.js';

/**
 * The staging sweeper, and the one thing it must never do.
 *
 * A worker killed mid-encode — the OOM killer, a segfault, the host losing
 * power — never reaches `runPayload`'s own cleanup, so its partial encode
 * stays in the library's staging directory. That directory is on the MEDIA
 * filesystem by design (installing the result has to be an atomic rename),
 * so nothing reclaiming those is the user's own disk filling with files
 * nobody will ever look at again. There was no sweeper in this tree at all.
 *
 * The danger is the opposite one: deleting the scratch directory of a run
 * that is still going takes the encode out from under a live ffmpeg. Every
 * test below is about which of the two happened, asserted on the filesystem.
 * Real directories, real files, real mtimes; the only injected value is the
 * clock, so nothing waits for time to pass.
 */

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

let db: Db;
let root: string;
let staging: string;
let library: LibraryRecord;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  root = mkdtempSync(join(tmpdir(), 'trawlarr-staging-'));
  staging = join(root, '.trawlarr', 'staging');
  mkdirSync(staging, { recursive: true });
  library = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv'],
    nowMs: NOW,
  });
});

let fileSeq = 0;

/** A job row on a real media_file row; only its id and `ended_at` matter here. */
const job = (input: { endedAtMs: number | null }): string => {
  fileSeq += 1;
  const fileId = `file-${String(fileSeq)}`;
  db.prepare(
    `INSERT INTO media_file (id, library_id, content_key, path, nlink, size_bytes, mtime_ms,
                             ctime_ms, container, state, discovered_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, 'mkv', 'running', ?, ?)`,
  ).run(fileId, library.id, `content-${fileId}`, `/media/${fileId}.mkv`, NOW, NOW, NOW, NOW);
  const repo = createJobRepo(db);
  const jobId = repo.start({
    fileId,
    flowId: 'flow',
    flowHash: 'hash',
    nowMs: NOW - 48 * HOUR_MS,
  });
  if (input.endedAtMs !== null) {
    repo.finish({ jobId, state: 'succeeded', outcome: 'done', nowMs: input.endedAtMs });
  }
  return jobId;
};

/** A scratch directory with one file in it, named exactly as `runPayload` names one. */
const scratchDir = (input: { jobId: string | null; contents?: number; mtimeMs?: number }) => {
  const name =
    input.jobId === null
      ? // A name from a build that predates job ids in the name: prefix, six
        // random characters, nothing to look up.
        'trawlarr-job-nNk0ey'
      : `${workDirPrefix(input.jobId)}xt4c8e`;
  const dir = join(staging, name);
  mkdirSync(dir);
  const file = join(dir, 'encode.mkv');
  writeFileSync(file, Buffer.alloc(input.contents ?? 1024));
  if (input.mtimeMs !== undefined) {
    const at = new Date(input.mtimeMs);
    utimesSync(file, at, at);
    utimesSync(dir, at, at);
  }
  return { name, dir, file };
};

const namesIn = (dir: string): string[] => readdirSync(dir).sort();

describe('sweepStaging', () => {
  it('never removes the scratch directory of a run whose job row is still open', async () => {
    // THE SAFETY INVARIANT, and it is about identity rather than age: this
    // directory has not been modified for a week (a plausible thing for a
    // long Execute step, whose output file's mtime advances only while
    // ffmpeg writes and which a stalled mount can freeze entirely), and its
    // job row has not ended. Age is not consulted at all.
    const { dir } = scratchDir({ jobId: job({ endedAtMs: null }), mtimeMs: NOW - 168 * HOUR_MS });

    const summary = await sweepStaging({ db, library, nowMs: NOW });

    expect(summary.retained).toBe(1);
    expect(summary.removed).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('removes the scratch directory of a run whose job row has ended', async () => {
    // The leak this exists for. Its owner has reported, been reclaimed, or
    // been recorded as vanished — either way nothing can write here again.
    const { dir } = scratchDir({ jobId: job({ endedAtMs: NOW - 1000 }), contents: 4096 });

    const summary = await sweepStaging({ db, library, nowMs: NOW });

    expect(summary.removed).toBe(1);
    expect(summary.bytesFreed).toBe(4096);
    expect(existsSync(dir)).toBe(false);
    expect(namesIn(staging)).toEqual([]);
  });

  it("removes an ended run's directory the moment it is found, however recent", async () => {
    // No quarantine period, deliberately: waiting would be waiting for a
    // fact that is already known.
    const { dir } = scratchDir({ jobId: job({ endedAtMs: NOW }), mtimeMs: NOW });

    await sweepStaging({ db, library, nowMs: NOW });

    expect(existsSync(dir)).toBe(false);
  });

  it('falls back to age for a directory no job row claims, and measures it on the contents', async () => {
    // A legacy name, or a `trawlarr run` that had no job row. Age is all
    // there is — and it is taken from the FILES, because a directory's own
    // mtime stops moving the moment its entries are created while an encode
    // goes on writing into one of them for hours.
    const fresh = scratchDir({ jobId: null, mtimeMs: NOW - 2 * HOUR_MS });
    const summaryFresh = await sweepStaging({ db, library, nowMs: NOW });
    expect(summaryFresh.retained).toBe(1);
    expect(existsSync(fresh.dir)).toBe(true);

    const summaryStale = await sweepStaging({
      db,
      library,
      nowMs: NOW + DEFAULT_STAGING_STALE_AFTER_MS + 3 * HOUR_MS,
    });
    expect(summaryStale.removed).toBe(1);
    expect(existsSync(fresh.dir)).toBe(false);
  });

  it('keeps an unclaimed directory alive on a file that is still being written', async () => {
    // The directory itself is ancient — created three days ago and never
    // touched since — while the encode inside it was written to a minute
    // ago. Ageing on the directory alone would delete a live encode.
    const { dir, file } = scratchDir({ jobId: null, mtimeMs: NOW - 72 * HOUR_MS });
    const recent = new Date(NOW - 60_000);
    utimesSync(file, recent, recent);

    const summary = await sweepStaging({ db, library, nowMs: NOW });

    expect(summary.retained).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  it('leaves anything that is not a scratch directory completely alone', async () => {
    const stray = join(staging, 'something-a-user-put-here');
    mkdirSync(stray);
    const strayFile = join(staging, 'trawlarr-job-not-a-directory');
    writeFileSync(strayFile, 'a file, not a directory');
    scratchDir({ jobId: job({ endedAtMs: NOW - 1000 }) });

    const summary = await sweepStaging({ db, library, nowMs: NOW });

    expect(summary.removed).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(namesIn(staging)).toEqual(['something-a-user-put-here', 'trawlarr-job-not-a-directory']);
  });

  it('changes nothing under dryRun, but reports what it would take', async () => {
    const { dir } = scratchDir({ jobId: job({ endedAtMs: NOW - 1000 }), contents: 2048 });

    const summary = await sweepStaging({ db, library, nowMs: NOW, dryRun: true });

    expect(summary.removed).toBe(1);
    expect(summary.bytesFreed).toBe(2048);
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses a staging directory that contains a library root', async () => {
    // Same containment rule the trash sweep has, for the same reason:
    // sweeping there would be sweeping the library. `LibraryRepo` refuses to
    // STORE such a configuration, so this is defence in depth against a row
    // that reached the table another way — which is why the record is built
    // by hand here rather than through the repo that would reject it.
    const summary = await sweepStaging({
      db,
      library: { ...library, stagingDir: root },
      nowMs: NOW,
    });

    expect(summary.dirsRefused).toBe(1);
    expect(summary.dirsSwept).toBe(0);
    expect(existsSync(join(root, '.trawlarr'))).toBe(true);
  });

  it('reports a staging directory that does not exist rather than failing', async () => {
    const empty = createLibraryRepo(db).create({
      name: 'Shows',
      roots: [mkdtempSync(join(tmpdir(), 'trawlarr-staging-empty-'))],
      extensions: ['mkv'],
      nowMs: NOW,
    });

    const summary = await sweepStaging({ db, library: empty, nowMs: NOW });

    expect(summary.dirsMissing).toBe(1);
    expect(summary.dirsSwept).toBe(0);
  });
});
