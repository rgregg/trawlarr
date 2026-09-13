import { describe, expect, it } from 'vitest';
import type { FfmpegCommand, FfmpegCommandStream } from '@trawlarr/plugin-api';
import { commandEncodes } from './command-encodes.js';

const stream = (codec_type: string, over: Partial<FfmpegCommandStream> = {}): FfmpegCommandStream =>
  ({
    index: 0,
    codec_type,
    codec_name: codec_type === 'video' ? 'h264' : 'aac',
    removed: false,
    forceEncoding: false,
    inputArgs: [],
    outputArgs: [],
    mapArgs: [],
    ...over,
  }) as FfmpegCommandStream;

const command = (streams: FfmpegCommandStream[]): FfmpegCommand => ({
  init: true,
  inputFiles: ['/in.mkv'],
  streams,
  container: 'mkv',
  hardwareDecoding: false,
  shouldProcess: true,
  overallInputArguments: [],
  overallOuputArguments: [],
});

describe('commandEncodes', () => {
  it('reports a video encode', () => {
    expect(
      commandEncodes(
        command([
          stream('video', { outputArgs: ['-c:{outputIndex}', 'libx265'] }),
          stream('audio'),
        ]),
      ),
    ).toEqual({ video: true, audio: false });
  });

  it('reports an audio-only encode', () => {
    expect(
      commandEncodes(
        command([stream('video'), stream('audio', { outputArgs: ['-c:{outputIndex}', 'aac'] })]),
      ),
    ).toEqual({ video: false, audio: true });
  });

  it('counts a forced encode and ignores tagging-only and removed streams', () => {
    expect(
      commandEncodes(
        command([
          stream('video', { outputArgs: ['-disposition:{outputIndex}', '+default'] }),
          stream('audio', { removed: true, outputArgs: ['-c:{outputIndex}', 'aac'] }),
          stream('audio', { forceEncoding: true }),
        ]),
      ),
    ).toEqual({ video: false, audio: true });
  });

  it('reports nothing for a copy-only remux', () => {
    expect(commandEncodes(command([stream('video'), stream('audio')]))).toEqual({
      video: false,
      audio: false,
    });
  });
});
