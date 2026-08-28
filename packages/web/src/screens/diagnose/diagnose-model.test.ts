import { describe, expect, it } from 'vitest';
import { groupProblems, normaliseReason } from './diagnose-model.js';

const file = (id: string, state: string, sizeBytes: number) => ({
  id,
  libraryId: 'lib-1',
  path: `/library/shows/${id}.mkv`,
  state,
  videoCodec: 'hevc',
  audioCodec: 'aac',
  sizeBytes,
  updatedAt: 1,
});

describe('normaliseReason', () => {
  it('strips the numbers so one cause does not become three problems', () => {
    expect(
      normaliseReason("the output's container runs 3231.5s against the original's 3232.7s"),
    ).toBe("the output's container runs Ns against the original's Ns");
  });

  it('leaves a reason with no numbers untouched', () => {
    expect(normaliseReason('replacement was larger than the original')).toBe(
      'replacement was larger than the original',
    );
  });
});

describe('groupProblems', () => {
  it('makes three files failing for one reason ONE problem', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200), file('c', 'failed', 300)],
      reasons: {
        a: "the output's container runs 3231.5s against the original's 3232.7s",
        b: "the output's container runs 3263.2s against the original's 3265.2s",
        c: "the output's container runs 3519.6s against the original's 3521.9s",
      },
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.files).toHaveLength(3);
    expect(groups[0]!.totalBytes).toBe(600);
  });

  it('keeps genuinely different causes apart', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200)],
      reasons: { a: 'replacement was larger', b: 'could not read the file' },
    });
    expect(groups).toHaveLength(2);
  });

  it('puts the biggest problem first', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200), file('c', 'failed', 200)],
      reasons: { a: 'small problem', b: 'big problem', c: 'big problem' },
    });
    expect(groups[0]!.files).toHaveLength(2);
  });

  it('ignores converged files entirely', () => {
    const groups = groupProblems({
      files: [file('a', 'good', 100), file('b', 'good', 200)],
      reasons: {},
    });
    expect(groups).toEqual([]);
  });

  it('groups files with no recorded reason together rather than dropping them', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100)],
      reasons: {},
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reason).toBe('No reason was recorded for this failure.');
  });

  it('treats a fetched-but-empty reason the same as a missing one', () => {
    // `GET /jobs?fileId=` can answer with an outcome of `''` (or the lookup
    // for one file can simply fail and never populate `reasons` at all) —
    // both must land in the same "no reason recorded" bucket as a missing
    // key, never as their own group keyed on the empty string.
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200)],
      reasons: { a: '' },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.files).toHaveLength(2);
    expect(groups[0]!.reason).toBe('No reason was recorded for this failure.');
  });
});
