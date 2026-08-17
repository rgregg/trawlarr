import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { PROGRESS_ARGS, createProgressParser, type FfmpegProgress } from './progress.js';
import {
  defaultKill,
  killProcessGroup,
  trackProcessGroupLeader,
  untrackProcessGroupLeader,
  type KillFn,
} from './process-group.js';

interface ReadableLike extends EventEmitter {
  setEncoding(encoding: string): unknown;
}

export interface ChildProcessLike extends EventEmitter {
  stdout: ReadableLike | null;
  stderr: ReadableLike | null;
  /** Undefined when the spawn itself failed, per Node's ChildProcess contract. */
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
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
  /**
   * Seam for tests: the kill used for this run's process group. Defaults to the
   * real `process.kill`; production code never sets this. It exists so a test
   * driving a FAKE child — whose pid belongs to some unrelated real process, or
   * to nothing at all — cannot signal a process group it did not create.
   */
  killFn?: KillFn;
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
export type RunFfmpegFn = (input: RunFfmpegInput) => Promise<FfmpegRunResult>;

export const runFfmpeg: RunFfmpegFn = (input) =>
  new Promise((resolve, reject) => {
    const spawnFn = input.spawnFn ?? (spawn as unknown as SpawnFn);
    const tailLimit = input.stderrTailLines ?? DEFAULT_STDERR_TAIL_LINES;

    const killFn = input.killFn ?? defaultKill;

    // `detached: true` makes the child a process-group LEADER, so its own
    // children join that group and one kill(-pid) reaches the whole tree. See
    // process-group.ts for why that is necessary (a plugin may spawn ffmpeg
    // itself) and for the cost it carries (the child no longer receives the
    // terminal's SIGINT, so the host's exit paths must kill the group).
    const child = spawnFn(input.ffmpegPath, [...PROGRESS_ARGS, ...input.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackProcessGroupLeader(child.pid, killFn);

    const parser = createProgressParser();
    const stderrTail: string[] = [];
    let cancelled = false;
    let finished = false;

    const onAbort = (): void => {
      if (finished) return;
      cancelled = true;
      // SIGKILL rather than SIGTERM: ffmpeg can ignore a polite request while
      // finalising, and a cancelled job must actually stop.
      //
      // The GROUP, not the pid: a plugin that spawns ffmpeg itself makes the
      // process we spawned a parent, and signalling only its pid leaves the
      // transcode running with nothing left to record or clean up after it.
      // The direct kill still follows unconditionally, as the fallback for the
      // cases where the group signal cannot be delivered — a child that failed
      // to spawn and has no pid, or an EPERM.
      killProcessGroup(child.pid, 'SIGKILL', killFn);
      child.kill('SIGKILL');
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = (): void => {
      finished = true;
      input.signal?.removeEventListener('abort', onAbort);
      // Untracked on close, not on abort: the group is only definitely gone
      // once the child has been reaped, and the host's exit paths must still
      // take it down if the host dies in between.
      untrackProcessGroupLeader(child.pid);
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
