import { describe, expect, it, vi } from 'vitest';
import type { PluginInputArgs } from '@trawlarr/plugin-api';
import { emptyFfmpegCommand } from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from '../index.js';
import { details, plugin } from './index.js';

const argsFor = (over: Partial<PluginInputArgs> = {}): PluginInputArgs =>
  ({
    inputFileObj: { _id: '/media/movie.mkv', container: 'mkv', ffProbeData: { streams: [] } },
    userVariables: { global: {}, library: {} },
    job: { jobId: 'j1', fileId: 'f1' },
    variables: { ffmpegCommand: emptyFfmpegCommand(), flowFailed: false, user: {} },
    inputs: { destination: 'ha', message: 'Done: {{file.path}}' },
    jobLog: () => {},
    ...over,
  }) as unknown as PluginInputArgs;

describe('trawlarr:sendWebhook', () => {
  it('sends the destination and rendered message once and continues unchanged', () => {
    const sendAlert = vi.fn();
    const args = argsFor({ sendAlert });
    const out = plugin(args) as {
      outputNumber: number;
      variables: unknown;
      outputFileObj: { _id: string };
    };
    expect(sendAlert).toHaveBeenCalledOnce();
    expect(sendAlert).toHaveBeenCalledWith('ha', 'Done: /media/movie.mkv');
    expect(out.outputNumber).toBe(1);
    expect(out.variables).toBe(args.variables);
    expect(out.outputFileObj._id).toBe('/media/movie.mkv');
  });

  it('logs and continues when alerts are unavailable', () => {
    const lines: string[] = [];
    const out = plugin(argsFor({ jobLog: (t: string) => lines.push(t) }));
    expect(out.outputNumber).toBe(1);
    expect(lines).toEqual(['alerts unavailable here; skipped']);
  });

  it('never fails the flow when sendAlert throws', () => {
    const lines: string[] = [];
    const out = plugin(
      argsFor({
        sendAlert: () => {
          throw new Error('boom');
        },
        jobLog: (t: string) => lines.push(t),
      }),
    );
    expect(out.outputNumber).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('boom');
  });

  it('skips with a log line on an empty destination', () => {
    const sendAlert = vi.fn();
    const lines: string[] = [];
    const out = plugin(
      argsFor({
        sendAlert,
        inputs: { destination: '  ', message: 'x' },
        jobLog: (t: string) => lines.push(t),
      }),
    );
    expect(out.outputNumber).toBe(1);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
  });

  it('sends the file name when the message is blank', () => {
    const sendAlert = vi.fn();
    plugin(argsFor({ sendAlert, inputs: { destination: 'ha', message: ' ' } }));
    expect(sendAlert).toHaveBeenCalledWith('ha', 'movie.mkv');
  });

  it('sends the message as written when a placeholder is bad', () => {
    const sendAlert = vi.fn();
    const lines: string[] = [];
    plugin(
      argsFor({
        sendAlert,
        inputs: { destination: 'ha', message: 'x {{nope}}' },
        jobLog: (t: string) => lines.push(t),
      }),
    );
    expect(sendAlert).toHaveBeenCalledWith('ha', 'x {{nope}}');
    expect(lines).toHaveLength(1);
  });

  it('tells the operator to place it before Hold for Review, and is registered', () => {
    expect(details().inputs[1]!.tooltip).toContain('before Hold for Review');
    expect(details().outputs).toEqual([{ number: 1, tooltip: expect.any(String) as string }]);
    expect(FIRST_PARTY_PLUGINS['trawlarr:sendWebhook']).toBeDefined();
  });
});
