import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeSignature, extractFacts, type FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { scanLibrary } from './scan-library.js';

/**
 * Reconciliation: what a scan does about rows whose file is no longer on
 * disk. Every assertion here is on database rows and files, never on log
 * text, and the only clock is the injected `now`.
 */

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const now = () => NOW;

const definition: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'check',
      pluginId: 'trawlarr:checkVideoCodec',
      pluginVersion: '1.0.0',
      inputs: { codec: 'hevc' },
    },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' }],
};

let sourceMedia: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-reconcile-src-'));
  sourceMedia = join(dir, 'source.mkv');
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=64x48:rate=5',
    '-c:v',
    'libx264',
    sourceMedia,
  ]);
}, 120_000);

const created: string[] = [];

let db: Db;
let root: string;
let library: LibraryRecord;

/** A distinct media file: re-encoded so its bytes (and content key) differ. */
const makeMedia = async (path: string, seed: number): Promise<void> => {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=1:size=${64 + seed}x48:rate=5`,
    '-c:v',
    'libx264',
    path,
  ]);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trawlarr-reconcile-'));
  created.push(root);
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  const flow = createFlowRepo(db).create({ name: 'HEVC', definition, nowMs: NOW });
  library = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv'],
    flowId: flow.id,
    nowMs: NOW,
  });
});

afterEach(() => {
  for (const dir of created.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

const scan = (options?: { allowEmptyRoots?: boolean }) =>
  scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: 'ffprobe',
    nowMs: now,
    ...options,
  });

const rows = (): MediaFileRow[] =>
  createMediaFileRepo(db)
    .listByLibrary({ libraryId: library.id })
    .sort((a, b) => a.path.localeCompare(b.path));

const rowFor = (path: string): MediaFileRow => {
  const row = rows().find((candidate) => candidate.path === path);
  if (row === undefined) throw new Error(`No row for ${path}`);
  return row;
};

describe('scanLibrary: reconciling rows against the filesystem', () => {
  it('marks a deleted file missing, keeps its row, and stops counting it as converged', async () => {
    const a = join(root, 'a.mkv');
    const b = join(root, 'b.mkv');
    await makeMedia(a, 0);
    await makeMedia(b, 1);
    await scan();

    const repo = createMediaFileRepo(db);
    const flowDefinitionHash = createFlowRepo(db).getById(library.flowId!)!.definitionHash;
    for (const row of rows()) {
      // Converged the way a successful run converges it: the signature the
      // scanner will recompute next time, so the rescan below leaves it
      // `good` instead of re-queueing it.
      const probe = repo.getProbe(row.id)!;
      repo.setLedger({
        fileId: row.id,
        record: {
          ...repo.getLedger(row.id)!,
          state: 'good',
          signature: computeSignature({
            flowDefinitionHash,
            facts: extractFacts({
              probe: probe.probe,
              container: row.container,
              sizeBytes: row.size_bytes,
            }),
          }),
        },
      });
    }

    unlinkSync(b);
    const summary = await scan();

    expect(summary.missing).toBe(1);
    // The row survives: its job history, attempt counts and size statistics
    // are information a user would want, so this marks rather than deletes.
    expect(rows()).toHaveLength(2);
    expect(rowFor(b).missing_since_ms).toBe(NOW);
    expect(rowFor(a).missing_since_ms).toBeNull();

    // The number this product exists to report: one file on disk, one file
    // converged, 100% — not "2 rows, one of them a ghost".
    const counts = repo.countsByState(library.id);
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(counts.good).toBe(1);
    expect(repo.missingCount(library.id)).toBe(1);
  });

  it('never claims a missing file, whatever ledger state it was left in', async () => {
    const a = join(root, 'a.mkv');
    const keep = join(root, 'keep.mkv');
    await makeMedia(a, 0);
    await makeMedia(keep, 1);
    await scan();
    expect(rowFor(a).state).toBe('queued');

    unlinkSync(a);
    await scan();
    expect(rowFor(a).missing_since_ms).toBe(NOW);

    // `keep.mkv` is still queued, so this is not "the queue happened to be
    // empty": the only claimable row left is the one that still exists.
    const claimed = createMediaFileRepo(db).claimNext({ workerClass: 'transcode', nowMs: NOW });
    expect(claimed?.path).toBe(keep);
    expect(createMediaFileRepo(db).claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();
  });

  it('leaves every row alone when a root is unavailable, rather than purging the library', async () => {
    const a = join(root, 'a.mkv');
    const b = join(root, 'b.mkv');
    await makeMedia(a, 0);
    await makeMedia(b, 1);
    await scan();

    // The NAS went away: the mount point is still there and still empty,
    // which is exactly what an unmounted network share looks like.
    const stash = mkdtempSync(join(tmpdir(), 'trawlarr-reconcile-stash-'));
    created.push(stash);
    renameSync(a, join(stash, 'a.mkv'));
    renameSync(b, join(stash, 'b.mkv'));

    const summary = await scan();
    expect(summary.missing).toBe(0);
    expect(summary.rootsUnavailable).toBe(1);
    expect(rows().every((row) => row.missing_since_ms === null)).toBe(true);

    // And when it comes back, nothing was lost.
    renameSync(join(stash, 'a.mkv'), a);
    renameSync(join(stash, 'b.mkv'), b);
    const back = await scan();
    expect(back.missing).toBe(0);
    expect(rows()).toHaveLength(2);
  });

  it('clears the missing mark when the file comes back', async () => {
    const a = join(root, 'a.mkv');
    const keep = join(root, 'keep.mkv');
    await makeMedia(a, 0);
    await makeMedia(keep, 1);
    await scan();

    const stash = mkdtempSync(join(tmpdir(), 'trawlarr-reconcile-stash-'));
    created.push(stash);
    renameSync(a, join(stash, 'a.mkv'));
    const gone = await scan();
    expect(gone.missing).toBe(1);

    renameSync(join(stash, 'a.mkv'), a);
    const restored = await scan();
    expect(restored.restored).toBe(1);
    expect(rowFor(a).missing_since_ms).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it('never marks a running row missing, even mid-replacement when its path is gone', async () => {
    const a = join(root, 'a.mkv');
    const keep = join(root, 'keep.mkv');
    await makeMedia(a, 0);
    await makeMedia(keep, 1);
    await scan();

    const repo = createMediaFileRepo(db);
    const row = rowFor(a);
    repo.setLedger({ fileId: row.id, record: { ...repo.getLedger(row.id)!, state: 'queued' } });
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW })?.fileId).toBe(row.id);

    // Replace has renamed the original away and not yet recorded the new
    // identity: the row's path holds nothing at all.
    renameSync(a, join(root, 'a.mp4'));

    const summary = await scan();
    expect(summary.missing).toBe(0);
    expect(repo.getById(row.id)?.missing_since_ms).toBeNull();
  });

  it('leaves a row alone when its path cannot be examined at all', async () => {
    const sub = join(root, 'sub');
    mkdirSync(sub);
    const a = join(sub, 'a.mkv');
    const keep = join(root, 'keep.mkv');
    await makeMedia(a, 0);
    await makeMedia(keep, 1);
    await scan();

    // Unreadable directory: the walk cannot see the file, and `lstat` cannot
    // say whether it is there. "I could not check" is not "it is gone".
    chmodSync(sub, 0o000);
    try {
      const summary = await scan();
      expect(summary.missing).toBe(0);
      expect(rowFor(a).missing_since_ms).toBeNull();
    } finally {
      chmodSync(sub, 0o755);
    }
  });

  it('reconciles a genuinely emptied root only when the operator says so', async () => {
    const a = join(root, 'a.mkv');
    await makeMedia(a, 0);
    await scan();

    unlinkSync(a);
    expect((await scan()).missing).toBe(0);

    const forced = await scan({ allowEmptyRoots: true });
    expect(forced.missing).toBe(1);
    expect(rowFor(a).missing_since_ms).toBe(NOW);
  });
});
