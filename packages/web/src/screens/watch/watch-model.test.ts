import { describe, expect, it } from 'vitest';
import { initialLiveState } from '../../api/events.js';
import { explainIdle, ranFfmpeg, summarise24h, toRunningRows } from './watch-model.js';

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
