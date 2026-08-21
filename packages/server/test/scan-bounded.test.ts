import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createLibraryRepo } from '../src/db/library-repo.js';
import { createMediaFileRepo } from '../src/db/media-file-repo.js';
import { scanLibrary } from '../src/scanner/scan-library.js';
import { DEFAULT_CHUNK_SIZE } from '../src/db/chunked.js';
import { fakeFfprobe } from './helpers/fake-ffprobe.js';
import { startDaemonForTest } from './helpers/daemon-harness.js';

const FILES = 5_000;

/**
 * FIVE THOUSAND, not one hundred thousand. The 100k run is `pnpm bench:scan`,
 * which reports numbers a human reads; this suite asserts the STRUCTURAL
 * properties those numbers depend on, at a size the gate can afford. A test
 * that took four minutes would be a test people learn to skip.
 *
 * Nothing here asserts on elapsed time, in either direction. The properties
 * are counts of observable state: rows per committed transaction, HTTP
 * statuses answered while a walk is in flight, probes performed by a scan
 * that follows an interrupted one, rows marked missing. Every `it` carries a
 * generous timeout, which is a hang guard and not an expectation — its only
 * job is to turn a wedged scan into a named failure instead of a hung run.
 */
const TIMEOUT_MS = 300_000;

const seedLibrary = (): { dataDir: string; root: string } => {
  const dataDir = mkdtempSync(join(tmpdir(), 'trawlarr-bounded-'));
  const root = join(dataDir, 'library');
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < FILES; i += 1) {
    if (i % 100 === 0) mkdirSync(join(root, `d${String(i / 100)}`), { recursive: true });
    writeFileSync(
      join(root, `d${String(Math.floor(i / 100))}`, `f${String(i)}.mkv`),
      `file ${String(i)}`,
    );
  }
  return { dataDir, root };
};

