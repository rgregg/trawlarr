import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Five megabytes per job. Large enough for an hour of verbose ffmpeg
 * progress, small enough that a plugin logging in a loop costs one file
 * rather than the volume.
 */
export const JOB_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface JobLogWriter {
  append(text: string): void;
  close(): void;
}

/**
 * A synchronous, capped, append-only writer for one job's log.
 *
 * SYNCHRONOUS ON PURPOSE. This runs inside the worker agent, whose most
 * important log line is the last one before it is killed — an OOM kill
 * during a long transcode is the realistic case, and buffered async writes
 * are exactly the lines that would be lost. `writeSync` to an `a`-mode
 * descriptor is durable enough for that: the kernel keeps the data across a
 * process death, which is the death this is defending against.
 */
export const createJobLogWriter = (input: { path: string; maxBytes?: number }): JobLogWriter => {
  const maxBytes = input.maxBytes ?? JOB_LOG_MAX_BYTES;
  mkdirSync(dirname(input.path), { recursive: true });
  const fd = openSync(input.path, 'a');
  let written = 0;
  let truncated = false;
  let closed = false;

  return {
    append: (text) => {
      if (closed || truncated) return;
      const line = Buffer.from(`${text}\n`, 'utf8');
      if (written + line.byteLength > maxBytes) {
        truncated = true;
        writeSync(fd, Buffer.from(`--- log truncated at ${String(maxBytes)} bytes ---\n`, 'utf8'));
        return;
      }
      writeSync(fd, line);
      written += line.byteLength;
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
};
