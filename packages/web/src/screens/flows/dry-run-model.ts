/**
 * The flow editor's library dry-run panel: types mirroring the server's dry
 * run API (`@trawlarr/server` `dry-run-runs.ts` / `dry-run-outcome.ts`), plus
 * the pure formatting and staleness logic the panel renders from.
 *
 * Typed locally rather than imported at runtime: the web bundle must not pull
 * in `@trawlarr/server` or `@trawlarr/engine` code, only the shapes their
 * JSON responses take.
 */

export type DryRunOutcome =
  | { kind: 'no-change' }
  | { kind: 'change'; detail: 'video' | 'audio' | 'streams' }
  | { kind: 'hold'; detail: string }
  | { kind: 'fail'; detail: string }
  | { kind: 'incomplete'; detail: string };

export interface DryRunFileRow {
  fileId: string;
  path: string;
  outcome: DryRunOutcome;
  publishedOutcome: DryRunOutcome;
}

export interface DryRunChangeGroup {
  from: DryRunOutcome;
  to: DryRunOutcome;
  files: Array<{ fileId: string; path: string }>;
}

export interface DryRunRun {
  runId: string;
  flowId: string;
  status: 'running' | 'done' | 'cancelled' | 'failed';
  error: string | null;
  processed: number;
  total: number;
  definitionHash: string;
  publishedHash: string;
  counts: Record<string, number>;
  changes: DryRunChangeGroup[];
  files: DryRunFileRow[];
}

/** One file's two walks: against the canvas draft, and against the published definition. */
export interface DryRunFileDetail {
  fileId: string;
  path: string;
  canvas: DryRunWalk | null;
  published: DryRunWalk | null;
}

/** The fields of the engine's `FlowDryRunResult` the panel actually renders. */
export interface DryRunWalk {
  steps: Array<{ nodeId: string; outputNumber: number | null; error: string | null }>;
  plannedCommands: string[][];
  partialWalkWarning: string | null;
}

/** A terse label for a single outcome, as shown on a file row. */
export const outcomeLabel = (outcome: DryRunOutcome): string => {
  switch (outcome.kind) {
    case 'no-change':
      return 'No change';
    case 'change':
      switch (outcome.detail) {
        case 'video':
          return 'Re-encode video';
        case 'audio':
          return 'Convert audio';
        case 'streams':
          return 'Remux';
      }
      break;
    case 'hold':
      return `Hold: ${outcome.detail}`;
    case 'fail':
      return 'Fail';
    case 'incomplete':
      return `Stops at ${outcome.detail}`;
  }
};

/** Order the summary's outcome groups render in: settled first, trouble last. */
const ORDER = ['no-change', 'change:video', 'change:audio', 'change:streams'];

/** Where a key falls in `ORDER`; holds and incompletes sort after the fixed prefix, fail last of all. */
const rank = (key: string): number => {
  const fixed = ORDER.indexOf(key);
  if (fixed !== -1) return fixed;
  if (key === 'fail') return Number.MAX_SAFE_INTEGER;
  if (key.startsWith('hold:')) return ORDER.length;
  if (key.startsWith('incomplete:')) return ORDER.length + 1;
  return ORDER.length; // unrecognised keys read alongside holds, ahead of fail
};

/** The same label an outcome of this key would carry, from the key alone. */
export const countLabel = (key: string): string => {
  const colon = key.indexOf(':');
  const kind = colon === -1 ? key : key.slice(0, colon);
  const detail = colon === -1 ? '' : key.slice(colon + 1);
  switch (kind) {
    case 'no-change':
      return 'No change';
    case 'change':
      return outcomeLabel({ kind: 'change', detail: detail as 'video' | 'audio' | 'streams' });
    case 'hold':
      return `Hold: ${detail}`;
    case 'fail':
      return 'Fail';
    case 'incomplete':
      return `Stops at ${detail}`;
    default:
      return key;
  }
};

/** Counts by outcomeKey, ordered: no change, re-encode/convert/remux, holds, incomplete, fail. */
export const orderedCounts = (
  counts: Record<string, number>,
): Array<{ key: string; label: string; count: number }> =>
  Object.entries(counts)
    .map(([key, count]) => ({ key, label: countLabel(key), count }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));

/**
 * A run is stale once the canvas it was taken against no longer matches what
 * is on screen (or was never validated at all) or the flow was published
 * again mid-run — either way the run's numbers describe a definition that no
 * longer exists, and must not be presented as current.
 */
export const isRunStale = (
  run: Pick<DryRunRun, 'definitionHash' | 'publishedHash'>,
  canvasHash: string | null,
  liveHash: string,
): boolean =>
  canvasHash === null || canvasHash !== run.definitionHash || run.publishedHash !== liveHash;

/** The node path a walk took, as a person reads a route. */
export const routeText = (walk: DryRunWalk | null, labels: Record<string, string>): string =>
  walk === null ? '' : walk.steps.map((step) => labels[step.nodeId] ?? step.nodeId).join(' → ');

/**
 * A file count as the panel prints it. Pinned to `en-US` grouping rather than
 * the browser locale so the same run reads the same in every screenshot and
 * test — `1,850 / 5,242`, never `1.850 / 5.242` beside an English label.
 */
export const formatCount = (value: number): string => value.toLocaleString('en-US');

/** The panel heading while a run is walking: `Dry run · 1,850 / 5,242`. */
export const progressText = (run: Pick<DryRunRun, 'processed' | 'total'>): string =>
  `Dry run · ${formatCount(run.processed)} / ${formatCount(run.total)}`;

/** One change group's summary line: `12 · No change → Remux`. */
export const changeGroupLabel = (group: DryRunChangeGroup): string =>
  `${formatCount(group.files.length)} · ${outcomeLabel(group.from)} → ${outcomeLabel(group.to)}`;

/** How many files the canvas would send down a different outcome than the published flow. */
export const changedFileCount = (run: Pick<DryRunRun, 'changes'>): number =>
  run.changes.reduce((sum, group) => sum + group.files.length, 0);

/**
 * What the Publish dialog may say about a dry run, or null when it may say
 * nothing. Only a finished run that still describes both the canvas being
 * published and the version it replaces qualifies: a stale or partial run's
 * numbers would be presented as the consequence of a publish they do not
 * describe. The server orders `changes` largest first, so the first three
 * groups are the biggest.
 */
export const publishDryRunSummary = (
  run: DryRunRun | null,
  canvasHash: string | null,
  liveHash: string,
): { line: string; groups: string[] } | null => {
  if (run === null || run.status !== 'done' || isRunStale(run, canvasHash, liveHash)) return null;
  return {
    line: `Dry run: ${formatCount(changedFileCount(run))} file(s) change outcome.`,
    groups: run.changes.slice(0, 3).map(changeGroupLabel),
  };
};
