import { describe, expect, it } from 'vitest';
import { PROGRESS_ARGS, createProgressParser } from './progress.js';

describe('PROGRESS_ARGS', () => {
  it('asks ffmpeg for machine-readable progress on stdout', () => {
    expect(PROGRESS_ARGS).toContain('-progress');
    expect(PROGRESS_ARGS).toContain('pipe:1');
    expect(PROGRESS_ARGS).toContain('-nostats');
  });
});

describe('createProgressParser', () => {
  it('emits one update per progress block', () => {
    const parser = createProgressParser();
    const updates = parser.push(
      ['frame=120', 'fps=48.5', 'out_time_ms=5000000', 'speed=2.1x', 'progress=continue', ''].join(
        '\n',
      ),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      frame: 120,
      fps: 48.5,
      outTimeMs: 5000,
      speed: 2.1,
      done: false,
    });
  });

  it('converts out_time_ms, which ffmpeg reports in microseconds', () => {
    const parser = createProgressParser();
    const [update] = parser.push('out_time_ms=90000000\nprogress=continue\n');
    expect(update?.outTimeMs).toBe(90_000);
  });

  it('marks the final block done', () => {
    const parser = createProgressParser();
    const [update] = parser.push('out_time_ms=1000000\nprogress=end\n');
    expect(update?.done).toBe(true);
  });

  it('handles a block split across chunk boundaries', () => {
    const parser = createProgressParser();
    expect(parser.push('frame=10\nout_time')).toHaveLength(0);
    const updates = parser.push('_ms=2000000\nprogress=continue\n');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.outTimeMs).toBe(2000);
    expect(updates[0]?.frame).toBe(10);
  });

  it('emits several updates from one busy chunk', () => {
    const parser = createProgressParser();
    const updates = parser.push(
      'out_time_ms=1000000\nprogress=continue\nout_time_ms=2000000\nprogress=continue\n',
    );
    expect(updates.map((u: (typeof updates)[number]) => u.outTimeMs)).toEqual([1000, 2000]);
  });

  it('reports nulls for fields ffmpeg omits rather than guessing', () => {
    const parser = createProgressParser();
    const [update] = parser.push('progress=continue\n');
    expect(update).toEqual({ frame: null, fps: null, outTimeMs: null, speed: null, done: false });
  });

  it('ignores N/A values, which ffmpeg emits early in a run', () => {
    const parser = createProgressParser();
    const [update] = parser.push('fps=N/A\nout_time_ms=N/A\nprogress=continue\n');
    expect(update?.fps).toBeNull();
    expect(update?.outTimeMs).toBeNull();
  });
});
