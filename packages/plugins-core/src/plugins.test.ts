import { describe, expect, it } from 'vitest';
import type { PluginInputArgs } from '@trawlarr/plugin-api';
import { HardwareDecodeConflictError, compileFfmpegArgs, emptyFfmpegCommand } from '@trawlarr/core';
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
      // Terminal nodes intentionally declare no outgoing connections.
      expect(Array.isArray(details.outputs), id).toBe(true);
      for (const output of details.outputs) {
        expect(Number.isInteger(output.number), id).toBe(true);
        expect(output.number, id).toBeGreaterThan(0);
      }
      expect(details.name, id).toBeTruthy();
    }
  });
});

describe('trawlarr:failFile', () => {
  const plugin = FIRST_PARTY_PLUGINS['trawlarr:failFile']!.module;

  it('has no outgoing ports and records the configured reason before failing', () => {
    const lines: string[] = [];
    const args = argsFor({
      inputs: { message: 'Video quality rejected.' },
      jobLog: (text) => lines.push(text),
    });
    expect(plugin.details().outputs).toEqual([]);
    expect(() => plugin.plugin(args)).toThrow('Video quality rejected.');
    expect(lines).toEqual(['Video quality rejected.']);
    expect(args.inputFileObj._id).toBe('/media/movie.mkv');
    expect(args.variables.flowFailed).toBe(false);
  });

  it.each([undefined, '', '  '])('provides a useful failure reason for message %s', (message) => {
    expect(() => plugin.plugin(argsFor({ inputs: { message } }))).toThrow(
      'File rejected by this flow.',
    );
  });
});

