/**
 * What a probe and a row actually mean, in words.
 *
 * "Why is this file like this" was the question every single time this week,
 * and it was answered with ffprobe and SQL because nothing in the product
 * would say it. The answer exists in the row; it just needed writing down.
 */
export interface StreamRow {
  index: number;
  kind: string;
  codec: string;
  detail: string;
  language: string;
  duration: string;
}

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  tags?: Record<string, string>;
}

/**
 * mkv leaves `duration` unset on every stream and puts the real length in a
 * tag formatted `00:53:51.457000000`. A file's own `durationMs` reads the
 * CONTAINER duration, which is not the same number and is not what this row
 * is showing — three real files failed in production last week from exactly
 * that substitution, so this reads the stream tag and nothing else.
 */
const streamDuration = (stream: ProbeStream): string => {
  const tag = stream.tags?.DURATION ?? stream.tags?.duration;
  if (tag === undefined) return '—';
  const [clock] = tag.split('.');
  return clock ?? '—';
};

const streamDetail = (stream: ProbeStream): string => {
  if (stream.codec_type === 'video') {
    return stream.height === undefined ? '—' : `${String(stream.height)}p`;
  }
  if (stream.codec_type === 'audio') {
    return stream.channels === undefined ? '—' : `${String(stream.channels)}ch`;
  }
  return '—';
};

export const toStreamRows = (probe: unknown): StreamRow[] => {
  const streams = (probe as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(streams)) return [];
  return (streams as ProbeStream[]).map((stream, position) => ({
    index: stream.index ?? position,
    kind: stream.codec_type ?? 'unknown',
    codec: stream.codec_name ?? 'unknown',
    detail: streamDetail(stream),
    language: stream.tags?.language ?? 'und',
    duration: streamDuration(stream),
  }));
};

/**
 * A delay, in words. `null` when the deadline has already passed — the
 * caller has to say something else entirely there, not a smaller number.
 * `Math.max(1, minutes)` used to floor an elapsed hold at "1m", so a file
 * whose hold expired an hour ago read "It will be retried in 1m" for as long
 * as nothing came along to pick it up, which is a promise about the future
 * built from a fact about the past.
 */
const humanDelay = (ms: number): string | null => {
  if (ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m`;
  return `${String(Math.round(minutes / 60))}h`;
};

/**
 * The one paragraph that answers "why is this file like this" — the
 * question that got asked with ffprobe and SQL all week because nothing in
 * the product would say it out loud.
 *
 * NO `flowHash` PARAMETER, deliberately (removed in review round 1). A
 * file's row carries no flow hash of its own — only a job's frozen
 * `flowHash`, written once at start and never updated, or the library's
 * CURRENT `flowId`, which is a different fetch. Threading either one
 * through here with no branch that reads it was exactly the shape that let
 * `FileDetail.tsx` read a job's stale binding as if it were current and
 * mis-target a dry run after a library was re-pointed to a different flow.
 * If a future case needs to compare against the flow, it must be the
 * library's current one — fetched where the comparison happens, not carried
 * in here unused as a temptation to compare the wrong thing.
 */
export const explainState = (input: {
  state: string;
  signature: string | null;
  attemptCount: number;
  lastJobReason: string | null;
  holdUntilMs: number | null;
  reviewReason?: string | null;
  nowMs: number;
}): string => {
  switch (input.state) {
    case 'good':
      return 'Converged. Its signature matches the flow this library uses, so there is nothing to do.';
    case 'queued':
      return input.signature === null
        ? 'Queued. It has no signature for the current flow — it has never run, or the flow changed.'
        : 'Queued. Its signature no longer matches the flow this library uses.';
    case 'running':
      return 'Running now. A worker has claimed it and is partway through the flow.';
    case 'failed':
      return `Failed after ${String(input.attemptCount)} attempts${
        input.lastJobReason === null ? '' : `: ${input.lastJobReason}`
      }. It will not retry on its own.`;
    case 'held': {
      if (input.reviewReason != null) {
        return `Held for review: ${input.reviewReason} It will not retry automatically. Requeue it after reviewing the file.`;
      }
      if (input.holdUntilMs === null) return 'Held after a failed attempt. It will be retried.';
      const delay = humanDelay(input.holdUntilMs - input.nowMs);
      return delay === null
        ? 'Held after a failed attempt. Its hold has already expired, so it is claimable now — if it stays here, nothing is picking it up.'
        : `Held after a failed attempt. It will be retried in ${delay}.`;
    }
    case 'not_converging':
      return 'Not converging. The flow ran without changing it enough to converge, so it has been set aside.';
    // `unknown` is the ledger's own starting state (`newLedgerRecord` in
    // `@trawlarr/core`) — a row that exists but has never been through a
    // scan's evaluation. It gets a real sentence rather than falling into
    // `default` because it is not a mystery state; it is a specific,
    // common one (every freshly-discovered file passes through it).
    case 'unknown':
      return 'Unknown. This file has not been evaluated against a flow yet.';
    default:
      return `State ${input.state}.`;
  }
};

/**
 * WHICH FLOW A DRY RUN REPLAYS, and what the screen has to admit about that
 * choice. Four booleans lived inline in `FileDetail.tsx` under a twelve-line
 * comment describing the production bug they exist to prevent; extracted
 * here so every branch is covered by a test rather than by that comment.
 *
 * THE BUG. A job row records the flow it ran under at `start()` and is never
 * updated. Reading it as "the flow now" is exactly what silently mis-targeted
 * a dry run after a library was re-pointed at a different flow on a real
 * system: the binding had moved, the job row had not, and dry-run kept
 * asking the old flow's question while the operator read the answer as if it
 * were about the current one. So the library's CURRENT binding wins whenever
 * it is known, and the job's frozen `flowId` is only ever a last resort.
 *
 * THE TWO NULLS ARE NOT THE SAME NULL, and the UI must never blur them into
 * one sentence. `libraryFlowId === null` with `lookupFailed === false` is a
 * FACT: this library has no flow bound. The same null with
 * `lookupFailed === true` is an UNKNOWN: the lookup that would have told us
 * did not come back. Both fall back to the last job's flow as the only lead
 * left, but only one of them is entitled to state what the library's flow
 * binding is.
 */
export interface FlowBinding {
  /** The flow to dry-run against, or `null` when there is nothing to replay. */
  flowId: string | null;
  /** True when `flowId` came from a job row rather than from the library. */
  fromLastJob: boolean;
  /**
   * Which sentence the screen owes the operator about that fallback:
   * `library-has-no-flow` states a fact, `library-lookup-failed` admits an
   * unknown, and `null` means no explanation is owed at all.
   */
  warning: 'library-has-no-flow' | 'library-lookup-failed' | null;
}

export const resolveFlowBinding = (input: {
  /** The library's CURRENT binding, or null — see the two nulls above. */
  libraryFlowId: string | null;
  /** Whether the library lookup itself failed, as opposed to answering null. */
  libraryLookupFailed: boolean;
  /** The most recent job's frozen `flowId`, if this file has ever run. */
  lastJobFlowId: string | null;
}): FlowBinding => {
  if (input.libraryFlowId !== null) {
    return { flowId: input.libraryFlowId, fromLastJob: false, warning: null };
  }
  if (input.lastJobFlowId === null) {
    // Nothing to replay: no binding and no history. The screen disables
    // Dry-run rather than warning about a flow it does not have.
    return { flowId: null, fromLastJob: false, warning: null };
  }
  return {
    flowId: input.lastJobFlowId,
    fromLastJob: true,
    warning: input.libraryLookupFailed ? 'library-lookup-failed' : 'library-has-no-flow',
  };
};