describe('scanning a large library stays bounded', () => {
  it('answers the in-flight-output guard from an index, not a walk of the whole library', () => {
    // The one assertion here that is about COST rather than behaviour, and it
    // is a structural fact rather than a stopwatch: the query plan SQLite
    // chooses for `listRunningPaths`.
    //
    // `scanLibrary` asks that query freshly for every walked file that
    // matches no row — it must, or a job started after the scan began is
    // invisible and the scan inserts a duplicate row for a file that run
    // already owns. On a first scan every file is new, so an answer computed
    // by visiting every row in the library is quadratic in the size of the
    // library. The 100,000-file benchmark is what found it (~15 ms per call
    // at 28,000 rows, throughput falling as 1/n); this is what keeps it
    // found, at a size the gate can afford, because a regression here is
    // invisible in any suite small enough to run in CI.
    const db = openDatabase({ file: ':memory:' });
    migrate(db);
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT path FROM media_file WHERE library_id = 'x' AND state = 'running'`,
        )
        .all() as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | ');

    expect(plan).toContain('media_file_running_idx');
    // "SEARCH" is a seek into an index; "SCAN" is every row. The distinction
    // is the entire finding, so it is asserted rather than implied.
    expect(plan).toContain('SEARCH');
    expect(plan).not.toContain('SCAN media_file');
    db.close();
  });

  it(
    'never writes more rows in one transaction than the chunk size',
    async () => {
      const { dataDir, root } = seedLibrary();
      const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
      migrate(db);
      const library = createLibraryRepo(db).create({ name: 'Big', roots: [root], nowMs: 0 });

      const sizes: number[] = [];

      await scanLibrary({
        db,
        libraryId: library.id,
        ffprobePath: fakeFfprobe(),
        nowMs: () => 0,
        onTransactionCommitted: (rows) => sizes.push(rows),
      });

      expect(createMediaFileRepo(db).countsByState(library.id).unknown).toBe(FILES);
      expect(sizes.length).toBeGreaterThan(1);
      // The synchronous driver blocks the event loop for the whole of a
      // transaction. One 5,000-row transaction is a multi-second freeze of
      // the API, the websocket and every heartbeat.
      expect(Math.max(...sizes)).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
      // And the rows really were written in those transactions, so a seam
      // that reported chunks nobody committed could not satisfy this.
      expect(sizes.reduce((sum, rows) => sum + rows, 0)).toBe(FILES);

      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    TIMEOUT_MS,
  );

  it(
    'commits a rescan in chunks rather than a transaction per file',
    async () => {
      // The asymmetry the incremental flush depends on, asserted so it
      // cannot be tuned away: a file that was PROBED flushes immediately
      // (at most one probe's work is ever at risk), but a file that was
      // SKIPPED — nearly all of a rescan — accumulates to a full chunk. Lose
      // that and a 100,000-file rescan pays 100,000 transactions instead of
      // ~200, which is the difference between a fast rescan and one that
      // freezes the API for its whole duration.
      const { dataDir, root } = seedLibrary();
      const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
      migrate(db);
      const library = createLibraryRepo(db).create({ name: 'Big', roots: [root], nowMs: 0 });

      await scanLibrary({ db, libraryId: library.id, ffprobePath: fakeFfprobe(), nowMs: () => 0 });

      const sizes: number[] = [];
      const second = await scanLibrary({
        db,
        libraryId: library.id,
        ffprobePath: fakeFfprobe(),
        nowMs: () => 0,
        onTransactionCommitted: (rows) => sizes.push(rows),
      });

      expect(second.probed).toBe(0);
      expect(sizes.length).toBeLessThanOrEqual(Math.ceil(FILES / DEFAULT_CHUNK_SIZE) + 1);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);

      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    TIMEOUT_MS,
  );

  it(
    'answers HTTP requests while a scan of that size is running',
    async () => {
      const { dataDir, root } = seedLibrary();
      const daemon = await startDaemonForTest(dataDir);
      try {
        await daemon.api('POST', '/libraries', { name: 'Big', roots: [root] });

        const answers: number[] = [];
        const totals: number[] = [];
        for (;;) {
          const stats = await daemon.api<{ scanning: boolean; total: number }>(
            'GET',
            `/libraries/${daemon.libraryId}/stats`,
          );
          if (!stats.scanning) break;
          totals.push(stats.total);
          answers.push((await daemon.raw('GET', '/system/health')).status);
          if (answers.length > 500) break;
        }

        // Every request answered 200 WHILE the walk was running. Not a
        // duration: a count of successful responses, which is the property
        // the chunking exists to provide.
        expect(answers.length).toBeGreaterThan(5);
        expect(answers.every((status) => status === 200)).toBe(true);

        // And the answers came from DURING the walk, not from either end of
        // it: the row count the API reported CLIMBED, more than once, while
        // the scan was still running — so the ledger advances as the walk
        // proceeds rather than appearing all at once when it ends. That is
        // what makes progress observable and a scan resumable.
        //
        // Honest about what this suite can and cannot falsify: the
        // `status === 200` assertions above are not falsifiable by reverting
        // any single line of the scanner, because a `better-sqlite3`
        // transaction CANNOT span an `await` — the walk awaits a probe and a
        // hash per file, so the event loop necessarily turns. The
        // responsiveness is structural, and this test guards the shape
        // against a future change that tries to batch the walk into one
        // transaction, not against a line that exists today. The bounded
        // transaction sizes are asserted properly in the two tests below.
        const climbed = [...new Set(totals)].filter((total) => total > 0);
        expect(climbed.length).toBeGreaterThan(1);
      } finally {
        await daemon.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  it(
    'resumes rather than restarting when a scan is interrupted',
    async () => {
      const { dataDir, root } = seedLibrary();
      const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
      migrate(db);
      const library = createLibraryRepo(db).create({ name: 'Big', roots: [root], nowMs: 0 });

      const stopAfter = 1_000;
      await expect(
        scanLibrary({
          db,
          libraryId: library.id,
          ffprobePath: fakeFfprobe(),
          nowMs: () => 0,
          onProgress: (seen) => {
            if (seen >= stopAfter) throw new Error('interrupted');
          },
        }),
      ).rejects.toThrow('interrupted');

      const second = await scanLibrary({
        db,
        libraryId: library.id,
        ffprobePath: fakeFfprobe(),
        nowMs: () => 0,
      });

      // The whole point of resumability: the second scan re-probes only what
      // the interruption cost, not everything. The allowance is one chunk,
      // because at most one chunk's probes are ever in flight.
      expect(second.probed).toBeLessThanOrEqual(FILES - stopAfter + DEFAULT_CHUNK_SIZE);
      expect(second.probed).toBeGreaterThan(0);

      const third = await scanLibrary({
        db,
        libraryId: library.id,
        ffprobePath: fakeFfprobe(),
        nowMs: () => 0,
      });
      expect(third.probed).toBe(0);

      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    TIMEOUT_MS,
  );

  it(
    'marks nothing missing when a scan is interrupted',
    async () => {
      const { dataDir, root } = seedLibrary();
      const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
      migrate(db);
      const library = createLibraryRepo(db).create({ name: 'Big', roots: [root], nowMs: 0 });
      await scanLibrary({ db, libraryId: library.id, ffprobePath: fakeFfprobe(), nowMs: () => 0 });

      rmSync(join(root, 'd0'), { recursive: true, force: true });
      await expect(
        scanLibrary({
          db,
          libraryId: library.id,
          ffprobePath: fakeFfprobe(),
          nowMs: () => 0,
          onProgress: (seen) => {
            if (seen >= 500) throw new Error('interrupted');
          },
        }),
      ).rejects.toThrow('interrupted');

      // Reconciliation needs the WHOLE picture; a partial walk that marked
      // files missing would delete a library from the ledger every time a
      // daemon was restarted mid-scan.
      expect(createMediaFileRepo(db).missingCount(library.id)).toBe(0);

      // And a scan that DOES run to completion still reconciles — exactly
      // once, for exactly the files that went away. Without this the
      // assertion above would be satisfied by a scanner that never
      // reconciled at all, which is the cheapest possible way to make
      // "nothing was marked missing" true.
      const complete = await scanLibrary({
        db,
        libraryId: library.id,
        ffprobePath: fakeFfprobe(),
        nowMs: () => 0,
      });
      expect(complete.missing).toBe(100);
      expect(createMediaFileRepo(db).missingCount(library.id)).toBe(100);

      // ONE reconciliation per scan, and it is the scan that owns it: the
      // next complete scan re-walks the same tree, finds the same 100 rows
      // already marked, and marks NOTHING — so `missing` is a count of what
      // this scan discovered, not a running total that grows every hour a
      // daemon is up. The rows stay marked; the mark is not re-applied.
      const again = await scanLibrary({
        db,
        libraryId: library.id,
        ffprobePath: fakeFfprobe(),
        nowMs: () => 0,
      });
      expect(again.missing).toBe(0);
      expect(again.rootsUnavailable).toBe(0);
      expect(createMediaFileRepo(db).missingCount(library.id)).toBe(100);

      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    TIMEOUT_MS,
  );
});
