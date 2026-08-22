import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { applyHardwareDecoding, assertCommandInitialised, hwaccelForEncoder } from '@trawlarr/core';

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
      label: 'Decode on the same hardware',
      name: 'hardwareDecoding',
      type: 'boolean',
      defaultValue: 'false',
      tooltip:
        'Decode the input on the same hardware that encodes it, by adding an -hwaccel flag ' +
        'ahead of the input. Without it a GPU encode still decodes every frame on the CPU, ' +
        'which is what limits throughput on a busy node. OFF by default and never inferred: ' +
        'the hardware must actually be there, or ffmpeg fails on every file.',
      inputUI: { type: 'switch' },
    },
    {
      label: 'Keep decoded frames on the device',
      name: 'hardwareDecodingKeepFramesOnDevice',
      type: 'boolean',
      defaultValue: 'false',
      tooltip:
        'Adds -hwaccel_output_format so decoded frames never leave the GPU. Faster again, ' +
        'but ONLY for a flow that does nothing else to the video: any filter that runs on ' +
        'the CPU (crop, scale, HDR-to-SDR, subtitle burn-in) and any encoder expecting ' +
        'system memory will fail on a frame it cannot read. Leave off unless you have ' +
        'measured the difference.',
      inputUI: {
        type: 'switch',
        displayConditions: {
          logic: 'AND',
          sets: [
            {
              logic: 'AND',
              inputs: [{ name: 'hardwareDecoding', value: 'true', condition: '===' }],
            },
          ],
        },
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

/** `'true'`/`'1'`/`'yes'` are true; anything else, including unset, is false. */
const booleanInput = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
};

export const plugin = async (args: PluginInputArgs): Promise<PluginOutputArgs> => {
  assertCommandInitialised(args.variables.ffmpegCommand);

  const encoder = String(args.inputs.encoder ?? 'libx265');
  const quality = String(args.inputs.quality ?? '24');
  const qualityFlag = QUALITY_FLAG_BY_ENCODER[encoder] ?? DEFAULT_QUALITY_FLAG;

  let encodedAnyVideo = false;

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
    encodedAnyVideo = true;
  }
  args.variables.ffmpegCommand.shouldProcess = true;
  args.jobLog(`Video encoder set to ${encoder} at ${qualityFlag} ${quality}.`);

  // Decoding is asked for LAST, and only when this node actually configured
  // an encode: a flow whose video streams were all removed has nothing to
  // decode on a GPU, and an -hwaccel flag for an input nobody encodes buys a
  // device initialisation and the failure that comes with it for nothing.
  if (booleanInput(args.inputs.hardwareDecoding) && encodedAnyVideo) {
    // Derived from the ENCODER, never detected and never guessed from the
    // machine: the operator declared this hardware, the scheduler already
    // refuses to route the job to a node that has not declared it, and
    // asking a GPU to decode for an encoder on a different GPU is not a
    // thing anyone wants. A software encoder therefore emits nothing at
    // all, which is what keeps the CPU path byte-identical.
    const hwaccel = hwaccelForEncoder(encoder);
    if (hwaccel === null) {
      args.jobLog(
        `Hardware decoding was requested, but ffmpeg has no hardware decoder that pairs with ` +
          `"${encoder}" — it decodes on the CPU. No -hwaccel flag was added.`,
      );
    } else {
      const keepFramesOnDevice = booleanInput(args.inputs.hardwareDecodingKeepFramesOnDevice);
      applyHardwareDecoding(args.variables.ffmpegCommand, {
        hwaccel,
        outputFormat: keepFramesOnDevice,
      });
      args.jobLog(
        `Hardware decoding enabled: -hwaccel ${hwaccel}` +
          (keepFramesOnDevice ? ` -hwaccel_output_format ${hwaccel}` : '') +
          `. This hardware must be present, or ffmpeg fails this file rather than falling ` +
          `back to software.`,
      );
    }
  }

  return {
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
