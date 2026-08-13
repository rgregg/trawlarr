import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from './ffmpeg-command.js';
import {
  compileFfmpegArgs,
  outputStreamIndex,
  outputStreamTypeIndex,
  shouldCopyStream,
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