describe('trawlarr:writeToLog', () => {
  const plugin = FIRST_PARTY_PLUGINS['trawlarr:writeToLog']!.module;

  it('logs multiline text verbatim and preserves the file and all run variables', async () => {
    const lines: string[] = [];
    const args = argsFor({
      inputs: { message: 'First line\nSecond line' },
      jobLog: (text) => lines.push(text),
    });
    const output = await plugin.plugin(args);
    expect(lines).toEqual(['First line\nSecond line']);
    expect(output.outputNumber).toBe(1);
    expect(output.outputFileObj._id).toBe(args.inputFileObj._id);
    expect(output.variables).toBe(args.variables);
    expect(output.variables.ffmpegCommand.init).toBe(false);
  });

  it('uses the metadata default when the message input is absent', async () => {
    const lines: string[] = [];
    await plugin.plugin(argsFor({ jobLog: (text) => lines.push(text) }));
    expect(lines).toEqual([plugin.details().inputs[0]!.defaultValue]);
  });

  it('expands placeholders only when opted in, preserving existing literal messages', async () => {
    const lines: string[] = [];
    const input = argsFor({
      inputs: { message: 'Processing {{file.path}}' },
      jobLog: (text) => lines.push(text),
    });
    await plugin.plugin(input);
    await plugin.plugin({ ...input, inputs: { ...input.inputs, interpolate: true } });
    expect(lines).toEqual(['Processing {{file.path}}', 'Processing /media/movie.mkv']);
    expect(() => plugin.plugin({ ...input, inputs: { interpolate: 'yes' } })).toThrow(
      'must be true or false',
    );
  });

  it('does not pretend to succeed when the job logger throws', () => {
    expect(() =>
      plugin.plugin(
        argsFor({
          jobLog: () => {
            throw new Error('Log unavailable');
          },
        }),
      ),
    ).toThrow('Log unavailable');
  });

  describe('trawlarr:checkCondition', () => {
    it('routes matching and non-matching files without altering their path or variables', async () => {
      const plugin = FIRST_PARTY_PLUGINS['trawlarr:checkCondition']!.module;
      const lines: string[] = [];
      const input = argsFor({
        inputs: { field1: 'video.codec', value1: 'h264' },
        jobLog: (text) => lines.push(text),
      });
      const yes = await plugin.plugin(input);
      const no = await plugin.plugin({ ...input, inputs: { value1: 'hevc' } });
      expect(yes.outputNumber).toBe(1);
      expect(no.outputNumber).toBe(2);
      expect(yes.outputFileObj._id).toBe(input.inputFileObj._id);
      expect(yes.variables).toBe(input.variables);
      expect(lines[0]).toContain('"h264"');
    });
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
    // `-c:{outputIndex}`, not `-c:v`: a type specifier would also match cover
    // art (an mjpeg video stream as far as ffmpeg is concerned) and, because
    // ffmpeg takes the LAST matching specifier, would override that stream's
    // own copy directive when the cover art precedes the video track.
    expect(video.outputArgs).toEqual(['-c:{outputIndex}', 'libx265', '-crf', '24']);
    expect(video.outputArgs).not.toContain('-c:v');
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

  /**
   * Hardware DECODING: the -hwaccel flag that goes ahead of -i.
   *
   * Asserted on the compiled argv rather than on the plugin's own bookkeeping,
   * because the only thing that matters is what ffmpeg is handed: -hwaccel is
   * an input option and is meaningless (or misread) anywhere after -i.
   */
  describe('hardware decoding', () => {
    const argvFor = async (inputs: Record<string, string>): Promise<string[]> => {
      const begun = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
      const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
        argsFor({ variables: begun.variables, inputs }),
      );
      return compileFfmpegArgs({
        command: out.variables.ffmpegCommand,
        outputPath: '/out.mkv',
      });
    };

    it('emits nothing for a software encoder, even when hardware decoding is asked for', async () => {
      // The CPU path must be BYTE-IDENTICAL to the one that predates this
      // feature: same argv, in the same order, not merely "no -hwaccel".
      const withDecode = await argvFor({
        encoder: 'libx265',
        quality: '24',
        hardwareDecoding: 'true',
      });
      const withoutDecode = await argvFor({ encoder: 'libx265', quality: '24' });
      expect(withDecode).toEqual(withoutDecode);
      expect(withDecode).not.toContain('-hwaccel');
    });

    it('emits nothing for a GPU encoder until the operator asks: it is never inferred', async () => {
      const argv = await argvFor({ encoder: 'hevc_nvenc', quality: '23' });
      expect(argv).not.toContain('-hwaccel');
      expect(argv).toEqual(
        await argvFor({ encoder: 'hevc_nvenc', quality: '23', hardwareDecoding: 'false' }),
      );
    });

    it('puts -hwaccel cuda ahead of the input for an NVENC encode', async () => {
      const argv = await argvFor({
        encoder: 'hevc_nvenc',
        quality: '23',
        hardwareDecoding: 'true',
      });
      expect(argv.slice(0, 4)).toEqual(['-hwaccel', 'cuda', '-i', '/media/movie.mkv']);
      // The rule that cost this project a library's cover art still holds:
      // codecs are addressed by resolved output index, never by type.
      expect(argv).toContain('-c:0');
      expect(argv).not.toContain('-c:v');
      // Decoding on the device does not imply keeping frames there.
      expect(argv).not.toContain('-hwaccel_output_format');
    });

    it('adds -hwaccel_output_format only when the flow asks to keep frames on the device', async () => {
      const argv = await argvFor({
        encoder: 'hevc_nvenc',
        quality: '23',
        hardwareDecoding: 'true',
        hardwareDecodingKeepFramesOnDevice: 'true',
      });
      expect(argv.slice(0, 6)).toEqual([
        '-hwaccel',
        'cuda',
        '-hwaccel_output_format',
        'cuda',
        '-i',
        '/media/movie.mkv',
      ]);
    });

    it("uses each encoder family's own decode API", async () => {
      const hwaccelIn = (argv: string[]): string | undefined => argv[argv.indexOf('-hwaccel') + 1];
      expect(
        hwaccelIn(await argvFor({ encoder: 'hevc_qsv', quality: '23', hardwareDecoding: 'true' })),
      ).toBe('qsv');
      expect(
        hwaccelIn(
          await argvFor({ encoder: 'hevc_vaapi', quality: '23', hardwareDecoding: 'true' }),
        ),
      ).toBe('vaapi');
    });

    it('emits no flag for AMF, which ffmpeg cannot decode with', async () => {
      const argv = await argvFor({ encoder: 'hevc_amf', quality: '23', hardwareDecoding: 'true' });
      expect(argv).not.toContain('-hwaccel');
      // The encode itself is still configured; only the decode is refused.
      expect(argv).toContain('hevc_amf');
    });

    it('emits one flag for a file with two video streams, not one per stream', async () => {
      const begun = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(
        argsFor({
          inputFileObj: {
            _id: '/media/two-video.mkv',
            container: 'mkv',
            video_codec_name: 'h264',
            ffProbeData: {
              format: { duration: '60' },
              streams: [
                { index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 240 },
                { index: 1, codec_type: 'video', codec_name: 'h264', width: 320, height: 240 },
                { index: 2, codec_type: 'audio', codec_name: 'eac3' },
              ],
            },
          },
        } as unknown as Partial<PluginInputArgs>),
      );
      const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
        argsFor({
          variables: begun.variables,
          inputs: { encoder: 'hevc_nvenc', quality: '23', hardwareDecoding: 'true' },
        }),
      );
      const argv = compileFfmpegArgs({
        command: out.variables.ffmpegCommand,
        outputPath: '/out.mkv',
      });
      expect(argv.filter((arg) => arg === '-hwaccel')).toHaveLength(1);
    });

    it('refuses a flow whose two encoder nodes want different decoders', async () => {
      const begun = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
      const first = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
        argsFor({
          variables: begun.variables,
          inputs: { encoder: 'hevc_nvenc', quality: '23', hardwareDecoding: 'true' },
        }),
      );
      await expect(
        FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
          argsFor({
            variables: first.variables,
            inputs: { encoder: 'hevc_qsv', quality: '23', hardwareDecoding: 'true' },
          }),
        ),
      ).rejects.toThrow(HardwareDecodeConflictError);
    });
  });

  describe('quality flag per encoder', () => {
    const flagFor = async (encoder: string): Promise<string | undefined> => {
      const begun = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
      const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
        argsFor({ variables: begun.variables, inputs: { encoder, quality: '24' } }),
      );
      const outputArgs = out.variables.ffmpegCommand.streams[0]!.outputArgs;
      const flagIndex = outputArgs.findIndex(
        (arg) => arg.startsWith('-') && arg !== '-c:{outputIndex}',
      );
      return outputArgs[flagIndex];
    };

    it('libx265 uses -crf', async () => {
      expect(await flagFor('libx265')).toBe('-crf');
    });

    it('libx264 uses -crf', async () => {
      expect(await flagFor('libx264')).toBe('-crf');
    });

    it('hevc_nvenc uses -cq', async () => {
      expect(await flagFor('hevc_nvenc')).toBe('-cq');
    });

    it('h264_nvenc uses -cq', async () => {
      expect(await flagFor('h264_nvenc')).toBe('-cq');
    });

    it('hevc_vaapi uses -qp', async () => {
      expect(await flagFor('hevc_vaapi')).toBe('-qp');
    });

    it('hevc_qsv uses -global_quality', async () => {
      expect(await flagFor('hevc_qsv')).toBe('-global_quality');
    });

    it('an encoder not in the map falls back to the -crf default', async () => {
      expect(await flagFor('some_future_encoder')).toBe('-crf');
    });
  });
});

