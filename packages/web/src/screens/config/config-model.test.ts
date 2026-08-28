import { describe, expect, it } from 'vitest';
import {
  formatWindow,
  parseWindow,
  parseWorkerCount,
  summarizePurge,
  type PurgeSweep,
} from './config-model.js';

describe('parseWorkerCount', () => {
  it('accepts zero, which is how work is stopped', () => {
    expect(parseWorkerCount('0')).toEqual({ ok: true, value: 0 });
  });

  it('refuses a negative or fractional count', () => {
    expect(parseWorkerCount('-1').ok).toBe(false);
    expect(parseWorkerCount('1.5').ok).toBe(false);
  });

  it('refuses text', () => {
    expect(parseWorkerCount('lots')).toEqual({
      ok: false,
      message: 'Enter a whole number of workers.',
    });
  });
});

describe('parseWindow', () => {
  it('reads HH:MM as minutes past midnight', () => {
    expect(parseWindow('02:30')).toEqual({ ok: true, minutes: 150 });
    expect(parseWindow('00:00')).toEqual({ ok: true, minutes: 0 });
  });

  it('refuses an impossible clock time', () => {
    expect(parseWindow('25:00').ok).toBe(false);
    expect(parseWindow('02:60').ok).toBe(false);
  });

  it('round-trips through formatWindow', () => {
    expect(formatWindow(150)).toBe('02:30');
    expect(formatWindow(0)).toBe('00:00');
  });
});

describe('summarizePurge', () => {
  const sweep = (patch: Partial<PurgeSweep> = {}): PurgeSweep => ({
    libraryId: 'lib-1',
    libraryName: 'Movies',
    retentionDays: 14,
    dryRun: true,
    summary: {
      dirsSwept: 1,
      dirsMissing: 0,
      dirsRefused: 0,
      removed: 3,
      bytesFreed: 1_000,
      retained: 1,
      skipped: 0,
      failed: 0,
    },
    ...patch,
  });

  it('sums removed files and bytes freed across every library swept', () => {
    expect(
      summarizePurge([
        sweep({ summary: { ...sweep().summary, removed: 3, bytesFreed: 1_000 } }),
        sweep({
          libraryId: 'lib-2',
          summary: { ...sweep().summary, removed: 2, bytesFreed: 500 },
        }),
      ]),
    ).toEqual({ files: 5, bytes: 1_500, failed: 0 });
  });

  it('reports files this run could not remove, so a partial purge is never silent', () => {
    expect(summarizePurge([sweep({ summary: { ...sweep().summary, failed: 2 } })])).toEqual({
      files: 3,
      bytes: 1_000,
      failed: 2,
    });
  });

  it('is zero for an empty sweep list', () => {
    expect(summarizePurge([])).toEqual({ files: 0, bytes: 0, failed: 0 });
  });
});
