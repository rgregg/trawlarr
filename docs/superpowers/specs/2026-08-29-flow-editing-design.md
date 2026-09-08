# Flow editing

**Status:** design approved 2026-08-29. Implements the flow-editing half of the
work deferred by `docs/superpowers/specs/2026-08-27-web-ui-task-first-redesign-design.md`.
Onboarding, the other deferred half, remains out of scope.

**Sub-project 2 of two. Depends on `2026-08-29-flow-versioning-design.md`, which
ships first** — publishing a flow re-queues thousands of files, and this design
makes publishing easy for the first time, so the history it publishes into needs
to exist already.

## Goal

Edit a flow — including its shape — from Configure, without going through a
library.

## Why

Three problems, all observed on a real install.

**Flows are unreachable.** A flow is a system-wide object; libraries hold a
`flowId`, many-to-one. But `/flows/:id` is reachable only from
Configure → Libraries, so a flow no library uses cannot be opened at all. This
install has two — `NvencHW` and `Trial` — that exist, occupy the name space, and
are invisible in the UI.

**The defects that matter are wiring, not values.** A `muxqueue` node
contributing `-max_muxing_queue_size 2048` sat on **both** branches of a codec
check instead of only the encode branch. Any overall output argument makes the
engine decide a file needs work, so all 4,621 files in a library were queued for
a pointless rewrite — about 9.2 TB of churn. No amount of editing node *inputs*
would have fixed that; the node was on the wrong edge.

**Editing means hand-writing JSON.** Every flow change this month went through
`PUT /flows/:id` with a hand-built definition, or `flow add` with a template.

## Decisions

| Decision | Rationale |
| --- | --- |
| **Full graph editing**, not inputs-only | The muxqueue class of defect is a wiring defect. |
| **Canvas editor via `@xyflow/react`** | Familiar to anyone arriving from Tdarr, which this project deliberately follows. Hand-rolling layout, edge routing, hit-testing, zoom and undo is weeks of work unrelated to trawlarr. |
| **Widen the licence allow-list to MIT, ISC and BSD-3-Clause** | `@xyflow/react`, `zustand`, `classcat` and `@xyflow/system` are MIT, but `@xyflow/system` pulls d3 (`d3-drag`, `d3-zoom`, `d3-selection`, `d3-transition`, `d3-interpolate`, `d3-color`, `d3-timer`, `d3-dispatch` — ISC; `d3-ease` — BSD-3-Clause). All three licences are permissive with attribution and keep trawlarr cleanly MIT-distributable, which is what the rule exists to protect. |
| **Draft, then explicit publish** | Publishing changes the flow's hash, and convergence signatures derive from it, so every file in every library using that flow re-queues. An edit must be able to sit half-finished without that happening. |
| **Draft stored server-side** | A draft is real work — an 11-node graph. It must survive closing the browser, switching machines and restarting the daemon. |
| **Publish shows the re-queue count only** | See "What Publish may claim". |

## Information architecture

- `/config?tab=flows` — new tab. Every flow, with the libraries using it, node
  count, hash, and whether it has an unpublished draft. This is where orphan
  flows become visible.
- `/flows/:id` — the existing read-only view, unchanged, now reachable from the
  list as well as from a library.
- `/flows/:id/edit` — the canvas editor. Its own route, so an edit in progress
  is linkable and survives a reload.

Creating a flow (`POST /flows`) and deleting one (`DELETE /flows/:id`) are
reachable from the list. Deletion already sets `library.flow_id` to null via
`ON DELETE SET NULL`, and `checkAllLibraries` writes the resulting pause reason,
so a library whose flow is deleted says so itself. The list must warn before
deleting a flow that is in use, naming the libraries.

## Data model

Migration **008** adds two nullable columns to `flow`:

```sql
ALTER TABLE flow ADD COLUMN draft_json TEXT;
ALTER TABLE flow ADD COLUMN draft_updated_at INTEGER;
```

`definition_json` remains the single source of what runs. `draft_json` is never
hashed, never read by the engine, and never affects convergence. A flow with a
draft is still running its published definition.

**Layout persistence (updated 2026-09-04).** Node coordinates are stored
separately as `flow.layout_json` (migration 010), a map of node IDs to finite
`{x, y}` positions. `GET /flows` and `GET /flows/:id` expose `layout`;
`PUT /flows/:id/layout` accepts and returns `{layout}`. This endpoint changes
only presentation metadata: no definition, draft, signature, version-history,
library-health or scan changes. Positions for draft nodes are allowed, and
publishing or discarding a draft preserves layout independently of the graph.
The canvas autosaves completed moves, auto-layout and layout undo/redo through
a serialized, coalescing queue. Failures retain pending positions and expose
a retry action; layout-only edits cannot publish a new flow version.

