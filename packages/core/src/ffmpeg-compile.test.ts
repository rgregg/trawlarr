import { describe, expect, it } from 'vitest';
import type { ProbeData, ProbeStream } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from './ffmpeg-command.js';
import {
  compileFfmpegArgs,
  mappableStreams,
  outputStreamIndex,
  outputStreamTypeIndex,
  shouldCopyStream,
  unmappableStreamReason,
  type DroppedStream,
  type RestoredStreamGroup,
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
    // Two audio tracks on purpose: removing the ONLY audio stream a file has
    // is the one removal the host refuses to honour (see `guardStreamRemoval`),
    // and this test is about output-stream numbering, not about that guard.
    // Probe order is [video(0), audio(1), audio(2), subtitle(3)]. Remove a
    // middle (audio) stream, then encode the video. The survivors are video
    // (input 0), audio (input 2) and subtitle (input 3); their OUTPUT
    // positions are 0, 1 and 2, which must be what "-c:<n>" refers to — not
    // their input indices.
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'eac3' },
          { codec_type: 'audio', codec_name: 'aac' },
          { codec_type: 'subtitle', codec_name: 'subrip' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
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
      '-map',
      '0:3',
      '-c:2',
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

/**
 * The all-audio-removed guard. The measured failure it exists for: a
 * natively foreign-language title under an `eng` keep-list, where
 * `Remove Stream By Property` matches EVERY audio stream because there is no
 * English track to keep. The command then honestly says "write no audio",
 * `verifyOutput` correctly refuses the result as data loss, and the file
 * retries to exhaustion — burning a full remux each time — and can never
 * converge. On one real library: 65 files, 55.7 GB, 47% of the remaining work.
 *
 * Asserted on the compiled argv, which is the decision — the streams ffmpeg is
 * actually told to write — never on log text.
 */
describe('the all-audio-removed guard', () => {
  const withStreams = (streams: ProbeStream[]) =>
    beginFfmpegCommand({ probe: { streams }, container: 'mkv', inputPath: '/in.mkv' });

  const VIDEO: ProbeStream = { index: 0, codec_type: 'video', codec_name: 'h264' };

  it('keeps the audio when a filter matched every audio stream', () => {
    const cmd = withStreams([
      VIDEO,
      { index: 1, codec_type: 'audio', codec_name: 'eac3', tags: { language: 'kor' } },
      { index: 2, codec_type: 'audio', codec_name: 'aac', tags: { language: 'kor' } },
    ]);
    for (const stream of cmd.streams) if (stream.codec_type === 'audio') stream.removed = true;

    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    expect(args.join(' ')).toContain('-map 0:1');
    expect(args.join(' ')).toContain('-map 0:2');
    expect(mappableStreams(cmd.streams)).toHaveLength(3);
  });

  it('keeps the audio when the file has exactly one audio stream — the boundary', () => {
    const cmd = withStreams([
      VIDEO,
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'jpn' } },
    ]);
    cmd.streams[1]!.removed = true;

    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' }).join(' ')).toContain(
      '-map 0:1',
    );
  });

  it('says so, once per guarded codec type, for the job log', () => {
    const cmd = withStreams([VIDEO, { index: 1, codec_type: 'audio', codec_name: 'aac' }]);
    cmd.streams[1]!.removed = true;
    const restored: RestoredStreamGroup[] = [];
    compileFfmpegArgs({
      command: cmd,
      outputPath: '/out.mkv',
      onRestoredStreams: (group) => restored.push(group),
    });
    expect(restored).toHaveLength(1);
    expect(restored[0]!.codecType).toBe('audio');
    expect(restored[0]!.count).toBe(1);
  });

  it('honours a filter that left at least one audio stream behind', () => {
    // The ordinary case, and the one the guard must not touch: an English
    // track survives, so the Japanese one really does go.
    const cmd = withStreams([
      VIDEO,
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } },
      { index: 2, codec_type: 'audio', codec_name: 'aac', tags: { language: 'jpn' } },
    ]);
    cmd.streams[2]!.removed = true;

    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' }).join(' ');
    expect(args).toContain('-map 0:1');
    expect(args).not.toContain('-map 0:2');
    expect(mappableStreams(cmd.streams)).toHaveLength(2);
  });

  it('does not protect subtitles: removing every subtitle is an ordinary flow', () => {
    const cmd = withStreams([
      VIDEO,
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
    ]);
    cmd.streams[2]!.removed = true;

    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' }).join(' ')).not.toContain(
      '-map 0:2',
    );
  });

  it('still refuses a total wipe, rather than writing an audio-only file', () => {
    // A flow that removed EVERY stream is broken, not over-matched. Restoring
    // the audio out of that would replace a loud refusal — ffmpeg never runs,
    // the original is untouched — with an audio-only file that verification
    // would accept in a movie's place.
    const cmd = withStreams([VIDEO, { index: 1, codec_type: 'audio', codec_name: 'aac' }]);
    for (const stream of cmd.streams) stream.removed = true;

    expect(() => compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toThrow(
      /every stream was removed/i,
    );
  });

  it('cannot be satisfied or triggered by an audio stream no muxer could write', () => {
    // The guard reads the same rule the compiler does: a stream that is going
    // to be dropped anyway is not what saves a file from silence. Here the
    // only surviving audio candidate is unwritable, so there is nothing to
    // restore and the output legitimately has no audio — which `verifyOutput`
    // is then left to refuse, loudly.
    const cmd = withStreams([
      VIDEO,
      { index: 1, codec_type: 'audio', codec_name: null as unknown as string, codec_tag: '0x0000' },
    ]);
    cmd.streams[1]!.removed = true;

    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' }).join(' ');
    expect(args).not.toContain('-map 0:1');
  });

  it('does not mutate the command it was given', () => {
    const cmd = withStreams([VIDEO, { index: 1, codec_type: 'audio', codec_name: 'aac' }]);
    cmd.streams[1]!.removed = true;
    compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    // The flow's own record of what it asked for is untouched; the guard is a
    // host decision applied when the command is read, not a rewrite of it.
    expect(cmd.streams[1]!.removed).toBe(true);
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
      /no remaining stream can be written.*dimensions 0x0/,
    );
  });
});

