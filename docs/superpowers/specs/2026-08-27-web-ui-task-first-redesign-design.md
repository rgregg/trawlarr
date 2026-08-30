# Web UI: task-first redesign

**Status:** design approved 2026-08-27. Supersedes the Overview/Libraries/Activity
structure in `packages/web`.

## Goal

Make the web UI the primary way to operate trawlarr, instead of `curl` and
`ffprobe`.

## Why the current structure fails

The engine converged two real libraries (Movies 563 files / 5.5 TB, Shows 4,625
files / 8.4 TB) over a week of operation. In that week the UI was used for
almost nothing. Every operational question was answered another way:

| Question asked in anger | How it was answered | Why not the UI |
| --- | --- | --- |
| Why was this file rewritten? | `job_step.log_excerpt` over the API | no file view exists |
| Which files are failing, and why? | `trawlarr status --files --state failed` | no file list exists |
| Why is the library not converging? | ad-hoc SQL over `probe_json` | nothing surfaces probes |
| Set worker counts | raw `PUT /api/v1/workers/counts` | no settings screen; CLI has no command |
| What does this flow actually do? | reading `flow.definition_json` | no flow view exists |

The data was always present in the API. The UI simply did not show it. Three
screens (`Overview`, `Libraries`, `Activity`, ~2,500 lines) present live job
activity and library CRUD and stop there.

There is also **no router**: the current screen is `useState` in `App.tsx`, so
nothing is linkable, bookmarkable, or survives a reload.

## Information architecture

Four modes, chosen because they match the four things the operator actually
does. Navigation is tasks; objects are shared.

```
trawlarr    Watch    Diagnose    Files    Configure          search   settings
```

**Modes are routes, not states.** A mode is a filtered way *in*. There is
exactly one file view, one job view, one flow view, each with its own URL. Every
mode links into the same one; nothing is duplicated. This is what keeps
task-first navigation from trapping the reader in a mode.

```
Watch ─────┐
Diagnose ──┼──▶  /files/:id  ──▶  /jobs/:id  ──▶  log
Files ─────┤
search ────┘
```

### Routes

| Route | Screen |
| --- | --- |
| `/` | Watch |
| `/diagnose` | Diagnose (problem groups) |
| `/files` | Files table; query string carries filters |
| `/files/:id` | File detail |
| `/jobs/:id` | Job detail (steps, reasons, log) |
| `/flows/:id` | Flow detail (read-only graph) |
| `/config` | Configure; `?tab=` selects section |

`/files?library=shows&state=failed&q=foundation` must reproduce a view exactly.
Filter state lives in the URL, not in component state.

## Data flow: two layers

The worker protocol already fixes this rule, and the UI adopts it verbatim:

> `progress` and `log` are LIVENESS ONLY. Nothing durable may ever depend on
> them. — `packages/server/src/worker/protocol.ts:44`

- **REST is truth.** Counts, states, history, sizes, probes, job steps. Survives
  reload. Every screen is correct from REST alone.
- **WebSocket is liveness.** Percent, stage, eta, scan cursor. Lossy by design.

A dead socket must make a screen *less lively*, never *wrong*. Progress bars
freeze; nothing else changes. The header already states this in words
("Reconnecting…") rather than a coloured dot, and that stays.

`packages/web/src/api/events.ts` already receives `job.progress` and
`scan.progress` and maintains a `LiveState`. No new transport work is needed.

## Screens

### Watch (`/`)

The default screen. Answers "what is happening now".

- **Running jobs** — file, progress bar, percent, eta, stage, encoder, speed.
  Links to file, job, and live log tail.
- **Libraries** — per-library convergence bars and counts.
- **Last 24 hours** — encoded / skipped / failed counts, bytes reclaimed, trash
  size. One query over `job`; no rollup table (history charts are out of scope).
- **Runtime** — worker counts, hardware verdict, schedule window.

**Idle is a designed state, not an empty screen.** The steady state of this
system is "converged, workers 0, nothing running", and that must not look like a
fault. When nothing is running, Watch states *why* — everything converged; or
workers are 0 and nothing will start; or outside the schedule window — with the
corrective action inline.

### Diagnose (`/diagnose`)

Problems, grouped by cause — **not** a list of failed rows.

The grouping key is the failure reason already written to `job_step`. Three
files failing for one reason must read as one problem with three files. This is
the specific deficiency that made the Foundation duration bug take days: three
failures looked like three mysteries.

Each group shows the reason, affected files, total bytes, and group actions
(`requeue all`). Groups cover: verification refusals, size-guard refusals,
stalled/held files, and unconverged files with no successful job.

When nothing is wrong, Diagnose says so and links to Files.

### Files (`/files`)

The table that did not exist. Separate from Diagnose by explicit decision.

- Columns: state, path, video codec, audio codecs, size, updated.
- Filters: library, state, search; all in the query string.
- Sort by any column.
- **Virtualised** — 4,625 rows today, and a library may be far larger.
- Footer states totals: file count, bytes, convergence percentage.

