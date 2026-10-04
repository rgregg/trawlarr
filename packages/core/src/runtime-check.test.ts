import { describe, expect, it } from 'vitest';
import {
  assessRuntime,
  DEFAULT_RUNTIME_THRESHOLD,
  parseMediaName,
  runtimeLookupDue,
  runtimeToleranceMs,
  RUNTIME_REFRESH_MS,
  RUNTIME_RETRY_MS,
} from './runtime-check.js';

const MIN = 60_000;
const t = DEFAULT_RUNTIME_THRESHOLD;

describe('runtimeToleranceMs', () => {
  it('uses 3 minutes for short titles and 5% for long ones', () => {
    expect(runtimeToleranceMs(22 * MIN, t)).toBe(3 * MIN);
    expect(runtimeToleranceMs(120 * MIN, t)).toBe(6 * MIN);
  });
});

describe('assessRuntime', () => {
  const base = { acceptedMs: null, threshold: t };

  it('does not flag a length within tolerance', () => {
    const a = assessRuntime({ ...base, actualMs: 118 * MIN, expectedMs: 120 * MIN });
    expect(a?.flagged).toBe(false);
  });

  it('flags a short file and reports a negative difference', () => {
    const a = assessRuntime({ ...base, actualMs: 90 * MIN, expectedMs: 120 * MIN });
    expect(a).toMatchObject({ flagged: true, diffMs: -30 * MIN, baselineMs: 120 * MIN });
  });

  it('flags a long file', () => {
    expect(assessRuntime({ ...base, actualMs: 140 * MIN, expectedMs: 120 * MIN })?.flagged).toBe(
      true,
    );
  });

  it('is not a mismatch when the expected runtime or the duration is unknown', () => {
    expect(assessRuntime({ ...base, actualMs: 90 * MIN, expectedMs: null })).toBeNull();
    expect(assessRuntime({ ...base, actualMs: null, expectedMs: 90 * MIN })).toBeNull();
    expect(assessRuntime({ ...base, actualMs: 90 * MIN, expectedMs: 0 })).toBeNull();
  });

  it('measures against the accepted length once one is set', () => {
    const input = { actualMs: 90 * MIN, expectedMs: 120 * MIN, threshold: t };
    expect(assessRuntime({ ...input, acceptedMs: 90 * MIN })?.flagged).toBe(false);
    // The length moved again: it reappears.
    expect(assessRuntime({ ...input, actualMs: 70 * MIN, acceptedMs: 90 * MIN })?.flagged).toBe(
      true,
    );
  });

  it('honours a per-library threshold', () => {
    const input = { actualMs: 110 * MIN, expectedMs: 120 * MIN, acceptedMs: null };
    expect(assessRuntime({ ...input, threshold: t })?.flagged).toBe(true);
    expect(assessRuntime({ ...input, threshold: { percent: 20, minutes: 3 } })?.flagged).toBe(
      false,
    );
  });
});

describe('runtimeLookupDue', () => {
  const nowMs = 10_000_000_000;
  it('is due when never checked', () => {
    expect(runtimeLookupDue({ checkedAtMs: null, expectedMs: null, nowMs })).toBe(true);
  });
  it('retries a miss sooner than it refreshes a hit', () => {
    const checkedAtMs = nowMs - RUNTIME_RETRY_MS;
    expect(runtimeLookupDue({ checkedAtMs, expectedMs: null, nowMs })).toBe(true);
    expect(runtimeLookupDue({ checkedAtMs, expectedMs: 5, nowMs })).toBe(false);
    expect(
      runtimeLookupDue({ checkedAtMs: nowMs - RUNTIME_REFRESH_MS, expectedMs: 5, nowMs }),
    ).toBe(true);
  });
});

describe('parseMediaName', () => {
  it('reads a movie title and year', () => {
    expect(
      parseMediaName('/m/Blade Runner 2049 (2017)/Blade.Runner.2049.2017.2160p.BluRay.mkv'),
    ).toEqual({ kind: 'movie', title: 'Blade Runner 2049', year: 2017 });
  });
  it('reads a movie with no year, stopping at quality tokens', () => {
    expect(parseMediaName('/m/Heat.1080p.WEB-DL.mkv')).toEqual({
      kind: 'movie',
      title: 'Heat',
      year: null,
    });
  });
  it('reads an episode', () => {
    expect(parseMediaName('/tv/Severance/Season 01/Severance.S01E03.In.Perpetuity.mkv')).toEqual({
      kind: 'episode',
      title: 'Severance',
      year: null,
      season: 1,
      episodes: [3],
    });
  });
  it('takes the series from the folder when the filename has none, and a year from it', () => {
    expect(parseMediaName('/tv/The Office (2005)/Season 2/S02E04 - Dwight.mkv')).toEqual({
      kind: 'episode',
      title: 'The Office',
      year: 2005,
      season: 2,
      episodes: [4],
    });
  });
  it('reads multi-episode files and the 1x02 spelling', () => {
    expect(parseMediaName('/tv/Show - S01E01-E02.mkv')).toMatchObject({ episodes: [1, 2] });
    expect(parseMediaName('/tv/Show - 2x05 - Name.mkv')).toMatchObject({
      season: 2,
      episodes: [5],
    });
  });
  it('does not read a resolution as an episode', () => {
    expect(parseMediaName('/m/Movie 2019 1920x1080.mkv')?.kind).toBe('movie');
  });
  it('gives up rather than guess', () => {
    expect(parseMediaName('/m/.mkv')).toBeNull();
  });
});
