import { execFile } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type ClaimedFile } from '../db/media-file-repo.js';
import { partialHashFile } from '../fs/partial-hash.js';
import { runJob } from '../worker/run-job.js';
import { scanLibrary } from './scan-library.js';
import { toolAvailableSync } from '../../../../test-support/tool-availability.js';

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const now = () => NOW;

const available = toolAvailableSync('ffmpeg');

const makeSample = (path: string, videoCodec: string) =>
  execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=10',
    '-c:v',
    videoCodec,
    '-preset',
    'ultrafast',
    path,
  ]);

const videoCodecOf = async (path: string): Promise<string> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'csv=p=0',
    path,
  ]);
  return stdout.trim();
};

const TRANSCODE_FLOW: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'check',
      pluginId: 'trawlarr:checkVideoCodec',
      pluginVersion: '1.0.0',
      inputs: { codec: 'hevc' },
    },
    { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'encoder',
      pluginId: 'trawlarr:setVideoEncoder',
      pluginVersion: '1.0.0',
      inputs: { encoder: 'libx265', quality: '30' },
    },
    { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'verify',
      pluginId: 'trawlarr:verifyOutput',
      pluginVersion: '1.0.0',
      inputs: { durationToleranceSeconds: '1', minSizeRatio: '0.05' },
    },
    {
      id: 'replace',
      pluginId: 'trawlarr:replaceOriginal',
      pluginVersion: '1.0.0',
      inputs: { trashRetentionDays: '14', allowCrossDevice: 'true' },
    },
  ],
  edges: [
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
    { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
    { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'encoder' },
    { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'execute' },
    { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
    { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
  ],
};

let db: Db;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
});

/** Library + flow + one real h264 file, scanned into `queued` and claimed. */
const setupClaimedFile = async (): Promise<{
  root: string;
  libraryId: string;
  claimed: ClaimedFile;
}> => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-window-'));
  await makeSample(join(root, 'sample.mkv'), 'libx264');

  const flow = createFlowRepo(db).create({ name: 'flow', definition: TRANSCODE_FLOW, nowMs: NOW });
  const library = createLibraryRepo(db).create({
    name: 'lib',
    roots: [root],
    extensions: ['mkv'],
    flowId: flow.id,
    nowMs: NOW,
  });

  await scanLibrary({ db, libraryId: library.id, ffprobePath: 'ffprobe', nowMs: now });
  const claimed = createMediaFileRepo(db).claimNext({ workerClass: 'transcode', nowMs: NOW });
  if (claimed === null) throw new Error('setup failed to queue the sample file');
  return { root, libraryId: library.id, claimed };
};

const allRows = (): { id: string; path: string; state: string; content_key: string }[] =>
  db.prepare(`SELECT id, path, state, content_key FROM media_file ORDER BY id`).all() as {
    id: string;
    path: string;
    state: string;
    content_key: string;
  }[];

/**
 * The OTHER half of the mid-replacement window (critical C2's counterpart).
 *
 * C2 (`run-job.test.ts`) pins the half where the scan runs entirely INSIDE
 * the window: the replacement has landed, `updateAfterRun` has not run, the
 * row is still `running`, and `listRunningPaths` is what stops the scan
 * opening a second row for it.
 *
 * This is the half where the scan STRADDLES the end of the window. A scan's
 * observation of a file is two reads — the walk's `stat` and the partial
 * hash of its bytes — and the database is not consulted until both have
 * finished. If the run lands its replacement, probes it, and records it
 * (`updateAfterRun` + the ledger transition) while those bytes are being
 * read, then by the time the scan looks at the database:
 *
 *  - the identity it holds is the ORIGINAL's, which no row claims any more —
 *    `updateAfterRun` has just replaced it with the replacement's;
 *  - and NO row is `running`, so the in-flight-output guard has nothing to
 *    match and cannot fire.
 *
 * The scan therefore inserts a second row for a file that is already
 * tracked, holding the pre-transcode identity and stat: the ghost row this
 * whole mechanism exists to prevent, reached from the other side. It is
 * `queued` on the next pass, claimed, and the already-hevc file is
 * transcoded a second time — generational loss on the user's file, with the
 * good result pushed into trash — while the real row's file no longer
 * exists and goes `missing`.
 *
 * Freshness of `listRunningPaths` is not enough on its own: the guard is
 * only sound if the IDENTITY it is guarding is still true of the file at
 * that path. That is what this pins.
 *
 * The interleaving is FORCED, at the `hashFile` seam — the only point in
 * the scan loop where a test can stand, because everything from the hash to
 * the insert is one synchronous block. The run injected there is the real
 * `runJob`: a real ffmpeg transcode, the real `Replace Original File`, the
 * real `applyJobReport`.
 */
