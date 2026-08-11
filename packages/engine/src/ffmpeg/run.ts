import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { PROGRESS_ARGS, createProgressParser, type FfmpegProgress } from './progress.js';

interface ReadableLike extends EventEmitter {
  setEncoding(encoding: string): unknown;
}

export interface ChildProcessLike extends EventEmitter {
  stdout: ReadableLike | null;
  stderr: ReadableLike | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcessLike;

export interface FfmpegRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  cancelled: boolean;
}

export interface RunFfmpegInput {
  ffmpegPath: string;
  args: string[];
  /** Probed duration, used to turn out_time into a percentage. */
  durationMs?: number | null;
  onProgress?: (progress: FfmpegProgress & { percent: number | null }) => void;
  signal?: AbortSignal;
  stderrTailLines?: number;
  spawnFn?: SpawnFn;
}

const DEFAULT_STDERR_TAIL_LINES = 40;

/**
 * Run ffmpeg.
 *
 * Progress is forwarded as it arrives because it doubles as the job's stall
 * heartbeat — a job that reports nothing for long enough is indistinguishable
 * from a hung one and gets killed. stderr is kept as a tail of the last
 * `stderrTailLines` lines, which keeps a diagnosable message when ffmpeg fails
 * without accumulating the entire (often enormous) stderr stream. Note this
 * bounds the LINE COUNT, not the byte count: a run that emits a small number
 * of pathologically long lines is still bounded only by those lines' length.
 */
export const runFfmpeg = (input: RunFfmpegInput): Promise<FfmpegRunResult> =>
  new Promise((resolve, reject) => {
    const spawnFn = input.spawnFn ?? (spawn as unknown as SpawnFn);
    const tailLimit = input.stderrTailLines ?? DEFAULT_STDERR_TAIL_LINES;

    const child = spawnFn(input.ffmpegPath, [...PROGRESS_ARGS, ...input.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parser = createProgressParser();
    const stderrTail: string[] = [];
    let cancelled = false;
    let finished = false;

    const onAbort = (): void => {
      if (finished) return;
      cancelled = true;
      // SIGKILL rather than SIGTERM: ffmpeg can ignore a polite request while
      // finalising, and a cancelled job must actually stop.
      child.kill('SIGKILL');
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = (): void => {
      finished = true;
      input.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (input.onProgress === undefined) return;
      for (const progress of parser.push(chunk)) {
        const duration = input.durationMs ?? null;
        const percent =
          duration === null || duration <= 0 || progress.outTimeMs === null
            ? null
            : Math.min(100, Math.round((progress.outTimeMs / duration) * 100));
        input.onProgress({ ...progress, percent });
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line === '') continue;
        stderrTail.push(line);
        if (stderrTail.length > tailLimit) stderrTail.shift();
      }
    });

    child.on('error', (error: Error) => {
      cleanup();
      reject(error);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal, stderrTail: stderrTail.join('\n'), cancelled });
    });
  });
