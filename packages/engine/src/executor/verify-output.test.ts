import { describe, expect, it } from 'vitest';
import type { PluginDetails, PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { createVerifyOutputRunner, verifyOutput } from './verify-output.js';
import type { LoadedPlugin } from '../host/loader.js';

const GIGABYTE = 1_000 * 1_000 * 1_000;

/** A probe with `count` streams and a duration, which is all the checks read. */
const probeOf = (input: { streams: number; durationSeconds: number }): ProbeData => ({
  streams: Array.from({ length: input.streams }, (_unused, index) => ({
    index,
    codec_type: index === 0 ? 'video' : 'audio',
    codec_name: index === 0 ? 'hevc' : 'aac',
  })),
  format: { duration: String(input.durationSeconds) },
});

const details = (): PluginDetails => ({
  name: 'Verify Output',
  description: 'fixture',
  style: { borderColor: '#33aa66' },
  tags: 'safety,verify',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 5,
  icon: 'faShieldHalved',
  inputs: [],
  outputs: [
    { number: 1, tooltip: 'verified' },
    { number: 2, tooltip: 'failed' },
  ],
  requiresVersion: '1.0.0',
});

/**
 * The declared behaviour of Verify Output throws on purpose, so a runner that
 * failed to substitute itself must not be able to pass these tests quietly.
 */
const verifyPlugin = (): LoadedPlugin =>
  ({
    id: 'trawlarr:verifyOutput',
    absPath: 'builtin:trawlarr:verifyOutput',
    version: '1.0.0',
    details: details(),
    module: {
      details,
      plugin: () => {
        throw new Error('the declared Verify Output behaviour must not run');
      },
    },
  }) as unknown as LoadedPlugin;

const argsFor = (input: {
  outputPath: string;
  originalPath: string;
  jobLog: (text: string) => void;
}): PluginInputArgs =>
  ({
    inputFileObj: { _id: input.outputPath },
    originalLibraryFile: { _id: input.originalPath },
    inputs: { durationToleranceSeconds: '1', minSizeRatio: '0.05' },
    variables: { ffmpegCommand: { init: false }, flowFailed: false, user: {} },
    jobLog: input.jobLog,
    updateWorker: () => {},
  }) as unknown as PluginInputArgs;

describe('verifyOutput', () => {
  it('passes a sound output with a matching duration and a sane size', () => {
    const report = verifyOutput({
      probe: probeOf({ streams: 2, durationSeconds: 3600 }),
      originalProbe: probeOf({ streams: 2, durationSeconds: 3600 }),
      outputSizeBytes: 4 * GIGABYTE,
      originalSizeBytes: 8 * GIGABYTE,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
    });

    expect(report).toEqual({ ok: true, reasons: [] });
  });

  it('fails an output that is shorter than the original beyond tolerance', () => {
    const report = verifyOutput({
      probe: probeOf({ streams: 2, durationSeconds: 1200 }),
      originalProbe: probeOf({ streams: 2, durationSeconds: 3600 }),
      outputSizeBytes: 4 * GIGABYTE,
      originalSizeBytes: 8 * GIGABYTE,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
    });

    expect(report.ok).toBe(false);
    // The reason has to name both durations: "it failed" is not actionable.
    expect(report.reasons).toHaveLength(1);
    expect(report.reasons[0]).toContain('1200.0s');
    expect(report.reasons[0]).toContain('3600.0s');
    expect(report.reasons[0]).toContain('2400.0s');
  });

  it('accepts a duration difference inside the tolerance', () => {
    const report = verifyOutput({
      probe: probeOf({ streams: 2, durationSeconds: 3599.5 }),
      originalProbe: probeOf({ streams: 2, durationSeconds: 3600 }),
      outputSizeBytes: 4 * GIGABYTE,
      originalSizeBytes: 8 * GIGABYTE,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
    });

    expect(report).toEqual({ ok: true, reasons: [] });
  });

  it('fails a 40 GB original that came back as a 200 MB output', () => {
    const report = verifyOutput({
      probe: probeOf({ streams: 2, durationSeconds: 3600 }),
      originalProbe: probeOf({ streams: 2, durationSeconds: 3600 }),
      outputSizeBytes: 200 * 1_000 * 1_000,
      originalSizeBytes: 40 * GIGABYTE,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
    });

    expect(report.ok).toBe(false);
    expect(report.reasons).toHaveLength(1);
    expect(report.reasons[0]).toContain('size');
    expect(report.reasons[0]).toContain('0.5%');
  });

  it('accepts an output LARGER than the original', () => {
    // A remux or a higher-quality encode legitimately grows the file, and
    // refusing it would refuse the work the user asked for.
    const report = verifyOutput({
      probe: probeOf({ streams: 2, durationSeconds: 3600 }),
      originalProbe: probeOf({ streams: 2, durationSeconds: 3600 }),
      outputSizeBytes: 30 * GIGABYTE,
      originalSizeBytes: 8 * GIGABYTE,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
    });

    expect(report).toEqual({ ok: true, reasons: [] });
  });

  it('fails an output that dropped a stream the original had', () => {
    const report = verifyOutput({
      probe: probeOf({ streams: 2, durationSeconds: 3600 }),
      originalProbe: probeOf({ streams: 4, durationSeconds: 3600 }),
      outputSizeBytes: 4 * GIGABYTE,
      originalSizeBytes: 8 * GIGABYTE,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
    });

    expect(report.ok).toBe(false);
    expect(report.reasons).toHaveLength(1);
    expect(report.reasons[0]).toContain('streams');
    expect(report.reasons[0]).toContain('4');
  });

  it('reports every problem at once, not just the first', () => {
    // Fixing one problem and rediscovering the next on the following run is a
    // bad experience, so all three reasons must come back together.
    const report = verifyOutput({
      probe: probeOf({ streams: 1, durationSeconds: 60 }),
      originalProbe: probeOf({ streams: 4, durationSeconds: 3600 }),
      outputSizeBytes: 100 * 1_000 * 1_000,
      originalSizeBytes: 40 * GIGABYTE,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
    });

    expect(report.ok).toBe(false);
    expect(report.reasons).toHaveLength(3);
    expect(report.reasons.some((reason) => reason.includes('streams'))).toBe(true);
    expect(report.reasons.some((reason) => reason.includes('60.0s'))).toBe(true);
    expect(report.reasons.some((reason) => reason.includes('size'))).toBe(true);
  });

  it('fails an output ffprobe could not read at all', () => {
    const report = verifyOutput({
      probe: { streams: [], format: {} },
      originalProbe: probeOf({ streams: 2, durationSeconds: 3600 }),
      outputSizeBytes: 4 * GIGABYTE,
      originalSizeBytes: 8 * GIGABYTE,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
    });

    expect(report.ok).toBe(false);
    // Nothing else is meaningful once the file is unreadable: one reason only.
    expect(report.reasons).toHaveLength(1);
    expect(report.reasons[0]).toContain('ffprobe');
  });
});

describe('createVerifyOutputRunner', () => {
  const runnerFor = (input: {
    probes: Record<string, ProbeData>;
    sizes: Record<string, number>;
    log?: (text: string) => void;
  }) =>
    createVerifyOutputRunner({
      probeFile: async (path) => {
        const probe = input.probes[path];
        if (probe === undefined) throw new Error(`no such file: ${path}`);
        return probe;
      },
      statFile: async (path) => {
        const size = input.sizes[path];
        if (size === undefined) throw new Error(`no such file: ${path}`);
        return { size, nlink: 1 };
      },
      log: input.log,
    });

  it('leaves plugins other than Verify Output alone', () => {
    const runner = runnerFor({ probes: {}, sizes: {} });
    const other = { ...verifyPlugin(), id: 'trawlarr:replaceOriginal' } as LoadedPlugin;

    expect(runner(other)).toBeNull();
    expect(runner(verifyPlugin())).not.toBeNull();
  });

  it('routes a good output to output 1', async () => {
    const module = runnerFor({
      probes: {
        '/work/movie.mkv': probeOf({ streams: 2, durationSeconds: 3600 }),
        '/library/movie.mkv': probeOf({ streams: 2, durationSeconds: 3600 }),
      },
      sizes: { '/work/movie.mkv': 4 * GIGABYTE, '/library/movie.mkv': 8 * GIGABYTE },
    })(verifyPlugin())!;

    const out = await module.plugin(
      argsFor({
        outputPath: '/work/movie.mkv',
        originalPath: '/library/movie.mkv',
        jobLog: () => {},
      }),
    );

    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe('/work/movie.mkv');
  });

  it('routes a bad output to output 2 without throwing, and logs why', async () => {
    const logged: string[] = [];
    const module = runnerFor({
      probes: {
        '/work/movie.mkv': probeOf({ streams: 1, durationSeconds: 12 }),
        '/library/movie.mkv': probeOf({ streams: 2, durationSeconds: 3600 }),
      },
      sizes: { '/work/movie.mkv': 1_000_000, '/library/movie.mkv': 40 * GIGABYTE },
    })(verifyPlugin())!;

    const out = await module.plugin(
      argsFor({
        outputPath: '/work/movie.mkv',
        originalPath: '/library/movie.mkv',
        jobLog: (text) => logged.push(text),
      }),
    );

    // Routed, not thrown: a failed verification is a flow decision, and the
    // node downstream of output 2 is how a user handles it.
    expect(out.outputNumber).toBe(2);
    const log = logged.join('\n');
    expect(log).toContain('streams');
    expect(log).toContain('12.0s');
    expect(log).toContain('size');
  });

  it('routes to output 2 when the output cannot be probed at all', async () => {
    const logged: string[] = [];
    const module = runnerFor({
      probes: { '/library/movie.mkv': probeOf({ streams: 2, durationSeconds: 3600 }) },
      sizes: { '/library/movie.mkv': 8 * GIGABYTE },
    })(verifyPlugin())!;

    const out = await module.plugin(
      argsFor({
        outputPath: '/work/missing.mkv',
        originalPath: '/library/movie.mkv',
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    expect(logged.join('\n')).toContain('/work/missing.mkv');
  });

  it('honours the node inputs rather than hard-coded thresholds', async () => {
    const module = runnerFor({
      probes: {
        '/work/movie.mkv': probeOf({ streams: 2, durationSeconds: 3590 }),
        '/library/movie.mkv': probeOf({ streams: 2, durationSeconds: 3600 }),
      },
      sizes: { '/work/movie.mkv': 4 * GIGABYTE, '/library/movie.mkv': 8 * GIGABYTE },
    })(verifyPlugin())!;

    const strict = argsFor({
      outputPath: '/work/movie.mkv',
      originalPath: '/library/movie.mkv',
      jobLog: () => {},
    });
    strict.inputs = { durationToleranceSeconds: '1', minSizeRatio: '0.05' };
    const lenient = argsFor({
      outputPath: '/work/movie.mkv',
      originalPath: '/library/movie.mkv',
      jobLog: () => {},
    });
    lenient.inputs = { durationToleranceSeconds: '30', minSizeRatio: '0.05' };

    expect((await module.plugin(strict)).outputNumber).toBe(2);
    expect((await module.plugin(lenient)).outputNumber).toBe(1);
  });
});
