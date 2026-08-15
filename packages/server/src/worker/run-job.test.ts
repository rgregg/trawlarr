import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
import { scanLibrary } from '../scanner/scan-library.js';
import { probeFile } from '../probe/ffprobe.js';
import { runJob } from './run-job.js';

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const now = () => NOW;

const hasFfmpegSync = (): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const available = hasFfmpegSync();

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

/**
 * No codec check, no encoder — Execute always finds nothing to do
 * (`deriveShouldProcess` false), Verify trivially passes an unchanged file
 * against itself, and Replace's "already the file this flow produced"
 * branch fires. Every one of these nodes still reports success (output 1),
 * so the flow CLAIMS to have modified the file while nothing on disk moved
 * — the scenario `applyRunOutcome`'s one-strike rule exists to catch.
 */
const NOOP_FLOW: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
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
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'begin' },
    { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'execute' },
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

  it('marks the ledger not_converging (the one-strike rule) when the flow claims a change but nothing moved', async () => {
    const { claimed } = await setupClaimedFile({ definition: NOOP_FLOW, videoCodec: 'libx264' });
    const beforeSize = statSync(claimed.path).size;
    const beforeCodec = await videoCodecOf(claimed.path);

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
      'trawlarr:beginCommand',
      'trawlarr:execute',
      'trawlarr:verifyOutput',
      'trawlarr:replaceOriginal',
    ]);
    // Replace reported success (its "nothing to replace" branch), which is
    // exactly the claim the file was modified.
    expect(steps.at(-1)?.outputNumber).toBe(1);

    // Nothing actually moved.
    expect(statSync(claimed.path).size).toBe(beforeSize);
    expect(await videoCodecOf(claimed.path)).toBe(beforeCodec);

    const ledger = createMediaFileRepo(db).getLedger(claimed.fileId);
    expect(ledger?.state).toBe('not_converging');
    expect(ledger?.consecutiveNoopCount).toBeGreaterThanOrEqual(1);
  }, 60_000);
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

describe.runIf(available)('runJob: rejection, persistence and stall regressions', () => {
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
    'Critical 3: an unexpected error (library reconfigured mid-flight) stalls the file ' +
      'instead of stranding it in running forever',
    async () => {
      const { claimed } = await setupClaimedFile({
        definition: TRANSCODE_FLOW,
        videoCodec: 'libx264',
      });

      const libraryRepo = createLibraryRepo(db);
      // Simulate the library's flow being cleared between claim and run —
      // the row is already `running` (claimNext set that), and nothing but
      // `runJob` itself can ever move it out of that state.
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

      const row = createMediaFileRepo(db).getById(claimed.fileId);
      expect(row?.state).not.toBe('running');
      expect(row?.state).toBe('held');
      expect(row?.attempt_count).toBe(1);
      expect(row?.hold_until_ms).not.toBeNull();
    },
    60_000,
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
    // Started at the FIRST advancing() call; by the time a 7-step flow
    // finishes, several more calls have happened, so a heartbeat recorded
    // per step must read later than job start.
    expect(jobRow.heartbeat_at!).toBeGreaterThan(jobRow.started_at);
  }, 60_000);
});
