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

const humanDelay = (ms: number): string => {
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
    case 'held':
      return input.holdUntilMs === null
        ? 'Held after a failed attempt. It will be retried.'
        : `Held after a failed attempt. It will be retried in ${humanDelay(
            input.holdUntilMs - input.nowMs,
          )}.`;
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
