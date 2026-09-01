/**
 * The flow History section's own shape, built from what
 * `GET /flows/:id/versions` returns.
 *
 * The API item carries no `definition` — Task 5 deliberately left the
 * heavy field off the list endpoint, since a history of fifty rows fetching
 * fifty full flow graphs is not a list, it is fifty detail fetches wearing a
 * table's clothes. What this model derives is exactly what a list row can
 * show without one: a shortened hash for scanning, a note that says
 * something even when the publisher left it blank, and which row is live.
 */

import type { FlowDiff } from '@trawlarr/core';

/** `GET /flows/:id/versions`'s per-item shape — see `flows.ts`'s handler. */
export interface ApiVersionSummary {
  id: string;
  flowId: string;
  definitionHash: string;
  note: string;
  createdAt: number;
  isCurrent: boolean;
}

export interface VersionRow {
  id: string;
  hash: string;
  shortHash: string;
  note: string;
  when: string;
  isCurrent: boolean;
}

const SHORT_HASH_LENGTH = 8;

/**
 * A version published with no note is not a version with nothing to say —
 * it is a version published the plain way (`PUT /flows/:id` with no `note`
 * field), which is most of them. "Published" says that plainly instead of
 * rendering an empty table cell an operator would read as a loading glitch.
 */
const describeNote = (note: string): string => (note === '' ? 'Published' : note);

/**
 * When a version was published, as a date — and "Today" for one published
 * on the same UTC day as `nowMs`, since that is the row an operator is most
 * likely to be checking right after a publish and the one where a bare date
 * reads as more stale than it is.
 */
export const formatWhen = (createdAtMs: number, nowMs: number): string => {
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return '—';
  const created = new Date(createdAtMs).toISOString();
  const now = new Date(nowMs).toISOString();
  const day = created.slice(0, 10);
  return day === now.slice(0, 10) ? `Today, ${created.slice(11, 16)} UTC` : day;
};

export const toVersionRows = (items: ApiVersionSummary[], nowMs: number): VersionRow[] =>
  items.map((item) => ({
    id: item.id,
    hash: item.definitionHash,
    shortHash: item.definitionHash.slice(0, SHORT_HASH_LENGTH),
    note: describeNote(item.note),
    when: formatWhen(item.createdAt, nowMs),
    isCurrent: item.isCurrent,
  }));

/**
 * `diffFlowDefinitions`'s output (`@trawlarr/core`'s `FlowDiff`), rendered
 * as lines a screen can list — same split as `toGraphRows`: every branch of
 * the rendering logic lives here, tested, so `FlowCompare.tsx` stays a thin
 * `<ul>` over this array.
 */
export interface DiffLine {
  kind:
    | 'node-added'
    | 'node-removed'
    | 'plugin-changed'
    | 'input-changed'
    | 'edge-added'
    | 'edge-removed';
  text: string;
}

/** An absent input value compares as `null` in `FlowDiff` — this names it
 * rather than printing the literal word "null", which reads as a bug. */
const orNotSet = (value: string | null): string => (value === null ? 'not set' : value);

const edgeLine = (edge: { fromNodeId: string; outputNumber: number; toNodeId: string }): string =>
  `${edge.fromNodeId} output ${String(edge.outputNumber)} → ${edge.toNodeId}`;

/**
 * Ordered nodes removed, nodes added, plugin changes, input changes, edges
 * removed, edges added — so a re-pointed branch (one edge removed, one
 * added, same nodes) reads as an adjacent pair rather than being split
 * across the list by an unrelated sort key.
 */
/**
 * `FlowVersion.tsx`'s knowledge of "which version is currently live", as a
 * discriminated union rather than the sentinel-typed `undefined` the screen
 * used before this: `undefined` used to mean both "still loading" and "the
 * lookup failed", which is exactly the bug this type exists to prevent — a
 * failed lookup rendered identically to a version that had loaded and
 * turned out not to be current, so the page asserted HISTORICAL for a
 * version it had simply failed to check.
 *
 * `id`/`hash` are both carried on `'known'` because Restore's confirmation
 * needs the live definition's hash, not just its id — see `isRestoreNoOp`.
 */
export type CurrentVersionState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'known'; id: string | null; hash: string | null };

export type VersionStatus = 'current' | 'historical' | 'loading' | 'failed';

/**
 * Which of the four states a version page is in, given what is known about
 * the flow's current version. Only `'current'` and `'historical'` are
 * actually known; `'loading'` and `'failed'` both mean "not yet decided",
 * and are kept distinct only so the screen can offer a retry for the one
 * that will not resolve on its own.
 */
export const resolveVersionStatus = (
  current: CurrentVersionState,
  versionId: string,
): VersionStatus => {
  if (current.kind !== 'known') return current.kind;
  return current.id === versionId ? 'current' : 'historical';
};

