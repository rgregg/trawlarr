import type { FfmpegCommand, FfmpegCommandStream, ProbeStream } from '@trawlarr/plugin-api';
import { assertCommandInitialised } from './ffmpeg-command.js';

/** A stream the host refused to map, and the reason, for the job log. */
export interface DroppedStream {
  /** The stream's ffprobe input index, or its array position if it has none. */
  index: number;
  codecName: string;
  reason: string;
}

const declaresDimension = (value: unknown): boolean => value !== undefined && value !== null;

const isUsableDimension = (value: unknown): boolean => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
};

const describeDimension = (value: unknown): string =>
  declaresDimension(value) ? String(value) : 'unset';

/**
 * Why this stream cannot be written to any container, or `null` if it can.
 *
 * Real libraries contain degenerate cover-art streams: an `mjpeg` "video"
 * stream carrying `width=0, height=0` — a placeholder some taggers leave
 * behind, alongside `[mjpeg] bits 230 is invalid`, i.e. genuinely malformed.
 * Every muxer refuses a video track with no dimensions (`[matroska] dimensions
 * not set` / `Could not write header for output file #0`), so mapping one
 * fails the whole encode before a frame is written — the file can never be
 * processed, three attempts later it is terminally `failed`, and the operator
 * sees only ffmpeg's message. This is not encoder-specific: the same file
 * succeeds under both `hevc_nvenc` and `libx265` once the degenerate stream is
 * left out.
 *
 * The boundary, chosen deliberately narrow because the failure mode of getting
 * it wrong is destroying artwork rather than failing loudly:
 *
 * - Only streams that **declare** a dimension are considered at all. Audio,
 *   subtitle, data and real attachments (fonts) carry no `width`/`height` and
 *   are never candidates, without this having to guess which `codec_type`
 *   ffmpeg will treat as video — which matters here because trawlarr
 *   reclassifies cover art to `attachment` while ffmpeg still muxes it as
 *   video.
 * - Among those, both dimensions must resolve to a finite number greater than
 *   zero. Zero (the observed case), negative, and non-numeric all describe a
 *   track no container can hold; a stream that declares one dimension and not
 *   the other is equally unwritable.
 * - A stream that declares NEITHER dimension is kept, even if it is typed
 *   `video`. Absence is a fact about the probe, not about the stream: a
 *   partial, synthetic or plugin-constructed command would otherwise lose its
 *   main video track silently. A loud ffmpeg error beats deleting video.
 *
 * A valid poster — `1251x1595 mjpeg` — has two positive dimensions and is
 * therefore never a candidate, at any size. Nothing here inspects codec,
 * disposition or size, so no real cover art can match.
 */
export const unmappableStreamReason = (stream: ProbeStream): string | null => {
  if (!declaresDimension(stream.width) && !declaresDimension(stream.height)) return null;
  if (isUsableDimension(stream.width) && isUsableDimension(stream.height)) return null;
  return (
    `it reports dimensions ${describeDimension(stream.width)}x` +
    `${describeDimension(stream.height)}, which no container can write`
  );
};

/** True for a stream ffmpeg could never mux; see {@link unmappableStreamReason}. */
export const isUnmappableStream = (stream: ProbeStream): boolean =>
  unmappableStreamReason(stream) !== null;

/**
 * The streams that will actually be written: those no plugin removed, minus
 * those no muxer could accept.
 *
 * Shared with `verifyOutput`, which counts the streams the flow intended to
 * write and holds the file if the output has fewer — it has to apply the same
 * rule, or every dropped stream would look like a lost one.
 */
export const mappableStreams = (streams: readonly FfmpegCommandStream[]): FfmpegCommandStream[] =>
  streams.filter((stream) => stream.removed !== true && !isUnmappableStream(stream));

const mapArgsOf = (stream: FfmpegCommandStream, position: number): string[] => {
  if (stream.mapArgs.length > 0) return stream.mapArgs;
  const index = typeof stream.index === 'number' ? stream.index : position;
  return ['-map', `0:${index}`];
};

/**
 * Position of a stream among the streams that will actually be written.
 * ffmpeg's `-c:<n>` and friends address output streams, which renumber from
 * zero after any removal — so this is not the input index and not the array
 * position.
 *
 * Callers pass the already-filtered surviving streams.
 */
