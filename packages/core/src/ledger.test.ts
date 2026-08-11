import { describe, expect, it } from 'vitest';
import { extractFacts, type FactSet } from './facts.js';
import {
  BACKOFF_MINUTES,
  MAX_ATTEMPTS,
  NOOP_LIMIT,
  applyRequeue,
  applyRunOutcome,
  applyStall,
  isEligible,
  isKnownGood,
  newLedgerRecord,
  type LedgerRecord,
} from './ledger.js';

const NOW = 1_700_000_000_000;
const SIG = 'sig-current';

const factsFor = (codec: string, size = 1000): FactSet =>
  extractFacts({
    probe: { format: { duration: '60' }, streams: [{ codec_type: 'video', codec_name: codec }] },
    container: 'mkv',
    sizeBytes: size,
  });

const h264 = factsFor('h264');
const hevc = factsFor('hevc', 400);

const record = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  ...newLedgerRecord(),
  ...over,
});

describe('isKnownGood', () => {
  it('is false for a file that has never run', () => {
    expect(isKnownGood(newLedgerRecord(), SIG)).toBe(false);
  });

  it('is true when the stored signature matches and the state is good', () => {
    expect(isKnownGood(record({ state: 'good', signature: SIG }), SIG)).toBe(true);
  });

  it('is false when the signature differs — a flow edit invalidates it', () => {
    expect(isKnownGood(record({ state: 'good', signature: 'sig-old' }), SIG)).toBe(false);
  });

  it('is false when a matching signature is attached to a non-good state', () => {
    expect(isKnownGood(record({ state: 'failed', signature: SIG }), SIG)).toBe(false);
  });
});

describe('applyRunOutcome — success', () => {
  it('marks a file good and stores the signature', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: true, claimedModified: true, preFacts: h264, postFacts: hevc },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.state).toBe('good');
    expect(next.signature).toBe(SIG);
    expect(next.attemptCount).toBe(0);
    expect(next.consecutiveNoopCount).toBe(0);
  });

  it('is good with no noop counted when the flow decided no work was needed', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: true, claimedModified: false, preFacts: h264, postFacts: null },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.state).toBe('good');
    expect(next.consecutiveNoopCount).toBe(0);
  });
});

describe('applyRunOutcome — convergence detection', () => {
  const noopRun = {
    success: true,
    claimedModified: true,
    preFacts: h264,
    postFacts: factsFor('h264'),
  };

  it(`gives up after ${NOOP_LIMIT} no-op run (one strike)`, () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: noopRun,
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.consecutiveNoopCount).toBe(NOOP_LIMIT);
    expect(next.state).toBe('not_converging');
  });

  it('still stores the current signature on a no-op run, so a later flow edit re-queues the file', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: noopRun,
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.signature).toBe(SIG);
    expect(isKnownGood(next, SIG)).toBe(false);
  });

  it('does not flag a run that actually changes the file', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: true, claimedModified: true, preFacts: h264, postFacts: hevc },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.consecutiveNoopCount).toBe(0);
    expect(next.state).toBe('good');
  });

  it('counts a missing post-run probe as a no-op when work was claimed', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: true, claimedModified: true, preFacts: h264, postFacts: null },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.consecutiveNoopCount).toBe(1);
    expect(next.state).toBe('not_converging');
  });

  it('does NOT flag a metadata-only change: same codecs/streams/container/duration but a different exact byte size', () => {
    // A tolerant comparison (factsEquivalent) would call this "no change" because the
    // size drift here is well under the 1% tolerance — but the size genuinely differs,
    // which is exactly the kind of legitimate metadata-only edit (e.g. mkvpropedit
    // retagging) that must NOT be flagged as non-converging.
    const before = factsFor('h264', 1000);
    const after = factsFor('h264', 1005);
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: true, claimedModified: true, preFacts: before, postFacts: after },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.state).toBe('good');
    expect(next.consecutiveNoopCount).toBe(0);
  });
});

describe('applyRunOutcome — failure and backoff', () => {
  it('holds with backoff on the first failure', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: false, claimedModified: false, preFacts: h264, postFacts: null },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.state).toBe('held');
    expect(next.attemptCount).toBe(1);
    expect(next.holdUntilMs).toBe(NOW + BACKOFF_MINUTES[0] * 60_000);
  });

  it('uses escalating backoff per attempt', () => {
    let current = record({ state: 'running' });
    const seen: Array<number | null> = [];
    for (let i = 0; i < 3; i += 1) {
      current = applyRunOutcome({
        record: { ...current, state: 'running' },
        outcome: { success: false, claimedModified: false, preFacts: h264, postFacts: null },
        currentSignature: SIG,
        nowMs: NOW,
      });
      seen.push(current.holdUntilMs);
    }
    expect(seen[0]).toBe(NOW + 5 * 60_000);
    expect(seen[1]).toBe(NOW + 25 * 60_000);
    expect(current.state).toBe('failed');
    expect(current.attemptCount).toBe(MAX_ATTEMPTS);
  });

  it('does not store a signature for a failed run', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: false, claimedModified: false, preFacts: h264, postFacts: null },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.signature).toBeNull();
  });
});

describe('applyStall', () => {
  it('treats a stall exactly like a failed attempt', () => {
    const next = applyStall({ record: record({ state: 'running' }), nowMs: NOW });
    expect(next.state).toBe('held');
    expect(next.attemptCount).toBe(1);
    expect(next.holdUntilMs).toBe(NOW + BACKOFF_MINUTES[0] * 60_000);
  });

  it('fails the file once attempts are exhausted', () => {
    const next = applyStall({
      record: record({ state: 'running', attemptCount: MAX_ATTEMPTS - 1 }),
      nowMs: NOW,
    });
    expect(next.state).toBe('failed');
  });
});

describe('applyRequeue', () => {
  it('clears both counters and returns the file to the queue', () => {
    const next = applyRequeue(
      record({
        state: 'not_converging',
        attemptCount: 3,
        consecutiveNoopCount: 2,
        holdUntilMs: NOW,
      }),
    );
    expect(next).toMatchObject({
      state: 'queued',
      attemptCount: 0,
      consecutiveNoopCount: 0,
      holdUntilMs: null,
    });
  });

  it('recovers a failed file too', () => {
    expect(applyRequeue(record({ state: 'failed', attemptCount: 3 })).state).toBe('queued');
  });
});

describe('isEligible', () => {
  it('allows a queued file with no hold', () => {
    expect(isEligible(record({ state: 'queued' }), NOW)).toBe(true);
  });

  it('blocks a held file until its hold expires', () => {
    const held = record({ state: 'held', holdUntilMs: NOW + 1000 });
    expect(isEligible(held, NOW)).toBe(false);
    expect(isEligible(held, NOW + 1001)).toBe(true);
  });

  it('never re-runs a terminal file automatically', () => {
    expect(isEligible(record({ state: 'failed' }), NOW)).toBe(false);
    expect(isEligible(record({ state: 'not_converging' }), NOW)).toBe(false);
    expect(isEligible(record({ state: 'good', signature: SIG }), NOW)).toBe(false);
  });
});
