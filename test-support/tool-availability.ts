import { execFileSync } from 'node:child_process';

/**
 * Raised when a tool-availability check could not be TRUSTED — as opposed to
 * answering "the tool is not installed".
 *
 * Thrown, never swallowed, because the caller is a `describe.runIf`
 * condition: answering `false` here skips a whole suite, and a skipped suite
 * is green. Converting "I could not run the check" into "the tool is absent"
 * therefore turns a transient failure into a silent false pass on exactly
 * the suites that exercise real ffmpeg — the class of thing this repo has
 * already been bitten by twice.
 */
export class ToolCheckFailedError extends Error {
  constructor(tool: string, cause: unknown) {
    const errno = cause as NodeJS.ErrnoException & { status?: number | null };
    const detail =
      errno.code ??
      (errno.status === undefined || errno.status === null
        ? undefined
        : `exit status ${String(errno.status)}`) ??
      String(cause);
    super(
      `Could not determine whether "${tool}" is available: the check itself failed ` +
        `(${detail}). This is NOT "${tool} is missing" — a spawn that fails under load ` +
        `(EAGAIN/EMFILE/ENOMEM), a permission problem, or a ${tool} that exists but exits ` +
        `non-zero all land here. Skipping the suite on this would report green for tests ` +
        `that never ran, so it fails instead. Re-run without a concurrent test run, or ` +
        `check that "${tool} -version" works in this shell.`,
    );
    this.name = 'ToolCheckFailedError';
    this.cause = cause;
  }
}

export type SpawnSyncFn = (
  file: string,
  args: readonly string[],
  options: { stdio: 'ignore' },
) => unknown;

/**
 * Is `tool` installed and runnable? Answered SYNCHRONOUSLY, at module scope,
 * because `describe.runIf`'s condition is read at collection time — a check
 * behind an async `beforeAll` reads as unavailable and skips the suite every
 * run, which is how a whole suite in this repo silently skipped for several
 * commits.
 *
 * Only `ENOENT` — the tool is genuinely not on PATH — answers `false`.
 * Everything else throws {@link ToolCheckFailedError}: see its doc comment
 * for why a skip is the wrong response to an unreliable check.
 */
export const toolAvailableSync = (
  tool: string,
  spawn: SpawnSyncFn = execFileSync as unknown as SpawnSyncFn,
): boolean => {
  try {
    spawn(tool, ['-version'], { stdio: 'ignore' });
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new ToolCheckFailedError(tool, cause);
  }
};

/** Both tools the media suites need, checked the same way. */
export const ffmpegAvailableSync = (): boolean =>
  toolAvailableSync('ffmpeg') && toolAvailableSync('ffprobe');
