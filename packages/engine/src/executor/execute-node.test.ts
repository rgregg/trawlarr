import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginDetails, PluginInputArgs, ProbeStream } from '@trawlarr/plugin-api';
import { beginFfmpegCommand, deriveShouldProcess } from '@trawlarr/core';
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
 * The real-world shape from the owner's library: video, audio, a genuine
 * 1251x1595 cover-art stream, and a degenerate 0x0 one that no muxer will
 * write.
 */
const degenerateCommand = (inputPath: string) => {
  const command = beginFfmpegCommand({
    probe: {
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
      ],
    },
    container: 'mkv',
    inputPath,
  });
  command.streams[0]!.outputArgs.push('-c:{outputIndex}', 'libx265');
  command.streams[0]!.forceEncoding = true;
  command.shouldProcess = true;
  return command;
};

/**
 * The other real-world shape: video, audio, an identified subtitle, and a
 * subtitle ffprobe described in full without naming a codec — the `-c:3 copy`
 * that made ffmpeg refuse the whole output.
 */
const codeclessCommand = (inputPath: string) => {
  const command = beginFfmpegCommand({
    probe: {
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        {
          index: 2,
          codec_type: 'subtitle',
          codec_name: 'subrip',
          codec_tag_string: '[0][0][0][0]',
        },
        {
          index: 3,
          codec_type: 'subtitle',
          codec_tag_string: '[0][0][0][0]',
        } as unknown as ProbeStream,
      ],
    },
    container: 'mkv',
    inputPath,
  });
  command.streams[0]!.outputArgs.push('-c:{outputIndex}', 'libx265');
  command.streams[0]!.forceEncoding = true;
  command.shouldProcess = true;
  return command;
};

/**
 * A command over one video and one audio stream. `encodes` decides whether any
 * work was asked for: with it false nothing has been touched, which is exactly
 * the "nothing to do" shape the runner must recognise.
 */
const SOURCE_STREAMS: ProbeStream[] = [
  { index: 0, codec_type: 'video', codec_name: 'h264' },
  { index: 1, codec_type: 'audio', codec_name: 'aac' },
];

