import type { FfmpegCommand } from '@trawlarr/plugin-api';
import { shouldCopyStream } from '@trawlarr/core';

export interface CommandEncodes {
  video: boolean;
  audio: boolean;
}

/**
 * Which stream types this command re-encodes, by the compiler's own rule
 * (`compileFfmpegArgs`' `needsEncode`). A dry run reports this so "re-encodes
 * video" and "only rewrites audio" can be told apart without parsing argv,
 * where `-c:1 aac` does not say what stream 1 is.
 */
export const commandEncodes = (command: FfmpegCommand): CommandEncodes => {
  const encoding = command.streams.filter(
    (stream) =>
      !stream.removed && (stream.forceEncoding === true || !shouldCopyStream(stream.outputArgs)),
  );
  return {
    video: encoding.some((stream) => stream.codec_type === 'video'),
    audio: encoding.some((stream) => stream.codec_type === 'audio'),
  };
};
