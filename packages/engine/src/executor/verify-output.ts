import type { PluginModule, ProbeData, ProbeStream } from '@trawlarr/plugin-api';
import { mappableStreams } from '@trawlarr/core';
import type { LoadedPlugin } from '../host/loader.js';

/**
 * Which of the file's clocks the length check actually read.
 *
 * `video` is the intended answer for a video library; the rest are the
 * documented fallbacks in {@link compareDurations}.
 */
export type DurationBasis = 'video' | 'audio' | 'container';

/**
 * The two numbers the length check compared, and where they came from.
 *
 * Reported rather than merely logged so a caller — and a test — can assert on
 * WHAT was compared, not on the wording of a sentence.
 */
export interface DurationComparison {
  /** `null` when no clock was readable on both sides. */
  basis: DurationBasis | null;
  /** `NaN` when the output had no readable duration at the chosen basis. */
  outputSeconds: number;
  /** `NaN` when the original had no readable duration at the chosen basis. */
  originalSeconds: number;
}

export interface VerifyReport {
  ok: boolean;
  reasons: string[];
  duration: DurationComparison;
}

/**
 * Every check the Verify Output node performs, as a pure function of two
 * probes and two sizes.
 *
 * Pure on purpose: the whole decision table — including the combinations that
 * would need a deliberately corrupted 40 GB file to reproduce on a real
 * filesystem — is testable without touching one. The runner below is the only
 * part that does IO, and it does nothing but gather these inputs and route
 * on the result.
 */
