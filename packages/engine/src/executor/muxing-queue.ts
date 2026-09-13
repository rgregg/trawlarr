/**
 * Execute's "Muxing queue size": ffmpeg's `-max_muxing_queue_size`.
 *
 * Before ffmpeg can write a single packet it needs one from every output
 * stream, so it holds the early ones in a queue. A stream that starts late —
 * typically a subtitle track whose first cue is minutes in — can fill that
 * queue, and ffmpeg then aborts the whole encode with "Too many packets
 * buffered for output stream". Raising the limit changes nothing about the
 * file written; it only stops that failure.
 *
 * Applied to the compiled argv, AFTER the no-op gate, and never through the
 * command model. The distinction is the whole design: `deriveShouldProcess`
 * and `describeCommandChanges` count ANY overall output argument as a change
 * to the file, so a size carried in `overallOuputArguments` on a path every
 * file takes would make every already-conformed file in a library run ffmpeg
 * again. Here it only ever joins a command that was going to run anyway.
 *
 * Off unless set, as in Tdarr, whose Execute adds no such argument; its own
 * health check uses 9999, which is the evidence a large value is safe.
 */

/** Far above any real need, and small enough that a typo is caught rather than obeyed. */
export const MUXING_QUEUE_SIZE_MAX = 1_048_576;

/** Reads the node input: a stored flow sends a string, a test may send a number. */
export const muxingQueueSizeFrom = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const size = Number(text);
  if (!Number.isInteger(size) || size < 1 || size > MUXING_QUEUE_SIZE_MAX) {
    throw new Error(
      `Muxing queue size must be a whole number from 1 to ${String(MUXING_QUEUE_SIZE_MAX)}, ` +
        `got "${text}". Leave it empty to use ffmpeg's default.`,
    );
  }
  return size;
};

/**
 * The argv with the size added as an OUTPUT option: after every input and
 * immediately before the output path, which `compileFfmpegArgs` always puts
 * last. Before `-i` it would apply to the input, and ffmpeg rejects it there.
 */
export const withMuxingQueueSize = (argv: readonly string[], size: number | null): string[] =>
  size === null
    ? [...argv]
    : [...argv.slice(0, -1), '-max_muxing_queue_size', String(size), argv.at(-1)!];
