import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { buildJobPayload } from './job-payload.js';

const NOW = 1_700_000_000_000;

/** A two-node flow: the shapes are copied from `run-job.test.ts`'s TRANSCODE_FLOW. */
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

const PROBE: ProbeData = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 240 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '2.0', size: '4096', bit_rate: '16384' },
};

let db: Db;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
});

/** One library with a flow attached, holding one probed media file row. */
const seedLibraryWithProbedFile = () => {
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
    identity: { inodeKey: '66:1234', contentKey: 'sha256:head:tail:4096' },
    path: '/lib/movie.mkv',
    nlink: 1,
    sizeBytes: 4096,
    mtimeMs: NOW - 1000,
    ctimeMs: NOW - 1000,
    container: 'mkv',
    nowMs: NOW,
  });
  mediaFileRepo.setProbe({
    fileId,
    probe: PROBE,
    facts: {
      container: 'mkv',
      sizeBytes: 4096,
      durationMs: 2000,
      width: 320,
      height: 240,
      streams: [],
    },
  });
  return { db, libraryId: library.id, fileId, flowId: flow.id };
};

/** The same, but the library has no flow attached at all. */
const seedLibraryWithNoFlow = () => {
  const seeded = seedLibraryWithProbedFile();
  createLibraryRepo(db).setFlow(seeded.libraryId, null);
  return seeded;
};

describe('buildJobPayload', () => {
  it('carries everything a run needs, so nothing has to go back to the database', () => {
    const { libraryId, fileId, flowId } = seedLibraryWithProbedFile();

    const payload = buildJobPayload({
      db,
      claimed: { fileId, libraryId, path: '/lib/movie.mkv' },
      jobId: 'job-1',
      workerClass: 'transcode',
      hardwareType: 'cpu',
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    });

    expect(payload.flow.id).toBe(flowId);
    expect(payload.flow.definition.nodes.length).toBeGreaterThan(0);
    expect(payload.probe.streams?.length).toBeGreaterThan(0);
    expect(payload.library.roots).toEqual(['/lib']);
    expect(payload.footprintId).toBe('66:1234');
    expect(payload.container).toBe('mkv');
    expect(payload.sizeBytes).toBe(4096);
    expect(payload.ffprobePath).toBe('ffprobe');
    // The whole point: it must survive the IPC boundary.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('names what is missing rather than throwing something anonymous', () => {
    const { libraryId, fileId } = seedLibraryWithNoFlow();

    expect(() =>
      buildJobPayload({
        db,
        claimed: { fileId, libraryId, path: '/lib/movie.mkv' },
        jobId: 'job-1',
        workerClass: 'transcode',
        hardwareType: 'cpu',
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
      }),
    ).toThrow(/has no flow attached/);
  });

  it('names an unprobed file rather than handing a run a payload it cannot judge', () => {
    // A signature is computed from the probe. Building a payload without one
    // would push the failure into the run, where it would read as "the flow
    // failed" rather than "this file was never probed".
    const { libraryId, fileId } = seedLibraryWithProbedFile();
    db.prepare(`UPDATE media_file SET probe_json = NULL WHERE id = ?`).run(fileId);

    expect(() =>
      buildJobPayload({
        db,
        claimed: { fileId, libraryId, path: '/lib/movie.mkv' },
        jobId: 'job-1',
        workerClass: 'transcode',
        hardwareType: 'cpu',
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
      }),
    ).toThrow(/has never been probed/);
  });

  it('writes nothing: the row, its state and its job rows are untouched', () => {
    const { libraryId, fileId } = seedLibraryWithProbedFile();
    const before = db.prepare(`SELECT * FROM media_file WHERE id = ?`).get(fileId);

    buildJobPayload({
      db,
      claimed: { fileId, libraryId, path: '/lib/movie.mkv' },
      jobId: 'job-1',
      workerClass: 'transcode',
      hardwareType: 'cpu',
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    });

    expect(db.prepare(`SELECT * FROM media_file WHERE id = ?`).get(fileId)).toEqual(before);
    expect(db.prepare(`SELECT id FROM job`).all()).toEqual([]);
  });
});