## API

Two additions; everything else already exists.

| Method | Path | Behaviour |
| --- | --- | --- |
| `PUT` | `/flows/:id/draft` | Writes `draft_json` and `draft_updated_at`. Validates the definition and returns validation errors, but **does not** re-hash, re-check libraries, or request a scan. |
| `DELETE` | `/flows/:id/draft` | Discards the draft. |

`GET /flows/:id` gains `draft` and `draftUpdatedAt` in its resource.

Publish is not a new endpoint. The client promotes the draft by sending it to
the existing `PUT /flows/:id`, which already validates, re-checks libraries, and
requests a scan per affected library — the correct blast-radius behaviour, and
the reason no new write path is needed. The server clears the draft on a
successful publish.

## The editor

The canvas is driven entirely by metadata `GET /plugins` already returns for all
98 plugins, so nothing here invents a schema:

- `details.inputs[]` — the node's editable fields.
- `details.outputs[]` — numbered, with tooltips. These become labelled edge
  handles, which is what makes "output 1 versus output 2" legible.
- `details.style.borderColor`, `details.icon`, `details.tags`,
  `details.sidebarPosition` — node appearance and palette ordering.
- `isStartPlugin` — only one start node, and it cannot be deleted.

**Validation runs continuously**, not at save: `POST /flows/validate` on every
structural change, with errors surfaced on the offending node. An invalid graph
should be visible while it is being built.

**A node reachable from two branches is drawn once**, as the read-only view
already does, with its other inbound edges labelled — the read-only view's
`alsoReachedFrom` behaviour carries over. Nodes unreachable from the start node
are drawn and marked, because a silently absent node reads as a node that is not
in the flow.

## What Publish may claim

Publish shows, and may only show:

- which libraries use this flow;
- **exactly how many files re-queue** — a count, from the libraries' own totals;
- the hash transition.

It must **not** estimate how many files will actually encode. That number is not
cheaply computable: `POST /flows/:id/dry-run` halts at the first plugin trawlarr
did not write (a deliberate safety ruling — walking past an unvouched plugin
means guessing at its side effects), and every real flow here reaches a
`tdarr:*` node within three steps. The one census that produced a true figure
required reading four plugin sources, confirming they only mutate
`args.variables`, and re-running the engine with those four vouched through an
in-process resolve hook.

Publish therefore states the count it knows and says plainly that how many
re-encode depends on the files. A number the UI cannot stand behind is worse
than no number.

## Error handling

- A draft that fails validation can still be **saved** — half-finished work is
  the point of a draft — but **cannot be published**. Publish is disabled with
  the reason shown.
- A publish that fails leaves the draft intact.
- The editor must distinguish "no draft", "draft saved", "draft invalid" and
  "failed to reach the daemon". Following the shipped UI's rule: empty, loading
  and error must never render alike.
- A draft that has gone stale — the live definition changed since the draft was
  taken — must be detected on publish and refuse, rather than silently reverting
  someone else's change.

## Testing

Follows the shipped UI's convention: logic in pure `*-model.ts` modules tested
with vitest; no DOM testing library, and none added. The canvas component itself
is untested by design, so everything testable must live outside it:

- graph ↔ react-flow node/edge translation, both directions;
- the mutation operations — insert a node on an edge, delete a node and heal the
  edges around it, re-point a branch — as pure functions over a definition;
- draft staleness detection;
- the publish summary's affected-library and file-count arithmetic;
- validation-error mapping onto nodes.

The mutation functions are where correctness lives — deleting a node from the
middle of a chain without orphaning what followed it is exactly the operation
that produces a muxqueue-shaped defect.

## Licence policy change

`scripts/audit-licenses.mjs` currently accepts MIT only and the gate asserts 291
packages. It must accept **MIT, ISC and BSD-3-Clause**, and the pinned count
updated to whatever the new tree reports. The script should name the licence and
package when it rejects, so the next widening is a decision rather than an
archaeology exercise.

## Out of scope

- **Onboarding and first-run**, still deferred to their own design.
- **A plugin trust model for dry-run**, which would make an encode estimate
  possible. Its own piece of work; noted here because it is the blocker.
- **Flow versioning or history.** A published definition replaces the previous
  one; git-style history for flows is not in this design.
- **Editing a flow's inputs from the library screen.** Libraries link to flows;
  editing happens in one place.
