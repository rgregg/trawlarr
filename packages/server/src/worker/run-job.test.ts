import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeSignature, extractFacts, type FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type ClaimedFile } from '../db/media-file-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { createPluginDocumentRepo } from '../db/plugin-document-repo.js';
import { scanLibrary, type ScanSummary } from '../scanner/scan-library.js';
import { probeFile } from '../probe/ffprobe.js';
import { moveCompanions as moveCompanionsReal } from '../fs/companions.js';
import { runJob } from './run-job.js';
import { toolAvailableSync } from '../../../../test-support/tool-availability.js';

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const now = () => NOW;

// See `toolAvailableSync`: only ENOENT means "not installed" and skips;
// a check that could not be trusted throws instead of skipping silently.
const available = toolAvailableSync('ffmpeg');

const makeSample = (path: string, videoCodec: string) =>
  execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    videoCodec,
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    path,
  ]);

/** Same shape as `makeSample`, but a visually different pattern — distinct bytes, same duration. */
const makeAltSample = (path: string, videoCodec: string) =>
  execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=2:size=320x240:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=2',
    '-c:v',
    videoCodec,
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
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

/** Builds a library + flow, seeds one real media file, scans it into `queued`, and claims it. */
const setupClaimedFile = async (input: {
  definition: FlowDefinition;
  videoCodec: string;
}): Promise<{ root: string; claimed: ClaimedFile; flowId: string }> => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-runjob-'));
  await makeSample(join(root, 'sample.mkv'), input.videoCodec);

  const flow = createFlowRepo(db).create({
    name: 'flow',
    definition: input.definition,
    nowMs: NOW,
  });
  const library = createLibraryRepo(db).create({
    name: `lib-${flow.id}`,
    roots: [root],
    extensions: ['mkv'],
    flowId: flow.id,
    nowMs: NOW,
  });

  await scanLibrary({ db, libraryId: library.id, ffprobePath: 'ffprobe', nowMs: now });

  const claimed = createMediaFileRepo(db).claimNext({ workerClass: 'transcode', nowMs: NOW });
  if (claimed === null) throw new Error('setup failed to queue the sample file');
  return { root, claimed, flowId: flow.id };
};

describe.runIf(available)('runJob', () => {
  it('transcodes an h264 file, verifies it, replaces the original, and records a good ledger', async () => {
    const { root, claimed } = await setupClaimedFile({
      definition: TRANSCODE_FLOW,
      videoCodec: 'libx264',
    });
    expect(await videoCodecOf(claimed.path)).toBe('h264');
    const originalSize = statSync(claimed.path).size;

    const result = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    expect(result.state).toBe('good');
    expect(result.stepCount).toBe(7);

    // The library path now holds the transcode.
    expect(await videoCodecOf(claimed.path)).toBe('hevc');

    // The original is recoverable in trash, untouched.
    const trashDir = join(root, '.trawlarr', 'trash');
    const trashed = readdirSync(trashDir);
    expect(trashed).toHaveLength(1);
    const trashedPath = join(trashDir, trashed[0]!);
    expect(await videoCodecOf(trashedPath)).toBe('h264');
    expect(statSync(trashedPath).size).toBe(originalSize);

    // The ledger converged with the current signature stored.
    const ledger = createMediaFileRepo(db).getLedger(claimed.fileId);
    expect(ledger?.state).toBe('good');
    expect(ledger?.signature).toBeTruthy();
    expect(ledger?.attemptCount).toBe(0);

    // Every step was recorded, in order, ending with the replacement.
    const steps = createJobRepo(db).getSteps(result.jobId);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(steps.map((s) => s.pluginId)).toEqual([
      'trawlarr:start',
      'trawlarr:checkVideoCodec',
      'trawlarr:beginCommand',
      'trawlarr:setVideoEncoder',
      'trawlarr:execute',
      'trawlarr:verifyOutput',
      'trawlarr:replaceOriginal',
    ]);
    expect(steps.at(-1)?.outputNumber).toBe(1);
  }, 180_000);

  it('takes the already-correct branch on a second pass over the converged file, doing no ffmpeg work', async () => {
    const { root, claimed } = await setupClaimedFile({
      definition: TRANSCODE_FLOW,
      videoCodec: 'libx264',
    });
    const first = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(first.state).toBe('good');

    const trashDir = join(root, '.trawlarr', 'trash');
    const trashedBefore = readdirSync(trashDir);
    const convergedSize = statSync(claimed.path).size;

    // Same identity, run again directly — no requeue needed, runJob itself
    // does not gate on the row's stored `state` column.
    const second = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    expect(second.state).toBe('good');
    expect(second.stepCount).toBe(2);

    const steps = createJobRepo(db).getSteps(second.jobId);
    expect(steps.map((s) => s.pluginId)).toEqual(['trawlarr:start', 'trawlarr:checkVideoCodec']);

    // No ffmpeg work happened: nothing new in trash, file untouched.
    expect(readdirSync(trashDir)).toEqual(trashedBefore);
    expect(statSync(claimed.path).size).toBe(convergedSize);
    expect(await videoCodecOf(claimed.path)).toBe('hevc');
  }, 180_000);

  it('fails the job and holds the file with a backoff (not failed) on the first bad-plugin attempt', async () => {
    const { claimed } = await setupClaimedFile({ definition: BROKEN_FLOW, videoCodec: 'libx264' });

    const result = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    expect(result.state).toBe('held');
    expect(result.stepCount).toBe(2);

    const steps = createJobRepo(db).getSteps(result.jobId);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ pluginId: 'trawlarr:start', outputNumber: 1 });
    expect(steps[1]?.pluginId).toBe('trawlarr:does-not-exist');
    expect(steps[1]?.outputNumber).toBeNull();
    expect(steps[1]?.logExcerpt).toContain('ERROR:');

    const ledger = createMediaFileRepo(db).getLedger(claimed.fileId);
    expect(ledger?.state).toBe('held');
    expect(ledger?.attemptCount).toBe(1);
    expect(ledger?.holdUntilMs).not.toBeNull();
    expect(ledger?.holdUntilMs).toBeGreaterThan(NOW);

    const jobRows = createJobRepo(db).listForFile(claimed.fileId);
    expect(jobRows[0]?.state).toBe('failed');
  }, 60_000);

  it(
    'marks the ledger not_converging (the one-strike rule) when Replace swaps in a new ' +
      'inode holding byte-identical content',
    async () => {
      // NOTE: under the output-number-based `claimedModified` this test used
      // before I-4, a flow whose Replace step took the "nothing to replace,
      // already the file this flow produced" branch (no swap, no identity
      // change at all) was — incorrectly — read as a modification claim.
      // Judged by identity (see `runJob`'s `claimedModified`), that branch
      // correctly reports NO change, so it can no longer stand in for the
      // one-strike scenario. The one real-component way left to make
      // identity change while facts stay byte-for-byte identical is to
      // swap in a file that is a genuine copy, not the same file — see
      // `copyVerbatimFlow`.
      const { claimed } = await setupClaimedFile({
        definition: copyVerbatimFlow(),
        videoCodec: 'libx264',
      });
      const beforeSize = statSync(claimed.path).size;
      const beforeCodec = await videoCodecOf(claimed.path);
      const beforeRow = createMediaFileRepo(db).getById(claimed.fileId);

      const result = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });

      expect(result.state).toBe('not_converging');

      const steps = createJobRepo(db).getSteps(result.jobId);
      expect(steps.map((s) => s.pluginId)).toEqual([
        'trawlarr:start',
        expect.any(String), // the copy-verbatim plugin's absolute path
        'trawlarr:verifyOutput',
        'trawlarr:replaceOriginal',
      ]);
      expect(steps.at(-1)?.outputNumber).toBe(1);

      // Content is byte-for-byte the same the whole way through...
      expect(statSync(claimed.path).size).toBe(beforeSize);
      expect(await videoCodecOf(claimed.path)).toBe(beforeCodec);

      // ...but identity genuinely changed: a new inode, holding the SAME
      // content, replaced the old one. This is what makes it a real
      // "claimed modified" case rather than an early refusal (which would
      // leave the row's identity untouched).
      const afterRow = createMediaFileRepo(db).getById(claimed.fileId);
      expect(afterRow?.inode_key).not.toBe(beforeRow?.inode_key);
      expect(afterRow?.content_key).toBe(beforeRow?.content_key);

      const ledger = createMediaFileRepo(db).getLedger(claimed.fileId);
      expect(ledger?.state).toBe('not_converging');
      expect(ledger?.consecutiveNoopCount).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );
});

