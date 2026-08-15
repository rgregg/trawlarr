import { beforeEach, describe, expect, it } from 'vitest';
import { buildIdentityCandidate } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createMediaFileRepo, type MediaFileRepo } from '../db/media-file-repo.js';
import { createJobRepo } from '../db/job-repo.js';
import {
  DEFAULT_STALE_AFTER_MS,
  MIN_STALE_AFTER_MS,
  StaleThresholdTooShortError,
  reapStalled,
} from './reap-stalled.js';

/**
 * The stall reaper. Rows and job rows only — no log text — and every clock
 * value is injected, so nothing here waits for time to pass.
 */

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const LIB = 'lib-movies';
const OTHER_LIB = 'lib-shows';

let db: Db;
let repo: MediaFileRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  for (const [id, name] of [
    [LIB, 'Movies'],
    [OTHER_LIB, 'Shows'],
  ]) {
    db.prepare(`INSERT INTO library (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, NOW);
  }
  repo = createMediaFileRepo(db);
});

let seq = 0;

/** A row in `running`, claimed at `claimedAtMs` (what `claimNext` stamps). */
const runningFile = (input: { claimedAtMs: number; libraryId?: string }): string => {
  seq += 1;
  const id = repo.upsertScanned({
    libraryId: input.libraryId ?? LIB,
    identity: buildIdentityCandidate({
      deviceId: 2049,
      inode: 100 + seq,
      hash: { sizeBytes: 4096, headHex: `a${String(seq)}`, tailHex: 'bb' },
    }),
    path: `/media/movies/file-${String(seq)}.mkv`,
    nlink: 1,
    sizeBytes: 4096,
    mtimeMs: NOW,
    ctimeMs: NOW,
    container: 'mkv',
    nowMs: NOW,
  });
  db.prepare(`UPDATE media_file SET state = 'running', updated_at = ? WHERE id = ?`).run(
    input.claimedAtMs,
    id,
  );
  return id;
};

/** A `running` job row for `fileId`, with the given heartbeat. */
const runningJob = (input: {
  fileId: string;
  startedAtMs: number;
  heartbeatAtMs: number | null;
}): string => {
  const jobId = createJobRepo(db).start({
    fileId: input.fileId,
    flowId: 'flow',
    flowHash: 'hash',
    nowMs: input.startedAtMs,
  });
  if (input.heartbeatAtMs !== null) {
    createJobRepo(db).heartbeat({ jobId, nowMs: input.heartbeatAtMs });
  }
  return jobId;
};

const jobRow = (jobId: string) =>
  db.prepare(`SELECT state, outcome, ended_at FROM job WHERE id = ?`).get(jobId) as {
    state: string;
    outcome: string | null;
    ended_at: number | null;
  };

describe('reapStalled', () => {
  it('reclaims a row whose job has not heartbeaten within the threshold, as a failed attempt', () => {
    const fileId = runningFile({ claimedAtMs: NOW - 40 * HOUR_MS });
    const jobId = runningJob({
      fileId,
      startedAtMs: NOW - 40 * HOUR_MS,
      heartbeatAtMs: NOW - 30 * HOUR_MS,
    });

    const summary = reapStalled({ db, nowMs: NOW });

    expect(summary.running).toBe(1);
    expect(summary.reclaimed).toBe(1);
    // A failed ATTEMPT, not a free requeue: the backoff and the attempt
    // counter are what stop a file that reliably kills its worker from
    // being retried for ever.
    expect(repo.getLedger(fileId)).toMatchObject({ state: 'held', attemptCount: 1 });
    expect(repo.getLedger(fileId)?.holdUntilMs).toBeGreaterThan(NOW);
    // The abandoned job row is closed too, so it stops reading as in-flight.
    expect(jobRow(jobId).ended_at).toBe(NOW);
    expect(jobRow(jobId).state).toBe('failed');
  });

  it('never reclaims a slow worker: a job 20 hours in with a recent heartbeat is live', () => {
    const fileId = runningFile({ claimedAtMs: NOW - 20 * HOUR_MS });
    const jobId = runningJob({
      fileId,
      startedAtMs: NOW - 20 * HOUR_MS,
      heartbeatAtMs: NOW - 10 * 60 * 1000,
    });

    const summary = reapStalled({ db, nowMs: NOW });

    expect(summary.reclaimed).toBe(0);
    expect(summary.live).toBe(1);
    expect(repo.getById(fileId)?.state).toBe('running');
    expect(jobRow(jobId).ended_at).toBeNull();
  });

  it('keys a job that has not heartbeaten at all on when it started', () => {
    const recent = runningFile({ claimedAtMs: NOW - 2 * HOUR_MS });
    runningJob({ fileId: recent, startedAtMs: NOW - 2 * HOUR_MS, heartbeatAtMs: null });
    const ancient = runningFile({ claimedAtMs: NOW - 40 * HOUR_MS });
    runningJob({ fileId: ancient, startedAtMs: NOW - 40 * HOUR_MS, heartbeatAtMs: null });

    reapStalled({ db, nowMs: NOW });

    expect(repo.getById(recent)?.state).toBe('running');
    expect(repo.getById(ancient)?.state).toBe('held');
  });

  it('reclaims a row that has no job row at all, keyed on when it was claimed', () => {
    // Killed between `claimNext` committing `running` and `jobRepo.start`:
    // there is no heartbeat anywhere, and the row is otherwise unreachable —
    // `claimNext` takes only queued/held and the scanner never touches
    // `running`.
    const orphan = runningFile({ claimedAtMs: NOW - 40 * HOUR_MS });
    const fresh = runningFile({ claimedAtMs: NOW - 5 * 60 * 1000 });

    const summary = reapStalled({ db, nowMs: NOW });

    expect(summary.reclaimed).toBe(1);
    expect(repo.getById(orphan)?.state).toBe('held');
    expect(repo.getById(fresh)?.state).toBe('running');
  });

  it('ignores an already-finished job and falls back to the row itself', () => {
    // The early-stall path records a SYNTHETIC job row and finishes it
    // immediately. An ended job is not evidence of a live worker, so it must
    // not make a genuinely abandoned row look alive — nor, on its own, make
    // a freshly claimed one look dead.
    const fileId = runningFile({ claimedAtMs: NOW - 40 * HOUR_MS });
    const jobId = runningJob({ fileId, startedAtMs: NOW - 40 * HOUR_MS, heartbeatAtMs: null });
    createJobRepo(db).finish({ jobId, state: 'failed', outcome: 'early stall', nowMs: NOW - 100 });

    expect(reapStalled({ db, nowMs: NOW }).reclaimed).toBe(0);
    expect(repo.getById(fileId)?.state).toBe('running');

    // ...and once that recent activity is itself old, the row is reclaimed.
    expect(reapStalled({ db, nowMs: NOW + 40 * HOUR_MS }).reclaimed).toBe(1);
  });

  it('takes a row that has already failed twice to the terminal state, not back to the queue', () => {
    const fileId = runningFile({ claimedAtMs: NOW - 40 * HOUR_MS });
    db.prepare(`UPDATE media_file SET attempt_count = 2 WHERE id = ?`).run(fileId);

    reapStalled({ db, nowMs: NOW });

    expect(repo.getLedger(fileId)).toMatchObject({ state: 'failed', attemptCount: 3 });
  });

  it('changes nothing under dryRun, but still reports what it would take', () => {
    const fileId = runningFile({ claimedAtMs: NOW - 40 * HOUR_MS });
    const jobId = runningJob({ fileId, startedAtMs: NOW - 40 * HOUR_MS, heartbeatAtMs: null });

    const summary = reapStalled({ db, nowMs: NOW, dryRun: true });

    expect(summary.reclaimed).toBe(1);
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]?.fileId).toBe(fileId);
    expect(repo.getById(fileId)?.state).toBe('running');
    expect(jobRow(jobId).ended_at).toBeNull();
  });

  it('scopes to the libraries it was given', () => {
    const mine = runningFile({ claimedAtMs: NOW - 40 * HOUR_MS });
    const theirs = runningFile({ claimedAtMs: NOW - 40 * HOUR_MS, libraryId: OTHER_LIB });

    reapStalled({ db, nowMs: NOW, libraryIds: [LIB] });

    expect(repo.getById(mine)?.state).toBe('held');
    expect(repo.getById(theirs)?.state).toBe('running');
  });

  it('refuses a threshold short enough to reclaim a legitimate transcode', () => {
    const fileId = runningFile({ claimedAtMs: NOW - 2 * HOUR_MS });
    runningJob({ fileId, startedAtMs: NOW - 2 * HOUR_MS, heartbeatAtMs: NOW - 2 * HOUR_MS });

    // A heartbeat only advances between STEPS, and one Execute step is a
    // whole transcode. A threshold measured in minutes would reclaim files
    // that are being encoded right now, and two workers on one file is how
    // this system destroys data.
    expect(() => reapStalled({ db, nowMs: NOW, staleAfterMs: 60_000 })).toThrow(
      StaleThresholdTooShortError,
    );
    expect(repo.getById(fileId)?.state).toBe('running');
    expect(MIN_STALE_AFTER_MS).toBe(HOUR_MS);
    expect(DEFAULT_STALE_AFTER_MS).toBe(24 * HOUR_MS);
  });
});
