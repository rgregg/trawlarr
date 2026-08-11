import type { ProbeStream } from './file-object.js';

/** An ffprobe stream plus the four fields plugins mutate to shape the command. */
export interface FfmpegCommandStream extends ProbeStream {
  removed: boolean;
  forceEncoding: boolean;
  inputArgs: string[];
  outputArgs: string[];
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