/**
 * Regression coverage for the convergence bug found by running the whole
 * loop end to end: Replace Original File swaps in a file with a NEW inode
 * and NEW content hash — both identity signals `upsertScanned` matches on —
 * at once, on every replacement. Left unrecorded on the row a job already
 * owns, the NEXT scan's identity lookup could not find that row (its stored
 * identity described a file that no longer existed) and opened a second row
 * for what looked like a brand new file. That row was immediately queued,
 * transcoded, and orphaned in turn — the library re-encoded the same file
 * forever and `alreadyGood` never left zero. `runJob` now calls
 * `mediaFileRepo.updateAfterRun` with the replaced file's real post-run
 * identity, path and stat so the row a job just finished IS the row the
 * next scan matches again.
 *
 * Both directions are asserted here, not just quiescence: a "fix" that
 * simply stopped ever re-queueing a `good` file would pass a
 * queues-nothing-once-good assertion while silently breaking the other half
 * of convergence — a flow edit must still reopen a converged file.
 */
describe.runIf(available)('convergence: scan / run / scan again', () => {
  const buildLibrary = async (definition: FlowDefinition) => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-converge-'));
    await makeSample(join(root, 'movie.mkv'), 'libx264');
    const flow = createFlowRepo(db).create({ name: 'flow', definition, nowMs: NOW });
    const library = createLibraryRepo(db).create({
      name: `lib-${flow.id}`,
      roots: [root],
      extensions: ['mkv'],
      flowId: flow.id,
      nowMs: NOW,
    });
    return { root, flow, library };
  };

  const drainQueue = async (libraryId: string) => {
    const mediaFileRepo = createMediaFileRepo(db);
    let ran = 0;
    for (;;) {
      const claimed = mediaFileRepo.claimNext({ workerClass: 'transcode', nowMs: NOW });
      if (claimed === null) break;
      if (claimed.libraryId !== libraryId) throw new Error('claimed a file from another library');
      await runJob({ db, claimed, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', nowMs: now });
      ran += 1;
    }
    return ran;
  };

  it('goes quiet once converged: the second scan reports alreadyGood and claimNext returns null', async () => {
    const { library } = await buildLibrary(TRANSCODE_FLOW);
    const mediaFileRepo = createMediaFileRepo(db);

    const scan1 = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(scan1.queued).toBe(1);
    expect(await drainQueue(library.id)).toBe(1);

    // Exactly one row describes this file: the run updated the SAME row
    // the scan created, rather than the next scan opening a second one.
    const rowsAfterRun = db.prepare('SELECT id FROM media_file').all();
    expect(rowsAfterRun).toHaveLength(1);

    const scan2 = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(scan2.alreadyGood).toBe(1);
    expect(scan2.queued).toBe(0);
    expect(mediaFileRepo.claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();

    // A THIRD scan is the real regression check: the bug re-triggered on
    // every pass, so one quiet scan alone would not have caught it.
    const scan3 = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(scan3.alreadyGood).toBe(1);
    expect(scan3.queued).toBe(0);
    expect(db.prepare('SELECT id FROM media_file').all()).toHaveLength(1);
  }, 120_000);

  it('leaves good and becomes claimable again once the flow it converged under is edited', async () => {
    const { library, flow } = await buildLibrary(TRANSCODE_FLOW);
    const mediaFileRepo = createMediaFileRepo(db);

    await scanLibrary({ db, libraryId: library.id, ffprobePath: 'ffprobe', nowMs: now });
    expect(await drainQueue(library.id)).toBe(1);

    const converged = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(converged.alreadyGood).toBe(1);
    expect(converged.queued).toBe(0);

    // Edit the flow: a different encoder quality changes flowDefinitionHash,
    // which is folded into the signature every converged file is checked
    // against.
    const edited: FlowDefinition = {
      ...TRANSCODE_FLOW,
      nodes: TRANSCODE_FLOW.nodes.map((node) =>
        node.id === 'encoder' ? { ...node, inputs: { encoder: 'libx265', quality: '10' } } : node,
      ),
    };
    createFlowRepo(db).update({ id: flow.id, definition: edited, nowMs: NOW + 1 });

    const afterEdit = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(afterEdit.queued).toBe(1);
    expect(afterEdit.alreadyGood).toBe(0);

    const ledger = mediaFileRepo.getLedger(
      (db.prepare('SELECT id FROM media_file').get() as { id: string }).id,
    );
    expect(ledger?.state).toBe('queued');

    expect(mediaFileRepo.claimNext({ workerClass: 'transcode', nowMs: NOW })).not.toBeNull();
  }, 120_000);
});

/** Same shape as TRANSCODE_FLOW, but Verify Output is impossible to satisfy. */
const REJECTING_VERIFY_FLOW: FlowDefinition = {
  ...TRANSCODE_FLOW,
  nodes: TRANSCODE_FLOW.nodes.map((node) =>
    node.id === 'verify'
      ? { ...node, inputs: { durationToleranceSeconds: '1', minSizeRatio: '0.99' } }
      : node,
  ),
};

/** TRANSCODE_FLOW with an unloadable node wired after a successful Replace. */
const FAIL_AFTER_REPLACE_FLOW: FlowDefinition = {
  nodes: [
    ...TRANSCODE_FLOW.nodes,
    { id: 'bad', pluginId: 'trawlarr:does-not-exist', pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [...TRANSCODE_FLOW.edges, { fromNodeId: 'replace', outputNumber: 1, toNodeId: 'bad' }],
};

/**
 * TRANSCODE_FLOW, but after a successful Replace it loops back into a SECOND
 * real encode that is never replaced in — ending with `currentPath` pointing
 * at a scratch file inside `workDir`, not the library file Replace produced.
 */
const LOOP_BACK_AFTER_REPLACE_FLOW: FlowDefinition = {
  nodes: [
    ...TRANSCODE_FLOW.nodes,
    { id: 'begin2', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'encoder2',
      pluginId: 'trawlarr:setVideoEncoder',
      pluginVersion: '1.0.0',
      inputs: { encoder: 'libx265', quality: '35' },
    },
    { id: 'execute2', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [
    ...TRANSCODE_FLOW.edges,
    { fromNodeId: 'replace', outputNumber: 1, toNodeId: 'begin2' },
    { fromNodeId: 'begin2', outputNumber: 1, toNodeId: 'encoder2' },
    { fromNodeId: 'encoder2', outputNumber: 1, toNodeId: 'execute2' },
    // execute2's outputs are deliberately left unconnected: the flow ends
    // with `currentPath` inside workDir either way.
  ],
};

/** A CommonJS plugin that records what the host handed it into the plugin document store. */
const diagPluginCode = (): string => `
const details = () => ({
  name: 'Diag Plugin',
  description: 'records host-supplied wiring for a test to assert on',
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

const plugin = async (args) => {
  await args.deps.crudTransDBN('DiagCollection', 'insert', 'diag', {
    librarySettingsName: args.librarySettings.name,
    libraryUserVar: args.userVariables.library.foo,
    footprintId: args.job.footprintId,
  });
  return {
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};

module.exports = { details, plugin };
`;

const writeDiagPlugin = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-diag-plugin-'));
  const abs = join(dir, 'index.js');
  writeFileSync(abs, diagPluginCode(), 'utf8');
  return abs;
};

/**
 * A CommonJS plugin standing in for Execute: copies the input file
 * byte-for-byte into `workDir` rather than transcoding it, so Replace swaps
 * in a file with a genuinely NEW inode but IDENTICAL content — the only
 * real-component way to construct "the flow claims a change and identity
 * really did change, but the facts are byte-for-byte the same", which is
 * what the one-strike rule exists to catch once `claimedModified` is judged
 * by identity rather than by output number.
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
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-copy-plugin-'));
  const abs = join(dir, 'index.js');
  writeFileSync(abs, copyVerbatimPluginCode(), 'utf8');
  return abs;
};

/**
 * A CommonJS plugin that ignores its own input entirely and copies a FIXED
 * source path (baked in at generation time) into `workDir` instead — used
 * to make one file's "transcode" deterministically produce bytes identical
 * to a DIFFERENT, already-tracked file, for the I-1 content-key-collision
 * test. Real `fs.copyFileSync`, no mocking of the engine or its runners.
 */
const copyFromPluginCode = (sourcePath: string): string => `
const fs = require('node:fs');
const path = require('node:path');

const details = () => ({
  name: 'Copy From Fixed Source',
  description: 'copies a fixed source path byte-for-byte, ignoring its own input',
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
  const dest = path.join(args.workDir, 'copy-from-source.mkv');
  fs.copyFileSync(${JSON.stringify(sourcePath)}, dest);
  return {
    outputNumber: 1,
    outputFileObj: { _id: dest },
    variables: args.variables,
  };
};

module.exports = { details, plugin };
`;

const writeCopyFromPlugin = (sourcePath: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-copy-from-plugin-'));
  const abs = join(dir, 'index.js');
  writeFileSync(abs, copyFromPluginCode(sourcePath), 'utf8');
  return abs;
};

/** start -> (byte-for-byte copy of `sourcePath`) -> verify -> replace. */
const copyFromFlow = (sourcePath: string): FlowDefinition => {
  const copyPath = writeCopyFromPlugin(sourcePath);
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
 * A CommonJS plugin that feeds a nonexistent path downstream — used to make
 * a SECOND `trawlarr:replaceOriginal` node refuse (its `statFile(newPath)`
 * fails), so its own reported path is the true `originalLibraryFile._id`
 * rather than a trivial "already there" no-op. See the I-5 test for why.
 */
const sabotagePluginCode = (): string => `
const details = () => ({
  name: 'Sabotage',
  description: 'feeds a nonexistent path downstream, for testing a Replace refusal',
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

const plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: '/nonexistent/trawlarr-test-path/should-not-exist.mkv' },
  variables: args.variables,
});

module.exports = { details, plugin };
`;

const writeSabotagePlugin = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-sabotage-plugin-'));
  const abs = join(dir, 'index.js');
  writeFileSync(abs, sabotagePluginCode(), 'utf8');
  return abs;
};

/**
 * A CommonJS plugin that forces the in-flight ffmpeg command's container,
 * so a Replace node downstream genuinely changes the library file's
 * extension (and therefore its path) rather than replacing in place. Placed
 * after Set Video Encoder and before Execute in the I-5 test.
 */
const setContainerPluginCode = (container: string): string => `
const details = () => ({
  name: 'Set Container',
  description: 'forces the in-flight ffmpeg command container',
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
  args.variables.ffmpegCommand.container = ${JSON.stringify(container)};
  return {
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};

module.exports = { details, plugin };
`;

const writeSetContainerPlugin = (container: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-set-container-plugin-'));
  const abs = join(dir, 'index.js');
  writeFileSync(abs, setContainerPluginCode(container), 'utf8');
  return abs;
};

/** start -> (byte-for-byte copy) -> verify -> replace, using the plugin above. */
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
 * TRANSCODE_FLOW with an encoder no ffmpeg build has, so Execute's ffmpeg
 * child really exits non-zero and the node really routes to its own failure
 * output (2), which the canonical flow — like this one — wires nowhere.
 *
 * Deliberately a nonsense encoder name rather than `hevc_nvenc` (the
 * real-world trigger: the most common first-run misconfiguration is a
 * hardware encoder on a host without that hardware). A host WITH an NVIDIA
 * card would transcode successfully and this test would silently prove
 * nothing there; an encoder no build has fails identically everywhere.
 */
const FAILING_ENCODE_FLOW: FlowDefinition = {
  ...TRANSCODE_FLOW,
  nodes: TRANSCODE_FLOW.nodes.map((node) =>
    node.id === 'encoder'
      ? { ...node, inputs: { encoder: 'no_such_encoder_exists', quality: '30' } }
      : node,
  ),
};

describe.runIf(available)('runJob: rejection, persistence and stall regressions', () => {
  it(
    'Critical C1: ffmpeg exiting non-zero, on a node whose failure output the flow routes ' +
      'nowhere, is not convergence',
    async () => {
      const { claimed } = await setupClaimedFile({
        definition: FAILING_ENCODE_FLOW,
        videoCodec: 'libx264',
      });
      const beforeRow = createMediaFileRepo(db).getById(claimed.fileId);
      const beforeSize = statSync(claimed.path).size;

      const result = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });

      // Nothing was transcoded, so nothing converged. `good` here is the
      // whole defect: it stores the PRE-transcode signature, which
      // `isKnownGood` then matches on every future scan — a library that
      // reports "100% converged" with every file still h264.
      expect(result.state).not.toBe('good');
      expect(result.state).toBe('held');

      const row = createMediaFileRepo(db).getById(claimed.fileId);
      expect(row?.state).toBe('held');
      expect(row?.signature).toBeNull();
      expect(row?.attempt_count).toBe(1);
      expect(row?.hold_until_ms).not.toBeNull();

      // The file on disk is untouched: same codec, same bytes, same identity.
      expect(await videoCodecOf(claimed.path)).toBe('h264');
      expect(statSync(claimed.path).size).toBe(beforeSize);
      expect(row?.content_key).toBe(beforeRow?.content_key);

      // Execute really ran and really reported its own failure output.
      const steps = createJobRepo(db).getSteps(result.jobId);
      expect(steps.at(-1)).toMatchObject({ pluginId: 'trawlarr:execute', outputNumber: 2 });

      // And the reason is recorded, in the database, on that step: without
      // the runner's `log` wired through, the excerpt is empty and there is
      // no record anywhere of WHY the encode failed.
      expect(steps.at(-1)?.logExcerpt).toMatch(/ffmpeg failed \(code \d+\)/);

      const jobRows = createJobRepo(db).listForFile(claimed.fileId);
      expect(jobRows[0]?.state).toBe('failed');
    },
    120_000,
  );

  it('Critical 1: a Verify Output rejection with no remediation route does not converge to good', async () => {
    const { claimed } = await setupClaimedFile({
      definition: REJECTING_VERIFY_FLOW,
      videoCodec: 'libx264',
    });
    const beforeCodec = await videoCodecOf(claimed.path);

    const result = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    // Rejected, not converged: `end-of-flow` at Verify's reject output is
    // the safety net firing, not success.
    expect(result.state).not.toBe('good');
    expect(result.state).toBe('held');

    const steps = createJobRepo(db).getSteps(result.jobId);
    expect(steps.at(-1)).toMatchObject({ pluginId: 'trawlarr:verifyOutput', outputNumber: 2 });

    // Nothing was ever replaced.
    expect(await videoCodecOf(claimed.path)).toBe(beforeCodec);

    const row = createMediaFileRepo(db).getById(claimed.fileId);
    expect(row?.state).toBe('held');
    expect(row?.attempt_count).toBe(1);
    expect(row?.hold_until_ms).not.toBeNull();

    const jobRows = createJobRepo(db).listForFile(claimed.fileId);
    expect(jobRows[0]?.state).toBe('failed');
  }, 60_000);

  it(
    'Critical 2: a failure after a successful Replace still persists the replacement, ' +
      'so a retry does not re-transcode the already-good file',
    async () => {
      const { claimed } = await setupClaimedFile({
        definition: FAIL_AFTER_REPLACE_FLOW,
        videoCodec: 'libx264',
      });

      const first = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });

      // The flow failed overall (the node after Replace could not load)...
      expect(first.state).not.toBe('good');

      // ...but the replacement on disk genuinely happened.
      expect(await videoCodecOf(claimed.path)).toBe('hevc');

      // And it was persisted: the row's own denormalised codec column
      // (derived by `setProbe` from the facts this run recorded) already
      // says hevc, without needing a second scan.
      const mediaFileRepo = createMediaFileRepo(db);
      const rowAfterFirst = mediaFileRepo.getById(claimed.fileId);
      expect(rowAfterFirst?.video_codec).toBe('hevc');

      // A retry must not re-discover this file as h264 from a stale probe
      // and burn a second, unnecessary transcode (with generational loss)
      // on an already-good file. checkVideoCodec takes the short branch.
      const second = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });
      const secondSteps = createJobRepo(db).getSteps(second.jobId);
      expect(secondSteps.map((s) => s.pluginId)).toEqual([
        'trawlarr:start',
        'trawlarr:checkVideoCodec',
      ]);
      expect(await videoCodecOf(claimed.path)).toBe('hevc');
    },
    120_000,
  );

  it(
    'I-4: a SINGLE Replace step that swaps the file in for real and STILL reports ' +
      'output 2 (a companion move that splits) still gets the change recorded',
    async () => {
      // The exact branch named in review: `replace-original.ts`'s
      // companion-split failure (around line 929) — `describeReplacement`
      // already ran (the media swap landed for real) before `moveCompanions`
      // throws and the node returns output 2. Round 1 could not reach this
      // black-box (no privilege to force a real EACCES/EXDEV on a
      // same-directory rename in this sandbox — verified empirically:
      // `chattr +i` denied, `chmod 000` does not block `rename()` on Linux).
      // The fix for THAT gap is `RunJobInput.moveCompanions`: an injectable
      // seam at the composition root, defaulting to the real implementation
      // in production, that lets a test force the exact failure without
      // touching engine internals or mocking anything else. The companion
      // move below is REAL (a real file really moves) up until the
      // synthetic throw that stands in for the permission/device failure
      // itself.
      const { root, claimed } = await setupClaimedFile({
        definition: TRANSCODE_FLOW,
        videoCodec: 'libx264',
      });
      writeFileSync(join(root, 'sample.srt'), 'subtitles', 'utf8');
      const beforeRow = createMediaFileRepo(db).getById(claimed.fileId);

      const result = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
        moveCompanions: async (moveInput) => {
          await moveCompanionsReal(moveInput);
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      });

      // The job failed — exactly ONE Replace step ran, and it reported
      // output 2.
      expect(result.state).not.toBe('good');
      const steps = createJobRepo(db).getSteps(result.jobId);
      const replaceSteps = steps.filter((s) => s.pluginId === 'trawlarr:replaceOriginal');
      expect(replaceSteps).toHaveLength(1);
      expect(replaceSteps[0]?.outputNumber).toBe(2);

      // The library file WAS genuinely replaced, on disk...
      expect(await videoCodecOf(claimed.path)).toBe('hevc');

      // ...and — the point of I-4 — that change was RECORDED even though
      // this SAME, SOLE Replace step ended in failure. Round 1's
      // `steps.some(replace && output === 1)` shape is definitionally
      // false here (there is exactly one Replace step and its output is
      // 2), so this is the one test in the suite where reverting to that
      // shape provably fails (see the task report for the pasted output).
      const afterRow = createMediaFileRepo(db).getById(claimed.fileId);
      expect(afterRow?.video_codec).toBe('hevc');
      expect(afterRow?.inode_key).not.toBe(beforeRow?.inode_key);
      expect(afterRow?.content_key).not.toBe(beforeRow?.content_key);
    },
    120_000,
  );

  it(
    'I-5: a later Replace refusing with a now-stale pre-run path does not stall a run ' +
      "whose earlier Replace's real, container-changing swap already landed",
    async () => {
      // Two Replace nodes, with a real container change (mkv -> mp4) forced
      // by a small custom node before Execute: the first Replace really
      // swaps `sample.mkv` for `sample.mp4` — `sample.mkv` genuinely no
      // longer exists afterward, moved to trash. A sabotage node then feeds
      // a nonexistent path into a SECOND Replace, which refuses and reports
      // ITS OWN `originalLibraryFile._id` — the PRE-RUN path, `sample.mkv`
      // — correctly, by that node's own contract, but that path is now
      // gone. Before this fix, stat-ing it for identity comparison threw
      // ENOENT and the whole run stalled, discarding the first Replace's
      // real swap: `OUTCOME: Unhandled error: ENOENT ... stat '.../
      // sample.mkv' | STATE: held`, exactly as reproduced in review.
      const containerPath = writeSetContainerPlugin('mp4');
      const sabotagePath = writeSabotagePlugin();
      const changeContainerFlow: FlowDefinition = {
        nodes: [
          ...TRANSCODE_FLOW.nodes.filter((n) => n.id !== 'replace'),
          { id: 'setContainer', pluginId: containerPath, pluginVersion: '1.0.0', inputs: {} },
          {
            id: 'replace1',
            pluginId: 'trawlarr:replaceOriginal',
            pluginVersion: '1.0.0',
            inputs: { trashRetentionDays: '14', allowCrossDevice: 'true' },
          },
          { id: 'sabotage', pluginId: sabotagePath, pluginVersion: '1.0.0', inputs: {} },
          {
            id: 'replace2',
            pluginId: 'trawlarr:replaceOriginal',
            pluginVersion: '1.0.0',
            inputs: { trashRetentionDays: '14', allowCrossDevice: 'true' },
          },
        ],
        edges: [
          ...TRANSCODE_FLOW.edges.filter(
            (e) => e.toNodeId !== 'replace' && e.toNodeId !== 'execute',
          ),
          { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'setContainer' },
          { fromNodeId: 'setContainer', outputNumber: 1, toNodeId: 'execute' },
          { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace1' },
          { fromNodeId: 'replace1', outputNumber: 1, toNodeId: 'sabotage' },
          { fromNodeId: 'sabotage', outputNumber: 1, toNodeId: 'replace2' },
        ],
      };

      const { root, claimed } = await setupClaimedFile({
        definition: changeContainerFlow,
        videoCodec: 'libx264',
      });
      const beforeRow = createMediaFileRepo(db).getById(claimed.fileId);
      const mp4Path = join(root, 'sample.mp4');

      const result = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });

      // Confirm the premise: the container really changed and the old path
      // is really gone — otherwise this would not be testing I-5 at all.
      expect(existsSync(claimed.path)).toBe(false);
      expect(existsSync(mp4Path)).toBe(true);

      // Did NOT stall: no unhandled ENOENT, a real job outcome instead.
      expect(result.outcome).not.toContain('ENOENT');
      expect(result.outcome).not.toContain('Unhandled error');

      // replace1's real swap is still on disk...
      expect(await videoCodecOf(mp4Path)).toBe('hevc');

      // ...and was NOT discarded: the row now points at the real, current
      // path and identity, not the stale pre-run ones.
      const afterRow = createMediaFileRepo(db).getById(claimed.fileId);
      expect(afterRow?.path).toBe(mp4Path);
      expect(afterRow?.container).toBe('mp4');
      expect(afterRow?.video_codec).toBe('hevc');
      expect(afterRow?.inode_key).not.toBe(beforeRow?.inode_key);
      expect(afterRow?.content_key).not.toBe(beforeRow?.content_key);
    },
    120_000,
  );

  it(
    'Critical 3 / I-7: an unexpected error (library reconfigured mid-flight) stalls the ' +
      'file instead of stranding it in running forever, and still records a real job ' +
      'row and a correct last_run_id pointer',
    async () => {
      const { claimed } = await setupClaimedFile({
        definition: TRANSCODE_FLOW,
        videoCodec: 'libx264',
      });
      const mediaFileRepo = createMediaFileRepo(db);
      const jobRepo = createJobRepo(db);
      const libraryRepo = createLibraryRepo(db);

      // A first, REAL successful run — so there is a genuine prior job row
      // and a genuine prior `last_run_id` this test can prove the failed
      // attempt below does not silently reuse or erase.
      const first = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });
      expect(first.state).toBe('good');
      const rowAfterFirst = mediaFileRepo.getById(claimed.fileId);
      expect(rowAfterFirst?.last_run_id).toBe(first.jobId);
      const jobCountAfterFirst = jobRepo.listForFile(claimed.fileId).length;
      expect(jobCountAfterFirst).toBe(1);

      // Simulate the library's flow being cleared between claim and a
      // SECOND run — the row is claimed again by re-using the same
      // `claimed` reference directly (this test is about `runJob`'s own
      // failure handling, not the queue), and nothing but `runJob` itself
      // can ever move a `running` row out of that state.
      libraryRepo.setFlow(claimed.libraryId, null);

      const result = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });

      // Did not throw, and did not leave the row `running`.
      expect(result.state).not.toBe('running');
      expect(result.state).toBe('held');

      const row = mediaFileRepo.getById(claimed.fileId);
      expect(row?.state).not.toBe('running');
      expect(row?.state).toBe('held');
      expect(row?.attempt_count).toBe(1);
      expect(row?.hold_until_ms).not.toBeNull();

      // I-7: this failure — which happens BEFORE `jobRepo.start` would
      // normally run, since the library/flow lookup is what fails — still
      // produces a REAL, distinct job row (not zero, not a reuse of the
      // first run's), and the row's `last_run_id` POINTER moves on to it
      // rather than being erased (a stray `null`) or left pointing at the
      // now-stale first run.
      expect(result.jobId).not.toBe('');
      expect(result.jobId).not.toBe(first.jobId);
      expect(row?.last_run_id).not.toBeNull();
      expect(row?.last_run_id).toBe(result.jobId);
      const jobsAfterSecond = jobRepo.listForFile(claimed.fileId);
      expect(jobsAfterSecond).toHaveLength(jobCountAfterFirst + 1);
      expect(jobsAfterSecond.some((j) => j.id === result.jobId)).toBe(true);
    },
    120_000,
  );

  it('Critical 4: the stored signature is derived from the ACTUAL post-run facts, not the pre-run ones', async () => {
    const { claimed } = await setupClaimedFile({
      definition: TRANSCODE_FLOW,
      videoCodec: 'libx264',
    });

    const preProbe = await probeFile({ ffprobePath: 'ffprobe', path: claimed.path });
    const preFacts = extractFacts({
      probe: preProbe,
      container: 'mkv',
      sizeBytes: statSync(claimed.path).size,
    });

    const result = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(result.state).toBe('good');

    const flowRow = createFlowRepo(db).getByName('flow');
    const flowHash = flowRow!.definitionHash;

    const postProbe = await probeFile({ ffprobePath: 'ffprobe', path: claimed.path });
    const postFacts = extractFacts({
      probe: postProbe,
      container: 'mkv',
      sizeBytes: statSync(claimed.path).size,
    });

    const ledger = createMediaFileRepo(db).getLedger(claimed.fileId);
    const preSignature = computeSignature({ flowDefinitionHash: flowHash, facts: preFacts });
    const postSignature = computeSignature({ flowDefinitionHash: flowHash, facts: postFacts });

    expect(ledger?.signature).toBe(postSignature);
    expect(ledger?.signature).not.toBe(preSignature);
  }, 60_000);

  it(
    'Critical 4: wires the real LibraryRecord, the library user variables, a stable ' +
      'footprintId and a durable (sqlite-backed) document store into every plugin invocation',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'trawlarr-diag-'));
      await makeSample(join(root, 'sample.mkv'), 'libx264');
      const diagPath = writeDiagPlugin();

      const definition: FlowDefinition = {
        nodes: [
          { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
          { id: 'diag', pluginId: diagPath, pluginVersion: '1.0.0', inputs: {} },
        ],
        edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'diag' }],
      };
      const flow = createFlowRepo(db).create({ name: 'diag-flow', definition, nowMs: NOW });
      const library = createLibraryRepo(db).create({
        name: 'diag-lib',
        roots: [root],
        extensions: ['mkv'],
        flowId: flow.id,
        nowMs: NOW,
      });
      db.prepare(`UPDATE library SET user_variables_json = ? WHERE id = ?`).run(
        JSON.stringify({ foo: 'bar' }),
        library.id,
      );

      await scanLibrary({ db, libraryId: library.id, ffprobePath: 'ffprobe', nowMs: now });
      const mediaFileRepo = createMediaFileRepo(db);
      const claimed = mediaFileRepo.claimNext({ workerClass: 'transcode', nowMs: NOW });
      if (claimed === null) throw new Error('setup failed to queue the sample file');
      const row = mediaFileRepo.getById(claimed.fileId);

      await runJob({ db, claimed, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', nowMs: now });

      // Read back through the SAME repo `deps.crudTransDBN` is backed by —
      // proving the document genuinely landed in sqlite, not a throwaway
      // in-memory map that would vanish with the job.
      const doc = createPluginDocumentRepo(db).get('DiagCollection', 'diag');
      expect(doc).toEqual({
        librarySettingsName: 'diag-lib', // the real LibraryRecord, not {}
        libraryUserVar: 'bar', // library.userVariables, not {}
        footprintId: row?.inode_key, // stable identity, not row.path
      });
      expect(doc?.footprintId).toMatch(/^\d+:\d+$/); // an inode key, not a filesystem path
    },
    60_000,
  );

  it(
    'Important 6: the post-run probe targets what Replace actually produced, not whatever ' +
      'the flow does afterward inside workDir',
    async () => {
      const { claimed } = await setupClaimedFile({
        definition: LOOP_BACK_AFTER_REPLACE_FLOW,
        videoCodec: 'libx264',
      });

      const result = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });
      expect(result.state).toBe('good');

      // The library path holds a real, playable hevc file — not a dangling
      // reference to a workDir scratch file the `finally` already deleted.
      expect(await videoCodecOf(claimed.path)).toBe('hevc');
      const onDiskSize = statSync(claimed.path).size;

      const row = createMediaFileRepo(db).getById(claimed.fileId);
      // The row's own size (persisted by `updateAfterRun`) matches the REAL
      // library file, not a scratch file that no longer exists.
      expect(row?.size_bytes).toBe(onDiskSize);
      expect(row?.video_codec).toBe('hevc');
    },
    120_000,
  );

  it('Important 7: heartbeat_at advances as the flow progresses, not just at job start', async () => {
    const { claimed } = await setupClaimedFile({
      definition: TRANSCODE_FLOW,
      videoCodec: 'libx264',
    });

    let tick = NOW;
    const advancing = () => {
      tick += 1;
      return tick;
    };

    const result = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: advancing,
    });

    const jobRow = db
      .prepare(`SELECT started_at, heartbeat_at FROM job WHERE id = ?`)
      .get(result.jobId) as { started_at: number; heartbeat_at: number | null };
    expect(jobRow.heartbeat_at).not.toBeNull();
    // A bound of `> started_at` alone is satisfied by the start-of-job
    // heartbeat ALONE (it is one `advancing()` tick after `started_at` by
    // construction), so it cannot tell "only the start heartbeat ran" apart
    // from "the per-step heartbeat also ran" — exactly the mutation that
    // needs killing. `>= started_at + stepCount` requires at least one
    // MORE tick per step beyond the start heartbeat, which only holds if
    // the per-step heartbeat call is still there.
    expect(jobRow.heartbeat_at!).toBeGreaterThanOrEqual(jobRow.started_at + result.stepCount);
  }, 60_000);

  it(
    'Minor 5: a flow with no start node still records the start-of-job heartbeat, ' +
      'with zero steps to mask its absence',
    async () => {
      // No node here has `isStartPlugin: true`, and `runJob` passes no
      // explicit `startNodeId`, so `runFlow` cannot find a start node: it
      // returns `stopReason: 'no-start-node'` with `steps: []` — no
      // `onStep` ever fires, so the per-step heartbeat literally cannot
      // run. This isolates the start-of-job heartbeat completely: unlike
      // Important 7's real multi-step flow, there is no "many other
      // `nowMs()` calls dwarf the difference" escape hatch here, no tick
      // coupling, and no timing/polling involved — a `heartbeat_at` read
      // after the run is either null (start heartbeat missing) or not
      // (present), full stop.
      const definition: FlowDefinition = {
        nodes: [
          {
            id: 'x',
            pluginId: 'trawlarr:checkVideoCodec',
            pluginVersion: '1.0.0',
            inputs: { codec: 'hevc' },
          },
        ],
        edges: [],
      };
      const { claimed } = await setupClaimedFile({ definition, videoCodec: 'libx264' });

      const result = await runJob({
        db,
        claimed,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        nowMs: now,
      });

      expect(result.stepCount).toBe(0);
      expect(result.outcome).toContain('no start node');

      const jobRow = db.prepare(`SELECT heartbeat_at FROM job WHERE id = ?`).get(result.jobId) as {
        heartbeat_at: number | null;
      };
      expect(jobRow.heartbeat_at).not.toBeNull();
    },
    30_000,
  );
});

