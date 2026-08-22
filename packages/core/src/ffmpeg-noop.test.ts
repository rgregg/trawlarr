import { describe, expect, it } from 'vitest';
import type { ProbeStream } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from './ffmpeg-command.js';
import { compileFfmpegArgs } from './ffmpeg-compile.js';
import { describeCommandChanges, wouldCommandChangeFile } from './ffmpeg-noop.js';

const INPUT = '/library/show/episode.mkv';

const sourceStreams = (): ProbeStream[] => [
  { index: 0, codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080 },
  { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
  { index: 2, codec_type: 'audio', codec_name: 'eac3', channels: 6 },
  { index: 3, codec_type: 'subtitle', codec_name: 'subrip', codec_tag_string: '[0][0][0][0]' },
];

const setup = (streams: ProbeStream[] = sourceStreams()) => {
  const source = { path: INPUT, container: 'mkv', streams };
  const command = beginFfmpegCommand({
    probe: { streams: streams.map((stream) => ({ ...stream })) },
    container: 'mkv',
    inputPath: INPUT,
  });
  return { source, command };
};

const kinds = (input: Parameters<typeof describeCommandChanges>[0]): string[] =>
  describeCommandChanges(input).map((change) => change.kind);

describe('describeCommandChanges', () => {
  it('reports nothing for a command nobody touched', () => {
    const { source, command } = setup();
    expect(describeCommandChanges({ command, source })).toEqual([]);
    expect(wouldCommandChangeFile({ command, source })).toBe(false);
  });

  it('ignores shouldProcess entirely, in both directions', () => {
    // The whole point of the gate: a declaration of intent is not a change.
    // `Set Container` to the container the file already has, a stream filter
    // that matched nothing, and a plugin that simply sets the flag all land
    // here — and on a real library that was 4,000 files rewritten to say what
    // they already said.
    const { source, command } = setup();
    command.shouldProcess = true;
    expect(describeCommandChanges({ command, source })).toEqual([]);

    // And the mirror: shouldProcess false does not make a real change inert.
    const other = setup();
    other.command.shouldProcess = false;
    other.command.container = 'mp4';
    expect(kinds({ command: other.command, source: other.source })).toEqual(['container']);
  });

  it('reports a container change even though every stream is copied', () => {
    const { source, command } = setup();
    command.container = 'mp4';
    const changes = describeCommandChanges({ command, source });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('container');
    expect(changes[0]!.detail).toContain('mkv');
    expect(changes[0]!.detail).toContain('mp4');
    // The compiled argv really is a pure copy — the container is the only
    // thing that differs, which is exactly the case a stream-level rule misses.
    expect(compileFfmpegArgs({ command, outputPath: '/staging/out.mp4' })).toContain('copy');
  });

  it('treats container spellings the rest of trawlarr calls equal as equal', () => {
    const { source, command } = setup();
    command.container = '.MKV ';
    expect(describeCommandChanges({ command, source })).toEqual([]);
  });

  it('reports a removed stream', () => {
    const { source, command } = setup();
    command.streams[3]!.removed = true;
    expect(kinds({ command, source })).toEqual(['stream-set', 'stream-set']);
  });

  it('reports an added stream, even when the added stream is only copied', () => {
    // `Ensure Audio Stream` adding a redundant stereo downmix to a file that
    // already carries aac:2 + eac3:6.
    const { source, command } = setup();
    command.streams.push({ ...command.streams[2]! });
    const changes = describeCommandChanges({ command, source });
    expect(changes.map((change) => change.kind)).toEqual(['stream-set']);
    expect(changes[0]!.detail).toContain('5 stream(s) where the file has 4');
  });

  it('reports a reorder that keeps the stream count identical', () => {
    const { source, command } = setup();
    const [video, aac, eac3, subtitle] = command.streams;
    command.streams = [video!, eac3!, aac!, subtitle!];
    expect(kinds({ command, source })).toEqual(['stream-order', 'stream-order']);
  });

  it('reports an insertion paired with a removal, which preserves the count', () => {
    const { source, command } = setup();
    command.streams[3]!.removed = true;
    command.streams.push({ ...command.streams[1]! });
    // Same number of mapped streams as the input has, and a different file.
    expect(kinds({ command, source })).toContain('stream-order');
  });

  it("reports a stream the host's own unmappable rule would drop", () => {
    // Nothing in the flow changed. The compiler would still leave the
    // dimensionless cover art out, so the output is a different file — and
    // one worth producing.
    const streams = [
      ...sourceStreams(),
      { index: 4, codec_type: 'video', codec_name: 'mjpeg', width: 0, height: 0 },
    ];
    const { source, command } = setup(streams);
    const changes = describeCommandChanges({ command, source });
    expect(changes.map((change) => change.kind)).toEqual(['stream-set', 'stream-set']);
    expect(changes[0]!.detail).toContain('cannot be written to any container');
  });

  it('reports tagging-only output arguments, which survive a stream copy', () => {
    const { source, command } = setup();
    command.streams[1]!.outputArgs.push('-metadata:s:1', 'language=eng');
    const changes = describeCommandChanges({ command, source });
    expect(changes.map((change) => change.kind)).toEqual(['stream-arguments']);
    expect(changes[0]!.detail).toContain('language=eng');
  });

  it('reports a disposition change, which also survives a stream copy', () => {
    const { source, command } = setup();
    command.streams[2]!.outputArgs.push('-disposition:2', 'default');
    expect(kinds({ command, source })).toEqual(['stream-arguments']);
  });

  it('reports forceEncoding, input arguments and both overall argument lists', () => {
    const forced = setup();
    forced.command.streams[0]!.forceEncoding = true;
    expect(kinds({ command: forced.command, source: forced.source })).toEqual(['stream-arguments']);

    const streamInput = setup();
    streamInput.command.streams[0]!.inputArgs.push('-hwaccel', 'cuda');
    expect(kinds({ command: streamInput.command, source: streamInput.source })).toEqual([
      'stream-arguments',
    ]);

    const overallIn = setup();
    overallIn.command.overallInputArguments.push('-hwaccel', 'cuda');
    expect(kinds({ command: overallIn.command, source: overallIn.source })).toEqual([
      'overall-arguments',
    ]);

    // Spelled the upstream way on purpose; community plugins write to it.
    const overallOut = setup();
    overallOut.command.overallOuputArguments.push('-map_metadata', '-1');
    expect(kinds({ command: overallOut.command, source: overallOut.source })).toEqual([
      'overall-arguments',
    ]);

    const hwDecode = setup();
    hwDecode.command.hardwareDecoding = true;
    expect(kinds({ command: hwDecode.command, source: hwDecode.source })).toEqual([
      'overall-arguments',
    ]);
  });

  it('reports a mapping that does not select the stream it claims to be', () => {
    const { source, command } = setup();
    command.streams[1]!.mapArgs = ['-map', '1:0'];
    expect(kinds({ command, source })).toEqual(['stream-mapping']);
  });

  it('accepts an empty mapArgs, which compiles to the identity map', () => {
    const { source, command } = setup();
    command.streams[1]!.mapArgs = [];
    expect(describeCommandChanges({ command, source })).toEqual([]);
    expect(compileFfmpegArgs({ command, outputPath: '/staging/out.mkv' })).toContain('0:1');
  });

  it('reports a second input file', () => {
    const { source, command } = setup();
    command.inputFiles.push('/library/show/extra.ac3');
    expect(kinds({ command, source })).toEqual(['input']);
  });

  it('reports a command reading a file other than the one being judged', () => {
    const { source, command } = setup();
    command.inputFiles = ['/somewhere/else.mkv'];
    const changes = describeCommandChanges({ command, source });
    expect(changes.map((change) => change.kind)).toEqual(['input']);
    expect(changes[0]!.detail).toContain('/somewhere/else.mkv');
  });

  describe('every case it cannot decide is decided as "would change"', () => {
    it('refuses a source with no probed streams', () => {
      const { command } = setup();
      expect(kinds({ command, source: { path: INPUT, container: 'mkv', streams: [] } })).toEqual([
        'unverifiable',
      ]);
      expect(
        kinds({ command, source: { path: INPUT, container: 'mkv', streams: undefined } }),
      ).toEqual(['unverifiable']);
    });

    it('refuses a stream that carries no ffprobe index to match on', () => {
      // A stream a plugin built by hand cannot be shown to be the same track
      // the file already has, whatever its codec says.
      const streams = [{ codec_type: 'video', codec_name: 'hevc' } as ProbeStream];
      const { source, command } = setup(streams);
      // Twice over: it cannot be matched to an input stream, and its seeded
      // `-map` cannot be shown to select its own track either.
      expect(kinds({ command, source })).toEqual(['unverifiable', 'stream-mapping']);
    });
  });
});
