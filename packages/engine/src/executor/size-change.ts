import type { PluginModule, PluginOutputArgs } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';

/**
 * Check Size Change: may a new file of this size replace the original?
 *
 * This was a built-in gate inside Replace Original File (`32381d6`), after a
 * drain re-encoded lean WEBDL episodes at a fixed quality target and every
 * one grew — up to 2.17x — with nothing in the flow wrong. It is a node now
 * because a fixed allowance was the wrong answer for flows that make a file
 * bigger ON PURPOSE: adding a stereo AAC track beside the surround one grows
 * a file by its bitrate times its running time, which no 1% allows, so those
 * files were discarded on every run and never converged. A flow that wants
 * the old protection keeps it by including this node; templates do, and the
 * flow editor warns when a Replace is reachable without it.
 *
 * Output 1 continues; output 2 means "bigger than allowed". Left unwired,
 * output 2 ends the run as a success that changed nothing — the original
 * stays and the file is recorded as done, exactly what the built-in gate did
 * — so the next scan skips it rather than encoding it again.
 */

/** The allowance an unset input gets: the 1% the built-in gate allowed. */
export const DEFAULT_MAX_SIZE_PERCENT = 101;

/**
 * Extra bytes a file may grow by regardless of the percentage, at limits of
 * 100% or more.
 *
 * Container overhead is structural, not proportional: an mp4 `moov` atom or
 * matroska cues scale with frame and stream count, so on a small file they are
 * a large fraction of a small number — a 2-second fixture remuxed mkv -> mp4
 * grows 1.3% without a frame re-encoded. Only under ~100 MiB is this the
 * larger bound. Not applied below 100%, where the limit is asking for a
 * saving and an allowance would admit the very non-saving it forbids.
 */
export const SIZE_CHANGE_SLACK_BYTES = 1_048_576;

export interface SizeChange {
  withinLimit: boolean;
  /** Signed: negative for a file that shrank. */
  grewByBytes: number;
  /** New size as a fraction of the original's; 1 when equal. */
  ratio: number;
}

export const decideSizeChange = (input: {
  newSizeBytes: number;
  originalSizeBytes: number;
  maxPercent: number;
}): SizeChange => {
  const grewByBytes = input.newSizeBytes - input.originalSizeBytes;
  const ratio = input.originalSizeBytes > 0 ? input.newSizeBytes / input.originalSizeBytes : 1;
  // An empty original is no basis for a judgement; Verify Output refuses
  // such a file outright before this is reached.
  if (input.originalSizeBytes <= 0) return { withinLimit: true, grewByBytes, ratio };
  const byPercent = input.newSizeBytes <= (input.originalSizeBytes * input.maxPercent) / 100;
  const bySlack = input.maxPercent >= 100 && grewByBytes <= SIZE_CHANGE_SLACK_BYTES;
  return { withinLimit: byPercent || bySlack, grewByBytes, ratio };
};

/** Reads the node input. Empty means the default; otherwise a number from 1 to 1000. */
export const maxSizePercentFrom = (value: unknown): number => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_MAX_SIZE_PERCENT;
  }
  const percent = Number(String(value).trim());
  if (!Number.isFinite(percent) || percent < 1 || percent > 1000) {
    throw new Error(
      `Maximum size must be a percentage of the original from 1 to 1000, got "${String(value)}".`,
    );
  }
  return percent;
};

/** `50.0% smaller`, `the same size`, `12.5% larger`. */
export const describeSizeChange = (originalSizeBytes: number, newSizeBytes: number): string => {
  if (originalSizeBytes <= 0) return 'a change of unknown proportion';
  if (newSizeBytes === originalSizeBytes) return 'the same size';
  const percent = Math.abs((newSizeBytes / originalSizeBytes - 1) * 100);
  return `${percent.toFixed(1)}% ${newSizeBytes < originalSizeBytes ? 'smaller' : 'larger'}`;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Engine-controlled, like Verify Output: the node's own module refuses to run
 * outside the engine, and a dry run — which has no output file to measure —
 * substitutes a stand-in that continues on output 1.
 *
 * Measures both FILES rather than reading `file_size`: after Execute the file
 * object still describes the pre-transcode file until Replace re-reads it, so
 * a size comparison built on `file_size` compares the original with itself.
 * That is also why Tdarr's own Compare File Size Ratio node cannot do this job
 * here unmodified.
 */
export const createCheckSizeChangeRunner =
  (input: {
    statFile: (path: string) => Promise<{ size: number; nlink: number }>;
    log?: (text: string) => void;
  }) =>
  (plugin: LoadedPlugin): PluginModule | null => {
    if (plugin.id !== 'trawlarr:checkSizeChange') return null;
    return {
      details: () => plugin.details,
      plugin: async (args): Promise<PluginOutputArgs> => {
        const say = (text: string) => {
          args.jobLog(text);
          input.log?.(text);
        };
        const maxPercent = maxSizePercentFrom(args.inputs.maxSizePercent);
        const newPath = args.inputFileObj._id;
        const originalPath = args.originalLibraryFile._id;

        let newSize: number;
        let originalSize: number;
        try {
          [newSize, originalSize] = (
            await Promise.all([input.statFile(newPath), input.statFile(originalPath)])
          ).map((stats) => stats.size) as [number, number];
        } catch (error) {
          throw new Error(`Check Size Change: a file could not be read (${messageOf(error)}).`);
        }

        const change = decideSizeChange({
          newSizeBytes: newSize,
          originalSizeBytes: originalSize,
          maxPercent,
        });
        const summary =
          `The new file is ${String(newSize)} bytes against the original's ` +
          `${String(originalSize)}: ${describeSizeChange(originalSize, newSize)}. The limit is ` +
          `${String(maxPercent)}% of the original.`;
        say(
          change.withinLimit ? `${summary} Within the limit.` : `${summary} Larger than allowed.`,
        );

        return {
          outputNumber: change.withinLimit ? 1 : 2,
          outputFileObj: { _id: newPath },
          variables: args.variables,
        };
      },
    };
  };
