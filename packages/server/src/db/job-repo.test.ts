import { beforeEach, describe, expect, it } from 'vitest';
import { leaseOnClaim } from '@trawlarr/core';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createFlowRepo } from './flow-repo.js';
import { createLibraryRepo } from './library-repo.js';
import { createMediaFileRepo } from './media-file-repo.js';
import { createSettingsRepo } from './settings-repo.js';
import { ensureLocalNode } from '../api/routes/nodes.js';
import { createJobRepo, MAX_LOG_EXCERPT_CHARS, type JobRepo } from './job-repo.js';

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

  it('bounds an unbounded log excerpt rather than storing it in full', () => {
    const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
    repo.recordStep({
      jobId,
      step: {
        seq: 1,
        nodeId: 'start',
        pluginId: 'trawlarr:start',
        outputNumber: 1,
        durationMs: 1,
        logExcerpt: 'x'.repeat(MAX_LOG_EXCERPT_CHARS * 3),
      },
    });
    const stored = repo.getSteps(jobId)[0]?.logExcerpt ?? '';
    expect(stored.length).toBeLessThan(MAX_LOG_EXCERPT_CHARS * 3);
    expect(stored.length).toBeGreaterThan(MAX_LOG_EXCERPT_CHARS);
    expect(stored.startsWith('x'.repeat(100))).toBe(true);
    expect(stored).toContain('truncated');
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

  describe('remote leases', () => {
    beforeEach(() => {
      // start({ nodeId }) has an FK on node(id); the local node row is the
      // simplest one that always exists.
      ensureLocalNode({ db, settings: createSettingsRepo({ db }), nowMs: () => NOW });
    });

    it('start writes node_id', () => {
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW, nodeId: 'local' });
      const row = db.prepare(`SELECT node_id FROM job WHERE id = ?`).get(jobId) as {
        node_id: string | null;
      };
      expect(row.node_id).toBe('local');
    });

    it('setRemote then listLeased returns the row with its lease, payload and path map', () => {
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW, nodeId: 'local' });
      repo.setRemote({
        jobId,
        nodeId: 'local',
        lease: leaseOnClaim(),
        payloadJson: '{"a":1}',
        pathMapJson: '[{"serverPath":"/media","nodePath":"/mnt"}]',
      });
      const leased = repo.listLeased();
      expect(leased).toHaveLength(1);
      expect(leased[0]).toEqual({
        jobId,
        fileId,
        nodeId: 'local',
        lease: { state: 'connected', expiresAtMs: null },
        payloadJson: '{"a":1}',
        pathMapJson: '[{"serverPath":"/media","nodePath":"/mnt"}]',
      });
    });

    it('setLease to grace with an expiry persists both columns', () => {
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW, nodeId: 'local' });
      repo.setRemote({
        jobId,
        nodeId: 'local',
        lease: leaseOnClaim(),
        payloadJson: '{}',
        pathMapJson: '[]',
      });
      repo.setLease({ jobId, lease: { state: 'grace', expiresAtMs: NOW + 60_000 } });
      const row = db
        .prepare(`SELECT lease_state, lease_expires_at FROM job WHERE id = ?`)
        .get(jobId) as { lease_state: string | null; lease_expires_at: number | null };
      expect(row.lease_state).toBe('grace');
      expect(row.lease_expires_at).toBe(NOW + 60_000);
    });

    it('finish removes the job from listLeased', () => {
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW, nodeId: 'local' });
      repo.setRemote({
        jobId,
        nodeId: 'local',
        lease: leaseOnClaim(),
        payloadJson: '{}',
        pathMapJson: '[]',
      });
      repo.finish({ jobId, state: 'succeeded', outcome: 'end-of-flow', nowMs: NOW + 10 });
      expect(repo.listLeased()).toEqual([]);
    });

    it('finish clears the stored payload and path map, which nothing reads once a job ends', () => {
      // A whole server-view payload per remote job, kept for ever, is the job
      // table growing by the flow definition on every run.
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW, nodeId: 'local' });
      repo.setRemote({
        jobId,
        nodeId: 'local',
        lease: leaseOnClaim(),
        payloadJson: '{"big":true}',
        pathMapJson: '[{"serverPath":"/media","nodePath":"/mnt"}]',
      });
      repo.finish({ jobId, state: 'failed', outcome: 'released', nowMs: NOW + 10 });
      const row = db
        .prepare(`SELECT payload_json, path_map_json, lease_state FROM job WHERE id = ?`)
        .get(jobId) as {
        payload_json: string | null;
        path_map_json: string | null;
        lease_state: string | null;
      };
      expect(row.payload_json).toBeNull();
      expect(row.path_map_json).toBeNull();
      // The lease is kept: the hub tells a late result from a duplicate by it.
      expect(row.lease_state).toBe('connected');
    });
  });

  describe('appendOutcome', () => {
    it('sets the outcome when it was null', () => {
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
      repo.appendOutcome({ jobId, text: 'first line' });
      expect(repo.getById(jobId)?.outcome).toBe('first line');
    });

    it('appends a newline plus the text to an existing outcome', () => {
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
      repo.appendOutcome({ jobId, text: 'first line' });
      repo.appendOutcome({ jobId, text: 'second line' });
      expect(repo.getById(jobId)?.outcome).toBe('first line\nsecond line');
    });
  });

  describe('requestCancel', () => {
    it('records when a cancel was requested, keeping the first request', () => {
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
      expect(repo.getById(jobId)?.cancelRequestedAt).toBeNull();
      repo.requestCancel({ jobId, nowMs: NOW + 5 });
      repo.requestCancel({ jobId, nowMs: NOW + 9 });
      expect(repo.getById(jobId)?.cancelRequestedAt).toBe(NOW + 5);
    });

    it('does not mark a job that has already ended', () => {
      const jobId = repo.start({ fileId, flowId, flowHash, nowMs: NOW });
      repo.finish({ jobId, state: 'succeeded', outcome: 'done', nowMs: NOW + 1 });
      repo.requestCancel({ jobId, nowMs: NOW + 2 });
      expect(repo.getById(jobId)?.cancelRequestedAt).toBeNull();
    });
  });
});