describe.runIf(available)('scanLibrary: an observation that a finished run invalidated', () => {
  it('does not open a second row for a file whose run recorded itself mid-observation', async () => {
    const { libraryId, claimed } = await setupClaimedFile();
    const before = createMediaFileRepo(db).getById(claimed.fileId);
    const originalSize = statSync(claimed.path).size;

    let injected = 0;
    const summary = await scanLibrary({
      db,
      libraryId,
      ffprobePath: 'ffprobe',
      nowMs: now,
      // Taken BEFORE the run: these are the original's real bytes, which is
      // exactly what a scan that started before the swap is holding.
      hashFile: async (path) => {
        const parts = await partialHashFile(path);
        if (path === claimed.path && injected === 0) {
          injected += 1;
          const result = await runJob({
            db,
            claimed,
            ffmpegPath: 'ffmpeg',
            ffprobePath: 'ffprobe',
            nowMs: now,
          });
          expect(result.state).toBe('good');
        }
        return parts;
      },
    });

    expect(injected).toBe(1);

    // The run really did replace the file and record itself: the window this
    // test straddles is the real one, not a simulated state.
    expect(await videoCodecOf(claimed.path)).toBe('hevc');
    expect(statSync(claimed.path).size).not.toBe(originalSize);

    // EXACTLY ONE ROW describes this file, and it is the row the run owns,
    // carrying the replacement's identity — not the pre-transcode one the
    // scan was holding.
    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(claimed.fileId);
    expect(rows[0]?.content_key).not.toBe(before?.content_key);
    expect(summary.added).toBe(0);

    // ...and it is still converged: the scan neither forked it nor knocked
    // it back out of `good` on the strength of a stale observation.
    expect(rows[0]?.state).toBe('good');
    expect(summary.queued).toBe(0);

    // Nothing is claimable: no ghost waiting out a backoff to transcode the
    // already-hevc file a second time.
    expect(createMediaFileRepo(db).claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();

    // The row was accounted for by the walk, so reconciliation did not mark
    // a file that is plainly on disk as missing.
    expect(summary.missing).toBe(0);
    expect(createMediaFileRepo(db).getById(claimed.fileId)?.missing_since_ms).toBeNull();
  }, 180_000);
});

/**
 * `media_file_running_idx` — the partial index `listRunningPaths` now uses —
 * changes the PLAN of the in-flight-output guard's query. This pins that it
 * does not change its ANSWER, which is the only thing the guard depends on:
 * a `running` row must be visible to a separate connection the instant the
 * claim commits, and must not be visible before it, exactly as it was when
 * the query was a full scan.
 *
 * Both are read on a real file database in WAL mode with two connections —
 * the deployment the guard exists for (`trawlarr scan` beside a daemon) —
 * and each is asked twice: once as the guard asks it (free to use the
 * partial index) and once with `+state` in the predicate, which SQLite
 * cannot answer from that index. Disagreement between the two would BE the
 * defect.
 */
describe('the running partial index does not change what a scanner can see', () => {
  const indexed = (db: Db, libraryId: string): string[] =>
    (
      db
        .prepare(`SELECT path FROM media_file WHERE library_id = ? AND state = 'running'`)
        .all(libraryId) as { path: string }[]
    ).map((row) => row.path);

  // `+state` disables the partial index for this query, so the same question
  // is answered by a table scan.
  const unindexed = (db: Db, libraryId: string): string[] =>
    (
      db
        .prepare(`SELECT path FROM media_file WHERE library_id = ? AND +state = 'running'`)
        .all(libraryId) as { path: string }[]
    ).map((row) => row.path);

  it('shows a claimed row to another connection exactly when the claim commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trawlarr-wal-'));
    const file = join(dir, 'trawlarr.db');
    const writer = openDatabase({ file });
    migrate(writer);

    const flow = createFlowRepo(writer).create({
      name: 'flow',
      definition: TRANSCODE_FLOW,
      nowMs: NOW,
    });
    const library = createLibraryRepo(writer).create({
      name: 'lib',
      roots: [dir],
      extensions: ['mkv'],
      flowId: flow.id,
      nowMs: NOW,
    });
    const fileId = createMediaFileRepo(writer).upsertScanned({
      libraryId: library.id,
      identity: { inodeKey: '1:1', contentKey: 'content-key' },
      path: join(dir, 'movie.mkv'),
      nlink: 1,
      sizeBytes: 10,
      mtimeMs: NOW,
      ctimeMs: NOW,
      container: 'mkv',
      nowMs: NOW,
    });
    createMediaFileRepo(writer).setLedger({
      fileId,
      record: {
        state: 'queued',
        signature: null,
        attemptCount: 0,
        consecutiveNoopCount: 0,
        holdUntilMs: null,
      },
    });

    // A SEPARATE connection, as a scanner process is.
    const reader = openDatabase({ file });
    const scanner = createMediaFileRepo(reader);

    // Confirm the index is what answers the guard's query, so this test is
    // constraining the indexed plan and not a fallback.
    const plan = (
      reader
        .prepare(
          `EXPLAIN QUERY PLAN SELECT path FROM media_file WHERE library_id = ? AND state = 'running'`,
        )
        .all(library.id) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' ');
    expect(plan).toContain('media_file_running_idx');

    // Before the claim: invisible to both plans.
    expect(scanner.listRunningPaths(library.id)).toEqual([]);
    expect(indexed(reader, library.id)).toEqual([]);
    expect(unindexed(reader, library.id)).toEqual([]);

    const claimed = createMediaFileRepo(writer).claimNext({
      workerClass: 'transcode',
      nowMs: NOW,
    });
    expect(claimed?.fileId).toBe(fileId);

    // The instant the claim commits: visible to both plans, identically.
    expect(scanner.listRunningPaths(library.id)).toEqual([join(dir, 'movie.mkv')]);
    expect(indexed(reader, library.id)).toEqual(unindexed(reader, library.id));

    // And inside a read transaction opened BEFORE the next state change, both
    // plans keep the same snapshot: the index does not leak a row the table
    // does not show, nor hide one it does.
    reader.prepare('BEGIN').run();
    expect(indexed(reader, library.id)).toEqual([join(dir, 'movie.mkv')]);
    createMediaFileRepo(writer).setLedger({
      fileId,
      record: {
        state: 'good',
        signature: 'sig',
        attemptCount: 0,
        consecutiveNoopCount: 0,
        holdUntilMs: null,
      },
    });
    expect(indexed(reader, library.id)).toEqual(unindexed(reader, library.id));
    reader.prepare('COMMIT').run();

    expect(indexed(reader, library.id)).toEqual([]);
    expect(unindexed(reader, library.id)).toEqual([]);

    reader.close();
    writer.close();
  });
});
