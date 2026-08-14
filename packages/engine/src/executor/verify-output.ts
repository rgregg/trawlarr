import type { PluginModule, ProbeData } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';

export interface VerifyReport {
  ok: boolean;
  reasons: string[];
}

/**
 * Every check the Verify Output node performs, as a pure function of two
 * probes and two sizes.
 *
 * Pure on purpose: the whole decision table — including the combinations that
 * would need a deliberately corrupted 40 GB file to reproduce on a real
 * filesystem — is testable without touching one. The runner below is the only
 * part that does IO, and it does nothing but gather these six inputs and route
 * on the result.
 */
export const verifyOutput = (input: {
  probe: ProbeData;
  originalProbe: ProbeData;
  outputSizeBytes: number;
  originalSizeBytes: number;
  durationToleranceSeconds: number;
  minSizeRatio: number;
}): VerifyReport => {
  const reasons: string[] = [];
  const streams = input.probe.streams ?? [];

  if (streams.length === 0) {
    reasons.push('the output has no streams — ffprobe could not read it');
    // Nothing else is meaningful once the file is unreadable.
    return { ok: false, reasons };
  }

  const expected = (input.originalProbe.streams ?? []).length;
  if (streams.length < expected) {
    reasons.push(`the output has ${streams.length} streams, fewer than the original's ${expected}`);
  }

  // "Unknown" must never read as "fine" — on EITHER side. ffmpeg can hit a
  // corrupt region, stop early and still exit 0, leaving a short file whose
  // duration element was never written; ffprobe reports a missing duration as
  // the literal "N/A", which parses to NaN just as an absent field does. And a
  // raw/VOB/TS ORIGINAL is routinely timed as "N/A" too, which used to skip
  // the comparison from the other direction and leave the size floor as the
  // only guard — a 20-minute 600 MB remnant of an 8 GB source clears a 5%
  // floor comfortably. Either way the length check did not happen, and saying
  // nothing about that is a false pass on the gate protecting a destructive
  // step.
  const outDuration = durationSecondsOf(input.probe);
  const origDuration = durationSecondsOf(input.originalProbe);
  if (!Number.isFinite(origDuration)) {
    reasons.push(
      `the original's duration could not be read, so the output's length could not be ` +
        `checked against it`,
    );
  } else if (!Number.isFinite(outDuration)) {
    reasons.push(
      `the output's duration could not be read, so it cannot be checked against the ` +
        `original's ${origDuration.toFixed(1)}s — a transcode that stopped early often ` +
        `leaves exactly this`,
    );
  } else {
    const drift = Math.abs(outDuration - origDuration);
    // `>`, not `>=`: the tolerance is how much the output MAY differ, so a
    // drift of exactly the tolerance passes.
    if (drift > input.durationToleranceSeconds) {
      reasons.push(
        `the output runs ${outDuration.toFixed(1)}s against the original's ` +
          `${origDuration.toFixed(1)}s, a ${drift.toFixed(1)}s difference`,
      );
    }
  }

  // Only a suspiciously SMALL output is a failure. A larger file is a normal
  // outcome of a remux or a higher-quality encode. But an original whose size
  // is unknown or zero cannot be a basis for that judgement at all, and
  // abstaining silently is the same false pass as above.
  if (input.originalSizeBytes > 0) {
    const ratio = input.outputSizeBytes / input.originalSizeBytes;
    // `<=`, not `<`: a file landing exactly ON the floor is the truncated
    // encode this check exists to catch, not a pass.
    if (ratio <= input.minSizeRatio) {
      reasons.push(
        `the output is ${(ratio * 100).toFixed(1)}% of the original's size, at or below the ` +
          `${(input.minSizeRatio * 100).toFixed(1)}% floor — this usually means a truncated encode`,
      );
    }
  } else {
    reasons.push(
      `the original's size is unknown (${input.originalSizeBytes} bytes), so the output's ` +
        `size could not be sanity-checked against it`,
    );
  }

  return { ok: reasons.length === 0, reasons };
};

