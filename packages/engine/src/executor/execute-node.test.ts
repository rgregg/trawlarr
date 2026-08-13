import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginDetails, PluginInputArgs } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from '@trawlarr/core';
import { createExecuteRunner } from './execute-node.js';
import type { LoadedPlugin } from '../host/loader.js';
import type { FfmpegRunResult, RunFfmpegInput } from '../ffmpeg/run.js';

const details = (): PluginDetails => ({
  name: 'Execute',
  description: 'fixture',
  style: { borderColor: '#000000' },
  tags: 'ffmpeg',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faPlay',
  inputs: [],
  outputs: [
    { number: 1, tooltip: 'success' },
    { number: 2, tooltip: 'failure' },
  ],
  requiresVersion: '1.0.0',
});

const executePlugin = (): LoadedPlugin =>
  ({
    id: 'trawlarr:execute',
    absPath: '/builtin/execute',
    version: '1.0.0',
    details: details(),
    // The runner replaces the declared behaviour entirely, so the module's own
    // plugin function must never be the thing under test.
    module: {
      details,
      plugin: () => {
        throw new Error('the declared Execute behaviour must not run');
      },
    },
  }) as unknown as LoadedPlugin;

/**
 * A command over one video and one audio stream. `encodes` decides whether any
 * work was asked for: with it false nothing has been touched, which is exactly
 * the "nothing to do" shape the runner must recognise.
 */
const commandFor = (input: { inputPath: string; encodes: boolean }) => {
  const command = beginFfmpegCommand({
    probe: {
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
      ],
    },
    container: 'mkv',
    inputPath: input.inputPath,
  });
  if (input.encodes) {
    command.streams[0]!.outputArgs.push('-c:{outputIndex}', 'libx265', '-crf', '24');
    command.streams[0]!.forceEncoding = true;
    command.shouldProcess = true;
  }
  return command;
};

const argsFor = (input: { inputPath: string; encodes: boolean }): PluginInputArgs =>
  ({
    inputFileObj: {
      _id: input.inputPath,
      container: 'mkv',
      ffProbeData: { format: { duration: '2' }, streams: [] },
    },
    variables: {
      ffmpegCommand: commandFor(input),
      flowFailed: false,
      user: {},
    },
    inputs: {},
    jobLog: () => {},
    updateWorker: () => {},
  }) as unknown as PluginInputArgs;

/** Somewhere to put an input file and, separately, the work directory. */
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-execute-'));
  const inputPath = join(root, 'source.mkv');
  writeFileSync(inputPath, 'not really a video', 'utf8');
  // The work directory is separate from the input's directory: the resolved
  // output must differ from the input, which the engine refuses otherwise.
  const workDir = join(root, 'work');
  mkdirSync(workDir, { recursive: true });
  return { root, inputPath, workDir };
};

/**
 * A stand-in for ffmpeg: records the invocation and, on success, writes the
 * file real ffmpeg would have written — the runner renames that scratch file
 * into place, so a fake that produces nothing would fail for the wrong reason.
 */
const fakeRunner = (input: { code: number }) => {
  const calls: RunFfmpegInput[] = [];
  const run = (runInput: RunFfmpegInput): Promise<FfmpegRunResult> => {
    calls.push(runInput);
    if (input.code === 0) {
      const scratchPath = runInput.args.at(-1)!;
      writeFileSync(scratchPath, 'encoded', 'utf8');
    }
    return Promise.resolve({
      code: input.code,
      signal: null,
      stderrTail: input.code === 0 ? '' : 'Invalid data found',
      cancelled: false,
    });
  };
  return { calls, run };
};

const runnerFor = (input: {
  workDir: string;
  runFfmpegFn?: (runInput: RunFfmpegInput) => Promise<FfmpegRunResult>;
  log?: (text: string) => void;
}) =>
  createExecuteRunner({
    ffmpegPath: 'ffmpeg',
    outputPathFor: (path, container) =>
      join(input.workDir, `${basename(path).replace(/\.[^.]+$/, '')}.${container}`),
    runFfmpegFn: input.runFfmpegFn,
    log: input.log,
  });

describe('createExecuteRunner', () => {
  it('leaves plugins other than Execute alone', () => {
    const { workDir } = workspace();
    const runner = runnerFor({ workDir });
    const other = { ...executePlugin(), id: 'trawlarr:setVideoEncoder' } as LoadedPlugin;
    expect(runner(other)).toBeNull();
    expect(runner(executePlugin())).not.toBeNull();
  });

  it('runs ffmpeg when the command asks for work, and reports the new file', async () => {
    const { inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 0 });
    const module = runnerFor({ workDir, runFfmpegFn: ffmpeg.run })(executePlugin())!;

    const out = await module.plugin(argsFor({ inputPath, encodes: true }));

    expect(ffmpeg.calls).toHaveLength(1);
    // The compiled command really is the one the flow built.
    expect(ffmpeg.calls[0]!.args).toContain('libx265');
    expect(ffmpeg.calls[0]!.args.slice(0, 3)).toEqual(['-i', inputPath, '-map']);
    expect(out.outputNumber).toBe(1);
    // A NEW file, never the input, and it exists on disk.
    expect(out.outputFileObj._id).not.toBe(inputPath);
    expect(existsSync(out.outputFileObj._id)).toBe(true);
    // Execute closes the command; a further command needs a fresh Begin.
    expect(out.variables.ffmpegCommand.init).toBe(false);
  });

  it('skips ffmpeg entirely when the command changes nothing', async () => {
    const { inputPath, workDir } = workspace();
    // This is the regression the skip exists for: with no skip, an untouched
    // command still compiles to a full remux of every file in a library.
    const ffmpeg = fakeRunner({ code: 0 });
    const logs: string[] = [];
    const module = runnerFor({
      workDir,
      runFfmpegFn: ffmpeg.run,
      log: (text) => logs.push(text),
    })(executePlugin())!;

    const out = await module.plugin(argsFor({ inputPath, encodes: false }));

    expect(ffmpeg.calls).toEqual([]);
    // Routes to the success output with the ORIGINAL path: nothing failed, and
    // nothing was produced for later nodes to pick up instead.
    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe(inputPath);
    expect(out.variables.ffmpegCommand.init).toBe(false);
    expect(logs.join('\n')).toMatch(/nothing to do/i);
    // Nor did it create the output file it would have written.
    expect(existsSync(join(workDir, 'source.mkv'))).toBe(false);
  });

  it('routes to the failure output and keeps the input when ffmpeg fails', async () => {
    const { inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 1 });
    const module = runnerFor({ workDir, runFfmpegFn: ffmpeg.run })(executePlugin())!;

    const out = await module.plugin(argsFor({ inputPath, encodes: true }));

    expect(ffmpeg.calls).toHaveLength(1);
    expect(out.outputNumber).toBe(2);
    expect(out.outputFileObj._id).toBe(inputPath);
    expect(existsSync(join(workDir, 'source.mkv'))).toBe(false);
  });
});
