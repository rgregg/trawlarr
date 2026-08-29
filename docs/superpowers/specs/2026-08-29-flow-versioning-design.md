# Flow versioning

**Status:** design approved 2026-08-29. Sub-project 1 of two; the flow *editor*
(`2026-08-29-flow-editing-design.md`) is sub-project 2 and depends on this
shipping first.

## Goal

Keep every published version of a flow, let a past version be viewed, compared
and restored, and make a job's recorded `flow_hash` resolve to the graph that
actually ran.

## Why this comes first

**Publishing a flow is irreversible today.** The definition is replaced in
place. The only route back to a previous graph is git, or memory — and
publishing re-queues every file in every library using the flow, 5,194 of them
on this install. The editor is going to make publishing easy for the first time;
the undo should exist before the thing that needs undoing.

**`job.flow_hash` is already an orphaned reference.** Every one of ~5,500 job
rows records the hash of the flow definition it ran under, and nothing stores
what that definition was. "What did this flow look like when this file was
transcoded in August?" is currently unanswerable. It came up repeatedly while
diagnosing whether a job had run the right flow — one false bug report this
month was exactly a current binding being read against a historical job's frozen
`flow_id`.

Versioning is also useful with no editor at all, which is why it stands as its
own sub-project rather than a feature of one.

## Data model

Migration **007**:

```sql
CREATE TABLE flow_version (
  id               TEXT PRIMARY KEY,
  flow_id          TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
  definition_hash  TEXT NOT NULL,
  definition_json  TEXT NOT NULL,
  note             TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL
);
CREATE INDEX flow_version_flow_idx ON flow_version (flow_id, created_at DESC);
CREATE INDEX flow_version_hash_idx ON flow_version (definition_hash);
```

`ON DELETE CASCADE`: deleting a flow deletes its history. A flow's versions have
no meaning without the flow, and `DELETE /flows/:id` already warns when a library
uses it.

**The migration backfills** each existing flow's current definition as its first
version, so history is never empty and the current hash always resolves. Job
rows older than that backfill keep hashes that resolve to nothing — honest, and
the UI must say "this version was not recorded" rather than implying the flow
never existed.

`definition_hash` is not unique: publishing A, then B, then A again yields three
rows, the first and third sharing a hash. That is correct — the timeline is the
record, and deduplicating it would lose when a change was reverted.

**Retention: keep everything.** A definition is a few kilobytes; the largest
flow here is 11 nodes. Pruning history is the one thing that defeats the point.

## Behaviour

**A version is appended on every publish**, inside the same transaction that
writes `definition_json`, so a flow's live definition and its newest version can
never disagree. The existing `PUT /flows/:id` gains this; no new write path.

**Restore publishes a past definition as a new version.** History stays
append-only — restoring v2 while at v5 produces v6 whose definition equals v2's,
with the note `Restored from <hash>`. Nothing is rewritten or removed, and the
restore carries exactly the blast radius of any other publish: the hash changes,
libraries re-check, scans are requested. The UI must present restore as a
publish, not as an undo button, because that is what it is.

**A no-op publish is still a version.** If the definition is byte-identical to
the current one, the hash does not change and nothing re-queues, but the row is
appended with an empty note. The timeline should show that someone pressed
publish.

## API

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/flows/:id/versions` | Newest first. Paged. Returns `id`, `definitionHash`, `note`, `createdAt`, and whether it is the current one — **not** the full definition. |
| `GET` | `/flows/:id/versions/:versionId` | One version including its full `definition`. |
| `POST` | `/flows/:id/versions/:versionId/restore` | Publishes that version's definition as a new version. Same validation, library re-check and scan requests as `PUT /flows/:id`. |
| `GET` | `/flows/versions/by-hash/:hash` | Resolves a hash to a version, so a job row can be linked to the graph it ran. Returns 404 with a distinct code when the hash predates the backfill. |

`PUT /flows/:id` accepts an optional `note`.

The listing omits definitions deliberately: a flow with a long history would
otherwise return hundreds of kilobytes to render a list of dates.

## The diff

A graph diff, not a text diff. Comparing two definitions produces:

- **nodes added / removed**, by node id;
- **node inputs changed**, per key, with before and after;
- **node plugin changed**, where an id was reused for a different plugin;
- **edges added / removed**, as `from:output → to`.

Edges are compared as `(fromNodeId, outputNumber, toNodeId)` triples. This is the
comparison that matters: the muxqueue defect was one edge — `check:1 → muxqueue`
where it should have been `check:1 → audio` — and a diff that renders that as one
removed edge and one added edge is the entire value of the feature.

Node ordering in the JSON must not produce spurious differences; the diff works
over sets keyed by id, never over array position.

This is a pure function over two definitions, and is where the testing weight
sits.

## Where it surfaces

- **`/flows/:id`** — the existing read-only flow view gains a **History**
  section: newest first, each row showing hash, note, date, and whether it is
  current. Reachable today from Configure → Libraries, so this needs nothing
  from sub-project 2.
- **`/flows/:id/versions/:versionId`** — one past version, rendered with the
  existing read-only graph renderer, clearly marked as historical and not
  current, with **Restore** and **Compare with current**.
- **`/flows/:id/compare?from=<id>&to=<id>`** — the diff.
- **`/jobs/:id`** — the job view already displays `flowHash`. It becomes a link
  to that version, or renders "this version was not recorded" for hashes
  predating the backfill. This is the payoff for the 5,500 existing rows.

## Error handling

- Restoring a version whose definition no longer validates — because a plugin it
  used has since been removed — must fail with the validation error naming the
  missing plugin, not with a generic failure. This is a realistic case: plugin
  sources are synced and can change.
- A hash that resolves to no version renders as "not recorded", distinct from a
  failed fetch.
- Restore is a publish, so it inherits publish's confirmation: which libraries,
  how many files re-queue. As established for the editor, it states the re-queue
  count and does **not** estimate how many files will re-encode.

## Testing

Logic in pure modules, per the shipped UI's convention; no DOM testing library.

- **The diff** — added, removed, changed inputs, changed plugin, re-pointed edge,
  node reordering producing no diff, and the muxqueue case specifically:
  `check:1 → muxqueue` becoming `check:1 → audio` must read as one edge removed
  and one added.
- **Append-on-publish is transactional** — a failed publish must leave no version
  row, and a successful one must leave the live definition and newest version in
  agreement. Assert on the database, not on a return value.
- **Restore appends rather than rewrites**, and its resulting definition equals
  the restored version's.
- **A no-op publish appends a row and changes no hash.**
- **The backfill** — an existing flow gets exactly one version whose hash equals
  its current `definitionHash`.
- **Hash resolution** — a known hash resolves; an unknown one returns the
  distinct not-recorded code, not a bare 404.

## Out of scope

- **The canvas editor**, which is sub-project 2 and depends on this.
- **Pruning or archiving history.**
- **Diffing across different flows** — comparison is within one flow's timeline.
- **Estimating encode volume on publish**, blocked on dry-run's plugin trust
  model, as recorded in the editor's spec.
