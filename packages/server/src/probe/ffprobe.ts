import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeData } from '@trawlarr/plugin-api';

const execFileAsync = promisify(execFile);

export class ProbeError extends Error {
  readonly path: string;

  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(`Cannot probe ${path}: ${message}`, options);
    this.name = 'ProbeError';
    this.path = path;
  }
}

/** Large enough for a probe of a file with many streams and chapters. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const probeFile = async (input: {
  ffprobePath: string;
  path: string;
}): Promise<ProbeData> => {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      input.ffprobePath,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input.path],
      { maxBuffer: MAX_OUTPUT_BYTES },
    ));
  } catch (cause) {
    throw new ProbeError(input.path, (cause as Error).message, { cause });
  }

  let parsed: ProbeData;
  try {
    parsed = JSON.parse(stdout) as ProbeData;
  } catch (cause) {
    throw new ProbeError(input.path, 'ffprobe produced output that is not JSON', { cause });
  }

  // ffprobe exits 0 with an empty object for a file it cannot decode, so an
  // absent streams array is a failure rather than a file with no streams.
  if (parsed.streams === undefined) {
    throw new ProbeError(input.path, 'ffprobe reported no streams — not a media file?');
  }
  return parsed;
};
