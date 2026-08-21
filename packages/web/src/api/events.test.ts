import { describe, expect, it } from 'vitest';
import { initialLiveState, LIVE_LOG_LINES, reduceLive, type LiveState } from './events.js';

const fold = (events: Parameters<typeof reduceLive>[1][]): LiveState =>
  events.reduce(reduceLive, initialLiveState);

const started = {
  type: 'job.started' as const,
  jobId: 'job-1',
  fileId: 'file-1',
  libraryId: 'lib-1',
  path: '/library/movie.mkv',
  workerId: 'worker-1',
  pid: 4242,
};

describe('reduceLive', () => {
  it('tracks a running job and its progress', () => {
    const state = fold([
      started,
      { type: 'job.progress', jobId: 'job-1', percent: 40, stage: 'encoding' },
    ]);

    expect(state.jobs['job-1']).toMatchObject({
      path: '/library/movie.mkv',
      pid: 4242,
      percent: 40,
      stage: 'encoding',
    });
  });

  it('drops a job when it finishes and flags the durable views as stale', () => {
    const state = fold([
      started,
      { type: 'job.finished', jobId: 'job-1', fileId: 'file-1', state: 'good', outcome: 'ok' },
    ]);

    expect(state.jobs).toEqual({});
    // The reducer NEVER becomes the record. A finish means "re-fetch", not
    // "here is the new file state" — so a client that missed the frame is
    // stale, never wrong.
    expect(state.staleness.jobs).toBe(1);
    expect(state.staleness.libraries).toBe(1);
  });

  it('caps the log tail rather than growing without bound', () => {
    const logs = Array.from({ length: LIVE_LOG_LINES + 50 }, (_, i) => ({
      type: 'job.log' as const,
      jobId: 'job-1',
      text: `line ${String(i)}`,
    }));
    const state = fold([started, ...logs]);

    expect(state.jobs['job-1']!.log).toHaveLength(LIVE_LOG_LINES);
    expect(state.jobs['job-1']!.log.at(-1)).toBe(`line ${String(LIVE_LOG_LINES + 49)}`);
  });

  it('appends steps in order', () => {
    const state = fold([
      started,
      {
        type: 'job.step',
        jobId: 'job-1',
        seq: 1,
        pluginId: 'trawlarr:start',
        outputNumber: 1,
        durationMs: 2,
      },
      {
        type: 'job.step',
        jobId: 'job-1',
        seq: 2,
        pluginId: 'trawlarr:execute',
        outputNumber: 1,
        durationMs: 900,
      },
    ]);
    expect(state.jobs['job-1']!.steps.map((step) => step.pluginId)).toEqual([
      'trawlarr:start',
      'trawlarr:execute',
    ]);
  });

  it('ignores a frame for a job it never saw start', () => {
    // Connecting mid-job is normal, and a reconnecting client is owed no
    // replay. A phantom row with no path is worse than no row.
    const state = fold([{ type: 'job.progress', jobId: 'ghost', percent: 10, stage: 'x' }]);
    expect(state.jobs).toEqual({});
  });

  it('tracks scan progress per library and clears it on finish', () => {
    const withScan = fold([{ type: 'scan.progress', libraryId: 'lib-1', seen: 120 }]);
    expect(withScan.scanning['lib-1']).toBe(120);

    const finished = reduceLive(withScan, {
      type: 'scan.finished',
      libraryId: 'lib-1',
      summary: { seen: 120 } as never,
    });
    expect(finished.scanning).toEqual({});
    expect(finished.staleness.libraries).toBe(1);
  });

  it('flags libraries stale when one pauses or resumes', () => {
    const paused = fold([
      { type: 'library.paused', libraryId: 'lib-1', reason: 'flow-invalid: x' },
    ]);
    expect(paused.staleness.libraries).toBe(1);
    expect(
      reduceLive(paused, { type: 'library.resumed', libraryId: 'lib-1' }).staleness.libraries,
    ).toBe(2);
  });

  it('flags workers stale on a worker count change', () => {
    const state = fold([
      { type: 'workers.changed', target: { transcode: 2, health: 0 }, active: 1 },
    ]);
    expect(state.staleness.workers).toBe(1);
  });
});
