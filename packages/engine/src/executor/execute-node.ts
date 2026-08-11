import { randomUUID } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import type { PluginModule } from '@trawlarr/plugin-api';
import { closeFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import { runFfmpeg } from '../ffmpeg/run.js';
import type { LoadedPlugin } from '../host/loader.js';

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
        const outputPath = input.outputPathFor(args.inputFileObj._id, command.container);

        // ffmpeg refuses to write to the same path it is reading from — and a
        // convergent flow's declared output naturally lands back on the input
        // path once the file already lives where it belongs. Write to a scratch
        // path alongside the real one and rename into place on success, so the
        // final path is atomic and never observed half-written.
        const ext = extname(outputPath);
        const scratchOutputPath = `${outputPath.slice(0, outputPath.length - ext.length)}.trawlarr-tmp-${randomUUID()}${ext}`;
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
