import type { ProbeStream } from './file-object.js';

/** An ffprobe stream plus the four fields plugins mutate to shape the command. */
export interface FfmpegCommandStream extends ProbeStream {
  removed: boolean;
  forceEncoding: boolean;
  inputArgs: string[];
  outputArgs: string[];
  /**
   * The `-map` arguments selecting this stream from its input. Carried per
   * stream rather than derived from array position, because plugins reorder,
   * insert and clone streams — after a reorder, position no longer identifies
   * the source track. Seeded as ['-map', '0:<ffprobe index>'].
   *
   * Present on the runtime object even though it is easy to overlook when
   * reading the published interface; community plugins spread it directly.
   */
  mapArgs: string[];
}

export interface FfmpegCommand {
  init: boolean;
  inputFiles: string[];
  streams: FfmpegCommandStream[];
  container: string;
  hardwareDecoding: boolean;
  shouldProcess: boolean;
  overallInputArguments: string[];
  /**
   * Spelled `Ouput` deliberately: this is the upstream contract key and
   * community plugins write to it. Do not "correct" it.
   */
  overallOuputArguments: string[];
}
