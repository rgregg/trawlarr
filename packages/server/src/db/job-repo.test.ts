import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createFlowRepo } from './flow-repo.js';
import { createLibraryRepo } from './library-repo.js';
import { createMediaFileRepo } from './media-file-repo.js';
import { createJobRepo, type JobRepo } from './job-repo.js';

const NOW = 1_700_000_000_000;

let db: Db;
let repo: JobRepo;
let fileId: string;
let flowId: string;
let flowHash: string;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createJobRepo(db);

  const flow = createFlowRepo(db).create({
    name: 'HEVC',
    definition: {
      nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
      edges: [],
    },
    nowMs: NOW,
  });
  flowId = flow.id;
  flowHash = flow.definitionHash;

  const library = createLibraryRepo(db).create({ name: 'Movies', roots: ['/media'], nowMs: NOW });
  fileId = createMediaFileRepo(db).upsertScanned({
    libraryId: library.id,
    identity: { inodeKey: '1:2', contentKey: 'hash' },
    path: '/media/movie.mkv',
    nlink: 1,
    sizeBytes: 100,
    mtimeMs: NOW,
    ctimeMs: NOW,
    container: 'mkv',
    nowMs: NOW,
  });
});

const rawJobRow = (jobId: string): { state: string; started_at: number } =>
  db.prepare(`SELECT state, started_at FROM job WHERE id = ?`).get(jobId) as {
    state: string;
    started_at: number;
  };

describe('createJobRepo', () => {
  it('start returns an id and writes a running row', () => {
    const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    expect(jobId).toBeTruthy();
    const row = rawJobRow(jobId);
    expect(row.state).toBe('running');
    expect(row.started_at).toBe(NOW);
  });

  it('recordStep stores sequence, node, plugin, output number, duration and log excerpt', () => {
    const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    repo.recordStep({
      jobId,
      step: {
        seq: 1,
        nodeId: 'start',
        pluginId: 'trawlarr:start',
        outputNumber: 1,
        durationMs: 12,
        logExcerpt: 'ran fine',
      },
    });
    const steps = repo.getSteps(jobId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      jobId,
      seq: 1,
      nodeId: 'start',
      pluginId: 'trawlarr:start',
      outputNumber: 1,
      durationMs: 12,
      logExcerpt: 'ran fine',
    });
  });

  it('folds a step error into its log excerpt, since job_step has no error column', () => {
    const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    repo.recordStep({
      jobId,
      step: {
        seq: 1,
        nodeId: 'check',
        pluginId: 'trawlarr:checkVideoCodec',
        outputNumber: null,
        durationMs: 3,
        logExcerpt: '',
        error: 'plugin threw',
      },
    });
    expect(repo.getSteps(jobId)[0]?.logExcerpt).toContain('plugin threw');
  });

  it('enforces (job_id, seq) uniqueness', () => {
    const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    const step = {
      seq: 1,
      nodeId: 'start',
      pluginId: 'trawlarr:start',
      outputNumber: 1,
      durationMs: 1,
      logExcerpt: '',
    };
    repo.recordStep({ jobId, step });
    expect(() => repo.recordStep({ jobId, step })).toThrow();
  });

  it('finish sets state, outcome and ended_at', () => {
    const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    repo.finish({ jobId, state: 'succeeded', outcome: 'end-of-flow', nowMs: NOW + 500 });
    const row = db.prepare(`SELECT state, outcome, ended_at FROM job WHERE id = ?`).get(jobId) as {
      state: string;
      outcome: string;
      ended_at: number;
    };
    expect(row.state).toBe('succeeded');
    expect(row.outcome).toBe('end-of-flow');
    expect(row.ended_at).toBe(NOW + 500);
  });

  it('heartbeat advances heartbeat_at without touching state', () => {
    const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    repo.heartbeat({ jobId, nowMs: NOW + 30 });
    const row = db.prepare(`SELECT state, heartbeat_at FROM job WHERE id = ?`).get(jobId) as {
      state: string;
      heartbeat_at: number;
    };
    expect(row.state).toBe('running');
    expect(row.heartbeat_at).toBe(NOW + 30);
  });

  it('listForFile returns newest first', () => {
    const first = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    const second = repo.start({ fileId, flowId, flowHash, nowMs: NOW + 100 });
    const rows = repo.listForFile(fileId);
    expect(rows.map((r) => r.id)).toEqual([second, first]);
  });

  it('getSteps returns them in sequence order', () => {
    const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    for (const seq of [3, 1, 2]) {
      repo.recordStep({
        jobId,
        step: {
          seq,
          nodeId: `n${seq}`,
          pluginId: 'trawlarr:start',
          outputNumber: 1,
          durationMs: 1,
          logExcerpt: '',
        },
      });
    }
    expect(repo.getSteps(jobId).map((s) => s.seq)).toEqual([1, 2, 3]);
  });
});
