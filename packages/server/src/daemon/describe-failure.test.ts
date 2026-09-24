import { describe, expect, it } from 'vitest';
import { describeFailure } from './describe-failure.js';

describe('describeFailure', () => {
  it('keeps the message first, because that is what a reader scans for', () => {
    expect(describeFailure(new Error('something broke')).split('\n')[0]).toBe('something broke');
  });

  it('names the syscall, path and code of a filesystem failure', () => {
    // The incident this exists for: a scan died with
    // `ENOENT: ... lstat '<a library file>'` and the log carried the message
    // and nothing else — no frame, so the call site could not be identified
    // from outside, and the failure was too rare to catch in the act.
    const error: NodeJS.ErrnoException = Object.assign(
      new Error("ENOENT: no such file or directory, lstat '/library/shows/x.mkv'"),
      { code: 'ENOENT', errno: -2, syscall: 'lstat', path: '/library/shows/x.mkv' },
    );

    const described = describeFailure(error);

    expect(described).toContain('code=ENOENT');
    expect(described).toContain('syscall=lstat');
    expect(described).toContain('path=/library/shows/x.mkv');
  });

  it('includes the stack, which is the whole point', () => {
    const described = describeFailure(new Error('boom'));
    expect(described).toContain('describe-failure.test.ts');
  });

  it('omits the errno line entirely for an ordinary error', () => {
    expect(describeFailure(new Error('boom'))).not.toContain('code=');
  });

  it('survives something that is not an Error at all', () => {
    expect(describeFailure('just a string')).toBe('just a string');
    expect(describeFailure(undefined)).toBe('undefined');
  });

  it('reports the cause, which is where a wrapped filesystem error hides', () => {
    // `ProbeError` and friends wrap the real failure; without this the
    // original syscall is lost behind a friendlier sentence.
    const cause: NodeJS.ErrnoException = Object.assign(new Error('ENOENT: ... open'), {
      code: 'ENOENT',
      syscall: 'open',
    });
    const described = describeFailure(new Error('Cannot probe /x.mkv', { cause }));

    expect(described).toContain('caused by');
    expect(described).toContain('syscall=open');
  });

  it('does not recurse for ever on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(() => describeFailure(b)).not.toThrow();
  });
});
