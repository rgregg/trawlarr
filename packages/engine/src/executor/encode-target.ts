import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

export interface EncodeTarget {
  /** Where ffmpeg should be told to write — never the same path as the input. */
  writePath: string;
  /** Where the result belongs once encoding succeeds. */
  finalPath: string;
}

/**
 * Decide where an Execute node's ffmpeg run writes, and where that output
 * ultimately belongs.
 *
 * ffmpeg refuses to write to the same path it is reading from — and a
 * convergent flow's declared output naturally lands back on the input path
 * once the file already lives where it belongs. So the write target is
 * always a scratch path alongside the real one; callers that actually run
 * ffmpeg rename it into place on success. This is the single place that
 * decides the encode target, so the real Execute and the dry run can never
 * disagree about what command would run.
 */
export const resolveEncodeTarget = (input: {
  path: string;
  container: string;
  outputPathFor: (path: string, container: string) => string;
}): EncodeTarget => {
  const finalPath = input.outputPathFor(input.path, input.container);
  const ext = extname(finalPath);
  const writePath = `${finalPath.slice(0, finalPath.length - ext.length)}.trawlarr-tmp-${randomUUID()}${ext}`;
  return { writePath, finalPath };
};
