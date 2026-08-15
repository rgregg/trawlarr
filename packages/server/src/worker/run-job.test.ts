import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
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
import { createJobRepo } from '../db/job-repo.js';
import { scanLibrary } from '../scanner/scan-library.js';
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
