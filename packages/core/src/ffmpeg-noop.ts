import type { FfmpegCommand, FfmpegCommandStream, ProbeStream } from '@trawlarr/plugin-api';
import { isUnmappableStream } from './ffmpeg-compile.js';

/**
 * One reason the compiled command would produce a file different from the one
 * it reads. The `kind` is for callers that want to group; the `detail` is
 * written for the operator reading a job log, because "why was this file
 * skipped" and "why was this file rewritten" are the two questions a run of
 * this gate has to be able to answer after the fact.
 */
export interface CommandChange {
  kind:
    | 'input'
    | 'container'
    | 'overall-arguments'
    | 'stream-set'
    | 'stream-order'
    | 'stream-arguments'
    | 'stream-mapping'
    | 'unverifiable';
  detail: string;
}

/** What the file being judged actually is right now, from its own probe. */
export interface CommandSource {
  /** The path the command is expected to read. */
  path: string;
  /** The file's current container, as the rest of trawlarr spells it. */
  container: string;
  /** The streams ffprobe found in it, in ffprobe's order. */
  streams: readonly ProbeStream[] | undefined;
}

/**
 * Containers are compared as trawlarr spells them everywhere else — the
 * extension without its dot — so `mkv`, `.MKV` and ` mkv ` are one container
 * and `mkv` and `mp4` are two.
 */
const normaliseContainer = (value: string): string =>
  value.trim().replace(/^\.+/, '').toLowerCase();

const describeContainer = (value: string): string => (value === '' ? '(none)' : value);

/** A stream's ffprobe input index, or null when it does not carry one. */
const probeIndexOf = (stream: ProbeStream): number | null =>
  typeof stream.index === 'number' ? stream.index : null;

const describeStream = (stream: FfmpegCommandStream): string => {
  const index = probeIndexOf(stream);
  const codec = typeof stream.codec_name === 'string' ? stream.codec_name : 'unknown';
  return index === null
    ? `an unindexed ${codec} stream`
    : `input stream ${String(index)} (${codec})`;
};

/**
 * Would the compiler emit this stream's `-map` unchanged from what
 * {@link beginFfmpegCommand} seeded — i.e. "take my own input track, once"?
 *
 * An empty `mapArgs` compiles to exactly that, so it counts. Anything else —
 * a second input's track, a filtergraph label, a duplicated map — is a
 * different output stream than the input carried, whatever the codec says.
 */
const isIdentityMapArgs = (stream: FfmpegCommandStream): boolean => {
  if (stream.mapArgs.length === 0) return true;
  if (stream.mapArgs.length !== 2) return false;
  const index = probeIndexOf(stream);
  if (index === null) return false;
  return stream.mapArgs[0] === '-map' && stream.mapArgs[1] === `0:${String(index)}`;
};

/**
 * Everything about this command that would make the output differ from the
 * input — an EMPTY array means running ffmpeg would rewrite the file to say
 * exactly what it already says.
 *
 * This is the host's no-op gate, and it answers a different question from
 * {@link deriveShouldProcess}. That one asks "did a plugin ask for work?" and
 * is deliberately generous, because several upstream plugins configure an
 * encode without ever setting `shouldProcess`. This one asks "would running
 * the command the flow built actually produce a different file?" — a question
 * only the command itself and the file's own probe can answer, and one that
 * `shouldProcess` is not evidence about in either direction. So
 * `shouldProcess` is not read here AT ALL, on purpose: a node declaring intent
 * it did not implement (a `Set Container` to the container the file already
 * has, a filter that matched nothing) is exactly the case this exists to
 * catch. It cost a real 8.4 TB library ~6.5 TB of pointless rewriting, at
 * 1,453 MB of trash per file, before it was stopped by hand.
 *
 * The failure modes are NOT symmetric, and every judgement below is bent the
 * same way because of it:
 *
 *  - Reporting NO changes when something would have changed marks the file
 *    converged, stamps its signature, and nothing re-evaluates it. That is a
 *    silent, permanent wrong answer — the same shape as the ffmpeg failure
 *    once recorded as convergence.
 *  - Reporting a change when nothing would have changed costs one needless
 *    remux, which is the behaviour that shipped before this existed.
 *
 * So anything that cannot be *proved* inert is reported as a change: a probe
 * with no streams, a stream with no ffprobe index, a `mapArgs` this does not
 * recognise, a second input file. "I cannot tell" is spelled `unverifiable`
 * and counted as a change.
 *
 * What counts as a change even when every stream is copied:
 *
 *  - a different container (`mkv` → `mp4`), because the output is a different
 *    file even at identical stream contents;
 *  - a stream removed by a plugin, or dropped by the host's own
 *    unmappable-stream rule (see `unmappableStreamReason`) — a file whose
 *    degenerate cover art the compiler would drop genuinely does change;
 *  - a stream added (`Ensure Audio Stream` adding a stereo downmix) or the
 *    stream ORDER changed, both of which show up as the mapped set no longer
 *    matching the probe's positionally;
 *  - any `outputArgs` at all, INCLUDING tagging-only ones: `-metadata` and
 *    `-disposition` survive a stream copy precisely because they rewrite what
 *    the container says about the track, which is a change to the file;
 *  - any `inputArgs`, `forceEncoding`, `overallInputArguments` or
 *    `overallOuputArguments` — the last spelled the upstream way on purpose.
 *
 * What is left, and the only thing worth skipping: a pure remux to the SAME
 * container with the SAME streams in the SAME order, carrying no arguments.
 */
