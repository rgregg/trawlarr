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
  it('uses the persisted review reason and keeps manual holds apart from retry failures', () => {
    const groups = groupProblems({
      files: [
        { ...file('review', 'held', 100), reviewReason: 'Inspect quality.' },
        file('retry', 'held', 200),
      ],
      reasons: { review: 'A stale failed job.', retry: 'Inspect quality.' },
    });
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.title === 'Held for review')).toMatchObject({
      reason: 'Inspect quality.',
      files: [expect.objectContaining({ id: 'review' })],
    });
  });

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

  it('keeps two states apart even when they report the exact same reason', () => {
    // The STATE half of the grouping key, which nothing else exercises. It
    // is the guard rail the `normaliseReason` over-collapse ruling leans on:
    // "exit code 1" and "exit code 137" may merge, but only ever WITHIN one
    // state, so a held file and a failed file never become one problem card
    // — they need different things from the operator.
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'held', 200)],
      reasons: { a: 'exit code 1', b: 'exit code 1' },
    });
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.title).sort()).toEqual([
      'Failed',
      'Held after a failed attempt',
    ]);
  });

  it('titles each group by what the state means, not by the state name', () => {
    const title = (state: string): string =>
      groupProblems({ files: [file('a', state, 1)], reasons: { a: 'boom' } })[0]!.title;
    expect(title('failed')).toBe('Failed');
    expect(title('held')).toBe('Held after a failed attempt');
    expect(title('not_converging')).toBe('Not converging');
    // A state this screen was not written for still gets a usable heading
    // rather than a blank one.
    expect(title('quarantined')).toBe('Needs attention');
  });

  it('flags a group whose members do not all share the exact same raw reason', () => {
    // "exit code 1" and "exit code 137" both normalise to "exit code N" and
    // land in one group — a real over-collapse `normaliseReason`'s doc
    // comment names — so the group must say its members disagree even
    // though it can only show one of their sentences verbatim.
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200)],
      reasons: { a: 'exit code 1', b: 'exit code 137' },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reasonsDiffer).toBe(true);
  });

  it('leaves reasonsDiffer false when every member shares the exact same reason', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200)],
      reasons: { a: 'exit code 1', b: 'exit code 1' },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reasonsDiffer).toBe(false);
  });
});
