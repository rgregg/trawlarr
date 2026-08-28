import { describe, expect, it } from 'vitest';
import { initialLiveState } from '../../api/events.js';
import {
  explainIdle,
  ranFfmpeg,
  summarise24h,
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

    const paused = explainIdle({ queued: 4507, workers: 0, converged: false, withinWindow: true });
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
    ).toEqual({ encoded: 1, skipped: 2, failed: 1 });
  });

  it('is all zero on an empty window, not a crash', () => {
    expect(summarise24h([])).toEqual({ encoded: 0, skipped: 0, failed: 0 });
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
