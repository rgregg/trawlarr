import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { assertCommandInitialised } from '@trawlarr/core';

/**
 * Each ffmpeg encoder exposes its own quality knob under a different flag name.
 * Verified against ffmpeg 6.1.1 via `ffmpeg -h encoder=<name>` (and, for
 * hevc_qsv's -global_quality, `ffmpeg -h full | grep global_quality`, since
 * that option is a generic AVCodecContext option rather than encoder-private):
 *   - libx264 / libx265 / libsvtav1 / libvpx-vp9 (software) -> -crf
 *   - hevc_nvenc / h264_nvenc (NVIDIA)                       -> -cq
 *   - hevc_vaapi (VAAPI)                                      -> -qp (no -crf/-cq)
 *   - hevc_qsv (Intel Quick Sync)                             -> -global_quality
 *     (has no -crf, -cq, or -qp private option at all)
 *
 * The default below covers an encoder the dropdown doesn't list (a user can
 * type an arbitrary value in the string input): -crf is the flag accepted by
 * the largest, most common family of ffmpeg encoders (essentially every
 * software x264/x265/AV1/VP9-style encoder), so it's the best blind guess.
 */
const QUALITY_FLAG_BY_ENCODER: Record<string, string> = {
  libx264: '-crf',
  libx265: '-crf',
  libsvtav1: '-crf',
  'libvpx-vp9': '-crf',
  hevc_nvenc: '-cq',
  h264_nvenc: '-cq',
  hevc_vaapi: '-qp',
  hevc_qsv: '-global_quality',
};
const DEFAULT_QUALITY_FLAG = '-crf';

export const details = (): PluginDetails => ({
  name: 'Set Video Encoder',
  description: 'Choose the encoder and quality for the video stream.',
  style: { borderColor: '#cc9933' },
  tags: 'ffmpeg,video',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 3,
  icon: 'faFilm',
  inputs: [
    {
      label: 'Encoder',
      name: 'encoder',
      type: 'string',
      defaultValue: 'libx265',
      tooltip: 'The ffmpeg encoder to use. Hardware encoders require matching hardware.',
      inputUI: {
        type: 'dropdown',
        options: ['libx265', 'libx264', 'hevc_nvenc', 'h264_nvenc', 'hevc_qsv', 'hevc_vaapi'],
      },
    },
    {
      label: 'Quality',
      name: 'quality',
      type: 'string',
      defaultValue: '24',
      tooltip: 'Lower is better quality and larger files. 20–24 is usually visually lossless.',
      inputUI: { type: 'slider', sliderOptions: { min: 0, max: 51 } },
    },
  ],
  outputs: [{ number: 1, tooltip: 'Encoder set' }],
  requiresVersion: '1.0.0',
});

export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  assertCommandInitialised(args.variables.ffmpegCommand);

  const encoder = String(args.inputs.encoder ?? 'libx265');
  const quality = String(args.inputs.quality ?? '24');
  const qualityFlag = QUALITY_FLAG_BY_ENCODER[encoder] ?? DEFAULT_QUALITY_FLAG;

  for (const stream of args.variables.ffmpegCommand.streams) {
    if (stream.codec_type !== 'video' || stream.removed === true) continue;
    // `-c:{outputIndex}`, never `-c:v`. ffmpeg resolves `-c` by LAST matching
    // specifier, and a type specifier matches every video-typed output stream
    // — including cover art, which is an mjpeg video stream to ffmpeg however
    // we reclassify it internally. For a file whose cover art precedes the
    // real video track, `-c:v libx265` appearing after the cover's `-c:0 copy`
    // overrides it and encodes the poster frame into a full hevc stream
    // (verified against ffmpeg 6.1.1). Addressing the stream by its own output
    // index cannot collide; the host substitutes the placeholder at compile
    // time, since a plugin cannot know its stream's final output position.
    stream.outputArgs.push('-c:{outputIndex}', encoder, qualityFlag, quality);
    stream.forceEncoding = true;
  }
  args.variables.ffmpegCommand.shouldProcess = true;
  args.jobLog(`Video encoder set to ${encoder} at ${qualityFlag} ${quality}.`);

  return {
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
