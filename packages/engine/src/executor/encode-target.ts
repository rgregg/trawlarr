import { randomUUID } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export interface EncodeTarget {
  /** Where ffmpeg should be told to write — never the same path as the input. */
  writePath: string;
  /** Where the result belongs once encoding succeeds. */
  finalPath: string;
}

/**
 * Raised when an Execute node's resolved output path is the file it is reading.
 *
 * Spec §6.1: the engine never implicitly replaces a file. Replacement is an
 * explicit, separately-routed decision, so a configuration that would land the
 * encode back on its own input is a configuration error, not something to
 * silently perform.
 */
export class InPlaceOutputError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `Execute resolved its output to "${path}", which is the file it is reading. ` +
        `Trawlarr never implicitly replaces a file: replacing the original is an explicit ` +
        `"Replace Original File" node (arriving in P2), not a side effect of encoding. ` +
        `Point this flow's output at a path that differs from the input — a different ` +
        `working directory, or a container that changes the extension.`,
    );
    this.name = 'InPlaceOutputError';
    this.path = path;
  }
}

/**
 * Resolve a path to its canonical absolute form.
 *
 * First attempts `realpathSync` to follow symlinks and normalize the path;
 * if the file does not exist, falls back to `resolve` to at least normalize
 * relative paths and `.` / `..` segments to absolute form.
 *
 * This allows the guard to catch cases where two different relative-path
 * spellings denote the same file, or where symlinks would cause an overwrite.
 */
const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    // Path may not exist yet (e.g., output file), so fall back to resolution.
    return resolve(path);
  }
};

/**
 * Decide where an Execute node's ffmpeg run writes, and where that output
 * ultimately belongs.
 *
 * Two separate concerns, deliberately handled here rather than at the call
 * sites so the real Execute and the dry run can never disagree about what
 * command would run:
 *
 *  1. ffmpeg refuses to write to the path it is reading, so the write target
 *     is always a scratch path alongside the final one; callers that actually
 *     run ffmpeg rename it into place on success.
 *  2. If the FINAL path is the input path, the scratch dance would end in
 *     silently clobbering the original. That is refused outright — see
 *     InPlaceOutputError.
 */
export const resolveEncodeTarget = (input: {
  path: string;
  container: string;
  outputPathFor: (path: string, container: string) => string;
}): EncodeTarget => {
  const finalPath = input.outputPathFor(input.path, input.container);
  // Compare canonical absolute paths to catch relative-path spellings and symlink aliases.
  if (canonicalPath(finalPath) === canonicalPath(input.path)) {
    throw new InPlaceOutputError(finalPath);
  }
  const ext = extname(finalPath);
  const writePath = `${finalPath.slice(0, finalPath.length - ext.length)}.trawlarr-tmp-${randomUUID()}${ext}`;
  return { writePath, finalPath };
};
