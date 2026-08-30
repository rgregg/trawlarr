import { describe, expect, it } from 'vitest';
import { initialLiveState } from '../../api/events.js';
import {
  explainIdle,
  mergeRunningRows,
  ranFfmpeg,
  summarise24h,
  toIdleInputs,
  toLibraryCard,
  toRunningRows,
  type LibraryResource,
  type LibraryStats,
} from './watch-model.js';

const library = (patch: Partial<LibraryResource> = {}): LibraryResource => ({
  id: 'lib-1',
  name: 'Movies',
  roots: ['/library/movies'],
  flowId: 'flow-1',
  paused: false,
  pausedReason: null,
  pausedBy: null,
  pausedExplanation: null,
  ...patch,
});

const stats = (patch: Partial<LibraryStats> = {}): LibraryStats => ({
  libraryId: 'lib-1',
  total: 100,
  byState: { good: 100, queued: 0, running: 0, failed: 0, not_converging: 0, held: 0, unknown: 0 },
  good: 100,
  missing: 0,
  convergedPercent: 100,
  paused: false,
  pausedExplanation: null,
  scanning: false,
  ...patch,
});

describe('toRunningRows', () => {
  it('shows the file name and its live progress', () => {
    const rows = toRunningRows({
      ...initialLiveState,
      jobs: {
        j1: {
          jobId: 'j1',
          fileId: 'f1',
          libraryId: 'lib-1',
          path: '/library/shows/Foundation/S02E02.mkv',
          workerId: 'w1',
          pid: 10,
          percent: 61,
          stage: 'Execute',
          steps: [],
          log: [],
        },
      },
    });
    expect(rows).toEqual([
      {
        jobId: 'j1',
        fileId: 'f1',
        name: 'S02E02.mkv',
        percent: 61,
        stage: 'Execute',
        workerId: 'w1',
      },
    ]);
  });

  it('is empty when nothing is running', () => {
    expect(toRunningRows(initialLiveState)).toEqual([]);
  });
});

describe('explainIdle', () => {
  it('distinguishes converged from paused — they must never read alike', () => {
    expect(
      explainIdle({ queued: 0, workers: 0, converged: true, withinWindow: true }).headline,
    ).toBe('Everything is converged');

    // base 0 AND no window granting workers: the real "worker count 0"
    // install. `withinWindow: true` here would be an incoherent fixture —
    // the schedule cannot be granting workers when the base is zero and no
    // window overrides it — and it is exactly the combination the
    // precedence bug hid behind; see `toIdleInputs`.
    const paused = explainIdle({ queued: 4507, workers: 0, converged: false, withinWindow: false });
    expect(paused.headline).toBe('Nothing will start');
    expect(paused.detail).toBe('4507 files are queued, but worker count is 0.');
    expect(paused.action).toEqual({ label: 'Set workers', to: '/config?tab=workers' });
  });

  it('names the schedule window when that is what is holding work back', () => {
    const outside = explainIdle({ queued: 12, workers: 1, converged: false, withinWindow: false });
    expect(outside.headline).toBe('Outside the schedule window');
    expect(outside.action).toEqual({ label: 'Change the window', to: '/config?tab=system' });
  });

  it('says work is starting when there is nothing wrong at all', () => {
    expect(
      explainIdle({ queued: 5, workers: 1, converged: false, withinWindow: true }).headline,
    ).toBe('Waiting for a worker');
  });

  it('prefers "set workers" over the window when both are true, because raising the count is the fix that matters', () => {
    const both = explainIdle({ queued: 9, workers: 0, converged: false, withinWindow: false });
    expect(both.headline).toBe('Nothing will start');
  });
});

describe('summarise24h', () => {
  it('separates real encodes from skips, because that is the whole question', () => {
    expect(
      summarise24h([
        { state: 'succeeded', ranFfmpeg: true },
        { state: 'succeeded', ranFfmpeg: false },
        { state: 'succeeded', ranFfmpeg: false },
        { state: 'failed', ranFfmpeg: true },
      ]),
    ).toEqual({ encoded: 1, skipped: 2, failed: 1, unclassified: 0 });
  });

  it('counts a job whose ffmpeg question is unanswered as unclassified, never as a skip', () => {
    // The step trace is one request per job and it is capped, so on a busy
    // day some jobs in the window have no answer yet. Counting those as
    // skips would silently under-report the number this panel exists for.
    expect(
      summarise24h([
        { state: 'succeeded', ranFfmpeg: true },
        { state: 'succeeded', ranFfmpeg: null },
        { state: 'failed', ranFfmpeg: null },
      ]),
    ).toEqual({ encoded: 1, skipped: 0, failed: 1, unclassified: 1 });
  });

  it('is all zero on an empty window, not a crash', () => {
    expect(summarise24h([])).toEqual({ encoded: 0, skipped: 0, failed: 0, unclassified: 0 });
  });
});

