import type { FfmpegCommand, FfmpegCommandStream, ProbeData } from '@trawlarr/plugin-api';

export class FfmpegCommandStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegCommandStateError';
  }
}

export const emptyFfmpegCommand = (): FfmpegCommand => ({
  init: false,
  inputFiles: [],
  streams: [],
  container: '',
  hardwareDecoding: false,
  shouldProcess: false,
  overallInputArguments: [],
  overallOuputArguments: [],
});

/**
 * Seed a command from a probe. Each ffprobe stream becomes a mutable stream
 * carrying its original fields plus the four the contract adds, because
 * plugins read arbitrary ffprobe properties while deciding what to do.
 */
export const beginFfmpegCommand = (input: {
  probe: ProbeData;
  container: string;
  inputPath: string;
}): FfmpegCommand => ({
  init: true,
  inputFiles: [input.inputPath],
  streams: (input.probe.streams ?? []).map((stream): FfmpegCommandStream => ({
    ...stream,
    removed: false,
    forceEncoding: false,
    inputArgs: [],
    outputArgs: [],
  })),
  container: input.container,
  hardwareDecoding: false,
  shouldProcess: false,
  overallInputArguments: [],
  overallOuputArguments: [],
});

/**
 * Command-building plugins call this and throw if a Begin Command node was
 * skipped. The message names both nodes because that is the actual fix.
 */
export const assertCommandInitialised = (command: FfmpegCommand): void => {
  if (command.init !== true) {
    throw new FfmpegCommandStateError(
      'FFmpeg command plugins were used out of order. Add a "Begin Command" node before ' +
        'any command-building node, and an "Execute" node afterwards to run the command. ' +
        'Starting a second command requires another "Begin Command".',
    );
  }
};

/** Close the command after Execute; a further command needs a fresh Begin. */
export const closeFfmpegCommand = (command: FfmpegCommand): FfmpegCommand => ({
  ...command,
  init: false,
  shouldProcess: false,
});
