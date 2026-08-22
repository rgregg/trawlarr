import { describe, expect, it } from 'vitest';
import type { ProbeData, ProbeStream } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from './ffmpeg-command.js';
import {
  compileFfmpegArgs,
  outputStreamIndex,
  outputStreamTypeIndex,
  shouldCopyStream,
  unmappableStreamReason,
  type DroppedStream,
} from './ffmpeg-compile.js';

const probe: ProbeData = {
  streams: [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'eac3' },
    { codec_type: 'subtitle', codec_name: 'subrip' },
  ],
};

const command = () => beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
const compile = (cmd = command(), outputPath = '/out.mkv') =>
  compileFfmpegArgs({ command: cmd, outputPath });

describe('compileFfmpegArgs', () => {
  it('maps every stream and copies by default', () => {
    expect(compile()).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-map',
      '0:1',
      '-map',
      '0:2',
      '-c',
      'copy',
      '/out.mkv',
    ]);
  });

  it('omits removed streams', () => {
    const cmd = command();
    cmd.streams[2]!.removed = true;
    expect(compile(cmd)).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-map',
      '0:1',
      '-c',
      'copy',
      '/out.mkv',
    ]);
  });

  it('places per-stream outputArgs immediately after that stream map, and copies untouched streams explicitly', () => {
    const cmd = command();
    cmd.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc', '-cq', '24');
    expect(compile(cmd)).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-c:v',
      'hevc_nvenc',
      '-cq',
      '24',
      '-map',
      '0:1',
      '-c:1',
      'copy',
      '-map',
      '0:2',
      '-c:2',
      'copy',
      '/out.mkv',
    ]);
  });

  it('drops the blanket copy once any stream specifies its own encoding, replacing it with per-stream copies', () => {
    const cmd = command();
    cmd.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc');
    const args = compile(cmd);
    // No bare "-c copy" blanket directive anywhere...
    expect(args.join(' ')).not.toContain('-c copy');
    // ...but the untouched streams still get an explicit per-stream copy, so
    // they are never silently handed to ffmpeg's container-default encoder.
    expect(args).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-c:v',
      'hevc_nvenc',
      '-map',
      '0:1',
      '-c:1',
      'copy',
      '-map',
      '0:2',
      '-c:2',
      'copy',
      '/out.mkv',
    ]);
  });

  it('encodes only the video stream, leaving audio and subtitles untouched, with a removed middle stream — asserting -c:<n> refers to OUTPUT stream position, not input index', () => {
    const cmd = command();
    // probe order is [video(0), audio(1), subtitle(2)]. Remove the middle
    // (audio) stream, then encode the video. The surviving streams are
    // video (input 0) and subtitle (input 2); their OUTPUT positions are 0
    // and 1 respectively, which must be what "-c:<n>" refers to — not their
    // input indices (0 and 2).
    cmd.streams[1]!.removed = true;
    cmd.streams[0]!.outputArgs.push('-c:v', 'libx265', '-crf', '30');
    expect(compile(cmd)).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-c:v',
      'libx265',
      '-crf',
      '30',
      '-map',
      '0:2',
      '-c:1',
      'copy',
      '/out.mkv',
    ]);
  });

  it('hoists stream inputArgs ahead of the input', () => {
    const cmd = command();
    cmd.streams[0]!.inputArgs.push('-hwaccel', 'cuda');
    expect(compile(cmd)).toEqual([
      '-hwaccel',
      'cuda',
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-map',
      '0:1',
      '-map',
      '0:2',
      '-c',
      'copy',
      '/out.mkv',
    ]);
  });

  it('wraps with overall input and output arguments, honouring the misspelled key', () => {
    const cmd = command();
    cmd.overallInputArguments.push('-fflags', '+genpts');
    cmd.overallOuputArguments.push('-max_muxing_queue_size', '9999');
    const args = compile(cmd);
    expect(args.slice(0, 2)).toEqual(['-fflags', '+genpts']);
    expect(args.slice(-3)).toEqual(['-max_muxing_queue_size', '9999', '/out.mkv']);
  });

  it('supports multiple inputs with correct file indices', () => {
    const cmd = command();
    cmd.inputFiles.push('/second.mkv');
    const args = compile(cmd);
    expect(args.filter((a: string) => a === '-i')).toHaveLength(2);
    expect(args).toContain('/second.mkv');
  });

  it('puts the output path last', () => {
    expect(compile().at(-1)).toBe('/out.mkv');
  });

  it('refuses to compile an uninitialised command', () => {
    const cmd = command();
    cmd.init = false;
    expect(() => compile(cmd)).toThrow(/Begin Command/i);
  });

  it('refuses to compile with no inputs', () => {
    const cmd = command();
    cmd.inputFiles = [];
    expect(() => compile(cmd)).toThrow(/input file/i);
  });

  it('refuses to compile when every stream was removed', () => {
    const cmd = command();
    for (const stream of cmd.streams) stream.removed = true;
    expect(() => compile(cmd)).toThrow(/every stream/i);
  });

  it('refuses to compile a command that has no streams at all', () => {
    // An empty or unreadable probe. Guarding this only when streams existed
    // and were all removed let a stream-less command compile a map-less
    // invocation, handing ffmpeg its own default stream selection for a file
    // the flow believes it has fully described.
    const cmd = beginFfmpegCommand({
      probe: { streams: [] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(cmd.streams).toEqual([]);
    expect(() => compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toThrow(
      /No streams mapped for new file/,
    );
  });

  it('refuses to compile when every stream was removed, naming the problem', () => {
    const cmd = beginFfmpegCommand({
      probe: { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    cmd.streams[0]!.removed = true;
    expect(() => compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toThrow(
      /No streams mapped for new file/,
    );
  });
});

describe('compileFfmpegArgs — mapArgs', () => {
  it('emits each stream mapArgs rather than deriving from array position', () => {
    // This is the reorder case: a plugin may reorder the streams array, after
    // which array position no longer matches the source track.
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    cmd.streams.reverse();
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    // Audio (source index 1) is now first, and must still map to 0:1.
    expect(args.slice(args.indexOf('-i') + 2)).toEqual([
      '-map',
      '0:1',
      '-map',
      '0:0',
      '-c',
      'copy',
      '/out.mkv',
    ]);
  });

  it('honours mapArgs a plugin has rewritten', () => {
    const cmd = beginFfmpegCommand({
      probe: { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    cmd.streams[0]!.mapArgs = ['-map', '1:5'];
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toContain('1:5');
  });

  it('falls back to the stream index when mapArgs was emptied', () => {
    const cmd = beginFfmpegCommand({
      probe: { streams: [{ index: 4, codec_type: 'video', codec_name: 'h264' }] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    cmd.streams[0]!.mapArgs = [];
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toContain('0:4');
  });
});

describe('compileFfmpegArgs — placeholder substitution', () => {
  const threeStreams = () =>
    beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'audio', codec_name: 'ac3' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });

  it('substitutes {outputIndex} with the position among surviving streams', () => {
    const cmd = threeStreams();
    cmd.streams[2]!.outputArgs.push('-c:{outputIndex}', 'libopus');
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toContain('-c:2');
  });

  it('substitutes {outputTypeIndex} with the position among same-type survivors', () => {
    // Stream 2 is the second audio stream, so its type index is 1.
    const cmd = threeStreams();
    cmd.streams[2]!.outputArgs.push('-b:a:{outputTypeIndex}', '128k');
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toContain('-b:a:1');
  });

  it('renumbers after a removal, so indices follow survivors not originals', () => {
    const cmd = threeStreams();
    cmd.streams[1]!.removed = true;
    cmd.streams[2]!.outputArgs.push('-c:{outputIndex}', 'libopus', '-b:a:{outputTypeIndex}', '96k');
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    // Survivors are video(0) and ac3, so the ac3 output index is 1 and, being
    // the only surviving audio stream, its type index is 0.
    expect(args).toContain('-c:1');
    expect(args).toContain('-b:a:0');
    expect(args).not.toContain('-c:2');
  });

  it('substitutes every occurrence in one argument', () => {
    const cmd = threeStreams();
    cmd.streams[1]!.outputArgs.push('-filter:{outputIndex}', 'x={outputIndex}');
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    expect(args).toContain('-filter:1');
    expect(args).toContain('x=1');
  });

  it('does not mutate the caller command', () => {
    // The compiler must stay pure: a dry run compiles the same command a real
    // run later executes, and must not leave substituted values behind.
    const cmd = threeStreams();
    cmd.streams[1]!.outputArgs.push('-c:{outputIndex}', 'libopus');
    compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    expect(cmd.streams[1]!.outputArgs).toEqual(['-c:{outputIndex}', 'libopus']);
  });
});

describe('compileFfmpegArgs — argument hygiene', () => {
  it('trims every argument and drops the empty ones', () => {
    // This is the shape a plugin produces from a free-text argument string it
    // split on spaces: a double space yields an empty element and a trailing
    // space yields both a padded element and another empty one. ffmpeg treats
    // an empty argv element as a filename and fails outright, so a flow that
    // works elsewhere would hard-fail here.
    const cmd = command();
    cmd.overallInputArguments.push(...'-ss  30 '.split(' '));
    cmd.overallOuputArguments.push(...' -map_metadata  0 '.split(' '));
    cmd.streams[0]!.outputArgs.push(...'-c:{outputIndex} libx265 '.split(' '));

    const args = compile(cmd);

    expect(args).not.toContain('');
    for (const arg of args) expect(arg).toBe(arg.trim());
    // The real arguments all survived, in order, with nothing merged.
    expect(args.slice(0, 4)).toEqual(['-ss', '30', '-i', '/in.mkv']);
    expect(args).toContain('libx265');
    expect(args.slice(-3)).toEqual(['-map_metadata', '0', '/out.mkv']);
  });

  it('keeps whitespace inside an argument that legitimately contains it', () => {
    // Trimming is per-element, so a metadata value with an internal space is
    // untouched — only padding around an element is removed.
    const cmd = command();
    cmd.streams[0]!.outputArgs.push('-metadata:s:0', 'title=Two Words');
    expect(compile(cmd)).toContain('title=Two Words');
  });
});

describe('shouldCopyStream', () => {
  it('copies a stream with no output arguments', () => {
    expect(shouldCopyStream([])).toBe(true);
  });

  it('does not copy a stream that sets a codec', () => {
    expect(shouldCopyStream(['-c:v', 'libx265'])).toBe(false);
    expect(shouldCopyStream(['-c:1', 'libopus'])).toBe(false);
    expect(shouldCopyStream(['-codec:a', 'aac'])).toBe(false);
    expect(shouldCopyStream(['-vcodec', 'libx264'])).toBe(false);
    expect(shouldCopyStream(['-acodec', 'aac'])).toBe(false);
  });

  it('still copies when the arguments only tag the stream', () => {
    // Setting a language or a disposition does not require re-encoding, and
    // treating it as an encode would silently transcode a stream the user
    // only wanted relabelled.
    expect(shouldCopyStream(['-metadata:s:1', 'language=eng'])).toBe(true);
    expect(shouldCopyStream(['-disposition:s:0', 'default'])).toBe(true);
    expect(shouldCopyStream(['-metadata', 'title=x'])).toBe(true);
  });

  it('does not copy when a non-tagging argument is present', () => {
    expect(shouldCopyStream(['-b:v', '2M'])).toBe(false);
    expect(shouldCopyStream(['-metadata:s:1', 'language=eng', '-b:v', '2M'])).toBe(false);
  });
});

describe('compileFfmpegArgs — copy directives', () => {
  const twoStreams = () =>
    beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });

  it('copies a tagged stream while encoding the one that asked for it', () => {
    const cmd = twoStreams();
    cmd.streams[0]!.outputArgs.push('-c:v', 'libx265');
    cmd.streams[1]!.outputArgs.push('-metadata:s:a:0', 'language=eng');
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    expect(args).toContain('-c:v');
    // The audio stream is only relabelled, so it must be copied, not encoded.
    expect(args.join(' ')).toContain('-c:1 copy');
    expect(args.join(' ')).toContain('-metadata:s:a:0 language=eng');
  });
});

describe('output index helpers', () => {
  const streams = () =>
    beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'audio', codec_name: 'ac3' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    }).streams;

  it('numbers output streams from zero in order', () => {
    const s = streams();
    expect(s.map((stream) => outputStreamIndex(s, stream))).toEqual([0, 1, 2]);
  });

  it('numbers type indices per codec_type', () => {
    const s = streams();
    expect(s.map((stream) => outputStreamTypeIndex(s, stream))).toEqual([0, 0, 1]);
  });
});

/**
 * Real libraries carry degenerate cover-art streams — an mjpeg "video" stream
 * probing as 0x0, left behind by some taggers — alongside genuine posters. No
 * muxer will write a video track with no dimensions, so mapping one fails the
 * whole encode before a frame is written and the file can never be processed.
 *
 * The shape here is the one observed in the owner's library: real video, real
 * cover art at 1251x1595, one degenerate 0x0 stream, more real cover art
 * after it.
 */
describe('unmappable streams', () => {
  const realWorldProbe: ProbeData = {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      { index: 1, codec_type: 'audio', codec_name: 'eac3' },
      {
        index: 7,
        codec_type: 'video',
        codec_name: 'mjpeg',
        width: 1251,
        height: 1595,
        disposition: { attached_pic: 1 },
      },
      {
        index: 9,
        codec_type: 'video',
        codec_name: 'mjpeg',
        width: 0,
        height: 0,
        disposition: { attached_pic: 1 },
      },
      {
        index: 10,
        codec_type: 'video',
        codec_name: 'mjpeg',
        width: 640,
        height: 360,
        disposition: { attached_pic: 1 },
      },
    ],
  };

  const realWorldCommand = () =>
    beginFfmpegCommand({ probe: realWorldProbe, container: 'mkv', inputPath: '/in.mkv' });

  it('drops the dimensionless stream and keeps every real cover-art stream', () => {
    const cmd = realWorldCommand();
    cmd.streams[0]!.outputArgs.push('-c:{outputIndex}', 'libx265');

    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });

    // The degenerate stream is not mapped...
    expect(args).not.toContain('0:9');
    // ...and both posters are, at their input indices.
    expect(args.filter((_, i) => args[i - 1] === '-map')).toEqual(['0:0', '0:1', '0:7', '0:10']);
    // Each surviving poster is COPIED, never encoded, and addressed by its
    // OUTPUT position — which renumbering after the drop makes 2 and 3, not
    // the input indices 7 and 10.
    expect(args).toEqual([
      '-i',
      '/in.mkv',
      '-map',
      '0:0',
      '-c:0',
      'libx265',
      '-map',
      '0:1',
      '-c:1',
      'copy',
      '-map',
      '0:7',
      '-c:2',
      'copy',
      '-map',
      '0:10',
      '-c:3',
      'copy',
      '/out.mkv',
    ]);
  });

  it('reports every dropped stream by input index, codec and reason', () => {
    const dropped: DroppedStream[] = [];
    compileFfmpegArgs({
      command: realWorldCommand(),
      outputPath: '/out.mkv',
      onDroppedStream: (entry) => dropped.push(entry),
    });
    expect(dropped).toEqual([
      { index: 9, codecName: 'mjpeg', reason: expect.stringContaining('dimensions 0x0') },
    ]);
  });

  it('reports nothing when every stream is mappable', () => {
    const dropped: DroppedStream[] = [];
    const cmd = realWorldCommand();
    cmd.streams[3]!.width = 8;
    cmd.streams[3]!.height = 8;
    const args = compileFfmpegArgs({
      command: cmd,
      outputPath: '/out.mkv',
      onDroppedStream: (entry) => dropped.push(entry),
    });
    expect(dropped).toEqual([]);
    expect(args).toContain('0:9');
  });

  it('does not report a stream a plugin already removed', () => {
    const dropped: DroppedStream[] = [];
    const cmd = realWorldCommand();
    cmd.streams[3]!.removed = true;
    compileFfmpegArgs({
      command: cmd,
      outputPath: '/out.mkv',
      onDroppedStream: (entry) => dropped.push(entry),
    });
    expect(dropped).toEqual([]);
  });

  it('drops a stream the flow explicitly asked to encode: no encoder can write it either', () => {
    const cmd = realWorldCommand();
    cmd.streams[3]!.forceEncoding = true;
    cmd.streams[3]!.outputArgs.push('-c:{outputIndex}', 'mjpeg');
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    expect(args).not.toContain('0:9');
    expect(args).not.toContain('mjpeg');
  });

  it('drops the input arguments of a dropped stream too', () => {
    const cmd = realWorldCommand();
    cmd.streams[3]!.inputArgs.push('-hwaccel', 'cuda');
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).not.toContain('-hwaccel');
  });

  it('names the reason when nothing mappable is left', () => {
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [{ index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 0, height: 0 }],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(() => compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toThrow(
      /dimensions no container can write/,
    );
  });
});

/**
 * The boundary itself, stated case by case. Widening it destroys artwork —
 * a poster is only ever a video stream with positive dimensions — and
 * narrowing it lets the mux failure back in.
 */
describe('unmappableStreamReason', () => {
  const reason = (stream: Partial<ProbeStream>): string | null =>
    unmappableStreamReason({ codec_name: 'mjpeg', codec_type: 'video', ...stream } as ProbeStream);

  it('rejects a stream that declares dimensions which are not both positive', () => {
    expect(reason({ width: 0, height: 0 })).toContain('0x0');
    expect(reason({ width: 1251, height: 0 })).toContain('1251x0');
    expect(reason({ width: 0, height: 1595 })).toContain('0x1595');
    expect(reason({ width: -1, height: 100 })).not.toBeNull();
    // A declared-but-unusable value: present, so we are entitled to judge it.
    expect(reason({ width: 'n/a' as unknown as number, height: 100 })).not.toBeNull();
    // One dimension declared and the other absent is equally unwritable.
    expect(reason({ width: 100 })).toContain('100xunset');
  });

  it('accepts every real cover-art stream, at any size', () => {
    expect(reason({ width: 1251, height: 1595 })).toBeNull();
    expect(reason({ width: 640, height: 360 })).toBeNull();
    expect(reason({ width: 1, height: 1 })).toBeNull();
    // ffprobe values arriving as strings are still dimensions.
    expect(
      reason({ width: '120' as unknown as number, height: '160' as unknown as number }),
    ).toBeNull();
  });

  it('never judges a stream that declares no dimensions at all', () => {
    // Audio, subtitles, data and real attachments (fonts) carry no width or
    // height, and neither do the synthetic probes tests and plugins build.
    // Absence is a fact about the PROBE, not the stream: judging it would let
    // a partial probe silently delete a library file's main video track,
    // which is far worse than the loud ffmpeg error it would prevent.
    expect(reason({ codec_type: 'audio', codec_name: 'eac3' })).toBeNull();
    expect(reason({ codec_type: 'attachment', codec_name: 'ttf' })).toBeNull();
    expect(reason({ codec_type: 'video', codec_name: 'h264' })).toBeNull();
  });
});
