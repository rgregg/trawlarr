import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runFfmpeg, type SpawnFn } from './run.js';
import type { FfmpegProgress } from './progress.js';

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  pid = 4242;
  killed = false;
  killSignals: string[] = [];

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignals.push(signal ?? 'SIGTERM');
    return true;
  }
}

const harness = () => {
  const child = new FakeChild();
  const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
  return { child, spawnFn };
};

describe('runFfmpeg', () => {
  it('spawns with progress arguments ahead of the caller arguments', async () => {
    const { child, spawnFn } = harness();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: ['-i', '/in.mkv', '/out.mkv'], spawnFn });
    setImmediate(() => child.emit('close', 0, null));
    await run;

    const [command, args] = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(command).toBe('ffmpeg');
    expect(args.slice(0, 2)).toEqual(['-progress', 'pipe:1']);
    expect(args.slice(-3)).toEqual(['-i', '/in.mkv', '/out.mkv']);
  });

  it('resolves with the exit code', async () => {
    const { child, spawnFn } = harness();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], spawnFn });
    setImmediate(() => child.emit('close', 0, null));
    await expect(run).resolves.toMatchObject({ code: 0, cancelled: false });
  });

  it('reports progress with a percentage when the duration is known', async () => {
    const { child, spawnFn } = harness();
    const seen: Array<number | null> = [];
    const run = runFfmpeg({
      ffmpegPath: 'ffmpeg',
      args: [],
      durationMs: 10_000,
      onProgress: (p: FfmpegProgress & { percent: number | null }) => seen.push(p.percent),
      spawnFn,
    });
    setImmediate(() => {
      child.stdout.emit('data', 'out_time_ms=5000000\nprogress=continue\n');
      child.emit('close', 0, null);
    });
    await run;
    expect(seen).toEqual([50]);
  });

  it('reports a null percentage when the duration is unknown', async () => {
    const { child, spawnFn } = harness();
    const seen: Array<number | null> = [];
    const run = runFfmpeg({
      ffmpegPath: 'ffmpeg',
      args: [],
      onProgress: (p: FfmpegProgress & { percent: number | null }) => seen.push(p.percent),
      spawnFn,
    });
    setImmediate(() => {
      child.stdout.emit('data', 'out_time_ms=5000000\nprogress=continue\n');
      child.emit('close', 0, null);
    });
    await run;
    expect(seen).toEqual([null]);
  });

  it('clamps the percentage to 100 when ffmpeg overshoots the probed duration', async () => {
    const { child, spawnFn } = harness();
    const seen: Array<number | null> = [];
    const run = runFfmpeg({
      ffmpegPath: 'ffmpeg',
      args: [],
      durationMs: 1000,
      onProgress: (p: FfmpegProgress & { percent: number | null }) => seen.push(p.percent),
      spawnFn,
    });
    setImmediate(() => {
      child.stdout.emit('data', 'out_time_ms=9000000\nprogress=continue\n');
      child.emit('close', 0, null);
    });
    await run;
    expect(seen).toEqual([100]);
  });

  it('keeps only the tail of stderr, so a chatty run cannot exhaust memory', async () => {
    const { child, spawnFn } = harness();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], stderrTailLines: 3, spawnFn });
    setImmediate(() => {
      for (let i = 1; i <= 50; i += 1) child.stderr.emit('data', `line ${i}\n`);
      child.emit('close', 1, null);
    });
    const result = await run;
    expect(result.stderrTail.split('\n')).toHaveLength(3);
    expect(result.stderrTail).toContain('line 50');
    expect(result.stderrTail).not.toContain('line 1\n');
  });

  it('kills the process when the signal aborts, and reports cancellation', async () => {
    const { child, spawnFn } = harness();
    const controller = new AbortController();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], signal: controller.signal, spawnFn });
    setImmediate(() => {
      controller.abort();
      child.emit('close', null, 'SIGKILL');
    });
    const result = await run;
    expect(child.killed).toBe(true);
    expect(result.cancelled).toBe(true);
  });

  it('rejects when the binary cannot be spawned at all', async () => {
    const { child, spawnFn } = harness();
    const run = runFfmpeg({ ffmpegPath: 'nope', args: [], spawnFn });
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    await expect(run).rejects.toThrow(/ENOENT/);
  });

  it('does not kill an already-finished process when aborted afterwards', async () => {
    const { child, spawnFn } = harness();
    const controller = new AbortController();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], signal: controller.signal, spawnFn });
    setImmediate(() => child.emit('close', 0, null));
    await run;
    controller.abort();
    expect(child.killed).toBe(false);
  });
});