export const outputStreamIndex = (
  streams: readonly FfmpegCommandStream[],
  stream: FfmpegCommandStream,
): number => streams.indexOf(stream);

/** As above, but counted within the stream's own codec_type. */
export const outputStreamTypeIndex = (
  streams: readonly FfmpegCommandStream[],
  stream: FfmpegCommandStream,
): number =>
  streams.filter((candidate) => candidate.codec_type === stream.codec_type).indexOf(stream);

/**
 * Plugins write `-c:{outputIndex}` and `-b:a:{outputTypeIndex}` because they
 * cannot know their stream's final output position — removals and insertions
 * elsewhere in the flow decide it. Resolving them is the host's job; passing
 * them through would hand ffmpeg a literal brace.
 */
const substitutePlaceholders = (
  outputArgs: readonly string[],
  streams: readonly FfmpegCommandStream[],
  stream: FfmpegCommandStream,
): string[] =>
  outputArgs.map((arg) =>
    arg
      .replaceAll('{outputIndex}', String(outputStreamIndex(streams, stream)))
      .replaceAll('{outputTypeIndex}', String(outputStreamTypeIndex(streams, stream))),
  );

/**
 * The option a flag names, with its leading dash and any stream specifier
 * stripped: `-c` and `-c:v` and `-c:0` all name `c`; `-metadata:s:0` names
 * `metadata`. Everything the compiler needs to know about a flag is decided
 * by this leading token, so classifying flags is a lookup on it rather than
 * a pattern match over the whole string.
 */
const optionNameOf = (arg: string): string => {
  if (!arg.startsWith('-')) return '';
  const named = arg.slice(1);
  const specifier = named.indexOf(':');
  return specifier === -1 ? named : named.slice(0, specifier);
};

/** Every option name that selects a codec, in each spelling ffmpeg accepts. */
const CODEC_OPTIONS = new Set(['c', 'codec', 'vcodec', 'acodec', 'scodec', 'dcodec']);

/**
 * Option names that only label a stream, and so survive a stream copy:
 * setting a language or a default-track flag rewrites container metadata and
 * never touches the encoded frames.
 */
const TAGGING_OPTIONS = new Set(['metadata', 'disposition']);

/**
 * Should this stream be copied rather than re-encoded?
 *
 * True when nothing was asked of it, or when everything asked of it is a
 * label change. Arguments arrive as flag/value pairs, so only the even
 * positions are flags — `['-metadata:s:0', 'language=eng']` is a single
 * tagging operation, not a flag plus an unknown option.
 */
export const shouldCopyStream = (outputArgs: readonly string[]): boolean => {
  if (outputArgs.length === 0) return true;
  for (let i = 0; i < outputArgs.length; i += 2) {
    const flag = outputArgs[i];
    if (flag === undefined) break;
    const option = optionNameOf(flag);
    if (CODEC_OPTIONS.has(option)) return false;
    if (!TAGGING_OPTIONS.has(option)) return false;
  }
  return true;
};

/**
 * Compile the cooperatively-built command into argv.
 *
 * Order is fixed by ffmpeg's grammar: overall input args, then per-stream
 * input args (hoisted, since things like -hwaccel must precede -i), then
 * inputs, then the map/output-args pairs for surviving streams, then overall
 * output args, then the output path.
 *
 * The blanket `-c copy` is emitted only when no stream needs an actual
 * encode (see `shouldCopyStream`); otherwise it would override the encoders
 * plugins just configured. As soon as one stream does need encoding, every
 * OTHER surviving stream that doesn't gets an explicit per-stream
 * `-c:<n> copy` — including a stream whose only outputArgs are tagging
 * (metadata/disposition) changes, which need no re-encode — otherwise it
 * would silently fall through to ffmpeg's container-default encoder instead
 * of being passed through untouched. The `<n>` here is the stream's
 * position among the mapped OUTPUT streams (its `-map` ordinal), not its
 * input stream index — those diverge as soon as an earlier stream is
 * removed.
 *
 * Whether a stream's outputArgs get `{outputIndex}`/`{outputTypeIndex}`
 * substituted is a separate question from whether it gets copied: a
 * metadata-only stream has outputArgs (so they must still be substituted)
 * but is also copied (so it needs both the substituted args AND a copy
 * directive). Keying both decisions off one boolean was the old bug.
 */