/**
 * I-1: a realistic content-key collision — restoring a previous original
 * beside its own already-transcoded copy, where a deterministic re-encode
 * reproduces the copy byte-for-byte — must be handled explicitly (a clear,
 * actionable outcome) and atomically (no split state: `setProbe` must not
 * survive on its own when `updateAfterRun` throws for the same run).
 *
 * Built without depending on ffmpeg's own determinism across two encodes
 * (verified separately, empirically, NOT to hold for this fixture — two
 * encodes of identical input differed at byte 221, almost certainly a
 * muxer timestamp): file B starts as a DISTINCT sample (so its initial scan
 * gets its own row and content_key, not an immediate collision), and B's
 * OWN flow then copies file A's CURRENT library content — byte-for-byte —
 * into B's slot, so B's post-run content_key is guaranteed to equal A's by
 * construction, not by chance.
 */
describe.runIf(available)('runJob: I-1 identity conflict handling', () => {
  it('handles a content-key collision explicitly and atomically, with no split state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-conflict-'));
    await makeSample(join(root, 'a.mkv'), 'libx264');
    await makeAltSample(join(root, 'b.mkv'), 'libx264');

    const flowA = createFlowRepo(db).create({
      name: 'copy-flow-a',
      definition: copyVerbatimFlow(),
      nowMs: NOW,
    });
    const library = createLibraryRepo(db).create({
      name: 'conflict-lib',
      roots: [root],
      extensions: ['mkv'],
      flowId: flowA.id,
      nowMs: NOW,
    });
    const libraryRepo = createLibraryRepo(db);
    const mediaFileRepo = createMediaFileRepo(db);

    // Both files are discovered up front, each with its own distinct
    // content_key (different samples) — no collision yet. Both are
    // claimed immediately (order between them is not guaranteed, so both
    // are drained and identified by path) — B being `running` a little
    // early does not matter, since `runJob` never reads a row's `state`.
    await scanLibrary({ db, libraryId: library.id, ffprobePath: 'ffprobe', nowMs: now });
    expect(db.prepare(`SELECT id FROM media_file`).all()).toHaveLength(2);

    const claims = [
      mediaFileRepo.claimNext({ workerClass: 'transcode', nowMs: NOW }),
      mediaFileRepo.claimNext({ workerClass: 'transcode', nowMs: NOW }),
    ];
    const claimedA = claims.find((c) => c?.path === join(root, 'a.mkv')) ?? null;
    const claimedB0 = claims.find((c) => c?.path === join(root, 'b.mkv')) ?? null;
    if (claimedA === null || claimedB0 === null) {
      throw new Error('setup failed to queue both files');
    }

    // File A: run for real (copies its own bytes back in, unchanged), so
    // it owns a stable, real content_key in this library.
    await runJob({
      db,
      claimed: claimedA,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    const rowA = mediaFileRepo.getById(claimedA.fileId);
    expect(rowA?.content_key).toBeTruthy();

    // Point the library at a flow for B that copies A's CURRENT content
    // byte-for-byte into B's own slot. `runJob` reads `library.flowId`
    // fresh at run time (not at claim time), so switching it now applies
    // to B's run below without needing to re-claim B.
    const flowB = createFlowRepo(db).create({
      name: 'copy-flow-b',
      definition: copyFromFlow(claimedA.path),
      nowMs: NOW,
    });
    libraryRepo.setFlow(library.id, flowB.id);
    const claimedB = claimedB0;

    const beforeRowB = mediaFileRepo.getById(claimedB.fileId);

    const resultB = await runJob({
      db,
      claimed: claimedB,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    // Explicit: the outcome names the real cause, not a bare generic
    // message a human would have to go spelunking for.
    expect(resultB.outcome).toContain('already matches another tracked file');
    expect(resultB.state).not.toBe('good');

    // M-1 / atomicity: row B's probe/codec/container/size/identity are
    // COMPLETELY UNCHANGED from before this run. Without the transaction,
    // `setProbe` would have already committed (new probe_json, new
    // video_codec) by the time `updateAfterRun` threw on the UNIQUE
    // violation, leaving exactly the split state this mechanism exists to
    // prevent: new codec columns, old identity/size/path.
    const afterRowB = mediaFileRepo.getById(claimedB.fileId);
    expect(afterRowB?.video_codec).toBe(beforeRowB?.video_codec);
    expect(afterRowB?.container).toBe(beforeRowB?.container);
    expect(afterRowB?.size_bytes).toBe(beforeRowB?.size_bytes);
    expect(afterRowB?.probe_json).toBe(beforeRowB?.probe_json);
    expect(afterRowB?.inode_key).toBe(beforeRowB?.inode_key);
    expect(afterRowB?.content_key).toBe(beforeRowB?.content_key);

    // Row A is completely undisturbed by B's failed attempt.
    const rowAAfter = mediaFileRepo.getById(claimedA.fileId);
    expect(rowAAfter?.content_key).toBe(rowA?.content_key);

    // Exactly two rows exist — B's failure did not fork a third.
    expect(db.prepare(`SELECT id FROM media_file`).all()).toHaveLength(2);
  }, 120_000);
});

/**
 * Critical C2: `Replace Original File` renames the new file into place, and
 * only AFTER `runJob` has probed it does `updateAfterRun` record the new
 * identity. Between those two points the on-disk file has an identity no row
 * claims — and `trawlarr scan` and `trawlarr run` are separate processes
 * against the same WAL database, which is the normal deployment, so a scan
 * really can walk that path inside the window.
 *
 * The scan matched nothing, inserted a SECOND row, and `updateAfterRun` then
 * hit `UNIQUE (library_id, content_key)` and unwound the run into a stall:
 * a ghost row keeping the PRE-transcode probe (claimed again after its
 * backoff, re-transcoding the already-hevc file with generational loss and
 * pushing the good result into trash) beside a second row for the same file,
 * both eventually `good` — "100% converged", one of them a permanent
 * phantom whose content exists only in trash. `NEVER_REQUEUE_STATES` could
 * not help: the file the scanner walked was associated with no row at all,
 * let alone the `running` one.
 *
 * The window is FORCED here, not raced: the scan is injected at the
 * `moveCompanions` seam, which `replaceOriginal` reaches after the media
 * swap has already landed and long before `updateAfterRun` runs. A test that
 * merely started a scan concurrently and hoped for the interleaving passes
 * against the broken code most of the time (see the P2 prerequisites note on
 * concurrency tests).
 */
describe.runIf(available)('runJob: C2 — a scan inside the replacement window', () => {
  it('does not open a second row for the file a running job is replacing', async () => {
    const { claimed } = await setupClaimedFile({
      definition: TRANSCODE_FLOW,
      videoCodec: 'libx264',
    });
    const mediaFileRepo = createMediaFileRepo(db);
    const beforeRow = mediaFileRepo.getById(claimed.fileId);
    const injected: ScanSummary[] = [];

    const result = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
      // The real companion move still happens; the scan is what this seam
      // is standing in for — any scanner walking this root at this instant.
      moveCompanions: async (moveInput) => {
        await moveCompanionsReal(moveInput);
        injected.push(
          await scanLibrary({
            db,
            libraryId: claimed.libraryId,
            ffprobePath: 'ffprobe',
            nowMs: now,
          }),
        );
      },
    });

    // The scan saw the swapped-in file and left it alone: it belongs to a
    // run in flight, not to a new library file.
    expect(injected).toHaveLength(1);
    expect(injected[0]?.added).toBe(0);
    expect(injected[0]?.queued).toBe(0);

    // Exactly ONE row describes this file, and it is the row the job owns.
    const rows = db.prepare('SELECT id, state, path, video_codec FROM media_file').all() as {
      id: string;
      state: string;
      path: string;
      video_codec: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(claimed.fileId);

    // The run converged rather than unwinding into a stall...
    expect(result.state).toBe('good');
    expect(rows[0]?.state).toBe('good');

    // ...on the POST-transcode facts: no stale probe left to make a later
    // claim re-transcode an already-hevc file.
    expect(await videoCodecOf(claimed.path)).toBe('hevc');
    expect(rows[0]?.video_codec).toBe('hevc');
    const afterRow = mediaFileRepo.getById(claimed.fileId);
    expect(afterRow?.content_key).not.toBe(beforeRow?.content_key);

    // Nothing is claimable: no ghost waiting out a backoff.
    expect(mediaFileRepo.claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();

    // And a normal scan AFTER the run recognises that same row as converged.
    const after = await scanLibrary({
      db,
      libraryId: claimed.libraryId,
      ffprobePath: 'ffprobe',
      nowMs: now,
    });
    expect(after.alreadyGood).toBe(1);
    expect(after.added).toBe(0);
    expect(after.queued).toBe(0);
    expect(db.prepare('SELECT id FROM media_file').all()).toHaveLength(1);
  }, 180_000);
});
