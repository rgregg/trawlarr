import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileState, FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { scanLibrary } from '../scanner/scan-library.js';
import { runQueue } from './loop.js';

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const now = () => NOW;

const makeSample = (path: string) =>
  execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=64x48:rate=5',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    path,
  ]);

/**
 * A flow that matches every sample's real codec (h264), so it converges to
 * `good` in two steps (Start, Check Video Codec) with no ffmpeg re-encode
 * at all. The loop's own claim/run/repeat behaviour is what these tests
 * cover — the transcode path itself is already covered end to end by
 * run-job.test.ts, and re-encoding real media here would only make this
 * suite slow without adding any coverage of the loop.
 */
const GOOD_FLOW: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'check',
      pluginId: 'trawlarr:checkVideoCodec',
      pluginVersion: '1.0.0',
      inputs: { codec: 'h264' },
    },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' }],
};

/** A node whose plugin cannot be loaded, reached right after a real Start node. */
const BROKEN_FLOW: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'bad', pluginId: 'trawlarr:does-not-exist', pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'bad' }],
};

let db: Db;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
});

/** Builds a library with `fileCount` real media files, wires `definition`, and scans them into `queued`. */
const buildLibrary = async (input: {
  fileCount: number;
  definition: FlowDefinition;
  name?: string;
}): Promise<{ root: string; library: LibraryRecord }> => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-loop-'));
  for (let i = 0; i < input.fileCount; i += 1) {
    await makeSample(join(root, `f${i}.mkv`));
  }
  const flow = createFlowRepo(db).create({
    name: 'flow',
    definition: input.definition,
    nowMs: NOW,
  });
  const library = createLibraryRepo(db).create({
    name: input.name ?? `lib-${flow.id}`,
    roots: [root],
    extensions: ['mkv'],
    flowId: flow.id,
    nowMs: NOW,
  });
  await scanLibrary({ db, libraryId: library.id, ffprobePath: 'ffprobe', nowMs: now });
  return { root, library };
};

describe('runQueue', () => {
  it('returns all zeros without error when the queue is empty', async () => {
    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(summary).toEqual({ claimed: 0, succeeded: 0, failed: 0, skipped: 0 });
  });

  it('processes three queued files and the summary counts match', async () => {
    const { library } = await buildLibrary({ fileCount: 3, definition: GOOD_FLOW });

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    expect(summary).toEqual({ claimed: 3, succeeded: 3, failed: 0, skipped: 0 });
    const counts = createMediaFileRepo(db).countsByState(library.id);
    expect(counts.good).toBe(3);
    expect(counts.queued).toBe(0);
    expect(counts.running).toBe(0);
  }, 60_000);

  it('maxFiles: 1 stops after one claim, leaving the rest queued', async () => {
    const { library } = await buildLibrary({ fileCount: 3, definition: GOOD_FLOW });

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      maxFiles: 1,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    const counts = createMediaFileRepo(db).countsByState(library.id);
    expect(counts.good).toBe(1);
    expect(counts.queued).toBe(2);
    expect(counts.running).toBe(0);
  }, 60_000);

  it('stops promptly when the signal aborts, leaving the remaining files claimable', async () => {
    const { library } = await buildLibrary({ fileCount: 3, definition: GOOD_FLOW });
    const controller = new AbortController();
    const seen: FileState[] = [];

    // Deterministic, not timing-based: the abort is triggered synchronously
    // from inside onFile (fired only after the first file's runJob has
    // fully resolved), so the loop's OWN between-files signal check — not
    // any wall-clock race — is what decides whether a second file is ever
    // claimed. Combined with the "three files processed" test above (which
    // proves the loop DOES keep claiming when nothing aborts it), this
    // distinguishes "the abort check works" from "the loop happens to only
    // ever touch one file" — a mutant that deletes the abort check entirely
    // would claim all 3 here, exactly like that other test, and fail both
    // the `claimed` and `queued` assertions below.
    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      signal: controller.signal,
      onFile: (event) => {
        seen.push(event.state);
        controller.abort();
      },
    });

    expect(seen).toHaveLength(1);
    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });

    const counts = createMediaFileRepo(db).countsByState(library.id);
    expect(counts.good).toBe(1);
    expect(counts.queued).toBe(2);
    expect(counts.running).toBe(0);
  }, 60_000);

  it('does not stop the loop when a file fails; the next file is still processed', async () => {
    const broken = await buildLibrary({ fileCount: 1, definition: BROKEN_FLOW, name: 'broken' });
    const good = await buildLibrary({ fileCount: 1, definition: GOOD_FLOW, name: 'good' });

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    expect(summary.claimed).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed + summary.skipped).toBe(1);

    const mediaFileRepo = createMediaFileRepo(db);
    expect(mediaFileRepo.countsByState(good.library.id).good).toBe(1);
    const brokenCounts = mediaFileRepo.countsByState(broken.library.id);
    // First bad-plugin attempt backs off (`held`), it does not go straight
    // to terminal `failed` — see recordFailedAttempt/MAX_ATTEMPTS in
    // @trawlarr/core. Either way, it is not `queued`/`running` and it did
    // not stop the loop from reaching the other library's file.
    expect(brokenCounts.held).toBe(1);
    expect(brokenCounts.queued).toBe(0);
    expect(brokenCounts.running).toBe(0);
  }, 60_000);

  it('skips a paused library: its files are never claimed', async () => {
    const paused = await buildLibrary({ fileCount: 1, definition: GOOD_FLOW, name: 'paused' });
    const active = await buildLibrary({ fileCount: 1, definition: GOOD_FLOW, name: 'active' });
    createLibraryRepo(db).pause(paused.library.id, 'maintenance');

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });

    const mediaFileRepo = createMediaFileRepo(db);
    expect(mediaFileRepo.countsByState(active.library.id).good).toBe(1);
    const pausedCounts = mediaFileRepo.countsByState(paused.library.id);
    expect(pausedCounts.queued).toBe(1);
    expect(pausedCounts.good).toBe(0);
    expect(pausedCounts.running).toBe(0);
  }, 60_000);

  it('calls onFile once per file with its resulting state', async () => {
    const { library } = await buildLibrary({ fileCount: 2, definition: GOOD_FLOW });
    const events: { fileId: string; path: string; state: FileState }[] = [];

    await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      onFile: (event) => events.push(event),
    });

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.state).toBe('good');
      expect(typeof event.fileId).toBe('string');
      expect(event.path.startsWith(library.roots[0]!)).toBe(true);
    }
    // Distinct files, not the same one reported twice.
    expect(new Set(events.map((e) => e.fileId)).size).toBe(2);
  }, 60_000);
});