export const compileFfmpegArgs = (input: {
  command: FfmpegCommand;
  outputPath: string;
  /**
   * Called once per stream the host refused to map. Dropping a stream is
   * never silent: the Execute node forwards this to the job log, which
   * `runFlow` also captures into that step's `log_excerpt`.
   */
  onDroppedStream?: (dropped: DroppedStream) => void;
}): string[] => {
  const { command, outputPath } = input;

  assertCommandInitialised(command);

  if (command.inputFiles.length === 0) {
    throw new Error('Cannot compile an ffmpeg command with no input file.');
  }

  // Unconditional, not `command.streams.length > 0 && kept.length === 0`: a
  // command seeded from an empty or unreadable probe has no streams to remove
  // yet would otherwise compile a map-less invocation, which tells ffmpeg to
  // apply its own default stream selection to a file the flow believes it has
  // described completely. Refusing is the same answer as for "every stream was
  // removed" — nothing was mapped — so it gets the same message.
  // The host gate: a stream no muxer can write is dropped here, in the one
  // place every flow passes through, rather than in a plugin a flow would have
  // to remember to include. A node protects only the flow that declares it; a
  // gate in the compiler protects every flow, including community ones, and
  // cannot be undone by a plugin that maps streams back in.
  const surviving = command.streams.filter((stream) => stream.removed !== true);
  const kept = surviving.filter((stream) => !isUnmappableStream(stream));

  surviving.forEach((stream, position) => {
    const reason = unmappableStreamReason(stream);
    if (reason === null) return;
    input.onDroppedStream?.({
      index: typeof stream.index === 'number' ? stream.index : position,
      codecName: String(stream.codec_name ?? 'unknown'),
      reason,
    });
  });

  if (kept.length === 0) {
    throw new Error(
      surviving.length === 0
        ? 'No streams mapped for new file: every stream was removed, so the output would ' +
            'contain nothing. Check which streams the flow is removing.'
        : 'No streams mapped for new file: every remaining stream reports dimensions no ' +
            'container can write, so the output would contain nothing.',
    );
  }

  const args: string[] = [...command.overallInputArguments];

  for (const stream of kept) {
    args.push(...stream.inputArgs);
  }

  for (const file of command.inputFiles) {
    args.push('-i', file);
  }

  // "Needs an actual encode" and "has outputArgs to substitute placeholders
  // in" are different questions once tagging-only args exist: a
  // metadata-only stream has outputArgs but doesn't need encoding.
  const needsEncode = (stream: FfmpegCommandStream): boolean =>
    stream.forceEncoding === true || !shouldCopyStream(stream.outputArgs);
  const anyStreamEncodes = kept.some(needsEncode);

  kept.forEach((stream, outputIndex) => {
    args.push(...mapArgsOf(stream, command.streams.indexOf(stream)));

    if (stream.outputArgs.length > 0) {
      const resolvedOutputArgs = substitutePlaceholders(stream.outputArgs, kept, stream);
      args.push(...resolvedOutputArgs);
    }

    if (!needsEncode(stream) && anyStreamEncodes) {
      // At least one other stream is being encoded, so the blanket `-c copy`
      // below is not being emitted — this stream needs its own explicit copy
      // directive, keyed by its OUTPUT position, or ffmpeg will silently
      // re-encode it with the container's default codec. This also covers a
      // stream whose outputArgs were pushed above but were tagging-only.
      args.push(`-c:${outputIndex}`, 'copy');
    }
  });

  if (!anyStreamEncodes) {
    args.push('-c', 'copy');
  }

  args.push(...command.overallOuputArguments);
  args.push(outputPath);

  // Trim every argument and drop the empties, as the last thing that happens.
  // Not cosmetic: plugins that accept a free-text argument string split it on
  // spaces, so a double or trailing space in a user's input yields an
  // empty-string element. ffmpeg treats an empty argv element as a filename
  // and dies immediately ("Error opening output file ."), which turns a flow
  // that works elsewhere into a hard failure here. Doing it once at the end
  // covers every source of arguments — plugin outputArgs, overall arguments,
  // mapArgs — instead of asking each of them to be careful.
  return args.map((arg) => arg.trim()).filter((arg) => arg !== '');
};
