import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
import { runJob } from './run-job.js';
import { runQueue, type LoopSummary } from './loop.js';

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

/**
 * A CommonJS plugin that copies the input file byte-for-byte into `workDir`
 * — a new inode holding identical content — standing in for a no-op
 * transcode. Same technique run-job.test.ts uses for its `not_converging`
 * (one-strike) coverage: Replace swaps in a genuinely new inode, but the
 * facts before and after are byte-for-byte identical, so `applyRunOutcome`
 * flags it in one strike rather than converging.
 */
const copyVerbatimPluginCode = (): string => `
const fs = require('node:fs');
const path = require('node:path');

const details = () => ({
  name: 'Copy Verbatim',
  description: 'copies the input file byte-for-byte, standing in for a no-op transcode',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'out 1' }],
  requiresVersion: '1.0.0',
});

const plugin = (args) => {
  const src = args.inputFileObj._id;
  const dest = path.join(args.workDir, 'copy' + path.extname(src));
  fs.copyFileSync(src, dest);
  return {
    outputNumber: 1,
    outputFileObj: { _id: dest },
    variables: args.variables,
  };
};

module.exports = { details, plugin };
`;

const writeCopyVerbatimPlugin = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-loop-copy-plugin-'));
  const abs = join(dir, 'index.js');
  writeFileSync(abs, copyVerbatimPluginCode(), 'utf8');
  return abs;
};

