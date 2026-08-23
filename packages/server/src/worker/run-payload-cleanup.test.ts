import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { sweepStaging } from '../library/staging-sweep.js';
import { createMediaFileRepo, type ClaimedFile } from '../db/media-file-repo.js';
import { scanLibrary } from '../scanner/scan-library.js';
import { runJob } from './run-job.js';
import { toolAvailableSync } from '../../../../test-support/tool-availability.js';

/**
 * CLEANUP MUST NOT BE ABLE TO DECIDE A JOB'S OUTCOME.
 *
 * `runPayload` removes its scratch directory in a `finally` that wraps its
 * own `return`. That placement is what makes an ordinary housekeeping error
 * dangerous: a throw from it does not merely leak a directory, it REPLACES
 * the report of the run that just finished. On the success path — and it
 * runs on the success path — a completed, verified, correctly installed
 * conversion is then handed to `applyThrownFailure` instead of
 * `applyJobReport`. The row is backed off holding its PRE-transcode
 * identity while the file on disk carries the post-transcode one, and when
 * the backoff expires the flow runs again and transcodes a file that was
 * already correct, pushing the good copy into trash.
 *
 * This was not hypothetical. On the owner's 8.4 TB NFS library the removal
 * raised `ENOTEMPTY: rmdir '.../staging/trawlarr-job-nNk0ey'`: unlinking a
 * file some process still holds open does not remove the entry on NFS, the
 * client silly-renames it to `.nfsXXXX`, and the final `rmdir` then finds
 * the directory non-empty. It happened on a refusal, where the substituted
 * outcome cost nothing much. The same removal runs after a successful
 * replacement.
 *
 * NOTHING HERE IS SIMULATED AND NOTHING IS MOCKED. A real library, a real
 * h264 file, a real ffmpeg transcode, the real Verify and Replace runners,
 * and a real undeletable directory made with real filesystem permissions.
 * The only thing the test arranges is that the removal fails — which is the
 * condition, not the behaviour under test.
 */

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const now = (): number => NOW;

const available = toolAvailableSync('ffmpeg');

const makeSample = (path: string): Promise<unknown> =>
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
    'libx264',
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

/**
 * A plugin, loaded from a path exactly as a community plugin with no source
 * is, that makes THIS RUN'S scratch directory undeletable and then passes the
 * encode through untouched.
 *
 * A plugin rather than a hook into `runPayload` because there is no seam
 * there and there should not be one: the removal has to fail during a real
 * run, between the directory being created and the run returning, which is
 * precisely the window a flow node occupies. `chmod 0555` on a subdirectory
 * makes its contents unlinkable, so the recursive removal fails with EACCES
 * — which `rm`'s `force` does not swallow and its `maxRetries` does not
 * retry, so it reaches the `finally` as a throw, which is the whole point.
 */
const OBSTRUCT_PLUGIN = `
const fs = require('node:fs');
const path = require('node:path');
exports.details = () => ({
  name: 'Obstruct Cleanup',
  description: 'Test fixture: makes the scratch directory undeletable.',
  style: {},
  tags: '',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: -1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'through' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => {
  const stuck = path.join(args.workDir, 'stuck');
  fs.mkdirSync(stuck, { recursive: true });
  fs.writeFileSync(path.join(stuck, 'leftover.bin'), 'not going anywhere');
  fs.chmodSync(stuck, 0o555);
  return {
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
`;

const flowWithObstruction = (pluginPath: string): FlowDefinition => ({
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
    { id: 'obstruct', pluginId: pluginPath, pluginVersion: '1.0.0', inputs: {} },
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
    { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'obstruct' },
    { fromNodeId: 'obstruct', outputNumber: 1, toNodeId: 'replace' },
  ],
});

let db: Db;
/** Every 0555 directory this suite made, so a failed run cannot leave one behind. */
const obstructed: string[] = [];

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
});

afterEach(() => {
  for (const dir of obstructed.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Already gone, which is the outcome half these tests want anyway.
    }
  }
});

const stagingDirOf = (root: string): string => join(root, '.trawlarr', 'staging');

const scratchDirsIn = (root: string): string[] => {
  const staging = stagingDirOf(root);
  if (!existsSync(staging)) return [];
  return readdirSync(staging).filter((name) => name.startsWith('trawlarr-job-'));
};