/**
 * How long the media runs, in seconds, or `NaN` if nothing says.
 *
 * `format.duration` first, then the video stream's own duration. The fallback
 * matters: plenty of containers report `N/A` at format level while every
 * stream inside is timed, and `probeFile` already asks for `-show_streams`, so
 * the baseline is sitting in the data we hold. Without it, such a file fails
 * verification for want of a number that was right there — and since an
 * unreadable duration is (correctly) a refusal on a gate in front of a
 * destructive step, that refusal would land on files we could perfectly well
 * have checked.
 */
const durationSecondsOf = (probe: ProbeData): number => {
  const fromFormat = Number.parseFloat(String(probe.format?.duration ?? ''));
  if (Number.isFinite(fromFormat)) return fromFormat;

  const streams = probe.streams ?? [];
  const video = streams.filter((stream) => stream.codec_type === 'video');
  for (const stream of [...video, ...streams]) {
    const fromStream = Number.parseFloat(String(stream.duration ?? ''));
    if (Number.isFinite(fromStream)) return fromStream;
  }
  return Number.NaN;
};

/** A node input the user typed, read as a number with a documented default. */
const numberInput = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The engine's substitute for the Verify Output node.
 *
 * Shaped exactly like {@link createExecuteRunner}: it returns `null` for any
 * plugin that is not this node, and the caller keeps the module's declared
 * behaviour in that case. The declared behaviour of this node throws, so a
 * flow containing it is only runnable through an engine that installs this.
 *
 * Probing and stat-ing are injected rather than imported so this stays
 * testable without ffprobe or a filesystem, matching how the Execute runner
 * takes `runFfmpegFn`.
 */
export const createVerifyOutputRunner =
  (input: {
    probeFile: (path: string) => Promise<ProbeData>;
    statFile: (path: string) => Promise<{ size: number; nlink: number }>;
    log?: (text: string) => void;
  }) =>
  (plugin: LoadedPlugin): PluginModule | null => {
    if (plugin.id !== 'trawlarr:verifyOutput') return null;

    return {
      details: () => plugin.details,
      plugin: async (args) => {
        const say = (text: string) => {
          args.jobLog(text);
          input.log?.(text);
        };
        const outputPath = args.inputFileObj._id;
        const originalPath = args.originalLibraryFile._id;

        const durationToleranceSeconds = numberInput(args.inputs.durationToleranceSeconds, 1);
        const minSizeRatio = numberInput(args.inputs.minSizeRatio, 0.05);

        let report: VerifyReport;
        try {
          const [probe, originalProbe, outputStats, originalStats] = await Promise.all([
            input.probeFile(outputPath),
            input.probeFile(originalPath),
            input.statFile(outputPath),
            input.statFile(originalPath),
          ]);
          report = verifyOutput({
            probe,
            originalProbe,
            outputSizeBytes: outputStats.size,
            originalSizeBytes: originalStats.size,
            durationToleranceSeconds,
            minSizeRatio,
          });
        } catch (error) {
          // A file that cannot be read or probed is a failed verification, not
          // a crashed job: routing it lets the flow's own failure branch deal
          // with it, and leaves the original untouched either way.
          report = {
            ok: false,
            reasons: [`the output could not be inspected: ${messageOf(error)}`],
          };
        }

        if (!report.ok) {
          say(`Verification of "${outputPath}" failed:`);
          for (const reason of report.reasons) say(`  - ${reason}`);
          return {
            outputNumber: 2,
            outputFileObj: { _id: outputPath },
            variables: args.variables,
          };
        }

        say(`Verified "${outputPath}": probes cleanly and matches the original within tolerance.`);
        return {
          outputNumber: 1,
          outputFileObj: { _id: outputPath },
          variables: args.variables,
        };
      },
    };
  };
