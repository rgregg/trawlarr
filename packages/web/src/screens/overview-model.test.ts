import { describe, expect, it } from 'vitest';
import { initialLiveState } from '../api/events.js';
import {
  overallConvergence,
  toLibraryCard,
  type LibraryResource,
  type LibraryStats,
} from './overview-model.js';

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

describe('overallConvergence', () => {
  it('weights by file count, not by library count', () => {
    const cards = [
      {
        ...toLibraryCard({
          library: library(),
          stats: stats({ total: 900, good: 900, convergedPercent: 100 }),
          live: initialLiveState,
        }),
      },
      {
        ...toLibraryCard({
          library: library({ id: 'lib-2', name: 'TV' }),
          stats: stats({ libraryId: 'lib-2', total: 100, good: 0, convergedPercent: 0 }),
          live: initialLiveState,
        }),
      },
    ];
    expect(overallConvergence(cards)).toEqual({ percent: 90, total: 1000, good: 900 });
  });

  it('reports 0 rather than NaN for an empty install', () => {
    expect(overallConvergence([])).toEqual({ percent: 0, total: 0, good: 0 });
  });
});
