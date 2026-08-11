import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { assertCommandInitialised } from '@trawlarr/core';

/** Encoders that take -crf; the hardware ones take -cq instead. */
const CRF_ENCODERS = new Set(['libx264', 'libx265', 'libsvtav1', 'libvpx-vp9']);

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
  const qualityFlag = CRF_ENCODERS.has(encoder) ? '-crf' : '-cq';

  for (const stream of args.variables.ffmpegCommand.streams) {
    if (stream.codec_type !== 'video' || stream.removed === true) continue;
    stream.outputArgs.push('-c:v', encoder, qualityFlag, quality);
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
