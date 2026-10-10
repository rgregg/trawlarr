import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newLedgerRecord } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { DEFAULT_WORKING_FILE_STALE_AFTER_MS } from '../library/working-file-sweep.js';
import { FAKE_PROBE_DOCUMENT } from '../../test/helpers/fake-ffprobe.js';
import { scanLibrary, type ScanSummary } from './scan-library.js';
import { ScopeError } from './scope.js';

const fixedProbe = (path: string): ProbeData =>
  ({
    ...FAKE_PROBE_DOCUMENT,
    format: { ...FAKE_PROBE_DOCUMENT.format, filename: path },
  }) as ProbeData;

/** What the scans read as the time. Only the working-file sweep compares it with a file's. */
let clockMs: number;

let base: string;
let root: string;
let db: Db;
let libraryId: string;
let probed: string[];

const scan = (scope?: string[]): Promise<ScanSummary> =>
  scanLibrary({
    db,
    libraryId,
    ffprobePath: 'unused',
    nowMs: () => clockMs,
    scope,
    probeFileImpl: async (input) => {
      probed.push(input.path);
      return fixedProbe(input.path);
    },
  });

const rows = (): MediaFileRow[] => createMediaFileRepo(db).listByLibrary({ libraryId });
const present = (): string[] =>
  rows()
    .filter((row) => row.missing_since_ms === null)
    .map((row) => row.path)
    .sort();
const missing = (): string[] =>
  rows()
    .filter((row) => row.missing_since_ms !== null)
    .map((row) => row.path)
    .sort();

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-scan-scoped-'));
  root = join(base, 'library');
  mkdirSync(join(root, 'Film A'), { recursive: true });
  mkdirSync(join(root, 'Film B'), { recursive: true });
  writeFileSync(join(root, 'Film A', 'a.mkv'), 'film a, the original');
  writeFileSync(join(root, 'Film B', 'b.mkv'), 'film b, the original');
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  libraryId = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv', 'mp4'],
    nowMs: 0,
  }).id;
  probed = [];
  clockMs = 1_000;
  await scan();
  probed = [];
});

