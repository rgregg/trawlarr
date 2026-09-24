/**
 * Everything worth knowing about a failure the daemon caught, as text for
 * the log.
 *
 * WHY THIS IS NOT JUST `error.message`. A scan once died with
 *
 *   [daemon] scan:scan failed: ENOENT: no such file or directory, lstat '<a library file>'
 *
 * and that line was the entire record. Every `lstat` and `realpathSync` on
 * the scan's path is guarded, so the message alone could not say which call
 * produced it, and the failure was a race against a file being replaced —
 * far too rare to catch by running the thing again. A stack would have named
 * the frame in one line of log; its absence cost an investigation that could
 * not conclude.
 *
 * So: the message, then the errno fields when the failure came from the
 * filesystem (`code`/`syscall`/`path` answer "which operation, on what"),
 * then the stack, then the same again for each `cause` — because the
 * interesting error is routinely wrapped by a friendlier one.
 */

/** Guards against a `cause` chain that loops back on itself. */
const MAX_CAUSE_DEPTH = 4;

const errnoDetail = (error: Error): string | null => {
  const candidate = error as NodeJS.ErrnoException;
  const parts: string[] = [];
  if (candidate.code !== undefined) parts.push(`code=${candidate.code}`);
  if (candidate.syscall !== undefined) parts.push(`syscall=${candidate.syscall}`);
  if (candidate.path !== undefined) parts.push(`path=${candidate.path}`);
  return parts.length === 0 ? null : `  ${parts.join(' ')}`;
};

const describeOne = (error: Error): string => {
  const lines = [error.message];
  const detail = errnoDetail(error);
  if (detail !== null) lines.push(detail);
  // `error.stack` normally repeats the message on its first line; the frames
  // are what this is for, so that repetition is dropped.
  const stack = error.stack;
  if (stack !== undefined) {
    const frames = stack.split('\n').filter((line) => line.trim().startsWith('at '));
    if (frames.length > 0) lines.push(frames.join('\n'));
  }
  return lines.join('\n');
};

export const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);

  const seen = new Set<unknown>();
  const sections: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) break;
    seen.add(current);
    sections.push(depth === 0 ? describeOne(current) : `  caused by: ${describeOne(current)}`);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return sections.join('\n');
};