const setupClaimedFile = async (): Promise<{
  root: string;
  claimed: ClaimedFile;
  library: LibraryRecord;
}> => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-cleanup-'));
  await makeSample(join(root, 'sample.mkv'));

  const pluginPath = join(mkdtempSync(join(tmpdir(), 'trawlarr-plugin-')), 'obstruct.js');
  writeFileSync(pluginPath, OBSTRUCT_PLUGIN);

  // The obstruction node is named by PATH, which no registry resolves, so
  // the flow is stored without node-capability validation — the same
  // position the repo is in for any community plugin named by path.
  const flow = createFlowRepo(db, { resolveNodeCapabilities: () => null }).create({
    name: 'flow',
    definition: flowWithObstruction(pluginPath),
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
  return { root, claimed, library };
};

describe.runIf(available)('a run whose scratch directory cannot be removed', () => {
  it('records the transcode it actually completed as succeeded, not as a failed attempt', async () => {
    const { root, claimed, library } = await setupClaimedFile();
    expect(await videoCodecOf(claimed.path)).toBe('h264');

    const result = await runJob({
      db,
      claimed,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      nowMs: now,
    });

    // THE CONDITION REALLY HELD. Without this the test could pass simply
    // because the removal succeeded and there was never anything to survive.
    const leftBehind = scratchDirsIn(root);
    expect(leftBehind).toHaveLength(1);
    const stuck = join(stagingDirOf(root), leftBehind[0]!, 'stuck');
    obstructed.push(stuck);

    // THE RUN REALLY HAPPENED, all the way through the replacement.
    expect(await videoCodecOf(claimed.path)).toBe('hevc');

    // AND IT IS RECORDED AS WHAT IT WAS. Against the old code every one of
    // these is the opposite: the job is `failed`, the ledger is a stalled
    // attempt with a backoff, and the row still holds the pre-transcode
    // identity of a file that is now hevc on disk.
    expect(result.state).toBe('good');
    expect(createJobRepo(db).getById(result.jobId)?.state).toBe('succeeded');

    const ledger = createMediaFileRepo(db).getLedger(claimed.fileId);
    expect(ledger?.state).toBe('good');
    expect(ledger?.attemptCount).toBe(0);
    expect(ledger?.holdUntilMs ?? null).toBeNull();

    // Nothing is waiting out a backoff to encode the already-hevc file again.
    expect(
      createMediaFileRepo(db).claimNext({ workerClass: 'transcode', nowMs: NOW + 60 * 60 * 1000 }),
    ).toBeNull();

    // AND THE LEAK IS RECLAIMABLE. The directory a real run left carries that
    // run's own job id, which is what lets the staging sweeper decide it by
    // IDENTITY — this job has ended, so nothing can write here again — rather
    // than by guessing from its age. (The obstruction is handed back first:
    // an EACCES is not what the sweeper is being asked about.)
    expect(leftBehind[0]).toContain(result.jobId);
    chmodSync(stuck, 0o755);
    expect((await sweepStaging({ db, library, nowMs: NOW })).removed).toBe(1);
    expect(scratchDirsIn(root)).toEqual([]);
  }, 180_000);

  /**
   * NOTE ON THE RETRY, WHICH THIS SUITE DELIBERATELY DOES NOT PIN.
   *
   * `rm`'s `maxRetries` covers `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY` and
   * `EPERM` — the observed NFS failure is in that set, and retrying is the
   * whole fix for it, because a silly-renamed `.nfsXXXX` entry disappears
   * the moment the descriptor holding it is released. None of those five is
   * reachable on a local filesystem from an unprivileged process on demand:
   * the obstruction above is `EACCES`, which `rm` does not retry (by
   * design — a permission problem does not clear by waiting), and producing
   * a real `ENOTEMPTY` means winning a race inside `rm` between its own
   * `readdir` and its own `rmdir`, which is exactly the kind of "run it and
   * hope" test this project does not write. The retry is therefore an
   * argued change with no failing-first test of its own, and it is the
   * SMALLER half of this fix: the rule the test above pins — that a
   * removal which fails anyway cannot change what the run reported — is
   * what makes the failure survivable however it arrives.
   */
});
