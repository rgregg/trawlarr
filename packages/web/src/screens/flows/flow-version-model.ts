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
