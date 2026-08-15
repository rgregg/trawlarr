# Trawlarr

Trawlarr is a media library transformation engine. It drives every file in a
media library toward a _known-good state_ defined by a user-authored
flowchart of processing steps — transcodes, remuxes, tag fixes, cleanup — and
converges the library toward that state as files, tools, and rules change
over time.

Trawlarr runs the community's existing Tdarr flow plugins unmodified. It is a
new implementation of the plugin host, built from a from-scratch design, not
a fork or a derivative of Tdarr's server or UI code.

## License

Trawlarr is MIT licensed. See [LICENSE](./LICENSE).

Trawlarr contains no code from
[Unmanic](https://github.com/Unmanic/unmanic). It began life as a fork of a
project maintained by [Josh.5](https://github.com/josh5), and this codebase
credits that lineage, but this repository is a ground-up rewrite: nothing
here is copied from that fork, from Tdarr, or from Tdarr_Plugins.

Compatibility with Tdarr is **interoperability, not derivation**: Trawlarr
implements the plugin contract (the shape of `args`, plugin metadata,
inputs/outputs) that the community's flow plugins already expect, so those
plugins run unmodified against a different, independently written host. No
Tdarr source is present in this repository.

## Plugins run as the service user — there is no sandbox

Installing a community plugin means downloading and executing that plugin
author's JavaScript directly, in the same process and with the same
privileges as the Trawlarr service itself. Trawlarr does not sandbox, isolate,
or restrict plugin code in any way. A plugin can read and write anything the
service user can, and can perform arbitrary I/O and network access.

Only install plugins from sources you trust. Trawlarr does not — and, as
currently designed, cannot — protect you from a malicious or compromised
plugin.

## Status

Early. There is no HTTP API, no UI, no filesystem watcher, and no scheduler
yet. What exists is a `trawlarr` command-line tool that can point at a real
folder of media, scan it, and drain the queue against real `ffmpeg`/`ffprobe`
— see "Try it" below — plus the libraries behind it.

The pnpm workspace holds five packages:

| Package                  | What it is                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@trawlarr/core`         | Pure domain logic: file identity, fact extraction, the convergence ledger, flow definitions and their signature hash, and the cooperative ffmpeg command model (build → compile to argv). No I/O.                                                                                     |
| `@trawlarr/plugin-api`   | Types for the Tdarr flow-plugin contract — the `args` object, `details()` metadata, inputs/outputs, and the injected `deps`.                                                                                                                                                          |
| `@trawlarr/plugins-core` | The first-party flow nodes that exist today: Start, Check Video Codec, Begin Command, Set Video Encoder, Execute.                                                                                                                                                                     |
| `@trawlarr/engine`       | The plugin host and executor: a validating CommonJS loader, the `deps` implementations (`crudTransDBN`, `axiosMiddleware`, and the injected npm modules), the file-object projection community plugins expect, ffmpeg invocation with progress parsing, the flow walker, and dry run. |
| `@trawlarr/server`       | SQLite persistence (connection setup, forward-only migrations, identity-preserving upsert, atomic claim), the library scanner, the unattended worker loop that drains the queue, and the `trawlarr` CLI itself.                                                                       |

### Try it

`@trawlarr/server` builds the `trawlarr` CLI: point it at a real folder of
media, give it a flow, and it will scan, queue, and drive every file toward
that flow's known-good state.

```bash
pnpm build

trawlarr() { node packages/server/dist/cli.js "$@"; }

trawlarr library add --name Movies --root /path/to/media
trawlarr flow add --name HEVC --file flow.json
trawlarr library set-flow --library Movies --flow HEVC
trawlarr scan --library Movies
trawlarr run
trawlarr status
```

`scan` walks the library's roots, probes whatever changed, and queues
anything that doesn't match the flow's current signature — including
nothing, on a library that's already converged. `run` drains the queue one
file at a time, printing each file's path and resulting state. `status`
reports, per library, a count by state and a convergence percentage — the
number the whole project exists to report. State (including which files are
queued, held, or done) lives in `<data-dir>/trawlarr.db`, an ordinary sqlite
file (`--data-dir` defaults to `./trawlarr-data`).

Two states are terminal by design: `failed` (the retry budget is spent) and
`not_converging` (the flow keeps changing the file without settling). Neither
the scanner nor the queue will touch them again, so they need a human:

```bash
trawlarr status --library Movies --files --state failed   # ids and paths
trawlarr requeue --file <id>                              # one file
trawlarr requeue --library Movies --state failed          # all of them
```

`requeue` clears the file's attempt count and backoff and puts it back in
`queued`, so the next `run` claims it.

A row left `running` by a worker that was killed mid-job is reclaimed by the
reaper instead:

```bash
trawlarr reap                            # every row silent for 24h
trawlarr reap --stale-after-hours 48 --dry-run
```

A job's heartbeat only advances between flow steps, and one step can be a
multi-hour transcode, so the threshold is a day and cannot be set below an
hour — reclaiming a file that is still being encoded would put two workers
on it. A reclaimed row counts as a failed attempt (it backs off, and becomes
`failed` once its attempts are spent), never as a free requeue.

**Files that disappear.** `scan` finishes by reconciling rows against the
filesystem: a row whose file is gone is marked missing, which keeps its
history but drops it out of the convergence count and out of the queue.
Putting the file back un-marks it on the next scan. Nothing is marked under
a root that cannot be shown to be present — missing, unreadable, or empty,
which is what an unmounted network share looks like — so a NAS that is
briefly offline never causes a library-wide purge. `scan
--allow-empty-roots` is the explicit override for a root that really is
empty now; `trawlarr status --library Movies --missing` lists what is gone.

A library churns, so missing rows would otherwise pile up for ever. Discard
them — and the job history attached to them — deliberately:

```bash
trawlarr forget --missing --library Movies --dry-run
trawlarr forget --file <id>
```

Each row is re-verified as missing at the moment of deletion, comparing the
file's content identity rather than merely whether its path is free (a better
rip at the same name is a different file, and correctly a different row). A
row whose own file turns out to be back has its mark cleared instead. Rows in
a terminal state (`failed`/`not_converging`) are kept unless asked for with
`--include-terminal` or named with `--file`: their attempt history is the only
record of why trawlarr gave up on that file.

**Trash retention.** Replace Original File moves the original into a
per-library `.trawlarr/trash` directory rather than deleting it, and its
`trashRetentionDays` input (default 14) says how long it is kept. The sweep
runs automatically at the end of every `trawlarr run`, and on demand:

```bash
trawlarr trash purge --library Movies --dry-run
trawlarr trash purge --library Movies --days 30
```

It only ever removes entries inside a resolved trash directory, and only
ones trawlarr itself named — a file you put there by hand is left alone.
Entries are aged by when trawlarr trashed them, not by their file
timestamps.

### The development CLI

`@trawlarr/engine` builds a CLI that walks a single flow over a single file.
It is a harness for exercising the engine, not a product surface.

```bash
pnpm build
node packages/engine/dist/cli.js --flow flow.json --file /media/movie.mkv [--dry-run]
```

It probes the file with `ffprobe`, resolves each node (first-party nodes
in-process, anything else loaded from disk), walks the flow, and prints a step
trace with each node's output number and duration. `--dry-run` walks without
side effects: it reports the exact ffmpeg command Execute would run, and stops
at the first node whose side effects the engine cannot vouch for — which is
every third-party plugin, because a plugin can spawn subprocesses directly.

Transcodes write to a new path. The engine never implicitly replaces a file;
an explicit Replace Original File node is not implemented yet.

### Compatibility harness

The engine is checked against real community plugins rather than mocks. The
corpus is fetched into `cache/` (gitignored) at a pinned upstream revision:

```bash
pnpm compat:fetch
pnpm test -- packages/engine/test/compat
```

The suite skips itself, loudly, if the corpus was never fetched. A nightly
workflow re-runs it against upstream `master` and opens an issue on failure,
so contract drift surfaces as a dated report rather than as a bug much later.

See [`docs/superpowers/specs/2026-08-10-trawlarr-design.md`](./docs/superpowers/specs/2026-08-10-trawlarr-design.md) for the design spec and [`docs/superpowers/plans/2026-08-10-trawlarr-p0-p1-engine.md`](./docs/superpowers/plans/2026-08-10-trawlarr-p0-p1-engine.md) for the implementation plan.

## Development

Requires Node.js 22 (LTS) and [pnpm](https://pnpm.io/) 9.

Node 22 is pinned in `.nvmrc`: if you use [nvm](https://github.com/nvm-sh/nvm), running `nvm use` will select the correct version. `better-sqlite3` ships prebuilt native binaries for Node 22; newer releases may not have prebuilds available yet and compilation would fail.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm audit:licenses
```