export const verifyOutput = (input: {
  probe: ProbeData;
  originalProbe: ProbeData;
  outputSizeBytes: number;
  originalSizeBytes: number;
  durationToleranceSeconds: number;
  minSizeRatio: number;
  /**
   * How many streams the flow's own ffmpeg command intended to write, or
   * `null` when no command described one (a flow that verifies a file it
   * merely copied, for instance).
   *
   * Comparing against the ORIGINAL's count was a host defect that made every
   * stream-removing community plugin unusable: `Remove Stream By Property`,
   * `Remove Subtitles`, `Remove Data Streams` and `Set Container` with
   * `forceConform` all produce an output with fewer streams BY DESIGN, and
   * verification rejected all of them, refused the replacement, and burned
   * three attempts per file before it landed in `failed`.
   */
  intendedStreamCount: number | null;
  /**
   * Refuse an output with no audio when the original had some.
   *
   * This is the fail-safe that deliberately replaces the accidental one the
   * field above removes. It is deliberately NOT satisfied by the flow's
   * intent: a language filter matching nothing removes every audio track, and
   * the command it builds says so, so an intent-following check would approve
   * a silent film and trash the original. Unmanic exposes this concern as
   * `fail_safe` on its own language plugin; it lives in the HOST GATE here
   * instead because a gate protects against every plugin — community ones
   * nobody here wrote and future ones nobody here has seen — while a node
   * input protects only against the node that declares it. That is the same
   * reasoning `docs/engineering-notes/p2-prerequisites.md` records under "An
   * allow-list is not a rule".
   */
  requireAudioIfOriginalHadAudio: boolean;
}): VerifyReport => {
  const reasons: string[] = [];
  const streams = input.probe.streams ?? [];

  if (streams.length === 0) {
    reasons.push('the output has no streams — ffprobe could not read it');
    // Nothing else is meaningful once the file is unreadable.
    return {
      ok: false,
      reasons,
      duration: { basis: null, outputSeconds: Number.NaN, originalSeconds: Number.NaN },
    };
  }

  const originalStreams = input.originalProbe.streams ?? [];
  // The flow's own intent is the baseline, falling back to the original's
  // count only when nothing described one. One-sided on purpose: MORE streams
  // than expected is what `Ensure Audio Stream` produces, and is never a
  // symptom of a truncated encode. Fewer is.
  const expected = input.intendedStreamCount ?? originalStreams.length;
  if (streams.length < expected) {
    reasons.push(
      `the output has ${streams.length} streams, fewer than the ${expected} this flow ` +
        `intended to write`,
    );
  }

  if (input.requireAudioIfOriginalHadAudio) {
    const originalHadAudio = originalStreams.some((stream) => stream.codec_type === 'audio');
    const outputHasAudio = streams.some((stream) => stream.codec_type === 'audio');
    if (originalHadAudio && !outputHasAudio) {
      reasons.push(
        `the original has audio and the output has none — a stream filter that matched ` +
          `nothing removes every audio track, which is why this is refused even though the ` +
          `flow asked for it`,
      );
    }
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
  const duration = compareDurations(input.probe, input.originalProbe);
  const outDuration = duration.outputSeconds;
  const origDuration = duration.originalSeconds;
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
        `the output's ${duration.basis ?? 'container'} runs ${outDuration.toFixed(1)}s against ` +
          `the original's ${origDuration.toFixed(1)}s, a ${drift.toFixed(1)}s difference`,
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

  return { ok: reasons.length === 0, reasons, duration };
};

/**
 * How long the PROGRAMME runs, in seconds, at one particular clock.
 *
 * `video` and `audio` take the LONGEST stream of that type, so a file carrying
 * a still-image cover art track (a 0.04s mjpeg video stream, which Matroska
 * times just like any other) is not mistaken for a four-hundredth of a second
 * of film. A stream flagged `attached_pic` is skipped outright.
 */
const durationAt = (probe: ProbeData, basis: DurationBasis): number => {
  if (basis === 'container') return parseDurationSeconds(probe.format?.duration);

  const timed = (probe.streams ?? [])
    .filter((stream) => stream.codec_type === basis && !isAttachedPicture(stream))
    .map(streamDurationSeconds)
    .filter((seconds) => Number.isFinite(seconds));
  return timed.length === 0 ? Number.NaN : Math.max(...timed);
};

/**
 * The clocks tried, in order of how well each one survives a stream being
 * removed ON PURPOSE.
 */
const DURATION_BASES: readonly DurationBasis[] = ['video', 'audio', 'container'];

/**
 * The two durations to compare, and which clock they came from.
 *
 * The container's own duration is the LAST resort, not the first, and that is
 * the whole point of this function.
 *
 * A Matroska container reports its duration as its LONGEST STREAM. Dubs and
 * commentary tracks routinely overhang the picture by a second or three —
 * `Foundation S02E02` carries video of 00:53:51.436, English audio of
 * 00:53:51.509 and an Italian dub of 00:53:52.736, and the container calls
 * itself 3232.736s because of the dub. A flow that deliberately drops the
 * Italian track therefore produces a container 1.2s shorter than the original
 * WITH EVERY FRAME AND EVERY RETAINED SAMPLE INTACT, and a container-to-
 * container comparison read that as a 1.2s loss against a 1.0s tolerance and
 * failed a perfect file. Two more episodes of the same run failed at 2.0s and
 * 2.3s for the same reason. Any release whose dub or commentary overhangs the
 * picture hits this, so the answer is not a wider tolerance — that would blunt
 * the check for every file to accommodate a number that was never evidence of
 * loss — but a clock that DOES NOT MOVE when a stream is removed on purpose.
 *
 * The video stream is that clock. It is the programme; it is what a truncated
 * encode shortens; and removing an audio track cannot change it. It is chosen
 * over "the longest RETAINED stream" because retention cannot be established
 * from two probes: nothing in an output stream identifies which original
 * stream it came from, so "retained" would have to be guessed from language
 * tags and ordering, and a wrong guess silently weakens the gate in front of a
 * destructive step. The video stream needs no guess.
 *
 * The fallbacks handle the files that have no such clock, and the rule is the
 * same each time — the FIRST basis both sides can answer wins:
 *
 * - `audio` catches the audio-only file (no video stream on either side) and
 *   the flow that deliberately removed the VIDEO stream (audio extraction):
 *   the output has no video to read, so the audio is compared instead, and a
 *   truncated extraction still shows up short.
 * - `container` is what remains for a raw TS/VOB original whose streams are
 *   individually untimed but whose container is not — the pre-existing
 *   behaviour, kept so this change fails nothing it used to pass.
 *
 * When no basis is readable on both sides, the numbers are reported as they
 * stand so the caller can say WHICH side was unreadable, and an unreadable
 * duration remains a REFUSAL rather than a silent pass — see the caller.
 */
export const compareDurations = (
  probe: ProbeData,
  originalProbe: ProbeData,
): DurationComparison => {
  for (const basis of DURATION_BASES) {
    const outputSeconds = durationAt(probe, basis);
    const originalSeconds = durationAt(originalProbe, basis);
    if (Number.isFinite(outputSeconds) && Number.isFinite(originalSeconds)) {
      return { basis, outputSeconds, originalSeconds };
    }
  }
  // Nothing lines up. Report each side's best available reading anyway: the
  // caller distinguishes "the original is untimed" from "the output is
  // untimed", and both are failures with different wording.
  return {
    basis: null,
    outputSeconds: anyDurationOf(probe),
    originalSeconds: anyDurationOf(originalProbe),
  };
};

/** The first readable duration at any basis, for the unreadable-side message. */
const anyDurationOf = (probe: ProbeData): number => {
  for (const basis of DURATION_BASES) {
    const seconds = durationAt(probe, basis);
    if (Number.isFinite(seconds)) return seconds;
  }
  return Number.NaN;
};

/** Cover art, which is a video stream to ffprobe and not to a viewer. */
const isAttachedPicture = (stream: ProbeStream): boolean =>
  Number((stream.disposition as Record<string, unknown> | undefined)?.attached_pic ?? 0) === 1;

/**
 * One stream's duration, in seconds, or `NaN` if nothing says.
 *
 * `stream.duration` is absent on Matroska — ffprobe reports `duration=N/A` for
 * every stream in an mkv and puts the real number in the stream's `DURATION`
 * TAG instead, as `HH:MM:SS.nnnnnnnnn`. Reading only the numeric field would
 * therefore find no video duration at all on exactly the files this change
 * exists for, fall through to the container, and change nothing. Some muxers
 * write the tag per language (`DURATION-eng`); the longest of them wins.
 */
const streamDurationSeconds = (stream: ProbeStream): number => {
  const direct = parseDurationSeconds(stream.duration);
  if (Number.isFinite(direct)) return direct;

  const tagged = Object.entries(stream.tags ?? {})
    .filter(([key]) => key.toUpperCase().startsWith('DURATION'))
    .map(([, value]) => parseDurationSeconds(value))
    .filter((seconds) => Number.isFinite(seconds));
  return tagged.length === 0 ? Number.NaN : Math.max(...tagged);
};

/**
 * Seconds from either shape ffprobe uses, or `NaN` for anything else.
 *
 * Anything unparseable — `N/A`, an empty tag, `garbage`, a negative number —
 * answers `NaN` rather than a guess, because `NaN` is what the caller turns
 * into a refusal. A value that cannot be understood must never be allowed to
 * read as a value that matches.
 */
export const parseDurationSeconds = (value: unknown): number => {
  if (typeof value === 'number') return value >= 0 && Number.isFinite(value) ? value : Number.NaN;
  const text = String(value ?? '').trim();
  if (text === '') return Number.NaN;

  if (text.includes(':')) {
    const parts = text.split(':');
    if (parts.length > 3) return Number.NaN;
    let seconds = 0;
    for (const part of parts) {
      // Number.parseFloat would accept "12abc"; Number() does not, and a
      // malformed timecode must not silently become a plausible length.
      const unit = part === '' ? Number.NaN : Number(part);
      if (!Number.isFinite(unit) || unit < 0) return Number.NaN;
      seconds = seconds * 60 + unit;
    }
    return seconds;
  }

  const plain = Number(text);
  return Number.isFinite(plain) && plain >= 0 ? plain : Number.NaN;
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

        // The command survives `closeFfmpegCommand` (which clears `init` and
        // `shouldProcess` but keeps `streams`), so the Execute node that just
        // ran has left behind exactly what it intended to write. A flow with
        // no Begin Command carries an empty stream array, which means "nothing
        // described an intent" rather than "zero streams" — hence `null`
        // there, which falls back to the original's count.
        const commandStreams = args.variables.ffmpegCommand?.streams ?? [];
        const intendedStreamCount =
          commandStreams.length === 0
            ? null
            : // Not just `removed !== true`: the compiler also drops streams no
              // muxer can write (dimensionless cover art). Counting those as
              // intended would make every such file fail verification for
              // "fewer streams than this flow described" — holding a file
              // because the host protected it. Both sides read one rule.
              mappableStreams(commandStreams).length;
        // A node input arrives as the STRING 'false' from a stored flow and as
        // the boolean false from a test. Reading only one of those makes the
        // switch look wired while doing nothing, so both are normalised here,
        // and an absent input keeps the protection ON.
        const requireAudioIfOriginalHadAudio =
          String(args.inputs.requireAudioIfOriginalHadAudio ?? 'true') !== 'false';

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
            intendedStreamCount,
            requireAudioIfOriginalHadAudio,
          });
        } catch (error) {
          // A file that cannot be read or probed is a failed verification, not
          // a crashed job: routing it lets the flow's own failure branch deal
          // with it, and leaves the original untouched either way.
          report = {
            ok: false,
            reasons: [`the output could not be inspected: ${messageOf(error)}`],
            // Nothing was compared, and saying so is not the same as saying
            // the lengths matched.
            duration: { basis: null, outputSeconds: Number.NaN, originalSeconds: Number.NaN },
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
