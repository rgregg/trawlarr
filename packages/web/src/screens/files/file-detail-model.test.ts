import { describe, expect, it } from 'vitest';
import { explainState, toStreamRows } from './file-detail-model.js';

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
