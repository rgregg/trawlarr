import { describe, expect, it, vi } from 'vitest';
import { emptyFfmpegCommand, ReviewHoldSignal } from '@trawlarr/core';
import type { PluginInputArgs } from '@trawlarr/plugin-api';
import * as onError from './onError/index.js';
import * as holdForReview from './holdForReview/index.js';

const argsFor = (reason?: string): PluginInputArgs =>
  ({
    inputFileObj: { _id: '/media/movie.mkv' },
    inputs: { reason },
    variables: {
      ffmpegCommand: emptyFfmpegCommand(),
      flowFailed: true,
      flowError: {
        nodeId: 'broken',
        pluginId: 'plugin',
        pluginName: 'Broken plugin',
        message: 'Original error',
      },
      user: {},
    },
    jobLog: vi.fn(),
  }) as unknown as PluginInputArgs;

describe('On Error', () => {
  it('declares a recovery entry and preserves file, command and original failure context', () => {
    expect(onError.details()).toMatchObject({
      isStartPlugin: false,
      pType: 'onFlowError',
      outputs: [{ number: 1, tooltip: 'Continue' }],
    });
    const args = argsFor();
    const result = onError.plugin(args);
    expect(result.outputFileObj._id).toBe(args.inputFileObj._id);
    expect(result.variables.ffmpegCommand).toBe(args.variables.ffmpegCommand);
    expect(result.variables.flowError).toBe(args.variables.flowError);
    expect(result.variables.flowErrorOutcome).toBe('failure');
    expect(result.variables.flowFailed).toBe(true);
    expect(result.variables.flowError!.message).toBe('Original error');
  });

  it.each([true, 'true'])(
    'allows successful recovery only when explicitly enabled: %s',
    (value) => {
      const args = argsFor();
      args.inputs.recoverAsSuccess = value;
      const result = onError.plugin(args);
      expect(result.variables.flowErrorOutcome).toBe('success');
      expect(result.variables.flowFailed).toBe(true);
      expect(result.variables.flowError).toBe(args.variables.flowError);
    },
  );

  it.each([undefined, false, 'false', 'yes'])(
    'preserves failure for non-opt-in input %s',
    (value) => {
      const args = argsFor();
      args.inputs.recoverAsSuccess = value;
      expect(onError.plugin(args).variables.flowErrorOutcome).toBe('failure');
    },
  );
});

describe('Hold for Review', () => {
  it('is terminal and throws a typed control signal without changing media or variables', () => {
    expect(holdForReview.details().outputs).toEqual([]);
    const args = argsFor('Inspect the audio.');
    const before = JSON.stringify(args);
    expect(() => holdForReview.plugin(args)).toThrow(ReviewHoldSignal);
    expect(args.jobLog).toHaveBeenCalledWith('Held for review: Inspect the audio.');
    expect(JSON.stringify(args)).toBe(before);
  });

  it.each([undefined, '', '   '])('supplies a useful reason for empty input %s', (reason) => {
    expect(() => holdForReview.plugin(argsFor(reason))).toThrow('Review requested by the flow.');
  });
});
