import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildIdentityCandidate,
  computeSignature,
  extractFacts,
  type FlowDefinition,
  type PartialHashParts,
} from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import { buildJobPayload, type JobPayload } from './job-payload.js';
import type { JobReport } from './run-payload.js';
import { applyJobFailure, applyJobReport } from './apply-report.js';

const NOW = 1_700_000_000_000;

const FLOW: FlowDefinition = {
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

const PRE_PROBE: ProbeData = {
  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }],
  format: { duration: '2.0' },
};

const POST_PROBE: ProbeData = {
  streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', width: 320, height: 240 }],
  format: { duration: '2.0' },
};

const OLD_HASH: PartialHashParts = { sizeBytes: 4096, headHex: 'oldhead', tailHex: 'oldtail' };
const NEW_HASH: PartialHashParts = { sizeBytes: 2048, headHex: 'newhead', tailHex: 'newtail' };

const OLD_IDENTITY = buildIdentityCandidate({ deviceId: 66, inode: 1234, hash: OLD_HASH });
const NEW_IDENTITY = buildIdentityCandidate({ deviceId: 66, inode: 5678, hash: NEW_HASH });
const NEW_CONTENT_KEY = NEW_IDENTITY.contentKey;

const PRE_FACTS = extractFacts({ probe: PRE_PROBE, container: 'mkv', sizeBytes: 4096 });
const POST_FACTS = extractFacts({ probe: POST_PROBE, container: 'mp4', sizeBytes: 2048 });

let db: Db;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
});

/** A library, a flow, one probed file, one started job, and the payload for it. */
const seeded = (): { payload: JobPayload } => {
  const flow = createFlowRepo(db).create({ name: 'flow', definition: FLOW, nowMs: NOW });
  const library = createLibraryRepo(db).create({
    name: 'lib',
    roots: ['/lib'],
    extensions: ['mkv'],
    flowId: flow.id,
    nowMs: NOW,
  });
  const mediaFileRepo = createMediaFileRepo(db);
  const fileId = mediaFileRepo.upsertScanned({
    libraryId: library.id,
    identity: OLD_IDENTITY,
    path: '/lib/movie.mkv',
    nlink: 1,
    sizeBytes: 4096,
    mtimeMs: NOW - 1000,
    ctimeMs: NOW - 1000,
    container: 'mkv',
    nowMs: NOW,
  });
  mediaFileRepo.setProbe({ fileId, probe: PRE_PROBE, facts: PRE_FACTS });

  const jobId = createJobRepo(db).start({
    fileId,
    flowId: flow.id,
    flowHash: flow.definitionHash,
    nowMs: NOW,
  });

  return {
    payload: buildJobPayload({
      db,
      claimed: { fileId, libraryId: library.id, path: '/lib/movie.mkv' },
      jobId,
      workerClass: 'transcode',
      hardwareType: 'cpu',
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    }),
  };
};

const baseReport = (payload: JobPayload): JobReport => ({
  jobId: payload.jobId,
  fileId: payload.fileId,
  steps: [],
  stopReason: 'end-of-flow',
  failed: false,
  error: null,
  success: true,
  outcome: 'Flow finished: end-of-flow.',
  replaced: null,
  preFacts: PRE_FACTS,
  postFacts: null,
  cancelled: false,
});

/** What `runPayload` reports when Replace Original File really swapped a file in. */
const reportWithReplacement = (payload: JobPayload): JobReport => ({
  ...baseReport(payload),
  replaced: {
    path: '/lib/movie.mp4',
    container: 'mp4',
    sizeBytes: 2048,
    mtimeMs: NOW,
    ctimeMs: NOW,
    nlink: 1,
    deviceId: 66,
    inode: 5678,
    hash: NEW_HASH,
    probe: POST_PROBE,
    probeError: null,
  },
  postFacts: POST_FACTS,
});