afterEach(() => {
  chmodSync(root, 0o755);
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('scanLibrary with a scope', () => {
  it('adds a new file named in scope, and probes nothing else', async () => {
    mkdirSync(join(root, 'Film C'));
    const added = join(root, 'Film C', 'c.mkv');
    writeFileSync(added, 'film c');

    const summary = await scan([added]);

    expect(summary.added).toBe(1);
    expect(summary.seen).toBe(1);
    expect(summary.scopedPaths).toBe(1);
    expect(probed).toEqual([added]);
    expect(present()).toContain(added);
  });

  it('adds every new file under a folder named in scope', async () => {
    mkdirSync(join(root, 'Show', 'Season 1'), { recursive: true });
    writeFileSync(join(root, 'Show', 'Season 1', 'e1.mkv'), 'e1');
    writeFileSync(join(root, 'Show', 'Season 1', 'e2.mkv'), 'e2');

    const summary = await scan([join(root, 'Show')]);

    expect(summary.added).toBe(2);
  });

  // A rename keeps the inode. The new path is observed first, the identity
  // matches the existing row, and the row follows the file — so nothing is
  // left at the old path for the missing pass to find.
  it('follows a renamed file to its new path, keeping one row', async () => {
    const before = rows().find((row) => row.path === join(root, 'Film A', 'a.mkv'))!;
    const renamed = join(root, 'Film A', 'a (2001).mkv');
    renameSync(join(root, 'Film A', 'a.mkv'), renamed);

    const summary = await scan([join(root, 'Film A', 'a.mkv'), renamed]);

    expect(summary.missing).toBe(0);
    expect(summary.added).toBe(0);
    expect(rows().find((row) => row.id === before.id)!.path).toBe(renamed);
    expect(missing()).toEqual([]);
  });

  it('handles an upgrade: the new file gets a row and the deleted one is marked missing', async () => {
    const old = join(root, 'Film A', 'a.mkv');
    const upgraded = join(root, 'Film A', 'a WEBDL.mkv');
    // Written before the old one is removed so the two cannot share an inode:
    // a filesystem that hands the freed inode straight to the new file makes
    // the scanner see one file that moved and changed, which is the identity
    // rule working as designed and not what this test is about.
    writeFileSync(upgraded, 'film a, a better release with different bytes');
    unlinkSync(old);

    const summary = await scan([join(root, 'Film A')]);

    expect(summary.added).toBe(1);
    expect(summary.missing).toBe(1);
    expect(missing()).toEqual([old]);
    expect(present()).toContain(upgraded);
  });

  it('marks a deleted folder in scope missing, and nothing outside it', async () => {
    rmSync(join(root, 'Film A'), { recursive: true });
    unlinkSync(join(root, 'Film B', 'b.mkv'));

    const summary = await scan([join(root, 'Film A')]);

    expect(summary.missing).toBe(1);
    expect(missing()).toEqual([join(root, 'Film A', 'a.mkv')]);
  });

  // A scope path lying under another is dropped before the scan (see
  // `validateScope`); the folder that covers it has to speak for it in the
  // missing pass too, or a deletion reported alongside its folder is lost.
  it('marks a deleted file missing when it was named alongside the folder that contains it', async () => {
    const gone = join(root, 'Film A', 'a.mkv');
    unlinkSync(gone);

    const summary = await scan([gone, join(root, 'Film A')]);

    expect(summary.scopedPaths).toBe(1);
    expect(summary.missing).toBe(1);
    expect(missing()).toEqual([gone]);
  });

  // A root that cannot be read is what an unmounted share
  // looks like, and a delete notification for a folder under it must not be
  // taken at its word.
  it('marks nothing missing when the root cannot be shown to be present', async () => {
    chmodSync(root, 0o000);

    const summary = await scan([join(root, 'Film A')]);

    expect(summary.missing).toBe(0);
    expect(summary.rootsUnavailable).toBe(1);
    chmodSync(root, 0o755);
    expect(missing()).toEqual([]);
  });

  // The orphan is aged past the sweep's threshold on purpose. A fresh one is
  // spared by ANY scan, so a test using it passes whether or not a scoped scan
  // sweeps; this one is a file the full scan below really does remove.
  it('does not sweep orphaned working files, which a full scan does', async () => {
    const orphan = join(root, 'Film A', '.trawlarr-replace-0000.mkv');
    writeFileSync(orphan, 'left by a dead worker');
    clockMs = Date.now();
    const old = new Date(clockMs - 2 * DEFAULT_WORKING_FILE_STALE_AFTER_MS);
    utimesSync(orphan, old, old);

    const scoped = await scan([join(root, 'Film A')]);

    expect(scoped.workingFilesRemoved).toBe(0);
    expect(existsSync(orphan)).toBe(true);

    const full = await scan();

    expect(full.workingFilesRemoved).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  describe('beside a running job', () => {
    const original = (): string => join(root, 'Film A', 'a.mkv');
    const markRunning = (): MediaFileRow => {
      const repo = createMediaFileRepo(db);
      const row = rows().find((candidate) => candidate.path === original())!;
      repo.setLedger({
        fileId: row.id,
        record: { ...(repo.getLedger(row.id) ?? newLedgerRecord()), state: 'running' },
      });
      return repo.getById(row.id)!;
    };

    // `Replace Original File` lands its output beside the original under the
    // original's stem, and the run records it a moment later. A scoped scan is
    // far likelier than a full one to arrive inside that moment — the watcher
    // reports the very file the run just wrote — and a row opened for it then
    // is the ghost row that gets the file transcoded a second time.
    it('leaves a running row and its replacement output alone', async () => {
      const running = markRunning();
      const output = join(root, 'Film A', 'a.mp4');
      writeFileSync(output, 'the replacement, landed but not yet recorded');

      const summary = await scan([join(root, 'Film A')]);

      expect(summary.inFlight).toBe(1);
      expect(summary.added).toBe(0);
      expect(probed).not.toContain(output);
      expect(
        rows()
          .map((row) => row.path)
          .sort(),
      ).toEqual([join(root, 'Film A', 'a.mkv'), join(root, 'Film B', 'b.mkv')]);
      const after = createMediaFileRepo(db).getById(running.id)!;
      expect(after.state).toBe('running');
      expect(after.path).toBe(running.path);
      expect(after.content_key).toBe(running.content_key);
    });

    it('leaves the output alone when it is named directly rather than through its folder', async () => {
      markRunning();
      const output = join(root, 'Film A', 'a.mp4');
      writeFileSync(output, 'the replacement, landed but not yet recorded');

      const summary = await scan([output]);

      expect(summary.inFlight).toBe(1);
      expect(summary.added).toBe(0);
      expect(rows()).toHaveLength(2);
    });

    // A replacement legitimately empties the original's path mid-run, and the
    // watcher reports exactly that unlink.
    it('does not mark a running row missing when its file is gone', async () => {
      const running = markRunning();
      unlinkSync(original());

      const summary = await scan([original(), join(root, 'Film A')]);

      expect(summary.missing).toBe(0);
      expect(missing()).toEqual([]);
      expect(createMediaFileRepo(db).getById(running.id)!.state).toBe('running');
    });
  });

  it('refuses a scope outside the library, and scans nothing', async () => {
    await expect(scan([join(base, 'elsewhere', 'x.mkv')])).rejects.toBeInstanceOf(ScopeError);
    expect(probed).toEqual([]);
  });

  it('reports scopedPaths as null for a full scan', async () => {
    expect((await scan()).scopedPaths).toBeNull();
  });
});