/**
 * The second real-world shape, one field over from the dimensionless one: a
 * stream ffprobe describes in full and reports NO codec for. Trawlarr mapped
 * it `-c:N copy`, and ffmpeg cannot copy a codec it does not know —
 * "Could not write header for output file #0 (incorrect codec parameters ?):
 * Function not implemented" — so the file went terminally `failed`.
 *
 * The probe below is the real shape of such a stream: ffprobe emits no
 * `codec_name` key at all, while every other field of its stream description
 * is present.
 */
describe('codec-less streams', () => {
  const codeclessProbe: ProbeData = {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', codec_tag_string: '[0][0][0][0]' },
      // No codec_name key whatsoever, exactly as ffprobe writes it.
      {
        index: 3,
        codec_type: 'subtitle',
        codec_tag_string: '[0][0][0][0]',
      } as unknown as ProbeStream,
    ],
  };

  const codeclessCommand = () =>
    beginFfmpegCommand({ probe: codeclessProbe, container: 'mkv', inputPath: '/in.mkv' });

  it('drops the codec-less stream and keeps every identified one', () => {
    const cmd = codeclessCommand();
    cmd.streams[0]!.outputArgs.push('-c:{outputIndex}', 'libx265');

    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });

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
      '0:2',
      '-c:2',
      'copy',
      '/out.mkv',
    ]);
    // The stream ffmpeg could not have written is not mapped at all — this is
    // the `-c:3 copy` that produced "Function not implemented".
    expect(args).not.toContain('0:3');
    expect(args).not.toContain('-c:3');
  });

  it('reports the drop with a reason naming the codec, not the dimensions', () => {
    const dropped: DroppedStream[] = [];
    compileFfmpegArgs({
      command: codeclessCommand(),
      outputPath: '/out.mkv',
      onDroppedStream: (entry) => dropped.push(entry),
    });
    expect(dropped).toEqual([
      { index: 3, codecName: 'unknown', reason: expect.stringContaining('no codec') },
    ]);
    expect(dropped[0]!.reason).not.toContain('dimensions');
  });

  it('names the reason when every remaining stream is codec-less', () => {
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [
          {
            index: 0,
            codec_type: 'subtitle',
            codec_tag_string: '[0][0][0][0]',
          } as unknown as ProbeStream,
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(() => compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toThrow(
      /no remaining stream can be written.*no codec/,
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

  /**
   * The codec half of the boundary, which is where the damage would be done
   * if it were drawn one step wider. "ffprobe positively reports no codec" is
   * unmappable; "this object does not happen to carry a codec_name" is not.
   */
  describe('the codec boundary', () => {
    it('rejects a stream ffprobe described in full and gave no codec_name', () => {
      // The observed case: every other field of the ffprobe stream object is
      // present, and codec_name is simply not among them. ffprobe writes
      // codec_name for every codec it can name and omits it only for
      // AV_CODEC_ID_NONE, so its absence HERE is a statement about the stream.
      const stream = {
        index: 3,
        codec_type: 'subtitle',
        codec_tag_string: '[0][0][0][0]',
        codec_tag: '0x0000',
      } as unknown as ProbeStream;
      expect(unmappableStreamReason(stream)).toContain('no codec');
      expect(unmappableStreamReason(stream)).toContain('absent');
    });

    it('rejects a declared codec_name that names no codec', () => {
      // Declared, so we are entitled to judge it — the same discipline the
      // dimension half applies to a declared width.
      expect(reason({ codec_name: null as unknown as string })).toContain('no codec');
      expect(reason({ codec_name: '' })).toContain('no codec');
      expect(reason({ codec_name: 'none' })).toContain('no codec');
      // ffprobe prints the literal string for AV_CODEC_ID_NONE when optional
      // fields are shown; same fact, same answer.
      expect(reason({ codec_name: 'unknown' })).toContain('no codec');
      expect(reason({ codec_name: 'UNKNOWN' })).toContain('no codec');
    });

    it('never judges a stream that merely lacks a codec_name', () => {
      // THE line. A synthetic probe — one a plugin built, a test wrote, or a
      // partial read produced — carries no ffprobe stream description around
      // it, so its missing codec_name is a fact about the probe rather than
      // about the stream. Judging it would let an incomplete probe silently
      // delete a library file's main video track, which is worse than the
      // loud ffmpeg error it would prevent.
      const bare = { index: 0, codec_type: 'video', width: 1920, height: 1080 };
      expect(unmappableStreamReason(bare as unknown as ProbeStream)).toBeNull();
      expect(
        unmappableStreamReason({ index: 1, codec_type: 'audio' } as unknown as ProbeStream),
      ).toBeNull();
      // And a stream with a real codec is never touched by this half, however
      // completely ffprobe described it.
      expect(
        reason({ codec_name: 'h264', codec_tag_string: 'avc1', width: 1920, height: 1080 }),
      ).toBeNull();
      expect(reason({ codec_name: 'subrip', codec_tag_string: '[0][0][0][0]' })).toBeNull();
    });
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