/** The `role="note"` banner at the top of a version page, one line per
 * `VersionStatus` — the one place this screen states what it does and does
 * not know about whether this version is current. */
export const describeVersionNotice = (status: VersionStatus): string => {
  switch (status) {
    case 'current':
      return 'This is the current version of this flow — it is what runs today.';
    case 'historical':
      return (
        'This is a HISTORICAL version, not the one currently in effect. Restoring it ' +
        'publishes this definition again, as a brand-new version — the history is ' +
        'append-only, so restoring never rewrites or removes anything.'
      );
    case 'loading':
      return 'Checking whether this is the current version of this flow…';
    case 'failed':
      return (
        'Could not determine whether this is the current version of this flow, so this ' +
        'page cannot say and will not offer to restore it until that is known.'
      );
  }
};

/**
 * A restore is a PUBLISH, not an undo — it always appends a new version
 * row. But when the version being restored carries the same
 * `definitionHash` the flow is already live on (publish A, then B, then A
 * again, then restore v1), the publish is a no-op by hash: no signature is
 * invalidated and nothing re-queues. This is the one fact the confirmation
 * must get right, and it is not visible from `VersionStatus` alone — a
 * version can be `'historical'` (a different version ROW is current) while
 * still being a no-op BY HASH, which is exactly the case this exists to
 * catch.
 */
export const isRestoreNoOp = (current: CurrentVersionState, versionHash: string): boolean =>
  current.kind === 'known' && current.hash !== null && current.hash === versionHash;

const libraryCountLabel = (count: number): string => `librar${count === 1 ? 'y' : 'ies'}`;

/** What Restore would do, in the terms its confirmation is allowed to
 * state: which libraries, how many files would re-queue — never how many
 * would re-encode, which is not cheaply computable. */
export interface RestorePreview {
  isNoOp: boolean;
  totalFiles: number;
  libraryCount: number;
}

/** The line shown above the library list, before Restore is confirmed. */
export const describeRestorePreview = (preview: RestorePreview): string => {
  if (preview.libraryCount === 0) {
    return 'No library currently uses this flow — restoring would re-queue nothing.';
  }
  if (preview.isNoOp) {
    return (
      'This definition is already live — restoring will record a new version but re-queue ' +
      'nothing.'
    );
  }
  return (
    `Restoring now would re-queue ${String(preview.totalFiles)} file(s) across ` +
    `${String(preview.libraryCount)} ${libraryCountLabel(preview.libraryCount)}:`
  );
};

/** The line inside the confirmation dialog itself — stronger than the
 * preview, since this is the last thing shown before the button that acts. */
export const describeRestoreConfirmation = (preview: RestorePreview): string => {
  if (preview.libraryCount === 0) {
    return 'No files will be re-queued — no library currently uses this flow.';
  }
  if (preview.isNoOp) {
    return (
      'This definition is already live — restoring will record a new version but re-queue ' +
      'nothing.'
    );
  }
  return (
    `${String(preview.totalFiles)} file(s) across ${String(preview.libraryCount)} ` +
    `${libraryCountLabel(preview.libraryCount)} will be re-queued for a rescan. How many will ` +
    'actually need re-encoding is not known ahead of time.'
  );
};

/** The confirm button's own label — the one place a wrong file count would
 * be read as a promise, so it follows the same no-op rule as the text above
 * it rather than always naming `totalFiles`. */
export const restoreButtonLabel = (preview: RestorePreview, restoring: boolean): string => {
  if (restoring) return 'Restoring…';
  if (preview.libraryCount === 0 || preview.isNoOp) return 'Yes, restore';
  return `Yes, restore and re-queue ${String(preview.totalFiles)} file(s)`;
};

export const toDiffLines = (diff: FlowDiff): DiffLine[] => [
  ...diff.nodesRemoved.map((nodeId): DiffLine => ({
    kind: 'node-removed',
    text: `${nodeId} removed`,
  })),
  ...diff.nodesAdded.map((nodeId): DiffLine => ({ kind: 'node-added', text: `${nodeId} added` })),
  ...diff.nodePluginChanged.map((change): DiffLine => ({
    kind: 'plugin-changed',
    text: `${change.nodeId}: ${change.from} → ${change.to}`,
  })),
  ...diff.inputsChanged.map((change): DiffLine => ({
    kind: 'input-changed',
    text: `${change.nodeId}.${change.key}: ${orNotSet(change.from)} → ${orNotSet(change.to)}`,
  })),
  ...diff.edgesRemoved.map((edge): DiffLine => ({ kind: 'edge-removed', text: edgeLine(edge) })),
  ...diff.edgesAdded.map((edge): DiffLine => ({ kind: 'edge-added', text: edgeLine(edge) })),
];
