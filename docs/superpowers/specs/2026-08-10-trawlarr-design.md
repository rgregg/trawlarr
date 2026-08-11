# Trawlarr — Design Spec

**Date:** 2026-08-10
**Status:** Approved design, revised after adversarial review, pre-implementation
**Supersedes:** the Unmanic-fork approach. Trawlarr is a from-scratch rewrite in a new
repository under MIT; see [§12](#12-license-and-repository).

---

## 1. Purpose

Trawlarr is a self-hosted media library transformation engine. It drives every file in
a library toward a *known-good state* defined by a user-authored flowchart of
processing steps, and it can tell you at a glance how much of the library has got
there.

It is free software under the MIT license, with no feature gated behind an account and
no component that reports to a network service the operator does not run.

### 1.1 Goals

1. **Tdarr flow plugin compatibility is the highest priority.** Tdarr has a large corpus
   of community flow plugins. Trawlarr's value depends on running them unmodified.
2. **Convergence is the headline metric.** The product answers "how much of my library
   is in the state I asked for?" without the user clicking anything.
3. **A simple, straightforward UI.** Power available, not mandatory.
4. **Multiple libraries** (movies, TV, music) with independent flows and schedules.
5. **One node, many workers, for v1** — with the multi-node seam designed now so that
   adding remote nodes later does not require reworking the engine.

### 1.2 Non-goals

- Not a media server, player, or metadata manager.
- **Not a host for Tdarr *classic* plugins.** See [§2.8](#28-classic-plugins-are-out-of-scope).
- Not a reimplementation of Tdarr's server API. A **narrow** set of host services that
  plugins reach through the args object *is* in scope, because plugins call them
  directly and there is no way to be compatible without them — see
  [§2.9](#29-host-services-reachable-from-plugins). That surface is deliberately small
  and enumerated, not open-ended.
- Not a sandbox for untrusted plugins. See [§4.7](#47-security-posture).

---

## 2. The compatibility contract

This section is the load-bearing part of the spec. Everything else is ordinary
application work; this is where the project succeeds or fails.

The contract below was established by reading Tdarr's published plugin interface
definitions and the community plugin corpus. Trawlarr declares its own types
independently, in its own words, as an interoperability contract. See
[§12.2](#122-licensing-position-on-the-contract).

### 2.1 Plugin module shape

A plugin is a CommonJS JavaScript module exporting two functions:

- `details()` → static descriptor, read at load time to populate the editor palette
  and to render the plugin's configuration form.
- `plugin(args)` → executed per file, returns a routing decision.

Plugins are authored in TypeScript and shipped compiled to JavaScript. Trawlarr loads
the compiled JavaScript.

### 2.2 `details()` descriptor

| Field | Type | Purpose |
| --- | --- | --- |
| `name` | string | Display name |
| `nameUI` | `{type: 'text' \| 'textarea', style?}` | Optional editable-title behaviour |
| `description` | string | Palette and node tooltip text |
| `style` | `{borderColor, opacity?, borderRadius?, width?, height?, backgroundColor?}` | Node appearance in the graph |
| `tags` | string | Search/filter keywords |
| `isStartPlugin` | boolean | Node may begin a flow |
| `pType` | `'start' \| 'onFlowError' \| ''` | Special role; `onFlowError` receives control when a flow throws |
| `sidebarPosition` | number | Ordering in the palette |
| `icon` | string | Palette icon identifier |
| `inputs` | `PluginInput[]` | Configuration fields — see [§2.6](#26-plugin-configuration-forms) |
| `outputs` | `{number, tooltip}[]` | Available outgoing edges, addressed by number |
| `requiresVersion` | string | Minimum host version the plugin expects — see [§2.10](#210-version-reporting) |

### 2.3 `plugin(args)` input object

Trawlarr must materialise this object faithfully. Fields that look incidental are
load-bearing, because plugins read them directly. Every field named here was confirmed
present in the interface definition; the ones flagged *(in corpus use)* were confirmed
by searching the community plugin corpus.

**File and configuration**

- `inputFileObj` — the file being processed ([§2.4](#24-the-file-object))
- `originalLibraryFile` — the file as it was when the flow began, before any step
  modified it
- `librarySettings` *(in corpus use — 30 hits)* — the owning library's configuration
- `inputs` — this node's resolved configuration values
- `userVariables` — `{global, library}`, string maps of user-defined values
- `variables` — mutable per-run state ([§2.5](#25-run-variables-and-the-ffmpeg-command))
- `config`, `configVars` — host configuration, including `configVars.config.pathTranslators`
  and `configVars.config.nodeType`

**Environment**

- `workDir` — scratch directory for this job
- `platform`, `arch`, `platform_arch_isdocker`
- `ffmpegPath`, `handbrakePath`, `mkvpropeditPath`
- `nodeHardwareType` *(in corpus use — 10 hits)*, `workerType` *(27 hits)*, `nodeTags`
- `job` — `{version, footprintId, jobId, start, type, fileId}` *(`footprintId` 14 hits)*
- `isAutomation`

**Callbacks**

- `jobLog(text)` — append to the job log
- `updateWorker(obj)` — report progress and status to the host. **Also the stall
  heartbeat** ([§4.6](#46-job-lifecycle-and-failure-handling))
- `logOutcome(outcome)` — record a terminal outcome string
- `updateStat(db, key, inc)` — increment a counter
- `scanIndividualFile(file, scanTypes)` — re-probe a file mid-flow
- `installClassicPluginDeps(deps)` — **present but always rejects**, since classic
  plugins are out of scope ([§2.8](#28-classic-plugins-are-out-of-scope))
- `logFullCliOutput` — whether to log complete subprocess output
- `lastSuccesfulPlugin`, `lastSuccessfulRun`, `thisPlugin` — introspection handles
  (the upstream spelling of `lastSuccesfulPlugin` is preserved deliberately)

**`deps` — live third-party modules injected into plugin scope**

`fsextra`, `gracefulfs`, `upath`, `axios`, `ncp`, `mvdir`, `parseArgsStringToArgv`,
`importFresh(path)`, `requireFromString(text, relativePath)`, `configVars`, plus two
host services covered separately in [§2.9](#29-host-services-reachable-from-plugins):
`axiosMiddleware(endpoint, data)` and `crudTransDBN(collection, mode, docID, obj)`.

These are real npm packages and their behaviour is part of the contract. Their licenses
are confirmed during the P0 dependency audit ([§12.3](#123-dependency-audit)).

### 2.4 The file object

The file object is ffprobe data plus denormalised bookkeeping fields, and its type
terminates in an open index signature — meaning community plugins read arbitrary
properties. Trawlarr's internal storage is its own design, but the engine must expose a
**projection** into this exact shape per job, and absorb mutations back.

Notable fields:

- `_id` — **the file path.** This is why plugins use `inputFileObj._id` as a filename.
  Note that this is a *path*, and paths are unstable; trawlarr's own identity is
  separate ([§4.2](#42-file-identity)).
- `footprintId` — projected from trawlarr's stable file identity
- `file`, `DB`, `container`, `file_size`, `createdAt`
- `statSync` — `{mtimeMs, ctimeMs}`
- `ffProbeData` — `{streams[], format}` as ffprobe emits it
- `scannerReads` — which probes have run: `ffProbeRead`, `exiftoolRead`,
  `mediaInfoRead`, `closedCaptionRead`
- `meta` — exiftool output (optional); `mediaInfo` — MediaInfo output (optional)
- Denormalised: `video_codec_name`, `audio_codec_name`, `video_resolution`,
  `videoStreamIndex`, `bit_rate`, `fileMedium`, `hasClosedCaptions`
- History: `history`, `oldSize`, `newSize`, `lastTranscodeDate`, `lastHealthCheckDate`
- Scheduling: `bumped`, `holdUntil` — plugin writes to these map onto trawlarr's
  priority and `hold_until`
- **Legacy status enums**, read *and written* by plugins:
  - `HealthCheck`: `'' | 'Hold' | 'Queued' | 'Success' | 'Error' | 'Cancelled'`
  - `TranscodeDecisionMaker`: `'' | 'Hold' | 'Queued' | 'Transcode success' |
    'Transcode error' | 'Transcode cancelled' | 'Not required'`

The convergence ledger ([§5.3](#53-the-convergence-ledger)) is the internal source of
truth. These two enums are projected out of it and written back into it. Omitting them
silently breaks plugins that branch on them.

### 2.5 Run variables and the ffmpeg command

`args.variables` carries mutable state across the whole flow run:

- `ffmpegCommand` — the cooperative command builder, below
- `flowFailed` — boolean
- `user` — user variable map
- `healthCheck` — optional `'Success'`
- `queueTags`, `removeFromTdarr`, `liveSizeCompare`, `automation`

**`ffmpegCommand`** is the mechanism by which several plugins collaborate on one
transcode:

```
{
  init: boolean,
  inputFiles: string[],
  streams: FfmpegCommandStream[],
  container: string,
  hardwareDecoding: boolean,
  shouldProcess: boolean,
  overallInputArguments: string[],
  overallOuputArguments: string[],   // upstream spelling preserved verbatim
}
```

A `FfmpegCommandStream` is **a raw ffprobe stream object with four mutation fields
added**: `removed: boolean`, `forceEncoding: boolean`, `inputArgs: string[]`,
`outputArgs: string[]`. There is no separate map-argument field.

**Compilation** is mechanical, and is trawlarr's responsibility, not the plugins':

1. Emit `overallInputArguments`.
2. Emit each stream's `inputArgs` ahead of the corresponding input.
3. Emit the inputs from `inputFiles`.
4. For each stream where `removed` is false, emit `-map 0:<index>` followed by that
   stream's `outputArgs`.
5. Emit `overallOuputArguments`, then the container-appropriate output path.

**Lifecycle is a state machine the engine enforces**, not a convention:

- A *Begin Command* node sets `init: true`.
- Command-building plugins mutate the structure; they throw if `init` is false.
- An *Execute* node compiles and runs the command, then closes it.
- A subsequent command requires a fresh *Begin Command*.

### 2.6 Plugin configuration forms

Each entry in `details().inputs` is `{label, name, type: 'string' | 'boolean' |
'number', defaultValue, tooltip, inputUI}`, where `inputUI` specifies:

- `type`: `dropdown | text | textarea | directory | slider | switch | codeEditor`
- `options[]` for dropdowns; `sliderOptions: {min, max}` for sliders
- `style` — arbitrary presentation overrides
- `onSelect` — a nested map that rewrites other input values when a value is chosen
- `displayConditions` — conditional visibility: a `logic: 'AND' | 'OR'` over `sets`,
  each itself a `logic` over `inputs` of `{name, value, condition}`, where `condition`
  is one of `=== !== > >= < <= includes notIncludes`

The editor must implement all of this. Rendering plugin config as a flat key-value
table makes correctly-functioning community plugins look broken.

### 2.7 Flow serialisation

Tdarr serialises a flow as `{name, description, tags, flowPlugins[], flowEdges[]}`.
Trawlarr stores flows in a structurally compatible shape so that v1.1 import is a
translation of node identifiers rather than a redesign.

### 2.8 Classic plugins are out of scope

Trawlarr implements **one** plugin generation: flow plugins. The older classic
generation is not supported, in v1 or later.

Rationale: classic support would require a second execution contract, and in Tdarr it is
reached through a bridge plugin that depends on host API endpoints
(`api/v2/read-plugin`) and on installing arbitrary npm packages at runtime
(`installClassicPluginDeps`) — a meaningful amount of surface, and the runtime-install
path is the least defensible thing in the whole contract. Flow plugins are also where
Tdarr's own development went.

Consequences for the contract:

- `installClassicPluginDeps` exists on the args object but **always rejects**, with a
  message naming the limitation, written to the job log.
- A flow containing a classic-bridge node fails validation with a clear explanation at
  edit time rather than at run time ([§6.5](#65-flow-validation)).

### 2.9 Host services reachable from plugins

Two `deps` entries are calls back into the host. Both are confirmed in community plugin
use, so neither can be a no-op — a silent stub makes popular plugins produce wrong
answers rather than errors.

**`crudTransDBN(collection, mode, docID, obj)`** — a document store. Observed modes:
`getById`, `insert`, `update`, `removeOne`. Observed usage:

| Collection | Used by | Semantics |
| --- | --- | --- |
| `F2FOutputJSONDB` | `processedAdd`, `processedCheck` | Plugin-owned skip-list of processed files |
| `SettingsGlobalJSONDB` | `pauseUnpauseAllNodes` | Host settings; doc `globalsettings`, key `pauseAllNodes` |

Implementation: a generic plugin-owned document table in SQLite keyed by
`(collection, docID)` handles arbitrary collections. Known **host** collections are
handled by an explicit allowlist mapping onto trawlarr's own settings — so
`SettingsGlobalJSONDB.globalsettings.pauseAllNodes` really does pause the workers.
Unknown keys within a host collection are ignored with a job-log warning. This is worth
getting right: without it `processedCheck` reports "not processed" for everything, and
users' skip-lists silently stop working.

**`axiosMiddleware(endpoint, data)`** — an HTTP call to the host API. In the current
corpus this is used *only* by the classic-plugin bridge, which is out of scope, so no
general API shim is required. Trawlarr implements it against a **small allowlist** of
endpoints it genuinely supports (`api/v2/scan-individual-file`, mapping onto the same
probe path as `args.scanIndividualFile`). Any other endpoint rejects with an explicit
"unsupported host endpoint" error naming the endpoint, in the job log and the step
trace. Failing loudly with a name is what makes an incompatibility a five-minute fix
instead of a bug hunt.

### 2.10 Version reporting

Plugins declare `requiresVersion`. Trawlarr reports its own version plus a declared
**contract level** — the Tdarr plugin-contract revision it implements. When a plugin
requires more than the declared level, trawlarr runs it anyway but records a warning in
the step trace and marks the node in the editor. Claiming a contract level trawlarr does
not implement, in order to silence warnings, is explicitly rejected as a strategy: it
converts clear startup warnings into confusing runtime failures.

### 2.11 Required external binaries

ffmpeg, ffprobe, HandBrake CLI, mkvpropedit, exiftool, and MediaInfo. exiftool and
MediaInfo are required because the file object exposes their output. The `scannerReads`
flags let trawlarr populate those lazily — only when a flow needs them — rather than on
every scan.

---

## 3. Architecture

### 3.1 Process model

One **server** process and N **worker** child processes.

The server owns the database, scanner, scheduler, HTTP/WebSocket API, and worker
supervision. Each worker runs one job at a time in its own OS process.

Workers are separate processes for four concrete reasons:

1. Third-party plugin code can crash, leak, block the event loop, or call
   `process.exit`.
2. `importFresh` semantics require a clean module registry per job.
3. Hard cancellation means killing a process tree, ffmpeg included.
4. Per-job memory can be bounded.

**The decision that protects the multi-node future:** workers never share memory or
touch the database. They speak a documented JSON job protocol over their IPC channel.
In v1.2, the identical protocol runs over WebSocket for remote nodes — a local worker
is simply *a node with one worker on the IPC transport*. There is only ever one code
path, which is what prevents the usual rot where local works and remote does not.

### 3.2 Packages

pnpm workspaces monorepo.

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `@trawlarr/plugin-api` | Type declarations for the contract; published for plugin authors | — |
| `@trawlarr/core` | Domain: library, file, flow, job, ledger. **No IO.** | `plugin-api` |
| `@trawlarr/engine` | Flow executor, plugin host, file-object projection, ffmpeg command compiler | `core` |
| `@trawlarr/server` | API, SQLite repositories, scanner, scheduler, supervisor | `core`, `engine` |
| `@trawlarr/node-agent` | Worker entry point; forked locally in v1, standalone later | `engine` |
| `@trawlarr/web` | React + Vite UI | `plugin-api` (types only) |
| `@trawlarr/plugins-core` | First-party MIT plugin set | `plugin-api` |

`core` and `engine` remaining IO-free is what makes the flow engine testable without a
filesystem or a subprocess.

### 3.3 Data store

SQLite in WAL mode, one file. **The server is the only process that ever opens the
database.** That is what keeps SQLite viable permanently: remote nodes receive job
payloads over the wire and never connect to the store. Backup is copying one file, and a
stock install needs no second container.

Migrations are forward-only numbered SQL files applied at startup, with the schema
version recorded in `setting`. Refusing to start on an unknown-future schema version
prevents a downgraded binary from corrupting a newer database.

**Synchronous-driver constraint.** `better-sqlite3` is synchronous, so a naive scan that
writes 100,000 rows in one transaction blocks the event loop and freezes the API and
WebSocket for the duration. Bulk work is therefore **chunked into bounded transactions
with yields between them** (target: no single transaction exceeding ~50 ms), and the
scanner is explicitly written as an incremental pipeline rather than a batch job. If
benchmarking in P2 shows this is insufficient, the fallback is moving database access
onto a worker thread; the repository layer is written so that this does not leak into
callers.

### 3.4 Data directory layout

A single configurable data directory (`/config` in Docker, following the convention the
target audience already expects):

```
trawlarr.db            SQLite database (+ -wal, -shm)
config.yaml            Bootstrap settings only: port, data paths, log level
plugins/               Synced remote plugin sources, one directory per source
logs/jobs/             Per-job logs, retention-capped
cache/                 Test/plugin corpus caches; safe to delete
```

Runtime settings live in the database and are edited through the UI. `config.yaml` holds
only what is needed to reach the database, so there is exactly one source of truth per
setting.

**Job workspaces are not here.** A workspace under `/config` is on a different
filesystem from a NAS-mounted library, which makes atomic replacement impossible and
degrades it to a long copy with a corruption window. Instead each library resolves its
own staging directory, defaulting to a hidden directory at the library root (so
`rename(2)` is atomic), configurable per library, with cross-device staging detected at
library setup and surfaced as a warning that names the consequence. Library trash lives
beside each library for the same reason.

### 3.5 API surface

REST over HTTP for state changes and queries, one WebSocket for live updates. The UI is
purely a client of this API — no privileged path — so anything the UI can do is
scriptable, which is what makes trawlarr composable with `*arr` tooling.

| Group | Endpoints |
| --- | --- |
| Libraries | CRUD, trigger scan, library stats summary |
| Files | Paginated/filtered query, per-file detail with run history, requeue, hold |
| Flows | CRUD, templates, validate graph, dry run / trial run |
| Plugins | List installed, sources CRUD, sync source, plugin details |
| Jobs | List, detail with step trace, log fetch, cancel |
| Nodes/workers | List, set worker counts by class, pause/resume |
| System | Health, version, contract level, detected binaries and hardware |

The WebSocket carries worker progress, job state transitions, log tails, and scan
progress. It is strictly a push channel for things that change second-to-second;
everything durable is fetched over REST, so a dropped socket degrades liveness and never
correctness.

An API key authorises non-browser clients, sent as a header.

---

## 4. Execution

### 4.1 Scanner

Three triggers, one code path:

- **Full walk** — new, changed, and deleted files detected by identity plus `size + mtime`.
- **Filesystem watch** — chokidar with debounce for near-real-time pickup.
- **Cron rescan** — catches what the watcher missed; network mounts drop events.

New or changed files are probed, and their ledger signature is recomputed.

Probing is the expensive part of scanning, so it runs at a bounded concurrency and is
resumable: a scan interrupted at 60,000 of 100,000 files does not restart from zero.

**Library roots may not overlap.** A file belonging to two libraries would be driven
toward two different known-good states by two flows, fighting indefinitely. Overlap is
rejected at library creation and re-checked when a root is edited.

### 4.2 File identity

**Identity is not the path.** Radarr and Sonarr rename files routinely on quality
upgrades and metadata refreshes. Keying on path means a rename reads as a delete plus a
new file, so an already-converged file is reprocessed from scratch — repeatedly, on
precisely the libraries this tool targets.

Identity resolution order, per library:

1. `(device, inode)` where the filesystem reports stable inodes.
2. A **partial content hash** — head bytes, tail bytes, and exact size — when the inode
   is absent or has changed. This survives copies, moves across devices, and filesystems
   that renumber.
3. Otherwise treat as a new file.

Path is an attribute of the record, not its key. This identity is what trawlarr projects
into the contract's `footprintId`, and it is what lets the ledger survive a library-wide
rename.

**Hardlinks.** A file with `nlink > 1` is very likely hardlinked into a torrent client's
download directory and still seeding. Replacing it either breaks the link or mutates the
seeded copy. Such files are **skipped with a warning by default**, overridable per
library, and filterable in the file table so the situation is visible rather than
mysterious.

**Companion files.** Libraries contain `movie.en.srt`, `.nfo`, artwork and similar. A
flow that changes container renames the primary file's extension and would orphan them,
breaking the media server's association. Each library carries a companion-extension
policy; companions are renamed alongside the primary file, and a flow that changes
container warns at validation time if no policy is set.

### 4.3 Queue and claiming

The queue is a query, not a subsystem: `media_file` where `state = 'queued'`, ordered by
priority then discovery time, filtered by worker class, node tags, and library affinity.
Derived state cannot disagree with file state.

**Claiming must be atomic.** A plain read-then-assign lets two workers take the same
file and transcode it twice into each other's output. Assignment is therefore a single
conditional statement — `UPDATE media_file SET state='running', … WHERE id = (SELECT …)
AND state='queued' RETURNING …` — inside one transaction. The server being the sole
writer makes this straightforward, but it must be written this way deliberately.

### 4.4 Worker classes and hardware limits

Workers have a **class** (v1: `transcode` and `health`), which is what the contract's
`workerType` reports and what plugins branch on. Pool sizes are per class.

Separately, workers declare a **hardware type** (`nodeHardwareType`), and hardware
carries its own concurrency cap independent of pool size — consumer NVIDIA cards impose
NVENC session limits, and exceeding them fails jobs rather than queuing them. So "six
transcode workers, at most two using NVENC" is directly expressible, and a node that
detects no GPU will not be handed GPU-requiring work.

### 4.5 Scheduling

The supervisor owns pool size: a base count per worker class, overridden by **schedule
windows** that each carry counts. "Two transcode workers 08:00–23:00, six overnight" is
directly expressible, and pausing is a window with zero.

Windows are evaluated in an explicitly configured timezone, not the host's, so a
container with `TZ` unset does not silently shift everyone's overnight window. Ambiguous
and skipped local times at DST transitions resolve to the earlier real instant, and this
is stated rather than left to discovery.

### 4.6 Job lifecycle and failure handling

1. Server atomically claims a file for a worker.
2. Worker opens a workspace in the library's staging directory.
3. `FileTransport` materialises the input at a local path ([§4.8](#48-filetransport)).
4. Engine walks the graph, reporting steps and progress by heartbeat.
5. Terminal nodes publish results. In File transfer mode, `Replace Original File`
   becomes a server-mediated operation — which is precisely why replacement is an
   explicit node.
6. Workspace is cleaned; outcome and a fresh probe are returned.

**Stalls:** every job heartbeats through `updateWorker`. No progress for **30 minutes**
(configurable) → kill the process tree including ffmpeg → requeue with
`attempt_count++` and exponential `hold_until` backoff of **5, 25, 125 minutes**. Past
**3 attempts** → `failed`, log retained. Long legitimate operations must report progress;
a plugin silent for half an hour is indistinguishable from a hung one, and this
expectation is documented for plugin authors.

**Flow errors:** a plugin that throws routes to a node with `pType: 'onFlowError'` if the
flow has one; otherwise the job fails with the step trace intact.

**Logs:** per-job file on disk, tailed to the UI over WebSocket, with a retention cap so
a runaway plugin cannot fill the disk.

### 4.7 Security posture

**This is process isolation, not a security sandbox.** Plugins are arbitrary JavaScript
with filesystem and network access, executing as the service user. Installing a plugin
means running its author's code. Tdarr is identical in this respect. The documentation
states this plainly rather than implying safety.

The web UI supports an optional single password and assumes a reverse proxy for TLS and
any richer authentication.

### 4.8 FileTransport

One interface, three implementations, so that plugins always receive a resolved local
path and remain unaware of how it got there.

| Implementation | Milestone | Behaviour |
| --- | --- | --- |
| Local | v1 | Paths used directly |
| Direct access | v1.2 | Node has the library mounted; a path-mapping table translates server paths to node paths |
| File transfer | v1.2 | Server sends the file to the node and collects the result |

**User-facing naming:** the modes are called **Direct access** and **File transfer**.
Tdarr's `mapped` / `unmapped` vocabulary appears only inside
`configVars.config.nodeType` where plugins can see it, and never in the UI or
documentation. Node setup asks a plain question — "Can this machine reach your library
files directly?" — and probes a sample library path to pre-select the likely answer. The
mapping table is self-describing: *the server sees `/media/movies`* → *this node sees ___*.

---

## 5. Domain model

### 5.1 Tables

`library`, `media_file`, `flow`, `plugin`, `plugin_source`, `job`, `job_step`, `node`,
`plugin_document`, `setting`.

`media_file` stores identity (`device`, `inode`, `content_hash`), current `path`, the raw
ffprobe JSON, and denormalised columns — `video_codec`, `audio_codec`, `resolution`,
`duration`, `bitrate`, `container`, `size`, `nlink` — so that filtering 20,000 files by
codec does not parse JSON. `exiftool_json` and `mediainfo_json` fill in lazily.

`plugin_document` backs `crudTransDBN` ([§2.9](#29-host-services-reachable-from-plugins)),
keyed by `(collection, doc_id)`.

`job_step` records `(plugin, output_number, duration, log excerpt)` for every node
traversed. This makes "why did this file get this decision?" answerable by replaying a
file's path through the graph, and is the most valuable debugging affordance in the
system.

### 5.2 Probe facts

A **fact set** is the subset of a file's probed state that convergence reasoning uses:
container, per-stream codec/type/language/disposition, resolution, duration, and size.
Fact sets are recorded before and after every run, which is what makes both the
signature and convergence detection work without speculative execution.

### 5.3 The convergence ledger

Ledger fields on `media_file`: `state`, `signature`, `last_run_id`, `attempt_count`,
`consecutive_noop_count`, `original_size`, `current_size`, `hold_until`, plus the
pre/post fact sets of the last run.

`state` ∈ `unknown | queued | running | good | failed | not_converging | held`.

**Signature:**

```
signature = sha256( flow_definition_hash, file_facts_hash )
```

`flow_definition_hash` covers the **entire flow definition** — graph structure, every
node's configuration, and every referenced plugin's resolved version.

This is deliberately *not* the set of plugins that actually executed. Which plugins
execute depends on running the flow, so a signature defined over the executed subset
cannot be computed before the run it is supposed to make unnecessary — it would be
circular. Hashing the whole definition is computable a priori and correct; the cost is
that updating a plugin on an unvisited branch invalidates files that would not have
reached it. That is the same acceptable over-invalidation already accepted below, and it
also makes a separate monotonic `flow_version` counter unnecessary: the definition hash
*is* the version.

`file_facts_hash` covers the fact set plus size. For v1 this over-invalidates — an
irrelevant metadata change causes re-evaluation — which is acceptable because
re-evaluating a good file is cheap: the flow reaches "not required" without transcoding.
It is never *wrong*, only sometimes wasteful.

Read-tracking (a proxy over the projected file object, hashing only the properties
plugins actually touched) is a v1.1+ optimisation, not a v1 foundation, because a plugin
calling `JSON.stringify(inputFileObj)` collapses it back to tracking everything.

A file is **known-good** when its current signature matches the signature recorded at
its last successful run. Editing a flow or updating a plugin changes
`flow_definition_hash` and so invalidates exactly the affected files, with no "requeue
everything" button.

### 5.4 Convergence detection

Detection is **retrospective**, never speculative. Re-asking a flow "would you process
this file?" is not possible: asking means running, and running means the Execute node
transcodes the file again.

After each run that reports success and claims to have modified the file, compare the
pre-run and post-run fact sets. If they are equivalent within tolerance, the run
accomplished nothing → `consecutive_noop_count++`. At **2**, set `not_converging` and
stop queueing the file.

This detects the real failure — work that changes nothing — rather than a proxy for it,
and it turns Tdarr's silent infinite-loop failure mode into a visible count on the
dashboard.

**Recovery:** `not_converging` and `failed` are both terminal until acted on. A manual
requeue — per file, or bulk from a filtered table view — resets `consecutive_noop_count`
and `attempt_count` and returns the file to `queued`. Editing the flow does the same
automatically for affected files, since the signature changes. Nothing silently retries a
file the system has already given up on.

---

## 6. Flows and safety

### 6.1 Replacement is an explicit node

The engine never implicitly replaces a file. `Replace Original File` is a node the author
places deliberately, so a flow's destructive effects are visible in the graph.

Its safety checks live **inside** the node, where they cannot be forgotten, with
tolerances exposed as node inputs:

- Output probes cleanly
- Duration within tolerance of the original
- Expected stream count present
- Size sanity — a 40 GB file becoming 200 MB is a failure, not a success
- Free space checked before work begins
- Hardlink check ([§4.2](#42-file-identity))

Replacement is an atomic `rename(2)` from the library's staging directory. When staging
is unavoidably cross-device, the node falls back to copy-then-rename and says so in the
step trace, because the fallback has a wider failure window and that should be visible.

Failed verification routes out the node's failure output rather than throwing, so flows
can branch on it. A separate `Verify Output` node offers the same checks without the
replacement. Replaced originals go to a per-library trash with default retention of
**14 days or 50 GB per library**, whichever binds first, emptied oldest-first. Companion
files are renamed per the library's policy in the same step.

### 6.2 New flows are scaffolded

A new flow is never blank. It starts as:

```
Start → Check Video Codec → Set Video Encoder → Execute → Replace Original File → End
```

so the shape of a correct, complete flow — including the explicit replacement step — is
visible immediately.

### 6.3 Templates in front, canvas behind

The graph editor is fully capable, because Tdarr fidelity requires it: community flows
contain branches *and cycles*, so any editor that cannot express a cycle cannot import
them. But a new user never has to see it. They pick a template, answer three or four
plain questions, and are done; *Edit as graph* opens the canvas.

v1 templates: transcode to HEVC, remux to MKV, strip unwanted tracks. A *health check
only* template arrives with the health check nodes in v1.1.

### 6.4 Dry run and trial run

A preview cannot be assumed side-effect-free. The engine controls its own nodes, but a
third-party node can spawn a subprocess directly, and no amount of engine cleverness
intercepts that. So there are two honestly-scoped modes:

**Dry run** (default) walks the graph with engine-controlled nodes inert — recording the
exact argv that `Execute` *would* run, and the branch each file *would* take — and
**stops at the first node whose side effects it cannot vouch for**, reporting which node
and why. Every v1 template is built from first-party nodes, so the common case completes
fully. The UI states the limitation rather than implying total coverage.

**Trial run** copies N files into scratch space and lets the flow execute for real
against the copies, then discards them. Fully accurate, including third-party nodes, at
the cost of real transcode time. Offered for small samples.

Reporting the decisions and the exact ffmpeg command a flow would produce is absent from
both Tdarr and Unmanic, and is cheap once the engine exists.

### 6.5 Flow validation

A flow is validated on save and before a library uses it. Validation catches: a
referenced plugin that is missing or whose inputs no longer match, a classic-bridge node
([§2.8](#28-classic-plugins-are-out-of-scope)), an `Execute` without a preceding *Begin
Command*, a container-changing flow with no companion-file policy, and unreachable nodes.

An invalid flow **pauses its libraries with a stated reason** rather than failing every
file individually. Ten thousand identical failures in the job list is not a diagnosis;
one paused library naming the missing plugin is.

---

## 7. Plugin sourcing

Trawlarr ships roughly 10–15 first-party plugins under MIT — probe, codec / resolution /
size filters, set video encoder, set audio codec, begin command, execute, remux
container, verify output, replace original, move file, webhook notify — so a fresh
install can build a working flow with nothing downloaded.

A plugin browser then syncs from a list of **user-configurable git/HTTP sources**, with
Tdarr's community repository as the default entry. Plugins land in the user's data
directory. Trawlarr therefore distributes no third-party plugin code, and each plugin's
license remains its author's concern. Supporting multiple sources also addresses a
long-standing Tdarr gap.

---

## 8. UI

React + Vite + TypeScript, React Flow for the graph, TanStack Query and Table, Tailwind
with a small hand-rolled component set, WebSocket for live state.

| Screen | Contents |
| --- | --- |
| Overview | Per-library convergence percentages, worker strip, space saved, 24h throughput, not-converging count |
| Libraries | List, then detail: filterable file table (codec, container, resolution, size, state, hardlinked), stats charts, scan controls |
| Library setup | Wizard: roots, extensions, companion policy, flow via template gallery, schedule |
| Flows | List, template gallery, graph editor, node config panel, dry run / trial run, validation results |
| Plugins | Installed list, browse and sync from sources, source management, contract-level warnings |
| Nodes | v1 shows the local node only: access mode, path mapping, worker counts by class, hardware caps, tags |
| Activity | Running and historical jobs, per-job step timeline, live log tail |
| Settings | Binary paths, schedule windows and timezone, auth, global user variables |

**Overview is library-centric by decision.** Convergence is the headline; workers are a
secondary strip. The product's question is "is my library done?", not "watch this
transcode finish."

Two requirements rather than polish:

- **Settings save when told.** Explicit Save, visible dirty state, no autosave guessing.
- **Real accessibility.** Keyboard reachability, labelled controls, managed focus, honest
  loading and error states.

---

## 9. Testing

| Layer | Approach |
| --- | --- |
| Domain | Pure unit tests: signature computation, fact-set equivalence, two-strike convergence rule, identity resolution, queue ordering, path mapping |
| Engine | Fake plugins: routing by output number, cycles, Begin/Execute state machine, `onFlowError`, mid-flow crashes, atomic claiming under contention |
| ffmpeg compiler | Golden tests — stream fixtures in, exact argv asserted |
| Compatibility | Real community plugins against probe fixtures, asserting output number and generated argv |
| Host services | `crudTransDBN` semantics against the observed usage patterns; `axiosMiddleware` allowlist rejection behaviour |
| Integration | Real ffmpeg on media generated at setup via `lavfi testsrc`; genuine transcode → verify → replace → trash, including a rename-mid-library case that must not reprocess |
| E2E | Playwright: create a library from a template, run it, watch convergence move |

The compatibility corpus is **fetched into a gitignored cache, never vendored**, which
keeps third-party plugin code out of the tree.

**It is pinned to a commit SHA for pull-request CI**, so a change upstream cannot break
an unrelated PR. A **scheduled nightly job** runs the same suite against upstream
`master` and opens an issue on divergence. That yields both properties — deterministic CI
and a genuine drift alarm — where fetching `master` everywhere would only yield flakiness.

No committed binary media fixtures — generate them.

---

## 10. Milestones

**v1**

| Phase | Deliverable |
| --- | --- |
| P0 | New repository, monorepo scaffold, `plugin-api` types, domain + signature + identity, schema and migrations, dependency audit, CI |
| P1 | Engine: executor, plugin host, file-object projection, ffmpeg compiler, Execute node, host services, compatibility harness green on a pinned plugin corpus. CLI-runnable, no UI. |
| P2 | Service: scanner, identity resolution, queue and claiming, worker classes, supervisor, jobs, logs, REST/WS API, first-party plugins, Docker image. Headless-usable. Scan benchmarked on a synthetic 100k-file library. |
| P3 | UI: all screens in §8, including library stats/browsing and schedule windows |

**P1 precedes anything user-visible deliberately.** It retires the project's central
risk: if community plugins do not run correctly, the premise is wrong and every later
phase is wasted effort.

**After v1**

- **v1.1** — Tdarr flow JSON import; health check / corruption detection nodes;
  signature read-tracking optimisation.
- **v1.2** — Remote nodes: WebSocket job transport, then Direct access path mapping, then
  File transfer.

---

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Tdarr changes the plugin contract | Pinned-SHA compatibility harness plus a nightly drift alarm; a declared contract level that can be bumped |
| Plugins are arbitrary code | Process isolation; documented honestly rather than papered over |
| Host services (`crudTransDBN`) have semantics inferred from usage, not documentation | Tested against observed patterns; unknown collections handled generically; unknown host-setting keys warn rather than silently no-op |
| ffmpeg build differences across platforms | Pin the Docker image's build; treat argv generation as version-sensitive and test on the shipped build |
| Scan performance on very large libraries | Chunked transactions, bounded probe concurrency, resumable scans, benchmarked before P2 is done |
| Identity resolution mis-detecting a rename as a new file | Inode-then-hash resolution with an explicit integration test for library-wide renames |
| The file-object projection is a wide surface with an open index signature | Treat it as a first-class tested component; grow coverage from the plugin corpus |
| Node ecosystem for a long-running media service | Workers isolated as processes; the server does no heavy CPU work |

---

## 12. License and repository

### 12.1 A new repository

The existing repository is a GPL-3.0 derivative of Unmanic. MIT-licensed code cannot
inherit from it, and it cannot be relicensed. **Trawlarr starts in a new, empty
repository, and no file is carried forward from the old tree.**

1. **New repository** for the MIT implementation, keeping the `trawlarr` name.
2. **The existing repository is archived** in place, read-only, still published under
   GPL-3.0 — the license it was released under. Its README gains a pointer to the new
   repository explaining that trawlarr was rewritten from scratch.
3. Logo and branding carry over as Ryan's own work; no code does.
4. Open issues that still describe wanted behaviour are re-filed against the new
   repository as fresh issues rather than transferred, so that no discussion implies code
   lineage.

A clean repository is also the simplest defensible position: there is no history in which
GPL-3.0 files and MIT files coexist, so the provenance question never needs arguing.

The first commit of the new repository is this specification. The README states plainly
that trawlarr contains no Unmanic code, credits Josh.5 for the prior fork's lineage as a
matter of good manners rather than obligation, and describes the Tdarr relationship as
interoperability with the plugin contract rather than derivation.

### 12.2 Licensing position on the contract

Tdarr's interface definitions and its community plugin repository are GPL-3.0.
Trawlarr's position:

- Trawlarr declares its own types, written independently and documented in its own words.
  Field names and type signatures are the functional requirement for interoperability;
  the protectable expression is the source files, which are not copied.
- No Tdarr or community plugin source is vendored into the repository or the Docker
  image. Plugins are fetched at runtime into the user's data directory, and at test time
  into a gitignored cache.
- The first-party plugin set is original MIT work, not derived from community plugins
  that solve the same problem.

### 12.3 Dependency audit

P0 includes a license audit of **every runtime dependency**, not merely the plugin `deps`
modules — including React Flow, whose base package is permissive while parts of the
wider offering are not. The audit is automated in CI so a later dependency bump cannot
quietly introduce an incompatible license.

---

## 13. Decisions log

| Decision | Choice | Rationale |
| --- | --- | --- |
| Stack | Node + TypeScript throughout | Plugins are CommonJS JS with live Node modules injected; any other host language adds a serialisation boundary exactly where compatibility breaks |
| Plugin generations | Flow plugins only; classic **not supported** | Avoids a second execution contract, host API endpoints, and runtime npm installation |
| Host services | Narrow, enumerated: real `crudTransDBN`, allowlisted `axiosMiddleware` | Confirmed in community plugin use; stubbing them makes popular plugins wrong rather than broken |
| Store | SQLite only; server is sole DB writer; chunked transactions | Zero-config for the common install; remote nodes never connect to the store; sync driver must not block the event loop |
| File identity | `(device, inode)` then partial content hash; path is an attribute | Radarr/Sonarr renames would otherwise discard the ledger and reprocess converged files |
| Known-good | Signature over the whole flow definition + fact set | A signature over *executed* plugins is circular and uncomputable before the run |
| Convergence | Retrospective pre/post fact-set comparison | A flow cannot be asked hypothetically; asking is running |
| Preview | Dry run that stops at unvouchable nodes, plus trial run on copies | Third-party nodes can spawn subprocesses the engine cannot intercept |
| Plugin sourcing | Small first-party MIT set + configurable remote sources | Works offline out of the box; ships no third-party code |
| Home screen | Library-centric convergence | Matches the product's actual question |
| Flow editing | Full canvas, template gallery in front | Cycles are required for Tdarr fidelity; users should not have to face the graph |
| File safety | Replacement as an explicit flow node, checks inside it, same-filesystem staging | Explicit beats implicit; atomic rename requires co-located staging |
| Hardlinks and companions | Skip hardlinked by default; per-library companion policy | Seeding libraries and sidecar subtitles are the norm, not the exception |
| Remote file access | One `FileTransport` interface, three implementations | Matches the contract's own `mapped`/`unmapped` concept; v1 ships local only |
| Mode naming | "Direct access" / "File transfer" | Tdarr's vocabulary is opaque to users; the contract keeps its own terms internally |
| Compatibility CI | Pinned SHA for PRs, nightly against `master` | Deterministic CI *and* a drift alarm, instead of flaky CI |
| v1 extras | Library stats/browsing, schedule windows | Chosen in; flow import and health checks deferred to v1.1 |
| License | MIT, brand-new repository, nothing carried forward | Cannot relicense GPL-3.0 inherited code; a clean repo needs no provenance argument |
