import { rename, unlink } from 'node:fs/promises';
import type { PluginModule } from '@trawlarr/plugin-api';
import { closeFfmpegCommand, compileFfmpegArgs, deriveShouldProcess } from '@trawlarr/core';
import { runFfmpeg } from '../ffmpeg/run.js';
import type { LoadedPlugin } from '../host/loader.js';
import { resolveEncodeTarget } from './encode-target.js';

/**
 * The engine owns execution: the Execute node's declared behaviour is replaced
 * by this, which compiles the cooperatively-built command and runs ffmpeg.
 * Keeping it here rather than inside the plugin is what makes dry runs and
 * cancellation possible at all.
 */
export const createExecuteRunner =
  (input: {
    ffmpegPath: string;
    outputPathFor: (path: string, container: string) => string;
    signal?: AbortSignal;
    onProgress?: (percent: number | null) => void;
    log?: (text: string) => void;
  }) =>
  (plugin: LoadedPlugin): PluginModule | null => {
    if (plugin.id !== 'trawlarr:execute') return null;

    return {
      details: () => plugin.details,
      plugin: async (args) => {
        const command = args.variables.ffmpegCommand;

        if (!deriveShouldProcess(command)) {
          input.log?.(
            'Nothing to do: no stream changes and no overall arguments. Skipping ffmpeg.',
          );
          return {
            outputNumber: 1,
            outputFileObj: { _id: args.inputFileObj._id },
            variables: { ...args.variables, ffmpegCommand: closeFfmpegCommand(command) },
          };
        }

        // The scratch/final split — and the refusal to resolve a final path
        // that IS the input, which would silently replace the original —
        // lives in resolveEncodeTarget, shared with the dry run, so the two
        // can never disagree about what command would run. It throws rather
        // than returning, which runFlow records as this node's error.
        const { writePath: scratchOutputPath, finalPath: outputPath } = resolveEncodeTarget({
          path: args.inputFileObj._id,
          container: command.container,
          outputPathFor: input.outputPathFor,
        });
        const ffmpegArgs = compileFfmpegArgs({ command, outputPath: scratchOutputPath });

        input.log?.(`Running: ${input.ffmpegPath} ${ffmpegArgs.join(' ')}`);

        const durationMs = Number.parseFloat(
          String(args.inputFileObj.ffProbeData.format?.duration ?? ''),
        );

        const result = await runFfmpeg({
          ffmpegPath: input.ffmpegPath,
          args: ffmpegArgs,
          durationMs: Number.isFinite(durationMs) ? durationMs * 1000 : null,
          signal: input.signal,
          onProgress: (progress) => {
            input.onProgress?.(progress.percent);
            args.updateWorker({ percentage: progress.percent, fps: progress.fps });
          },
        });

        const succeeded = result.code === 0 && !result.cancelled;
        if (!succeeded) {
          input.log?.(`ffmpeg failed (code ${String(result.code)}): ${result.stderrTail}`);
          await unlink(scratchOutputPath).catch(() => {});
        } else {
          await rename(scratchOutputPath, outputPath);
        }

        return {
          outputNumber: succeeded ? 1 : 2,
          outputFileObj: { _id: succeeded ? outputPath : args.inputFileObj._id },
          variables: { ...args.variables, ffmpegCommand: closeFfmpegCommand(command) },
        };
      },
    };
  };