/** start -> (byte-for-byte copy) -> verify -> replace. */
const copyVerbatimFlow = (): FlowDefinition => {
  const copyPath = writeCopyVerbatimPlugin();
  return {
    nodes: [
      { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
      { id: 'copy', pluginId: copyPath, pluginVersion: '1.0.0', inputs: {} },
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
      { fromNodeId: 'start', outputNumber: 1, toNodeId: 'copy' },
      { fromNodeId: 'copy', outputNumber: 1, toNodeId: 'verify' },
      { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
    ],
  };
};

/**
 * A CommonJS plugin that remuxes the input into an mp4 container via a real
 * `ffmpeg -c copy` call — genuinely changing the library file's extension
 * (and therefore its path) without re-encoding anything, so this stays
 * fast. Used to pin that `onFile`/the row's path reflect what Replace
 * actually produced, not the path the file was claimed under.
 */
const remuxToMp4PluginCode = (ffmpegPath: string): string => `
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const details = () => ({
  name: 'Remux To MP4',
  description: 'remuxes the input into an mp4 container, changing its extension',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'out 1' }],
  requiresVersion: '1.0.0',
});

const plugin = (args) => {
  const dest = path.join(args.workDir, 'remuxed.mp4');
  execFileSync(
    ${JSON.stringify(ffmpegPath)},
    ['-y', '-i', args.inputFileObj._id, '-c', 'copy', dest],
    { stdio: 'ignore' },
  );
  return {
    outputNumber: 1,
    outputFileObj: { _id: dest },
    variables: args.variables,
  };
};

module.exports = { details, plugin };
`;

const writeRemuxToMp4Plugin = (ffmpegPath: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-loop-remux-plugin-'));
  const abs = join(dir, 'index.js');
  writeFileSync(abs, remuxToMp4PluginCode(ffmpegPath), 'utf8');
  return abs;
};

/** start -> (real ffmpeg remux to mp4) -> verify -> replace. */
const remuxToMp4Flow = (ffmpegPath: string): FlowDefinition => {
  const remuxPath = writeRemuxToMp4Plugin(ffmpegPath);
  return {
    nodes: [
      { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
      { id: 'remux', pluginId: remuxPath, pluginVersion: '1.0.0', inputs: {} },
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
      { fromNodeId: 'start', outputNumber: 1, toNodeId: 'remux' },
      { fromNodeId: 'remux', outputNumber: 1, toNodeId: 'verify' },
      { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
    ],
  };
};

let db: Db;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
});

/** The all-zeros shape, so each test only spells out the fields it expects nonzero. */
const ZERO_SUMMARY: LoopSummary = {
  claimed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  heldForRetry: 0,
  notConverging: 0,
  pausedSkipped: 0,
};
const summaryOf = (overrides: Partial<LoopSummary>): LoopSummary => ({
  ...ZERO_SUMMARY,
  ...overrides,
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
  // `flow.name` is unique at the schema level (see migration
  // 002_flow_name_unique.sql) — a fixed literal here collides the instant a
  // test builds more than one library, so every call gets its own name.
  const flow = createFlowRepo(db).create({
    name: `flow-${randomUUID()}`,
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
    expect(summary).toEqual(ZERO_SUMMARY);
  });

  it('processes three queued files and the summary counts match', async () => {
    const { library } = await buildLibrary({ fileCount: 3, definition: GOOD_FLOW });

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    expect(summary).toEqual(summaryOf({ claimed: 3, succeeded: 3 }));
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

    expect(summary).toEqual(summaryOf({ claimed: 1, succeeded: 1 }));
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
    expect(summary).toEqual(summaryOf({ claimed: 1, succeeded: 1 }));

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

    // First bad-plugin attempt backs off (`held`), it does not go straight
    // to terminal `failed` — see recordFailedAttempt/MAX_ATTEMPTS in
    // @trawlarr/core.
    expect(summary).toEqual(summaryOf({ claimed: 2, succeeded: 1, heldForRetry: 1, skipped: 1 }));

    const mediaFileRepo = createMediaFileRepo(db);
    expect(mediaFileRepo.countsByState(good.library.id).good).toBe(1);
    const brokenCounts = mediaFileRepo.countsByState(broken.library.id);
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

    expect(summary).toEqual(summaryOf({ claimed: 1, succeeded: 1, pausedSkipped: 1 }));

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

  // --- Fix round 1 ---------------------------------------------------

  it('does not abort the drain when runJob itself throws: the file counts as failed and the loop continues', async () => {
    const { library } = await buildLibrary({ fileCount: 3, definition: GOOD_FLOW });
    let calls = 0;

    // Throws on the SECOND claim, whichever file that happens to be —
    // deterministic without depending on tie-break ordering among rows
    // scanned in the same instant. Delegates to the real runJob for every
    // other claim, so the other two files genuinely converge.
    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      runJobFn: (jobInput) => {
        calls += 1;
        if (calls === 2) throw new Error('boom: simulated SQLITE_BUSY or similar');
        return runJob(jobInput);
      },
    });

    expect(calls).toBe(3);
    expect(summary).toEqual(summaryOf({ claimed: 3, succeeded: 2, failed: 1 }));

    const counts = createMediaFileRepo(db).countsByState(library.id);
    expect(counts.good).toBe(2);
    // The thrown claim is genuinely stranded `running` — recorded, not
    // silently repaired; there is no stall reaper anywhere in the server
    // yet (see loop.ts's doc comment). What matters here is that the OTHER
    // two files still converged and the drain returned instead of
    // rejecting.
    expect(counts.running).toBe(1);
    expect(counts.queued).toBe(0);
  }, 60_000);

  it('does not abort the drain when onFile throws: the remaining files are still processed', async () => {
    const { library } = await buildLibrary({ fileCount: 3, definition: GOOD_FLOW });
    let calls = 0;

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      onFile: () => {
        calls += 1;
        if (calls === 1) throw new Error('a CLI formatting bug, or closed stdout');
      },
    });

    expect(calls).toBe(3);
    expect(summary).toEqual(summaryOf({ claimed: 3, succeeded: 3 }));
    expect(createMediaFileRepo(db).countsByState(library.id).good).toBe(3);
  }, 60_000);

  it('pins every counter distinctly: swapping any two would fail this test', async () => {
    // Every bucket gets a DIFFERENT file count on purpose: two counters
    // that both happened to land on 1 would make a mutant that swaps their
    // labels (e.g. reports every `held` as `notConverging` and vice versa)
    // produce the exact same summary object — invisible to `toEqual`. With
    // distinct counts (2, 3, 4, 1, 5) below, any such swap changes the
    // resulting object and the test fails. This is the earlier version's
    // real gap: it used 1 file per bucket and did NOT catch a
    // heldForRetry/notConverging swap (verified while writing this test —
    // see the task report).
    const succeeding = await buildLibrary({ fileCount: 2, definition: GOOD_FLOW, name: 'good' });
    const terminal = await buildLibrary({
      fileCount: 3,
      definition: BROKEN_FLOW,
      name: 'terminal',
    });
    const retrying = await buildLibrary({
      fileCount: 4,
      definition: BROKEN_FLOW,
      name: 'retrying',
    });
    const notConverging = await buildLibrary({
      fileCount: 1,
      definition: copyVerbatimFlow(),
      name: 'not-converging',
    });
    const paused = await buildLibrary({ fileCount: 6, definition: GOOD_FLOW, name: 'paused' });

    // Pre-seed every one of `terminal`'s files at attemptCount 2, so THIS
    // run's failure (attemptCount 3 >= MAX_ATTEMPTS) lands directly on the
    // terminal `failed` state instead of another `held` — real ledger
    // backoff mechanics (recordFailedAttempt in @trawlarr/core), not a
    // shortcut.
    const mediaFileRepo = createMediaFileRepo(db);
    for (const row of mediaFileRepo.listByLibrary({ libraryId: terminal.library.id })) {
      mediaFileRepo.setState({ fileId: row.id, state: 'queued', attemptCount: 2 });
    }

    createLibraryRepo(db).pause(paused.library.id, 'maintenance');

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    expect(summary).toEqual({
      claimed: 10,
      succeeded: 2,
      failed: 3,
      heldForRetry: 4,
      notConverging: 1,
      skipped: 5,
      pausedSkipped: 6,
    });

    expect(mediaFileRepo.countsByState(succeeding.library.id).good).toBe(2);
    expect(mediaFileRepo.countsByState(terminal.library.id).failed).toBe(3);
    expect(mediaFileRepo.countsByState(retrying.library.id).held).toBe(4);
    expect(mediaFileRepo.countsByState(notConverging.library.id).not_converging).toBe(1);
    expect(mediaFileRepo.countsByState(paused.library.id).queued).toBe(6);
  }, 60_000);

  it('libraryIds restricts the drain to the named library only', async () => {
    const restricted = await buildLibrary({ fileCount: 1, definition: GOOD_FLOW, name: 'a' });
    const other = await buildLibrary({ fileCount: 1, definition: GOOD_FLOW, name: 'b' });

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      libraryIds: [restricted.library.id],
    });

    expect(summary).toEqual(summaryOf({ claimed: 1, succeeded: 1 }));

    const mediaFileRepo = createMediaFileRepo(db);
    expect(mediaFileRepo.countsByState(restricted.library.id).good).toBe(1);
    // Untouched: the other library was never in the restricted set, even
    // though it is enabled and would otherwise have been drained.
    const otherCounts = mediaFileRepo.countsByState(other.library.id);
    expect(otherCounts.queued).toBe(1);
    expect(otherCounts.good).toBe(0);
  }, 60_000);

  it('onFile reports the resulting (post-run) path, not the path the file was claimed under', async () => {
    const { root } = await buildLibrary({ fileCount: 1, definition: remuxToMp4Flow('ffmpeg') });
    const events: { fileId: string; path: string; state: FileState }[] = [];

    await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      onFile: (event) => events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('good');
    expect(events[0]!.path).toBe(join(root, 'f0.mp4'));
    expect(events[0]!.path).not.toBe(join(root, 'f0.mkv'));

    const row = createMediaFileRepo(db).getById(events[0]!.fileId);
    expect(row?.path).toBe(events[0]!.path);
  }, 60_000);

  // --- Fix round 2 ---------------------------------------------------

  it('stops the drain and still returns the summary so far when the claim step itself throws', async () => {
    const { library } = await buildLibrary({ fileCount: 3, definition: GOOD_FLOW });
    const mediaFileRepo = createMediaFileRepo(db);
    const realClaimNext = mediaFileRepo.claimNext;
    let calls = 0;

    // Throws on the 3rd claim attempt (a stand-in for SQLITE_BUSY on the
    // claimNext UPDATE, e.g. a concurrent scanner or API write against the
    // same WAL database), after two files have already genuinely
    // succeeded. `runQueue` must resolve with what it already has, not
    // reject and discard those two real successes.
    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      claimNextFn: (claimInput) => {
        calls += 1;
        if (calls === 3) throw new Error('SQLITE_BUSY: simulated claim failure');
        return realClaimNext(claimInput);
      },
    });

    expect(calls).toBe(3);
    expect(summary).toEqual(summaryOf({ claimed: 2, succeeded: 2 }));

    const counts = mediaFileRepo.countsByState(library.id);
    expect(counts.good).toBe(2);
    // The third claim never actually reached the database (the seam threw
    // instead of calling the real claimNext), so this row is untouched —
    // still `queued`, not stranded `running`, and the drain stopped
    // cleanly rather than spinning on the failing claim.
    expect(counts.queued).toBe(1);
    expect(counts.running).toBe(0);
  }, 60_000);

  it('keeps whatever pausedSkipped total it already reached when that tally itself fails partway', async () => {
    const active = await buildLibrary({ fileCount: 1, definition: GOOD_FLOW, name: 'active' });
    const pausedA = await buildLibrary({ fileCount: 1, definition: GOOD_FLOW, name: 'paused-a' });
    const pausedB = await buildLibrary({ fileCount: 1, definition: GOOD_FLOW, name: 'paused-b' });
    const libraryRepo = createLibraryRepo(db);
    libraryRepo.pause(pausedA.library.id, 'maintenance');
    libraryRepo.pause(pausedB.library.id, 'maintenance');

    const mediaFileRepo = createMediaFileRepo(db);
    const realListByLibrary = mediaFileRepo.listByLibrary;

    // `library.list()` orders by name (paused-a before paused-b), so
    // paused-a's contribution is tallied before paused-b's read throws.
    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      listByLibraryFn: (listInput) => {
        if (listInput.libraryId === pausedB.library.id) {
          throw new Error('simulated read failure for the second paused library');
        }
        return realListByLibrary(listInput);
      },
    });

    // The real work (the active library's file) is intact regardless.
    expect(summary.claimed).toBe(1);
    expect(summary.succeeded).toBe(1);
    // Only paused-a's queued file is counted: paused-b's read failed, and
    // the partial total already accumulated from paused-a survives rather
    // than being reset to 0 or the whole summary being discarded.
    expect(summary.pausedSkipped).toBe(1);

    expect(mediaFileRepo.countsByState(active.library.id).good).toBe(1);
  }, 60_000);

  it('does not double-count a file this drain already claimed and worked on when its library is paused mid-drain', async () => {
    const { library } = await buildLibrary({ fileCount: 2, definition: BROKEN_FLOW });
    const libraryRepo = createLibraryRepo(db);

    const summary = await runQueue({
      db,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      // Pauses the library right after the FIRST file's outcome (`held`,
      // via heldForRetry) is recorded, before the loop claims again — the
      // exact "paused mid-drain, after already claiming one of its files"
      // scenario the pausedSkipped doc comment calls out.
      onFile: () => {
        libraryRepo.pause(library.id, 'paused mid-drain');
      },
    });

    expect(summary.claimed).toBe(1);
    expect(summary.heldForRetry).toBe(1);
    // The second file was never claimed this drain (the library was
    // already paused by the time the loop reached it) — it is the only
    // one pausedSkipped should count. A double-count bug would report 2
    // here (the first file's `held` row counted again, on top of the
    // second file's untouched `queued` row).
    expect(summary.pausedSkipped).toBe(1);

    const counts = createMediaFileRepo(db).countsByState(library.id);
    expect(counts.held).toBe(1);
    expect(counts.queued).toBe(1);
  }, 60_000);
});
