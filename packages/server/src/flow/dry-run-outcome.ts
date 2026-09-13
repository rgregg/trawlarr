import type { FlowDryRunResult } from './dry-run.js';

export type DryRunOutcome =
  | { kind: 'no-change' }
  | { kind: 'change'; detail: 'video' | 'audio' | 'streams' }
  | { kind: 'hold'; detail: string }
  | { kind: 'fail'; detail: string }
  | { kind: 'incomplete'; detail: string };

/**
 * One file's dry run as a single outcome. Order matters: a hold and a failure
 * both end a walk early, and must not be read as "incomplete"; an incomplete
 * walk must never be read as "no change", because the nodes that would have
 * changed the file were never reached.
 */
export const classifyDryRun = (result: FlowDryRunResult): DryRunOutcome => {
  if (result.stopReason === 'held-for-review') {
    return { kind: 'hold', detail: result.reviewReason ?? 'Review requested by the flow.' };
  }
  if (result.failed || result.error !== null) {
    return { kind: 'fail', detail: result.error ?? 'The flow failed.' };
  }
  if (!result.complete) {
    return { kind: 'incomplete', detail: result.stoppedAtNodeId ?? result.stopReason };
  }
  if (result.wouldRunFfmpeg) {
    const ran = result.executeDecisions.filter((decision) => !decision.skip);
    if (ran.some((decision) => decision.encodes?.video === true))
      return { kind: 'change', detail: 'video' };
    if (ran.some((decision) => decision.encodes?.audio === true))
      return { kind: 'change', detail: 'audio' };
    return { kind: 'change', detail: 'streams' };
  }
  return { kind: 'no-change' };
};

/** Files with the same key are "the same outcome". Error text varies per file, so failures group together. */
export const outcomeKey = (outcome: DryRunOutcome): string =>
  outcome.kind === 'no-change' || outcome.kind === 'fail'
    ? outcome.kind
    : `${outcome.kind}:${outcome.detail}`;
