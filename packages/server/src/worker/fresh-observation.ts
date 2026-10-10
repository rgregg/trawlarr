import { stat as fsStat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ProbeData } from '@trawlarr/plugin-api';
import { probeFile } from '../probe/ffprobe.js';
import type { JobPayload } from './job-payload.js';

/** What a run takes as true of its file when it starts. */
export interface FileObservation {
  probe: ProbeData;
  container: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * The facts a run should start from: the payload's if the file on disk is
 * still the one that was probed, a fresh probe's if it is not.
 *
 * A payload is built from the row, and the row describes the file as the last
 * SCAN (or the last recorded replacement) saw it. A retry after a failed
 * reconcile is exactly the case where those are far apart: the first attempt
 * installed a new file, then `updateAfterRun` failed (an identity conflict), so
 * the row still carries the pre-transcode probe while the file on disk is
 * already converted. Run against the row, the flow saw `vc1` on a file that
 * was already HEVC and encoded it a second time (11.02 GB to 10.16 GB), with
 * stream maps computed from the stale probe.
 *
 * Size and mtime are the comparison, the same pair the scanner uses to decide
 * a file needs re-probing. A file that cannot be stat'd keeps the payload's
 * facts, because the flow's own nodes report that failure better than this
 * does. A file that CHANGED but cannot be probed throws: running a flow on
 * facts known to be stale is the defect, and the attempt is cheaper to spend
 * than the encode.
 */
export const observeCurrentFile = async (input: {
  payload: JobPayload;
  log: (text: string) => void;
  /** Seams for tests. */
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number; ctimeMs: number }>;
  probe?: (input: { ffprobePath: string; path: string }) => Promise<ProbeData>;
}): Promise<FileObservation> => {
  const { payload } = input;
  const unchanged: FileObservation = {
    probe: payload.probe,
    container: payload.container,
    sizeBytes: payload.sizeBytes,
    mtimeMs: payload.mtimeMs,
    ctimeMs: payload.ctimeMs,
  };

  let current;
  try {
    current = await (input.stat ?? fsStat)(payload.path);
  } catch {
    return unchanged;
  }
  if (current.size === payload.sizeBytes && current.mtimeMs === payload.mtimeMs) return unchanged;

  // A remux or tag fix can change mtime and leave the byte count identical;
  // "2048 bytes then, 2048 now" would give an operator nothing to go on.
  const what =
    current.size !== payload.sizeBytes
      ? `${String(payload.sizeBytes)} bytes then, ${String(current.size)} now`
      : `modified ${new Date(payload.mtimeMs).toISOString()} then, ${new Date(current.mtimeMs).toISOString()} now`;
  input.log(
    `"${payload.path}" has changed since it was last probed (${what}), so it is being probed ` +
      `again before the flow runs.`,
  );
  let probe: ProbeData;
  try {
    probe = await (input.probe ?? probeFile)({
      ffprobePath: payload.ffprobePath,
      path: payload.path,
    });
  } catch (error) {
    throw new Error(
      `"${payload.path}" has changed since it was last probed and could not be probed again ` +
        `(${error instanceof Error ? error.message : String(error)}). Not running the flow ` +
        `against facts known to be out of date.`,
      { cause: error },
    );
  }
  return {
    probe,
    container: extname(payload.path).replace('.', '').toLowerCase(),
    sizeBytes: current.size,
    mtimeMs: current.mtimeMs,
    ctimeMs: current.ctimeMs,
  };
};
