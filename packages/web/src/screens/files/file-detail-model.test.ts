import { describe, expect, it } from 'vitest';
import { explainState, resolveFlowBinding, toStreamRows } from './file-detail-model.js';

describe('toStreamRows', () => {
  const probe = {
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'hevc',
        width: 1920,
        height: 1080,
        tags: { DURATION: '00:53:51.457000000' },
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
        channels: 2,
        tags: { language: 'eng', DURATION: '00:53:51.509000000' },
      },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'ita' } },
    ],
  };

  it('reads the duration from the DURATION tag, which is where mkv keeps it', () => {
    const rows = toStreamRows(probe);
    expect(rows[0]!.duration).toBe('00:53:51');
    expect(rows[0]!.detail).toBe('1080p');
  });

  it('describes audio by channel count and language', () => {
    const rows = toStreamRows(probe);
    expect(rows[1]!.detail).toBe('2ch');
    expect(rows[1]!.language).toBe('eng');
  });

  it('says und for a stream with no language rather than leaving it blank', () => {
    expect(toStreamRows(probe)[0]!.language).toBe('und');
  });

  it('returns nothing for a probe that could not be parsed', () => {
    expect(toStreamRows(null)).toEqual([]);
    expect(toStreamRows({ streams: 'nonsense' })).toEqual([]);
  });
});

describe('explainState', () => {
  const base = {
    signature: 'abc',
    attemptCount: 0,
    lastJobReason: null,
    holdUntilMs: null,
    nowMs: 1_000,
  };

  it('explains a converged file by its signature, not by silence', () => {
    expect(explainState({ ...base, state: 'good' })).toBe(
      'Converged. Its signature matches the flow this library uses, so there is nothing to do.',
    );
  });

  it('says why a queued file is queued when the flow moved underneath it', () => {
    expect(explainState({ ...base, state: 'queued', signature: null })).toBe(
      'Queued. It has no signature for the current flow — it has never run, or the flow changed.',
    );
  });

  it('leads with the failure reason, because that is the whole question', () => {
    expect(
      explainState({
        ...base,
        state: 'failed',
        attemptCount: 3,
        lastJobReason: 'the output ran 1.2s shorter than the original',
      }),
    ).toBe(
      'Failed after 3 attempts: the output ran 1.2s shorter than the original. It will not retry on its own.',
    );
  });

  it('says when a held file will come back', () => {
    expect(explainState({ ...base, state: 'held', holdUntilMs: 61_000, nowMs: 1_000 })).toBe(
      'Held after a failed attempt. It will be retried in 1m.',
    );
  });

  it('says why a queued file with a signature is queued — the flow moved, not the file', () => {
    expect(explainState({ ...base, state: 'queued', signature: 'abc' })).toBe(
      'Queued. Its signature no longer matches the flow this library uses.',
    );
  });

  it('states a failure with no recorded reason without trailing a colon into nothing', () => {
    expect(explainState({ ...base, state: 'failed', attemptCount: 3, lastJobReason: null })).toBe(
      'Failed after 3 attempts. It will not retry on its own.',
    );
  });

  it('says a held file with no deadline will be retried, without inventing a time', () => {
    expect(explainState({ ...base, state: 'held', holdUntilMs: null })).toBe(
      'Held after a failed attempt. It will be retried.',
    );
  });

  it('does not promise a retry in 1m for a hold that expired an hour ago', () => {
    // `Math.max(1, minutes)` used to floor an ELAPSED hold at "1m", turning a
    // fact about the past into a promise about the future that never came
    // true — a file sitting held with an expired deadline is a file nothing
    // is picking up, which is the opposite of what that sentence said.
    expect(explainState({ ...base, state: 'held', holdUntilMs: 1_000, nowMs: 3_600_000 })).toBe(
      'Held after a failed attempt. Its hold has already expired, so it is claimable now — if it stays here, nothing is picking it up.',
    );
  });

  it('explains not_converging as set aside, not as a failure', () => {
    expect(explainState({ ...base, state: 'not_converging' })).toBe(
      'Not converging. The flow ran without changing it enough to converge, so it has been set aside.',
    );
  });

  it('names a state it does not know rather than rendering an empty paragraph', () => {
    expect(explainState({ ...base, state: 'quarantined' })).toBe('State quarantined.');
  });

  it('says a running file is being worked on, rather than falling into the generic default', () => {
    expect(explainState({ ...base, state: 'running' })).toBe(
      'Running now. A worker has claimed it and is partway through the flow.',
    );
  });

  it('says an unknown file has never been evaluated, rather than falling into the generic default', () => {
    expect(explainState({ ...base, state: 'unknown' })).toBe(
      'Unknown. This file has not been evaluated against a flow yet.',
    );
  });
});

describe('resolveFlowBinding', () => {
  it("uses the library's CURRENT binding, never the job's frozen one", () => {
    // The production bug: a job row records the flow it ran under at
    // `start()` and is never updated, so reading it as "the flow now"
    // mis-targeted a dry run after a library was re-pointed at a different
    // flow — the binding had moved, the job row had not.
    expect(
      resolveFlowBinding({
        libraryFlowId: 'flow-now',
        libraryLookupFailed: false,
        lastJobFlowId: 'flow-then',
      }),
    ).toEqual({ flowId: 'flow-now', fromLastJob: false, warning: null });
  });

  it('states a FACT when the library has no flow bound', () => {
    expect(
      resolveFlowBinding({
        libraryFlowId: null,
        libraryLookupFailed: false,
        lastJobFlowId: 'flow-then',
      }),
    ).toEqual({ flowId: 'flow-then', fromLastJob: true, warning: 'library-has-no-flow' });
  });

  it('admits an UNKNOWN when the lookup that would have told us failed', () => {
    // Same null, different meaning. The two must never share a sentence:
    // one says what IS true, the other says what could not be checked.
    expect(
      resolveFlowBinding({
        libraryFlowId: null,
        libraryLookupFailed: true,
        lastJobFlowId: 'flow-then',
      }),
    ).toEqual({ flowId: 'flow-then', fromLastJob: true, warning: 'library-lookup-failed' });
  });

  it('has nothing to replay, and nothing to warn about, with no binding and no history', () => {
    expect(
      resolveFlowBinding({ libraryFlowId: null, libraryLookupFailed: false, lastJobFlowId: null }),
    ).toEqual({ flowId: null, fromLastJob: false, warning: null });
    expect(
      resolveFlowBinding({ libraryFlowId: null, libraryLookupFailed: true, lastJobFlowId: null }),
    ).toEqual({ flowId: null, fromLastJob: false, warning: null });
  });
});
