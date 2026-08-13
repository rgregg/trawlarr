import type {
  FfmpegCommand,
  FfmpegCommandStream,
  ProbeData,
  ProbeStream,
} from '@trawlarr/plugin-api';

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

/** ffprobe reports cover art as a video stream carrying this disposition. */
const isAttachedPicture = (stream: ProbeStream): boolean =>
  Number((stream.disposition as Record<string, unknown> | undefined)?.attached_pic) === 1;

const mapArgsFor = (stream: ProbeStream, position: number): string[] => {
  const index = typeof stream.index === 'number' ? stream.index : position;
  return ['-map', `0:${index}`];
};

/**
 * Seed a command from a probe. Each ffprobe stream becomes a mutable stream
 * carrying its original fields plus the five the contract adds, because
 * plugins read arbitrary ffprobe properties while deciding what to do.
 */
export const beginFfmpegCommand = (input: {
  probe: ProbeData;
  container: string;
  inputPath: string;
}): FfmpegCommand => ({
  init: true,
  inputFiles: [input.inputPath],
  streams: (input.probe.streams ?? []).map((stream, position): FfmpegCommandStream => ({
    ...stream,
    // Cover art is an mjpeg "video" stream; reclassifying it keeps encoder
    // nodes, which select on codec_type, from trying to re-encode a poster.
    codec_type: isAttachedPicture(stream) ? 'attachment' : stream.codec_type,
    removed: false,
    forceEncoding: false,
    mapArgs: mapArgsFor(stream, position),
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

/**
 * Does this command actually change anything?
 *
 * Plugins set `shouldProcess` when they know they have made a change, but
 * some changes are implicit: removing a stream, asking a stream to encode,
 * or adding overall arguments all mean work is needed even if no plugin said
 * so. Running ffmpeg when nothing changed would rewrite the file for no
 * reason — a needless remux of every file in a library.
 */
export const deriveShouldProcess = (command: FfmpegCommand): boolean =>
  command.shouldProcess ||
  command.overallInputArguments.length > 0 ||
  command.overallOuputArguments.length > 0 ||
  command.streams.some(
    (stream) => stream.removed === true || stream.outputArgs.length > 0 || stream.forceEncoding,
  );

/** Close the command after Execute; a further command needs a fresh Begin. */
export const closeFfmpegCommand = (command: FfmpegCommand): FfmpegCommand => ({
  ...command,
  init: false,
  shouldProcess: false,
});
