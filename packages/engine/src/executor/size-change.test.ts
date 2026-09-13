import { mkdtempSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginDetails, PluginInputArgs } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';
import {
  createCheckSizeChangeRunner,
  decideSizeChange,
  maxSizePercentFrom,
  SIZE_CHANGE_SLACK_BYTES,
} from './size-change.js';

const within = (newSizeBytes: number, originalSizeBytes: number, maxPercent = 101) =>
  decideSizeChange({ newSizeBytes, originalSizeBytes, maxPercent }).withinLimit;

describe('decideSizeChange at the default 101%', () => {
  it('accepts anything that shrank, which is the ordinary case', () => {
    expect(within(1, 1_000_000_000)).toBe(true);
    expect(within(883_853_072, 1_823_927_056)).toBe(true);
  });

  it('accepts a file that came out exactly the same size', () => {
    expect(within(1_000_000_000, 1_000_000_000)).toBe(true);
  });

  it('rejects the incident the limit exists for: 884 MB in, 1.82 GB out', () => {
    const result = decideSizeChange({
      newSizeBytes: 1_823_927_056,
      originalSizeBytes: 883_853_072,
      maxPercent: 101,
    });
    expect(result.withinLimit).toBe(false);
    expect(result.grewByBytes).toBe(940_073_984);
    expect(result.ratio).toBeCloseTo(2.06, 2);
  });

  it('lets a small file grow by container overhead, which a percentage alone would reject', () => {
    // A measured mkv -> mp4 remux of a 2-second fixture: 50,773 bytes in,
    // 51,430 out. 1.3% larger, and a flow doing exactly what it was asked.
    expect(within(51_430, 50_773)).toBe(true);
    const small = 1_000_000;
    expect(within(small + SIZE_CHANGE_SLACK_BYTES, small)).toBe(true);
    expect(within(small + SIZE_CHANGE_SLACK_BYTES + 1, small)).toBe(false);
  });

  it('treats the percentage as the most a large file may grow by', () => {
    const original = 1_000_000_000;
    expect(within(original * 1.01, original)).toBe(true);
    expect(within(original * 1.01 + 1, original)).toBe(false);
  });
});

describe('decideSizeChange at other limits', () => {
  it('admits up to 10% growth at 110%, as a flow adding a stereo track may need', () => {
    // Glass Onion: 2.97 GB, plus a ~203 MB stereo AAC track.
    expect(within(2_970_000_000 + 203_000_000, 2_970_000_000, 110)).toBe(true);
    expect(within(2_970_000_000 * 1.11, 2_970_000_000, 110)).toBe(false);
  });

  it('demands a real saving below 100%, with no small-file allowance to undo it', () => {
    // The allowance exists for container overhead on a file that is meant to
    // come out the same size or bigger; under a limit that asks for a saving
    // it would admit exactly the non-saving the limit forbids.
    expect(within(900_000, 1_000_000, 90)).toBe(true);
    expect(within(950_000, 1_000_000, 90)).toBe(false);
    expect(within(1_000_000, 1_000_000, 90)).toBe(false);
  });

  it('has no basis for a judgement when the original is empty, and does not pretend to', () => {
    expect(within(1_000_000_000, 0)).toBe(true);
  });
});

describe('maxSizePercentFrom', () => {
  it('defaults an unset input to 101, the allowance the built-in check used to give', () => {
    expect(maxSizePercentFrom(undefined)).toBe(101);
    expect(maxSizePercentFrom('')).toBe(101);
  });

  it('reads a stored string and a number alike, decimals included', () => {
    expect(maxSizePercentFrom('110')).toBe(110);
    expect(maxSizePercentFrom(97.5)).toBe(97.5);
  });

  it.each(['0', '-5', 'abc', '1001'])('refuses %s', (value) => {
    expect(() => maxSizePercentFrom(value)).toThrow(/Maximum size/);
  });
});

describe('createCheckSizeChangeRunner', () => {
  const plugin = (id = 'trawlarr:checkSizeChange'): LoadedPlugin =>
    ({ id, details: { name: 'Check Size Change' } as PluginDetails }) as LoadedPlugin;

  const space = (originalBytes: number, newBytes: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'trawlarr-size-'));
    const original = join(dir, 'original.mkv');
    const output = join(dir, 'output.mkv');
    writeFileSync(original, Buffer.alloc(originalBytes));
    writeFileSync(output, Buffer.alloc(newBytes));
    return { original, output };
  };

  const argsFor = (paths: { original: string; output: string }, inputs = {}) => {
    const log: string[] = [];
    const args = {
      inputFileObj: { _id: paths.output },
      originalLibraryFile: { _id: paths.original },
      inputs,
      variables: { user: {} },
      jobLog: (text: string) => log.push(text),
    } as unknown as PluginInputArgs;
    return { args, log };
  };

  const runner = createCheckSizeChangeRunner({
    statFile: async (path) => {
      const stats = await stat(path);
      return { size: stats.size, nlink: stats.nlink };
    },
  });

  it('leaves plugins other than Check Size Change alone', () => {
    expect(runner(plugin('trawlarr:execute'))).toBeNull();
  });

  it('continues on output 1, with the file it was given, when the size is within the limit', async () => {
    // Measured from the files, not from `file_size`: that still describes
    // the pre-transcode file until Replace re-reads it.
    const paths = space(4_000_000, 3_000_000);
    const { args, log } = argsFor(paths);
    const out = await runner(plugin())!.plugin(args);
    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe(paths.output);
    expect(log.join('\n')).toMatch(/25\.0% smaller/);
  });

  it('routes to output 2 when the new file is larger than allowed', async () => {
    const paths = space(4_000_000, 6_000_000);
    const { args, log } = argsFor(paths);
    const out = await runner(plugin())!.plugin(args);
    expect(out.outputNumber).toBe(2);
    expect(log.join('\n')).toMatch(/50\.0% larger.*limit is 101%/);
  });

  it('uses the limit configured on the node', async () => {
    const paths = space(4_000_000, 4_300_000);
    const { args } = argsFor(paths, { maxSizePercent: '110' });
    expect((await runner(plugin())!.plugin(args)).outputNumber).toBe(1);
  });

  it('fails the step rather than guessing when a file cannot be read', async () => {
    const paths = space(4_000_000, 3_000_000);
    const { args } = argsFor({ original: paths.original, output: `${paths.output}.gone` });
    await expect(runner(plugin())!.plugin(args)).rejects.toThrow(/could not be read/);
  });
});