describe('ranFfmpeg', () => {
  it('is true for a step that ran ffmpeg', () => {
    expect(
      ranFfmpeg([{ pluginId: 'trawlarr:execute', logExcerpt: 'Running ffmpeg: -c:v hevc_nvenc' }]),
    ).toBe(true);
  });

  it('is false for a step that skipped ffmpeg', () => {
    expect(
      ranFfmpeg([{ pluginId: 'trawlarr:execute', logExcerpt: 'Skipping ffmpeg: already matches' }]),
    ).toBe(false);
  });

  it('is false when there is no execute step at all — a job that failed before reaching it', () => {
    expect(ranFfmpeg([{ pluginId: 'trawlarr:probe', logExcerpt: '' }])).toBe(false);
    expect(ranFfmpeg([])).toBe(false);
  });

  it('treats an empty excerpt as "not run", never as null', () => {
    expect(ranFfmpeg([{ pluginId: 'trawlarr:execute', logExcerpt: '' }])).toBe(false);
  });
});

describe('toLibraryCard', () => {
  it('reports a fully converged library as converged', () => {
    const card = toLibraryCard({ library: library(), stats: stats(), live: initialLiveState });
    expect(card.status).toBe('converged');
    expect(card.convergedPercent).toBe(100);
  });

  it('shows WHY a library is paused, in the daemon’s own words', () => {
    const card = toLibraryCard({
      library: library({
        paused: true,
        pausedReason: 'flow-invalid: no flow is attached',
        pausedBy: 'trawlarr',
        pausedExplanation:
          'This library has no flow, so there is no known-good state to converge toward.',
      }),
      stats: stats({
        paused: true,
        convergedPercent: 0,
        good: 0,
        byState: { ...stats().byState, good: 0, unknown: 100 },
      }),
      live: initialLiveState,
    });

    expect(card.status).toBe('paused');
    // A paused library that says only "paused" is barely better than one that
    // says nothing: the reason IS the diagnosis.
    expect(card.detail).toBe(
      'This library has no flow, so there is no known-good state to converge toward.',
    );
  });

  it('reports files needing a human as needing attention, even at high convergence', () => {
    const card = toLibraryCard({
      library: library(),
      stats: stats({
        convergedPercent: 98,
        good: 98,
        byState: { ...stats().byState, good: 98, failed: 1, not_converging: 1 },
      }),
      live: initialLiveState,
    });
    expect(card.status).toBe('attention');
    expect(card.detail).toContain('1 failed');
    expect(card.detail).toContain('1 not converging');
  });

  it('reports a library with a running job as working', () => {
    const live = {
      ...initialLiveState,
      jobs: {
        'job-1': {
          jobId: 'job-1',
          fileId: 'f',
          libraryId: 'lib-1',
          path: '/library/movies/a.mkv',
          workerId: 'w',
          pid: 1,
          percent: 30,
          stage: 'encoding',
          steps: [],
          log: [],
        },
      },
    };
    expect(
      toLibraryCard({ library: library(), stats: stats({ convergedPercent: 50 }), live }).status,
    ).toBe('working');
  });

  it('reports a scanning library as working', () => {
    const live = { ...initialLiveState, scanning: { 'lib-1': 4200 } };
    const card = toLibraryCard({
      library: library(),
      stats: stats({ convergedPercent: 0, good: 0 }),
      live,
    });
    expect(card.status).toBe('working');
    expect(card.detail).toContain('4200');
  });

  it('reports a library with work still ahead of it as idle, naming the biggest backlog', () => {
    const card = toLibraryCard({
      library: library(),
      stats: stats({
        convergedPercent: 40,
        good: 40,
        byState: {
          good: 40,
          queued: 35,
          unknown: 25,
          running: 0,
          failed: 0,
          not_converging: 0,
          held: 0,
        },
      }),
      live: initialLiveState,
    });
    expect(card.status).toBe('idle');
    // `good` is excluded from the sort even when it is the largest count —
    // the detail line is about what is still OUTSTANDING.
    expect(card.detail).toBe('35 queued');
  });

  it('leaves the idle detail empty rather than inventing one when nothing is outstanding', () => {
    const card = toLibraryCard({
      library: library(),
      stats: stats({
        total: 0,
        good: 0,
        convergedPercent: 0,
        byState: {},
      }),
      live: initialLiveState,
    });
    expect(card.status).toBe('idle');
    expect(card.detail).toBeNull();
  });

  it('never rounds convergence up to 100', () => {
    // The one number this product exists to report. 100 is reserved for
    // good === total exactly; the daemon floors it and the UI must not undo
    // that by formatting.
    const card = toLibraryCard({
      library: library(),
      stats: stats({ total: 1000, good: 999, convergedPercent: 99 }),
      live: initialLiveState,
    });
    expect(card.headline).toBe('99% converged');
  });
});

