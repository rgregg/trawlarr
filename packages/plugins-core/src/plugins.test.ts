import { describe, expect, it } from 'vitest';
import type { PluginInputArgs } from '@trawlarr/plugin-api';
import { emptyFfmpegCommand } from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from './index.js';

const argsFor = (over: Partial<PluginInputArgs> = {}): PluginInputArgs =>
  ({
    inputFileObj: {
      _id: '/media/movie.mkv',
      container: 'mkv',
      video_codec_name: 'h264',
      ffProbeData: {
        format: { duration: '60' },
        streams: [
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'eac3' },
        ],
      },
    },
    variables: { ffmpegCommand: emptyFfmpegCommand(), flowFailed: false, user: {} },
    inputs: {},
    jobLog: () => {},
    ...over,
  }) as unknown as PluginInputArgs;

describe('every first-party plugin', () => {
  it('conforms to the contract', () => {
    for (const [id, entry] of Object.entries(FIRST_PARTY_PLUGINS)) {
      const details = entry.module.details();
      expect(typeof entry.module.plugin, id).toBe('function');
      expect(Array.isArray(details.inputs), id).toBe(true);
      expect(details.outputs.length, id).toBeGreaterThan(0);
      expect(details.name, id).toBeTruthy();
    }
  });
});

describe('trawlarr:start', () => {
  it('is a start node that passes the file through', async () => {
    const plugin = FIRST_PARTY_PLUGINS['trawlarr:start']!.module;
    expect(plugin.details().isStartPlugin).toBe(true);
    const out = await plugin.plugin(argsFor());
    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe('/media/movie.mkv');
  });
});

describe('trawlarr:checkVideoCodec', () => {
  const plugin = () => FIRST_PARTY_PLUGINS['trawlarr:checkVideoCodec']!.module;

  it('routes to output 1 when the codec matches', async () => {
    const out = await plugin().plugin(argsFor({ inputs: { codec: 'h264' } }));
    expect(out.outputNumber).toBe(1);
  });

  it('routes to output 2 when it does not', async () => {
    const out = await plugin().plugin(argsFor({ inputs: { codec: 'hevc' } }));
    expect(out.outputNumber).toBe(2);
  });

  it('compares case-insensitively', async () => {
    const out = await plugin().plugin(argsFor({ inputs: { codec: 'H264' } }));
    expect(out.outputNumber).toBe(1);
  });
});

describe('trawlarr:beginCommand', () => {
  it('initialises the command from the probe', async () => {
    const out = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
    expect(out.variables.ffmpegCommand.init).toBe(true);
    expect(out.variables.ffmpegCommand.streams).toHaveLength(2);
    expect(out.variables.ffmpegCommand.inputFiles).toEqual(['/media/movie.mkv']);
  });
});

describe('trawlarr:setVideoEncoder', () => {
  it('sets encoder args on the video stream and marks the command for processing', async () => {
    const begun = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
    const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
      argsFor({
        variables: begun.variables,
        inputs: { encoder: 'libx265', quality: '24' },
      }),
    );
    const video = out.variables.ffmpegCommand.streams[0]!;
    expect(video.outputArgs).toEqual(['-c:v', 'libx265', '-crf', '24']);
    expect(out.variables.ffmpegCommand.shouldProcess).toBe(true);
  });

  it('leaves audio streams alone', async () => {
    const begun = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
    const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
      argsFor({ variables: begun.variables, inputs: { encoder: 'libx265', quality: '24' } }),
    );
    expect(out.variables.ffmpegCommand.streams[1]!.outputArgs).toEqual([]);
  });

  it('refuses to run without a Begin Command node, naming the fix', async () => {
    await expect(
      FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
        argsFor({ inputs: { encoder: 'libx265', quality: '24' } }),
      ),
    ).rejects.toThrow(/Begin Command/i);
  });
});
