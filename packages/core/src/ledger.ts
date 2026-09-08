import { factsHash, type FactSet } from './facts.js';

export type FileState =
  'unknown' | 'queued' | 'running' | 'good' | 'failed' | 'not_converging' | 'held';

export interface LedgerRecord {
  state: FileState;
  /** Signature recorded at the last successful run; null if never succeeded. */
  signature: string | null;
  attemptCount: number;
  consecutiveNoopCount: number;
  holdUntilMs: number | null;
  /** Non-null only for an indefinite hold requiring explicit requeue. */
  reviewReason?: string | null;
}

export interface RunOutcome {
  success: boolean;
  held?: boolean;
  reviewReason?: string | null;
  /** Whether the flow reports having modified the file. */
  claimedModified: boolean;
  preFacts: FactSet;
  /** Facts after the run; null when the file was not re-probed. */
  postFacts: FactSet | null;
}

export const MAX_ATTEMPTS = 3 as const;
export const BACKOFF_MINUTES = [5, 25, 125] as const;
export const NOOP_LIMIT = 1 as const;

const MINUTE_MS = 60_000;

export const newLedgerRecord = (): LedgerRecord => ({
  state: 'unknown',
  signature: null,
  attemptCount: 0,
  consecutiveNoopCount: 0,
  holdUntilMs: null,
});

export const isKnownGood = (record: LedgerRecord, currentSignature: string): boolean =>
  record.state === 'good' && record.signature === currentSignature;

const backoffFor = (attemptCount: number): number => {
  const index = Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1);
  return (BACKOFF_MINUTES[index] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]!) * MINUTE_MS;
};

const recordFailedAttempt = (record: LedgerRecord, nowMs: number): LedgerRecord => {
  if (record.reviewReason != null) {
    return { ...record, state: 'held', holdUntilMs: null };
  }
  const attemptCount = record.attemptCount + 1;
  if (attemptCount >= MAX_ATTEMPTS) {
    return { ...record, state: 'failed', attemptCount, holdUntilMs: null };
  }
  return {
    ...record,
    state: 'held',
    attemptCount,
    holdUntilMs: nowMs + backoffFor(attemptCount),
  };
};

/**
 * Fold a completed run into the ledger.
 *
 * Convergence is judged retrospectively: if the run claimed to modify the
 * file but the post-run facts are byte-for-byte identical to the pre-run
 * facts, the run accomplished nothing. That's one strike: a no-op run marks
 * the file `not_converging` immediately, because a run that asked to change
 * a file and changed nothing will not fix itself by repeating.
 *
 * The comparison here is deliberately exact (factsHash), not the tolerant
 * factsEquivalent from facts.ts. A tolerant comparison would false-flag
 * legitimate metadata-only flows (e.g. retagging subtitle languages or
 * setting a title with mkvpropedit) that leave codecs, streams, container
 * and duration untouched but do real work. factsHash already includes
 * sizeBytes, so an exact hash match implies exact size equality too.
 *
 * A missing post-run probe alongside a modification claim counts as a no-op:
 * we cannot verify progress, and assuming progress is how infinite loops start.
 *
 * Known limitation: a flow that does real work but has no Replace Original
 * File node leaves the library file itself unchanged, so this rule will
 * flag it as non-converging. Arguable, not wrong — left as-is.
 */
export const applyRunOutcome = (input: {
  record: LedgerRecord;
  outcome: RunOutcome;
  currentSignature: string;
  nowMs: number;
}): LedgerRecord => {
  const { record, outcome, currentSignature, nowMs } = input;

  if (outcome.held === true) {
    return {
      ...record,
      state: 'held',
      holdUntilMs: null,
      reviewReason: outcome.reviewReason?.trim() || 'Review requested by the flow.',
    };
  }

  if (!outcome.success) return recordFailedAttempt(record, nowMs);

  const wasNoop =
    outcome.claimedModified &&
    (outcome.postFacts === null || factsHash(outcome.preFacts) === factsHash(outcome.postFacts));

  const consecutiveNoopCount = wasNoop ? record.consecutiveNoopCount + 1 : 0;

  return {
    state: consecutiveNoopCount >= NOOP_LIMIT ? 'not_converging' : 'good',
    signature: currentSignature,
    attemptCount: 0,
    consecutiveNoopCount,
    holdUntilMs: null,
  };
};

/** A stalled job is a failed attempt: same counter, same backoff. */
export const applyStall = (input: { record: LedgerRecord; nowMs: number }): LedgerRecord =>
  recordFailedAttempt(input.record, input.nowMs);

/** Manual recovery. Nothing else clears a terminal state. */
export const applyRequeue = (record: LedgerRecord): LedgerRecord => ({
  ...record,
  state: 'queued',
  attemptCount: 0,
  consecutiveNoopCount: 0,
  holdUntilMs: null,
  reviewReason: null,
});

export const isEligible = (record: LedgerRecord, nowMs: number): boolean => {
  if (record.reviewReason != null) return false;
  if (record.state === 'queued') return record.holdUntilMs === null || nowMs > record.holdUntilMs;
  if (record.state === 'held') return record.holdUntilMs === null || nowMs > record.holdUntilMs;
  return false;
};