export const describeCommandChanges = (input: {
  command: FfmpegCommand;
  source: CommandSource;
}): CommandChange[] => {
  const { command, source } = input;
  const changes: CommandChange[] = [];
  const add = (kind: CommandChange['kind'], detail: string): void => {
    changes.push({ kind, detail });
  };

  const sourceStreams = source.streams;
  if (sourceStreams === undefined || sourceStreams.length === 0) {
    // Nothing to compare the command against. A command built from a probe
    // this thin cannot be shown to be inert, and "shown to be inert" is the
    // only thing that may skip an encode.
    add(
      'unverifiable',
      'the file has no probed streams, so the command cannot be compared against it',
    );
    return changes;
  }

  if (command.inputFiles.length !== 1) {
    add(
      'input',
      `the command reads ${String(command.inputFiles.length)} input files rather than the ` +
        `single file being judged, so its output cannot be that file`,
    );
  } else if (command.inputFiles[0] !== source.path) {
    add(
      'input',
      `the command reads "${String(command.inputFiles[0])}", which is not the file being ` +
        `judged ("${source.path}")`,
    );
  }

  const wanted = normaliseContainer(command.container);
  const current = normaliseContainer(source.container);
  if (wanted !== current) {
    add(
      'container',
      `the container changes from ${describeContainer(current)} to ${describeContainer(wanted)}`,
    );
  }

  if (command.overallInputArguments.length > 0) {
    add('overall-arguments', `overall input arguments: ${command.overallInputArguments.join(' ')}`);
  }
  if (command.overallOuputArguments.length > 0) {
    add(
      'overall-arguments',
      `overall output arguments: ${command.overallOuputArguments.join(' ')}`,
    );
  }
  if (command.hardwareDecoding) {
    // Normally already covered by the overall input arguments
    // `applyHardwareDecoding` pushes, but a plugin may set the flag directly.
    // A command asking for a decode path is not a command we can call inert.
    add('overall-arguments', 'hardware decoding is enabled');
  }

  const surviving = command.streams.filter((stream) => stream.removed !== true);
  const removed = command.streams.length - surviving.length;
  if (removed > 0) {
    add('stream-set', `${String(removed)} stream(s) were removed by the flow`);
  }

  const kept = surviving.filter((stream) => !isUnmappableStream(stream));
  const dropped = surviving.length - kept.length;
  if (dropped > 0) {
    // The host's own rule, not the flow's. It still changes the file, so it
    // still has to run — a library file carrying a dimensionless cover-art
    // stream is genuinely improved by the remux that leaves it out.
    add(
      'stream-set',
      `${String(dropped)} stream(s) cannot be written to any container and would be dropped`,
    );
  }

  if (kept.length !== sourceStreams.length) {
    add(
      'stream-set',
      `the output would carry ${String(kept.length)} stream(s) where the file has ` +
        `${String(sourceStreams.length)}`,
    );
  } else {
    // Same count is not the same set: an insertion paired with a removal, or a
    // reorder, both preserve the count and both change the file. Compare
    // position by position against the probe's own indices.
    kept.forEach((stream, position) => {
      const from = probeIndexOf(stream);
      const to = probeIndexOf(sourceStreams[position]!);
      if (from === null || to === null) {
        add(
          'unverifiable',
          `output position ${String(position)} cannot be matched to an input stream, because ` +
            `one of them carries no ffprobe index`,
        );
        return;
      }
      if (from !== to) {
        add(
          'stream-order',
          `output position ${String(position)} would carry input stream ${String(from)}, where ` +
            `the file has stream ${String(to)}`,
        );
      }
    });
  }

  for (const stream of surviving) {
    const label = describeStream(stream);
    if (stream.forceEncoding) {
      add('stream-arguments', `${label} is marked for re-encoding`);
    }
    if (stream.outputArgs.length > 0) {
      // Tagging-only args (`-metadata`, `-disposition`) count. They survive a
      // stream copy exactly because they rewrite what the container says.
      add('stream-arguments', `${label} carries output arguments: ${stream.outputArgs.join(' ')}`);
    }
    if (stream.inputArgs.length > 0) {
      add('stream-arguments', `${label} carries input arguments: ${stream.inputArgs.join(' ')}`);
    }
    if (!isIdentityMapArgs(stream)) {
      add('stream-mapping', `${label} is mapped as ${stream.mapArgs.join(' ')}`);
    }
  }

  return changes;
};

/**
 * Would running this command produce a file different from the one it reads?
 *
 * The safe answer is `true`; see {@link describeCommandChanges} for why every
 * uncertain case gives it.
 */
export const wouldCommandChangeFile = (input: {
  command: FfmpegCommand;
  source: CommandSource;
}): boolean => describeCommandChanges(input).length > 0;