### File detail (`/files/:id`)

- Path, state, size, mtime.
- **Streams** from `probe_json`: index, type, codec, resolution/channels,
  language, duration.
- **Why is it in this state** — stated in words. For `good`: the signature
  matches the flow's current definition. For `queued`: what changed. For
  `failed`: the reason from the last job.
- **Job history**, newest first, each with its outcome and one-line reason.
- Actions: requeue, raise priority, dry-run against the library's flow.

### Job detail (`/jobs/:id`)

The step list, with the engine's own reason strings shown at full width — not
truncated, not behind a disclosure. These strings are the product of a week's
work and are what a human actually needs:

```
Running ffmpeg: 1 stream(s) were removed by the flow; output position 1
would carry input stream 2, where the file has stream 1
Skipping ffmpeg: the compiled command would produce a file identical to
the input — the file is already in the state this flow wants
the output's container runs 3231.5s against the original's 3232.7s
```

Full log available from `GET /jobs/:id/log`.

### Configure (`/config`)

Editable: worker counts, schedule window, trash retention (with size and next
sweep, plus purge), libraries (add/edit/remove), plugin sources (add/sync).
Read-only: hardware verdict and ffmpeg paths.

Controls carry the operational knowledge next to them where it exists — the
worker control notes that raising transcode workers 1→3 measurably *reduced*
throughput on this hardware.

### Flow detail (`/flows/:id`) — read-only

Flows are not edited in this release, but they must be readable: "why did this
file get rewritten" is usually a question about the graph. Renders the node
graph with branch labels and each node's inputs, plus the flow hash and which
libraries use it. States that changing a flow changes its hash and re-queues
every file using it. Offers the raw JSON for copying.

The muxqueue defect — one node on the wrong branch of a codec check, which
queued ~9.2 TB of pointless rewrites — is visible at a glance in a drawn graph
and was not visible in JSON.

## Writes

Four, chosen deliberately because this UI can start work on 8.4 TB:

1. **Requeue** — a file, or every file in a Diagnose group.
2. **Raise priority** — run something next.
3. **Worker counts** — `PUT /api/v1/workers/counts`. This is both the start
   button and the stop button for a runaway.
4. **Dry-run** — what a flow would do to a file, and why, with no encode.

Every write states its blast radius before committing when that radius exceeds
one file.

## Responsive

Desktop and phone are both first-class: every task must be completable on both.

- Tables collapse to cards below the breakpoint; no horizontal scrolling of
  primary content.
- No hover-only affordances — every action reachable by touch.
- Detail views are a side panel on desktop and a full screen on mobile, both
  addressed by the same URL.

## Error handling

- **401** clears the key and returns to the key gate — existing `useApi`
  behaviour, preserved.
- **Socket down** — header says "Reconnecting…"; screens stay correct from REST.
- **Failed fetch** — the affected panel shows the error and a retry; one panel
  failing never blanks the screen.
- **Empty vs. broken vs. idle must be visually distinct.** An empty Diagnose
  ("nothing needs you") and a failed Diagnose fetch must never render alike.

## Technical approach

**No new runtime dependencies.** The web package currently depends on `react`
and `react-dom` only, and the repo runs an MIT-only licence audit pinned at 291
packages. Two things are hand-rolled instead:

- **Router** — a small `useRoute` hook over the History API: parse
  `location.pathname` + `searchParams`, render by pattern, intercept internal
  link clicks, respond to `popstate`. The route table above is the whole
  requirement; a routing library would be more code than the code it replaces.
- **Virtualisation** — a windowing hook computing visible index range from
  scroll offset and fixed row height.

**Testing follows the existing pattern.** There is no DOM testing library and
none is added. Screens keep their logic in paired pure `*-model.ts` modules
(as `activity-model.ts`, `overview-model.ts`, `library-form-model.ts` already
do), and those are unit-tested with vitest. Components stay thin enough to need
no tests. New model modules: route parsing, file filtering/sorting, diagnose
grouping, stream summarisation, and the "why is it in this state" explanation.

The grouping and explanation logic is where the real complexity lives, and it is
all pure functions over API responses — which is exactly what this pattern
tests well.

## Migration

- `Activity.tsx` → absorbed into Watch.
- `Overview.tsx` → absorbed into Watch (convergence bars) and Configure.
- `Libraries.tsx`, `LibrarySetup.tsx` → Configure's libraries section.
- `FlowPicker.tsx` → retained for library setup; flow *editing* stays out.
- `useApi`, `KeyGate`, `useLive`, `api/*` → unchanged.

## Out of scope, deliberately

Both are wanted, and both are deferred to their own design:

- **Onboarding / first-run wizard.** The empty-install path — no library, no
  flow, no plugins, API key only in the logs.
- **Flow editing.** Editing inputs such as `keepLanguages` from the UI, with a
  blast-radius preview before committing.

Also out of scope: history charts and rollup tables (counters only); multi-node
UI (the schema reserves `node`, and v1.2 adds remote nodes — the IA leaves room
but builds nothing).
