import type { FfmpegCommand } from '@trawlarr/plugin-api';
import { type HardwareType, hardwareForEncoder } from './worker-class.js';

/**
 * The ffmpeg `-hwaccel` name that decodes on each hardware family, or `null`
 * where ffmpeg has no decode API for it.
 *
 * Keyed by the hardware family, not by the encoder name, so it is the same
 * table `hardwareForEncoder` already uses to route jobs: an `hevc_nvenc`,
 * `h264_nvenc` or a future `av1_nvenc` all decode through `cuda` without this
 * list having to name them.
 *
 * `amf` is deliberately `null`: AMD's AMF is an ENCODE-only API in ffmpeg —
 * there is no `-hwaccel amf` — so an AMF flow decodes on the CPU no matter
 * what is asked for. Saying so in the job log is the honest answer; emitting
 * a flag ffmpeg does not know would fail every file with "Unrecognized
 * hwaccel".
 *
 * `vaapi` gets `-hwaccel vaapi` with NO `-hwaccel_device`. Picking a render
 * node (`/dev/dri/renderD128`) for the operator would be detection — the
 * thing trawlarr does not do — and a guessed device that is wrong fails in
 * exactly the same way an unguessed one does, only less honestly. ffmpeg
 * opens its own default DRM device when it is not told which to use.
 */
export const HWACCEL_BY_HARDWARE: Record<HardwareType, string | null> = {
  cpu: null,
  nvenc: 'cuda',
  qsv: 'qsv',
  vaapi: 'vaapi',
  videotoolbox: 'videotoolbox',
  amf: null,
};

/** The `-hwaccel` name that pairs with an encoder, or `null` for none. */
export const hwaccelForEncoder = (encoder: string): string | null =>
  HWACCEL_BY_HARDWARE[hardwareForEncoder(encoder)];

/**
 * Two nodes in one flow asked for different hardware decoders.
 *
 * `-hwaccel` is an INPUT option: every stream's `inputArgs` are hoisted into
 * one preamble ahead of the single `-i`, so two different values do not
 * "apply to different streams" — they both land in front of the same input
 * and ffmpeg silently keeps the last one. Which of two GPUs decoded the file
 * would then depend on node ordering inside the flow. Refusing is the only
 * answer that cannot be wrong quietly.
 */
export class HardwareDecodeConflictError extends Error {
  constructor(flag: string, existing: string, wanted: string) {
    super(
      `This flow asks for two different hardware decoders on one input: "${flag} ${existing}" ` +
        `is already set and another node asked for "${flag} ${wanted}". ffmpeg applies ` +
        `${flag} to the whole input, not to one stream, so only the last one would take ` +
        `effect and which GPU decoded the file would depend on node order. Leave hardware ` +
        `decoding enabled on at most one node, and make it match the encoder.`,
    );
    this.name = 'HardwareDecodeConflictError';
  }
}

/** The value following `flag` in an argument list, or `null` if absent. */
const valueAfter = (args: readonly string[], flag: string): string | null => {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  return args[at + 1] ?? null;
};

/**
 * Every place an input argument can already have been written: the overall
 * preamble, and each stream's own `inputArgs` — which the compiler hoists
 * into that same preamble, so a community plugin that set `-hwaccel` on one
 * stream has set it for the whole input whether it meant to or not.
 */
const declaredInputArgs = (command: FfmpegCommand): string[] => [
  ...command.overallInputArguments,
  ...command.streams.flatMap((stream) => stream.inputArgs),
];

/**
 * Ask for the decode to happen on `hwaccel`, once, for the whole input.
 *
 * Written to `overallInputArguments` rather than to a stream: `-hwaccel`
 * describes the INPUT, and a per-stream copy would be emitted once per video
 * stream in a multi-video file, giving ffmpeg the same flag twice.
 *
 * Idempotent for an identical request (a flow with two encoder nodes both
 * targeting the same GPU is not a conflict) and throws
 * {@link HardwareDecodeConflictError} for a different one.
 *
 * `outputFormat` keeps decoded frames in device memory
 * (`-hwaccel_output_format cuda`). It is much faster — nothing is copied back
 * over PCIe — but every filter that runs on the CPU, and every encoder that
 * expects system memory, then fails on a frame it cannot read. It is off
 * unless the caller asks, so the default pairs with any flow.
 */
export const applyHardwareDecoding = (
  command: FfmpegCommand,
  input: { hwaccel: string; outputFormat?: boolean },
): void => {
  const declared = declaredInputArgs(command);
  const wanted: Array<[string, string]> = [['-hwaccel', input.hwaccel]];
  if (input.outputFormat === true) wanted.push(['-hwaccel_output_format', input.hwaccel]);

  for (const [flag, value] of wanted) {
    const existing = valueAfter(declared, flag);
    if (existing !== null && existing !== value) {
      throw new HardwareDecodeConflictError(flag, existing, value);
    }
    if (existing === null) command.overallInputArguments.push(flag, value);
  }
  command.hardwareDecoding = true;
};