describe('applyJobReport', () => {
  it('writes the new identity when the report says the library file changed', () => {
    const { payload } = seeded();

    applyJobReport({ db, payload, report: reportWithReplacement(payload), nowMs: () => NOW });

    const row = createMediaFileRepo(db).getById(payload.fileId)!;
    expect(row.path).toBe('/lib/movie.mp4');
    expect(row.content_key).toBe(NEW_CONTENT_KEY);
    expect(row.inode_key).toBe(NEW_IDENTITY.inodeKey);
    expect(row.container).toBe('mp4');
    expect(row.size_bytes).toBe(2048);
    expect(row.video_codec).toBe('hevc');
    expect(row.state).toBe('good');
    expect(row.signature).toBe(
      computeSignature({ flowDefinitionHash: payload.flow.definitionHash, facts: POST_FACTS }),
    );
    expect(row.last_run_id).toBe(payload.jobId);
    expect(createJobRepo(db).listForFile(payload.fileId)[0]?.state).toBe('succeeded');
  });

  it('records a replacement even when the run as a whole failed afterwards', () => {
    // The first of the four "job succeeded != file changed" defects:
    // persistence gated on success threw away the record of a real
    // replacement, and the retry re-transcoded an already-transcoded file at
    // full cost, with generational loss, pushing the good result into trash.
    const { payload } = seeded();

    applyJobReport({
      db,
      payload,
      report: { ...reportWithReplacement(payload), success: false },
      nowMs: () => NOW,
    });

    const row = createMediaFileRepo(db).getById(payload.fileId)!;
    expect(row.content_key).toBe(NEW_CONTENT_KEY);
    expect(row.video_codec).toBe('hevc');
    expect(row.state).not.toBe('good');
    expect(row.state).toBe('held');
    expect(row.attempt_count).toBe(1);
    expect(createJobRepo(db).listForFile(payload.fileId)[0]?.state).toBe('failed');
  });

  it('leaves identity alone when the replaced path is the untouched original', () => {
    // A Replace that REFUSED (hardlink guard, occupied destination, "already
    // the file this flow produced") reports the original's own path. Its
    // identity still matches the row, so nothing was modified — judging that
    // by the step's output number instead is what made an early refusal read
    // as a modification claim.
    const { payload } = seeded();
    const report: JobReport = {
      ...baseReport(payload),
      replaced: {
        path: '/lib/movie.mkv',
        container: 'mkv',
        sizeBytes: 4096,
        mtimeMs: NOW - 1000,
        ctimeMs: NOW - 1000,
        nlink: 1,
        deviceId: 66,
        inode: 1234,
        hash: OLD_HASH,
        probe: PRE_PROBE,
        probeError: null,
      },
      postFacts: PRE_FACTS,
    };

    applyJobReport({ db, payload, report, nowMs: () => NOW });

    const row = createMediaFileRepo(db).getById(payload.fileId)!;
    expect(row.path).toBe('/lib/movie.mkv');
    expect(row.content_key).toBe(OLD_IDENTITY.contentKey);
    expect(row.state).toBe('good');
    // The signature stored is the PRE-run one, because nothing changed.
    expect(row.signature).toBe(
      computeSignature({ flowDefinitionHash: payload.flow.definitionHash, facts: PRE_FACTS }),
    );
  });

  it('refuses to record a changed file it cannot describe, rather than storing a split row', () => {
    const { payload } = seeded();
    const withReplacement = reportWithReplacement(payload);
    const report: JobReport = {
      ...withReplacement,
      replaced: { ...withReplacement.replaced!, probe: null, probeError: 'ffprobe exited 1' },
      postFacts: null,
    };

    expect(() => applyJobReport({ db, payload, report, nowMs: () => NOW })).toThrow(
      /could not be probed: ffprobe exited 1/,
    );

    // Nothing was half-written: the row still describes the pre-run file.
    const row = createMediaFileRepo(db).getById(payload.fileId)!;
    expect(row.content_key).toBe(OLD_IDENTITY.contentKey);
    expect(row.video_codec).toBe('h264');
  });
});

describe('applyJobFailure', () => {
  it('folds an attempt with no report at all into a backoff rather than leaving the row running', () => {
    const { payload } = seeded();
    createMediaFileRepo(db).setState({ fileId: payload.fileId, state: 'running' });

    const { state } = applyJobFailure({
      db,
      payload,
      reason: 'worker exited',
      nowMs: () => NOW,
    });

    expect(state).toBe('held');
    const row = createMediaFileRepo(db).getById(payload.fileId)!;
    expect(row.state).toBe('held');
    expect(row.attempt_count).toBe(1);
    expect(row.hold_until_ms).toBeGreaterThan(NOW);
    expect(row.last_run_id).toBe(payload.jobId);

    const job = createJobRepo(db).listForFile(payload.fileId)[0]!;
    expect(job.state).toBe('failed');
    expect(job.outcome).toBe('worker exited');
  });
});