describe('trawlarr:verifyOutput', () => {
  const plugin = () => FIRST_PARTY_PLUGINS['trawlarr:verifyOutput']!.module;

  it('declares pass and fail outputs so a flow can branch on verification', () => {
    const details = plugin().details();
    expect(details.outputs.map((o) => o.number)).toEqual([1, 2]);
    expect(details.outputs[1]?.tooltip.toLowerCase()).toMatch(/fail|did not/);
  });

  it('exposes the tolerances as inputs rather than hard-coding them', () => {
    const names = plugin()
      .details()
      .inputs.map((i) => i.name);
    expect(names).toContain('durationToleranceSeconds');
    expect(names).toContain('minSizeRatio');
    // The audio fail-safe is a host gate, but the flow author still has to be
    // able to see it and turn it off for a deliberately silent flow.
    expect(names).toContain('requireAudioIfOriginalHadAudio');
  });

  it('refuses to run outside an engine that supplies its behaviour', async () => {
    await expect(plugin().plugin(argsFor())).rejects.toThrow(/engine/i);
  });
});

describe('trawlarr:replaceOriginal', () => {
  const plugin = () => FIRST_PARTY_PLUGINS['trawlarr:replaceOriginal']!.module;

  it('declares success and failure outputs', () => {
    expect(
      plugin()
        .details()
        .outputs.map((o) => o.number),
    ).toEqual([1, 2]);
  });

  it('says plainly in its description that it replaces the original', () => {
    // A flow author reading the palette must not be surprised by this node.
    expect(plugin().details().description.toLowerCase()).toMatch(/replace|original/);
  });

  it('refuses to run outside an engine that supplies its behaviour', async () => {
    await expect(plugin().plugin(argsFor())).rejects.toThrow(/engine/i);
  });
});