describe('mergeRunningRows', () => {
  const restJob = {
    id: 'j1',
    fileId: 'f1',
    workerPid: 4242,
    workerHost: 'media-server',
  };

  it('shows a running job with the socket dead — the record, not the frames', () => {
    // The rule this exists for: a dead socket makes this screen LESS LIVELY,
    // never wrong. Before this, running rows came from `live.jobs` alone, so
    // a dropped socket rendered "Waiting for a worker" while a transcode was
    // in fact running — false, not stale.
    const rows = mergeRunningRows({
      rest: [restJob],
      files: { f1: { path: '/library/shows/Foundation/S02E02.mkv' } },
      live: initialLiveState,
    });
    expect(rows).toEqual([
      {
        jobId: 'j1',
        fileId: 'f1',
        name: 'S02E02.mkv',
        percent: null,
        stage: 'Running',
        workerId: 'media-server pid 4242',
      },
    ]);
  });

  it('lays the live frame over the fetched row without adding a second one', () => {
    const live = {
      ...initialLiveState,
      jobs: {
        j1: {
          jobId: 'j1',
          fileId: 'f1',
          libraryId: 'lib-1',
          path: '/library/shows/Foundation/S02E02.mkv',
          workerId: 'w1',
          pid: 4242,
          percent: 61,
          stage: 'Execute',
          steps: [],
          log: [],
        },
      },
    };
    const rows = mergeRunningRows({
      rest: [restJob],
      files: { f1: { path: '/library/shows/Foundation/S02E02.mkv' } },
      live,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.percent).toBe(61);
    expect(rows[0]!.stage).toBe('Execute');
  });

  it('still shows a job that started since the last fetch', () => {
    // `job.started` bumps no staleness counter, so a live-only row is the
    // only way a just-started job appears before something else refetches.
    const live = {
      ...initialLiveState,
      jobs: {
        j2: {
          jobId: 'j2',
          fileId: 'f2',
          libraryId: 'lib-1',
          path: '/library/movies/new.mkv',
          workerId: 'w2',
          pid: 9,
          percent: 0,
          stage: 'Probe',
          steps: [],
          log: [],
        },
      },
    };
    const rows = mergeRunningRows({ rest: [restJob], files: {}, live });
    expect(rows.map((row) => row.jobId)).toEqual(['j1', 'j2']);
  });

  it('names a worker from the durable pid when no live frame says otherwise', () => {
    const rows = mergeRunningRows({
      rest: [{ ...restJob, workerHost: null }],
      files: {},
      live: initialLiveState,
    });
    expect(rows[0]!.workerId).toBe('pid 4242');
    expect(
      mergeRunningRows({
        rest: [{ ...restJob, workerPid: null, workerHost: null }],
        files: {},
        live: initialLiveState,
      })[0]!.workerId,
    ).toBe('unknown');
  });
});

describe('toIdleInputs', () => {
  const totals = { total: 100, good: 40, queued: 60 };

  it('does not call an install worker-less when a window is granting workers', () => {
    // THE PRECEDENCE BUG: base 0 with an active window that allocates
    // workers used to report "Nothing will start — worker count is 0" while
    // workers were in fact allocated and about to claim.
    const inputs = toIdleInputs({
      totals,
      workers: { baseCounts: { transcode: 0, health: 0 }, target: { transcode: 2, health: 0 } },
    });
    expect(inputs.workers).toBe(0);
    expect(inputs.withinWindow).toBe(true);
    expect(explainIdle(inputs).headline).toBe('Waiting for a worker');
  });

  it('names the window when the base is set but the schedule has zeroed it', () => {
    const inputs = toIdleInputs({
      totals,
      workers: { baseCounts: { transcode: 2, health: 1 }, target: { transcode: 0, health: 0 } },
    });
    expect(inputs.workers).toBe(3);
    expect(inputs.withinWindow).toBe(false);
    expect(explainIdle(inputs).headline).toBe('Outside the schedule window');
  });

  it('says worker count is zero only when nothing is set and nothing is granted', () => {
    const inputs = toIdleInputs({
      totals,
      workers: { baseCounts: { transcode: 0, health: 0 }, target: { transcode: 0, health: 0 } },
    });
    expect(explainIdle(inputs).headline).toBe('Nothing will start');
  });

  it('treats an install with no files at all as converged, not as 0%', () => {
    const inputs = toIdleInputs({
      totals: { total: 0, good: 0, queued: 0 },
      workers: { baseCounts: { transcode: 1 }, target: { transcode: 1 } },
    });
    expect(inputs.converged).toBe(true);
    expect(explainIdle(inputs).headline).toBe('Everything is converged');
  });
});
