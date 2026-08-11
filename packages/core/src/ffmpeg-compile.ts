import type { FfmpegCommand } from '@trawlarr/plugin-api';
import { assertCommandInitialised } from './ffmpeg-command.js';

/**
 * Compile the cooperatively-built command into argv.
 *
 * Order is fixed by ffmpeg's grammar: overall input args, then per-stream
 * input args (hoisted, since things like -hwaccel must precede -i), then
 * inputs, then the map/output-args pairs for surviving streams, then overall
 * output args, then the output path.
 *
 * The blanket `-c copy` is emitted only when no stream asked for its own
 * codec; otherwise it would override the encoders plugins just configured.
 */
export const compileFfmpegArgs = (input: {
  command: FfmpegCommand;
  outputPath: string;
}): string[] => {
  const { command, outputPath } = input;

  assertCommandInitialised(command);

  if (command.inputFiles.length === 0) {
    throw new Error('Cannot compile an ffmpeg command with no input file.');
  }

  const kept = command.streams.filter((stream) => stream.removed !== true);
  if (command.streams.length > 0 && kept.length === 0) {
    throw new Error(
      'Cannot compile an ffmpeg command in which every stream was removed — ' +
        'the output would contain nothing.',
    );
  }

  const args: string[] = [...command.overallInputArguments];

  for (const stream of command.streams) {
    if (stream.removed === true) continue;
    args.push(...stream.inputArgs);
  }

  for (const file of command.inputFiles) {
    args.push('-i', file);
  }

  const anyStreamEncodes = kept.some(
    (stream) => stream.outputArgs.length > 0 || stream.forceEncoding === true,
  );

  for (const stream of kept) {
    const index = command.streams.indexOf(stream);
    args.push('-map', `0:${index}`);
    args.push(...stream.outputArgs);
  }

  if (!anyStreamEncodes) {
    args.push('-c', 'copy');
  }

  args.push(...command.overallOuputArguments);
  args.push(outputPath);

  return args;
};
