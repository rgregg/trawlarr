# Library dry run from the flow editor

Status: approved 2026-09-13.

## Problem

The Publish dialog says "how many files will actually re-encode is not known".
The only dry run in the product is one file against the published flow
(`POST /flows/:id/dry-run`, the Dry-run button on a file). Judging an edit
before publishing it has meant running scripts inside the container that copy
the database and walk every file.

## Outcome

A **Dry run** button in the flow editor walks every file the flow governs
against the definition on the canvas (unsaved edits included) and against the
published definition, and shows:

- counts by outcome for the canvas definition;
- what changes versus published, grouped as `published outcome → canvas
  outcome`, each group listing its files;
- for a selected file, both walks' node routes and the ffmpeg commands the
  canvas definition would run;
- progress while running, and Cancel.

The Publish dialog shows the latest run's change counts when that run matches
the definition being published, in place of "not known".

## Server

### `dryRunFlow` takes a definition

`dryRunFlow` (`packages/server/src/flow/dry-run.ts`) gains an optional
`definition`. When given, the walk, plugin resolution (`buildJobPayload`'s
`pluginPaths`) and node verdicts use it instead of the flow's stored
definition. Nothing else changes: plugin documents stay read-only, nothing is
written to the database.

### Outcome classification

A pure function `classifyDryRun(result) → DryRunOutcome`:

| kind          | when                                                            | detail                                   |
| ------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `hold`        | `stopReason === 'held-for-review'`                              | review reason                            |
| `fail`        | `failed` or `error` present                                     | error text                               |
| `incomplete`  | not `complete`                                                  | node the walk stopped at                 |
| `change`      | `wouldRunFfmpeg`                                                | `video` / `audio` / `streams` (see below) |
| `no-change`   | otherwise                                                       | —                                        |

`change` detail comes from the command model the engine compiled, using the
compiler's own "needs an encode" rule per stream: any video stream encoded →
`video`; else any audio stream encoded → `audio`; else `streams` (remux,
stream removal, metadata/disposition only). The engine records this on each
Execute decision (`encodes`), because argv alone (`-c:1 aac`) does not say
which stream type an index is. A dry run that could not start for
a file (no probe, library gone) is `fail` with that message.

Outcome key for grouping = `kind` plus `detail` for `change`, `hold` and
`incomplete`; `fail` groups by kind only (error text varies per file) and
shows the text per file.

### Runs

A `FlowDryRunCoordinator` in the daemon, handed to routes on `ApiContext`
like `pluginSyncs`:

- `start(flowId, definition)` → run id. One run per flow: starting another
  cancels the previous. Files = every non-missing file in libraries whose flow
  is this flow, ordered by path, snapshotted at start.
- For each file, dry-runs the canvas definition then the published one,
  classifies both, and keeps the full results only for files whose outcome
  key differs (the only files the editor can open). Yields to the event loop between
  files (`setImmediate`) so the API and the supervisor stay responsive.
- Held in memory, latest run per flow only, discarded on restart. A run
  records the canvas definition's hash and the published hash it compared
  against.
- `cancel(flowId, runId)`: cancels a running run (it stays readable as
  `cancelled`) and drops one that is no longer running. A run whose flow has
  been deleted is dropped the next time runs are read or started.

### API

- `POST /flows/:id/dry-runs` `{ definition }` → `202 { runId }`. The
  definition must validate (same resolver as publish); otherwise `400` with
  the problems.
- `GET /flows/:id/dry-runs/:runId` → `{ status: running|done|cancelled|failed,
  error, processed, total, definitionHash, publishedHash, counts, changes:
  [{ from, to, files: [{ fileId, path }] }] }`. No per-file rows: the poll
  stays small however large the library. `changes` is empty while `running`
  and filled once the run is not.
- `GET /flows/:id/dry-runs/:runId/files/:fileId` → `{ fileId, path, outcome,
  publishedOutcome, canvas, published }`, the last two the full
  `FlowDryRunResult`s (null for a walk that threw; the reason is the
  outcome's `detail`). Only for files in `changes`; any other is `404`.
- `POST /flows/:id/dry-runs/:runId/cancel` → the run view: stops a running
  run, leaves a finished one as it is. `404` for no such run. The editor's
  Cancel sends it, so a run that finishes just before the click still shows
  its results.
- `DELETE /flows/:id/dry-runs/:runId` → `204`: cancels a running run, drops a
  finished one. `404` for no such run. The editor sends it when the panel
  closes or unmounts.

The web polls the run while it is running (1s). No event-bus event: progress
is liveness only.

## Web

- `Dry run` button beside Publish. Disabled while the canvas has validation
  problems.
- Panel below the canvas: progress + Cancel while running; then counts, the
  changes list (collapsed groups, expand to files), and a file view with both
  routes and the planned commands.
- When the canvas changes after a run, the panel marks the results out of
  date (canvas hash ≠ run's definition hash) and keeps them.
- One line of limits: walks stop at community nodes the engine cannot vouch
  for (shown as incomplete); Check Size Change is not measured.
- Copy stays terse (no explanatory paragraphs).

Grouping, stale detection and count formatting live in a tested model file;
the component only renders.

## Not included

Run history, persistence across restarts, a CLI command, single-file dry run
from the editor.

## Testing

- `classifyDryRun` unit tests, including the three change details against real
  compiled argv.
- `dryRunFlow` with a `definition` override walks that definition, not the
  stored one, and leaves the database byte-identical.
- Coordinator: counts and changes against a fixture library; a second start
  cancels the first; cancel stops the walk; a file that cannot be dry-run is
  `fail`, not a crashed run.
- Routes: 202 / 400 on invalid definition / 404 unknown run.
- Web model: grouping, stale detection.
- End to end with real ffmpeg: a library where the canvas definition changes
  one file's outcome shows exactly that change.
