import { describe, expect, it } from 'vitest';
import type { FfmpegCommand, PluginFileObject, PluginOutputArgs } from './index.js';

describe('contract shape', () => {
  it('preserves the upstream misspelling on the ffmpeg command', () => {
    const cmd: FfmpegCommand = {
      init: true,
      inputFiles: ['/in.mkv'],
      streams: [],
      container: 'mkv',
      hardwareDecoding: false,
      shouldProcess: false,
      overallInputArguments: [],
      overallOuputArguments: ['-max_muxing_queue_size', '9999'],
    };
    expect(Object.keys(cmd)).toContain('overallOuputArguments');
    expect(Object.keys(cmd)).not.toContain('overallOutputArguments');
  });

  it('models the legacy status enums as the contract spells them', () => {
    const file = {
      _id: '/library/movie.mkv',
      HealthCheck: 'Success',
      TranscodeDecisionMaker: 'Transcode success',
    } as PluginFileObject;
    expect(file.HealthCheck).toBe('Success');
    expect(file.TranscodeDecisionMaker).toBe('Transcode success');
  });

  it('routes by output number', () => {
    const out: PluginOutputArgs = {
      outputNumber: 2,
      outputFileObj: { _id: '/library/movie.mkv' },
      variables: {
        ffmpegCommand: {
          init: false,
          inputFiles: [],
          streams: [],
          container: '',
          hardwareDecoding: false,
          shouldProcess: false,
          overallInputArguments: [],
          overallOuputArguments: [],
        },
        flowFailed: false,
        user: {},
      },
    };
    expect(out.outputNumber).toBe(2);
  });
});
