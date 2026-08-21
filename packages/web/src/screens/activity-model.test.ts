import { describe, expect, it } from 'vitest';
import { initialLiveState } from '../api/events.js';
import { formatProgress, mergeJobs, toRecentJobs } from './activity-model.js';

const liveJob = {
  jobId: 'job-live',
  fileId: 'f1',
  libraryId: 'lib-1',
  path: '/library/movies/new.mkv',
  workerId: 'w1',
  pid: 99,
  percent: 42,
  stage: 'encoding',
  steps: [],
  log: [],
};

describe('mergeJobs', () => {
  it('puts running jobs before finished ones', () => {
    const rows = mergeJobs({
      live: { ...initialLiveState, jobs: { 'job-live': liveJob } },
      recent: [
        {
          id: 'job-old',
          path: '/library/movies/old.mkv',
          state: 'succeeded',
          outcome: 'ok',
          started_at: 10,
        },
      ],
    });
    expect(rows.map((row) => row.jobId)).toEqual(['job-live', 'job-old']);
    expect(rows[0]!.live).toBe(true);
  });

  it('prefers the live frame over the fetched row for a job that is in both', () => {
    // The REST page is a snapshot; the socket is current. A row showing a
    // stale "queued" beside a live 42% is the shape that makes a UI look
    // broken.
    const rows = mergeJobs({
      live: { ...initialLiveState, jobs: { 'job-live': liveJob } },
      recent: [
        {
          id: 'job-live',
          path: '/library/movies/new.mkv',
          state: 'running',
          outcome: null,
          started_at: 5,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ live: true, percent: 42, pid: 99 });
  });

  it('carries the outcome of a finished job', () => {
    const rows = mergeJobs({
      live: initialLiveState,
      recent: [
        {
          id: 'job-old',
          path: '/a.mkv',
          state: 'failed',
          outcome: 'verify rejected output',
          started_at: 1,
        },
      ],
    });
    expect(rows[0]).toMatchObject({
      live: false,
      state: 'failed',
      outcome: 'verify rejected output',
    });
  });
});

describe('formatProgress', () => {
  it('shows the percentage and stage for a live job', () => {
    expect(
      formatProgress({
        jobId: 'j',
        path: '/a.mkv',
        live: true,
        percent: 42,
        stage: 'encoding',
        outcome: null,
        state: null,
        startedAtMs: 0,
        workerId: 'w',
        pid: 1,
      }),
    ).toBe('42% — encoding');
  });

  it('says the stage without a number when the percentage is unknown', () => {
    // ffmpeg cannot always report a percentage; "0%" would be a lie and
    // "" would look like a hang.
    expect(
      formatProgress({
        jobId: 'j',
        path: '/a.mkv',
        live: true,
        percent: null,
        stage: 'probing',
        outcome: null,
        state: null,
        startedAtMs: 0,
        workerId: 'w',
        pid: 1,
      }),
    ).toBe('probing');
  });

  it('shows the outcome for a finished job', () => {
    expect(
      formatProgress({
        jobId: 'j',
        path: '/a.mkv',
        live: false,
        percent: null,
        stage: '',
        outcome: 'ok',
        state: 'succeeded',
        startedAtMs: 0,
        workerId: null,
        pid: null,
      }),
    ).toBe('succeeded — ok');
  });
});

describe('toRecentJobs', () => {
  it('resolves each job\u2019s path from the file it names', () => {
    // `GET /jobs` carries a file id and no path: the path lives on the file,
    // and a history of opaque uuids is not a history anyone can read.
    expect(
      toRecentJobs({
        items: [{ id: 'job-1', fileId: 'f1', state: 'succeeded', outcome: 'ok', startedAt: 7 }],
        pathByFileId: { f1: '/library/movies/old.mkv' },
      }),
    ).toEqual([
      {
        id: 'job-1',
        path: '/library/movies/old.mkv',
        state: 'succeeded',
        outcome: 'ok',
        started_at: 7,
      },
    ]);
  });

  it('keeps a job whose file is gone, with no path rather than an invented one', () => {
    const [row] = toRecentJobs({
      items: [{ id: 'job-1', fileId: 'gone', state: 'failed', outcome: 'cancelled', startedAt: 3 }],
      pathByFileId: {},
    });
    expect(row).toEqual({ id: 'job-1', state: 'failed', outcome: 'cancelled', started_at: 3 });
    expect(mergeJobs({ live: initialLiveState, recent: [row!] })[0]!.path).toBe('');
  });
});