const commandFor = (input: { inputPath: string; encodes: boolean }) => {
  const command = beginFfmpegCommand({
    probe: { streams: SOURCE_STREAMS.map((stream) => ({ ...stream })) },
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

const argsFor = (input: { inputPath: string; encodes: boolean }): PluginInputArgs => {
  // The no-op gate compares the command against the ORIGINAL library file's
  // own probe and container, so a fixture missing either would exercise the
  // "cannot verify, therefore run" branch instead of the one under test.
  const fileObject = {
    _id: input.inputPath,
    container: 'mkv',
    ffProbeData: {
      format: { duration: '2' },
      streams: SOURCE_STREAMS.map((stream) => ({ ...stream })),
    },
  };
  return {
    inputFileObj: fileObject,
    originalLibraryFile: fileObject,
    variables: {
      ffmpegCommand: commandFor(input),
      flowFailed: false,
      user: {},
    },
    inputs: {},
    jobLog: () => {},
    updateWorker: () => {},
  } as unknown as PluginInputArgs;
};

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
    expect(logs.join('\n')).toMatch(/skipping ffmpeg/i);
    // Nor did it create the output file it would have written.
    expect(existsSync(join(workDir, 'source.mkv'))).toBe(false);
  });

  it('skips a command that declares work but would change nothing about the file', async () => {
    // The 8.4 TB incident in miniature: a `Set Container` to the container the
    // file already has, plus a filter that matched nothing, leaves a command
    // that SAYS it needs processing (`deriveShouldProcess` is true) and
    // compiles to a byte-for-byte remux of 4,000 already-correct files.
    const { inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 0 });
    const logs: string[] = [];
    const module = runnerFor({
      workDir,
      runFfmpegFn: ffmpeg.run,
      log: (text) => logs.push(text),
    })(executePlugin())!;

    const args = argsFor({ inputPath, encodes: false });
    args.variables.ffmpegCommand.shouldProcess = true;
    expect(deriveShouldProcess(args.variables.ffmpegCommand)).toBe(true);

    const out = await module.plugin(args);

    expect(ffmpeg.calls).toEqual([]);
    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe(inputPath);
    expect(existsSync(join(workDir, 'source.mkv'))).toBe(false);
    // The operator has to be able to tell this skip from the "no plugin asked
    // for anything" one, because only this one means a node in their flow is
    // asking for work it does not do.
    expect(logs.join('\n')).toContain('set shouldProcess');
  });

  it('runs a container change even though every stream is copied', async () => {
    // The dangerous direction: `deriveShouldProcess` never looks at the
    // container, so this command reads as "no work" to it while the output is
    // a different file. Skipping here would mark an unconverted file
    // converged and stamp its signature, permanently.
    const { inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 0 });
    const module = runnerFor({ workDir, runFfmpegFn: ffmpeg.run })(executePlugin())!;

    const args = argsFor({ inputPath, encodes: false });
    args.variables.ffmpegCommand.container = 'mp4';
    expect(deriveShouldProcess(args.variables.ffmpegCommand)).toBe(false);

    const out = await module.plugin(args);

    expect(ffmpeg.calls).toHaveLength(1);
    // Every stream still copied — the change is the container alone.
    expect(ffmpeg.calls[0]!.args).toContain('-c');
    expect(ffmpeg.calls[0]!.args.at(-1)).toMatch(/\.mp4$/);
    expect(out.outputFileObj._id).toBe(join(workDir, 'source.mp4'));
  });

  it('runs when a stream was added, even though the added stream is only copied', async () => {
    // `Ensure Audio Stream` adding a redundant stereo downmix: the shape that
    // rewrote a whole library. The added track carries no encode of its own
    // here, so only the stream SET distinguishes the output from the input.
    const { inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 0 });
    const module = runnerFor({ workDir, runFfmpegFn: ffmpeg.run })(executePlugin())!;

    const args = argsFor({ inputPath, encodes: false });
    const command = args.variables.ffmpegCommand;
    command.streams.push({ ...command.streams[1]! });

    await module.plugin(args);

    expect(ffmpeg.calls).toHaveLength(1);
    const argv = ffmpeg.calls[0]!.args;
    expect(argv.filter((_, i) => argv[i - 1] === '-map')).toEqual(['0:0', '0:1', '0:1']);
  });

  it('runs when the host itself would drop a stream the file still has', async () => {
    // Nothing in the FLOW changed, but the compiler's unmappable-stream rule
    // would leave the degenerate cover art out — so the output really is a
    // different file, and the file really is worth rewriting.
    const { inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 0 });
    const module = runnerFor({ workDir, runFfmpegFn: ffmpeg.run })(executePlugin())!;

    const streams: ProbeStream[] = [
      ...SOURCE_STREAMS,
      { index: 2, codec_type: 'video', codec_name: 'mjpeg', width: 0, height: 0 },
    ];
    const args = argsFor({ inputPath, encodes: false });
    args.originalLibraryFile.ffProbeData.streams = streams;
    args.variables.ffmpegCommand = beginFfmpegCommand({
      probe: { streams },
      container: 'mkv',
      inputPath,
    });

    await module.plugin(args);

    expect(ffmpeg.calls).toHaveLength(1);
    const argv = ffmpeg.calls[0]!.args;
    expect(argv.filter((_, i) => argv[i - 1] === '-map')).toEqual(['0:0', '0:1']);
  });

  it('refuses to skip when it is not reading the original library file', async () => {
    // A second Begin/Execute pair runs against a path an earlier Execute
    // produced, while the file object's probe still describes the file the job
    // started with. Comparing the two could only produce a confident wrong
    // answer, so this branch runs.
    const { root, inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 0 });
    const module = runnerFor({ workDir, runFfmpegFn: ffmpeg.run })(executePlugin())!;

    const args = argsFor({ inputPath, encodes: false });
    const producedPath = join(root, 'earlier-output.mkv');
    writeFileSync(producedPath, 'produced by an earlier Execute', 'utf8');
    args.inputFileObj = { ...args.inputFileObj, _id: producedPath };
    args.variables.ffmpegCommand.inputFiles = [producedPath];

    await module.plugin(args);

    expect(ffmpeg.calls).toHaveLength(1);
  });

  it('leaves an unmappable stream out of the argv and says so where the operator can see it', async () => {
    const { inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 0 });
    const logs: string[] = [];
    const module = runnerFor({
      workDir,
      runFfmpegFn: ffmpeg.run,
      log: (text) => logs.push(text),
    })(executePlugin())!;

    const args = argsFor({ inputPath, encodes: true });
    args.variables.ffmpegCommand = degenerateCommand(inputPath);
    const out = await module.plugin(args);

    // The argv ffmpeg was actually handed: the 0x0 stream is absent and the
    // real poster is mapped and copied at its renumbered output position.
    const argv = ffmpeg.calls[0]!.args;
    expect(argv.filter((_, i) => argv[i - 1] === '-map')).toEqual(['0:0', '0:1', '0:7']);
    expect(argv.slice(argv.indexOf('0:7'))).toEqual(['0:7', '-c:2', 'copy', expect.any(String)]);
    expect(out.outputNumber).toBe(1);

    // Reported, not silent. This `log` seam is `args.jobLog`, which runFlow
    // also captures into the step's own log_excerpt, so a user whose file
    // lost a stream can find out from either the job log or the step trace.
    const log = logs.join('\n');
    expect(log).toContain('Dropped input stream 9 (mjpeg)');
    expect(log).toContain('dimensions 0x0');
  });

  it('leaves a codec-less stream out of the argv and names the codec in the log', async () => {
    const { inputPath, workDir } = workspace();
    const ffmpeg = fakeRunner({ code: 0 });
    const logs: string[] = [];
    const module = runnerFor({
      workDir,
      runFfmpegFn: ffmpeg.run,
      log: (text) => logs.push(text),
    })(executePlugin())!;

    const args = argsFor({ inputPath, encodes: true });
    args.variables.ffmpegCommand = codeclessCommand(inputPath);
    const out = await module.plugin(args);

    // The argv ffmpeg was actually handed: the stream it could not have
    // written is absent, and the identified subtitle is copied at its
    // renumbered output position.
    const argv = ffmpeg.calls[0]!.args;
    expect(argv.filter((_, i) => argv[i - 1] === '-map')).toEqual(['0:0', '0:1', '0:2']);
    expect(argv).not.toContain('0:3');
    expect(out.outputNumber).toBe(1);

    const log = logs.join('\n');
    expect(log).toContain('Dropped input stream 3');
    expect(log).toContain('no codec');
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
