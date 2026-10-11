# Targeted Scans — Design Spec

**Date:** 2026-10-10
**Status:** Implemented on the `spec/targeted-scan` branch
**Extends:** [the design spec](2026-08-10-trawlarr-design.md) §3.3 (scanning) and the scan
coordinator's rules in `packages/server/src/daemon/scan-coordinator.ts`.

---

## 1. Purpose

When a file is added, changed, renamed or removed in a library, trawlarr should examine
that file — not walk every folder of the library to find it.

Today every trigger (a watcher event, the interval, startup, `POST /libraries/:id/scan`)
ends in the same whole-library walk. That is correct and currently cheap (about 30 seconds
for 5,400 files), but its cost grows with the library while the thing that changed stays
one file.

### 1.1 Goals

1. A scan can be limited to a list of paths, files or folders, inside one library.
2. The file watcher feeds the paths it already sees into that scan, with no configuration.
3. Sonarr, Radarr and Lidarr can post their own webhook straight to trawlarr, with no
   script in between.
4. The periodic full scan stays. It is the backstop for everything nobody reported.

### 1.2 Non-goals

- **Not Tdarr's `/api/v2/scan-files` wire format.** The behaviour matches Tdarr's (a
  library plus a list of paths is a targeted scan; no paths is a full one), the request
  shape is trawlarr's own. Accepting Tdarr's shape so that `tdarr_inform` and
  `tdarr_autoscan` work unmodified is a possible follow-up, not this work.
- Not a per-event reading of \*arr payloads (see [§5.2](#52-the-arr-endpoint)).
- Not a change to how one file is identified, probed, queued or guarded.
- Not a removal or retuning of the interval scan.

### 1.3 What Tdarr does, and where this differs

Tdarr's scan API takes a library id, a path or list of paths, and a mode. A list of file
paths in `scanFolderWatcher` mode is its targeted scan; its folder watcher has a "file
system events" option and an hourly find-new scan as the documented fallback. \*arr
integration is done by community tools in front of that API, subscribing to Import,
Upgrade, Rename and Delete.

Two deliberate differences:

- **Folders are accepted, not only files.** Tdarr loses a library's history when handed a
  sub-folder. Trawlarr's identity is `(device, inode)` then content hash, never the path,
  so a folder is simply a smaller walk.
- **Reported paths accumulate into one scan per library.** Tdarr users report UI lock-ups
  from many individual scan calls, and a scan request answered OK and then ignored because
  another was running. The coordinator's existing one-scan-per-library rule already
  prevents both, and is kept.

---

## 2. The scoped scan

`scanLibrary` gains one optional input:

```ts
/** Absolute paths inside this library's roots: files or folders. Absent means the whole library. */
scope?: readonly string[];
```

With `scope` absent, nothing about a scan changes.

### 2.1 What a scoped scan walks

For each scope path, in order:

- **A folder** is walked with `walkFiles`, exactly as a root is today: same extension
  filter, same reserved-directory pruning, same refusal of trawlarr's own working files,
  same "one bad directory never aborts the walk".
- **A file** is yielded directly if its extension is one the library wants and its name is
  not a working-file name. No directory is read.
- **A path that does not exist** yields nothing. It still matters to
  [§2.3](#23-marking-files-missing).

Reserved-directory pruning is evaluated against the **library's roots**, not the scope
path, so a folder reached through a symlink alias of a root is still recognised
(`createSubtreeMatcher` is built from `library.roots`).

The scoped walk does not rely on its caller having validated the paths. It has its own
guards and skips:

- any scope path outside the library's roots;
- any path reached through a symlink below a root (the full walk never follows a directory
  symlink, so a path that only exists through one is never library media);
- any file inside a reserved directory.

### 2.2 What happens to each file

Unchanged. Every yielded file goes through the existing loop body: `observeFile`, the
in-flight guard (`isInFlightOutput`), `upsertScanned`, probing between transactions,
incremental commits. No part of that logic is moved or copied — the scoped scan changes
what the loop iterates over, not what it does.

This is the reason for the design. That loop is where four data-loss defects were fixed;
a separate single-file function would mean extracting it.

### 2.3 Marking files missing

A full scan marks a row missing when the completed walk did not see it. A scoped scan
cannot use that rule: almost every row is outside the scope.

A scoped scan considers a row for missing **only if its recorded path is a scope path or
lies under one**, and then applies every existing condition unchanged:

- the row is not already missing, not `running`, and was not seen by this scan;
- the root containing it is shown to be available (`rootIsAvailable`);
- `lstat` of the row's path fails with `ENOENT` specifically.

Candidates are found by a path-prefix query on `media_file`, not by listing the library.
The query compares the recorded path as a byte range, not with `LIKE` and not with a
length-based prefix, so a path's characters (`%`, `_`, multi-byte text) cannot hide rows.

Ordering is what makes renames and upgrades correct, and it is the full scan's ordering:
present files are observed first, the missing pass runs last, and only after the scoped
walk ran to completion.

| Event | Scope contains | Result |
|---|---|---|
| New file | the file, or its folder | Row created and queued |
| Rename, same inode | old and new path, or their folder | New path observed first; identity matches, so the row follows the file. Nothing is left at the old path to mark |
| Upgrade: old file deleted, new file added | both, or their folder | New row for the new file; the old row is confirmed gone and marked missing. If the filesystem hands the deleted file's inode to the new file, the identity rule (inode first) records one row that moved and changed, re-probed and re-queued, rather than a new row plus a missing one. A full scan gives the same outcome |
| Deleted file or folder | the path | Rows at or under it are confirmed gone and marked missing |
| File moved, only the old path reported | the old path | The row is marked missing although the file exists at its new path. It stays marked until a scan observes the new path; the row then follows the file by identity and the mark is cleared. A full scan would never have marked it, because it observes the new path before its missing pass. "Forget missing" used inside that window discards the history of a file that still exists |
| Share unmounted | anything | Root not shown available: nothing is marked |

### 2.4 What a scoped scan skips

The orphaned working-file sweep. It stays with full scans: it is tidying, it needs the
whole picture of what running jobs own, and a day-old threshold makes hourly plenty.

### 2.5 Reporting

`ScanSummary` gains `scopedPaths: number | null` (`null` for a full scan). The
`scan.progress` and `scan.finished` events are otherwise unchanged, so the web UI needs no
change to keep working.

---

## 3. The coordinator

`ScanCoordinator.request` gains an optional third argument:

```ts
request(libraryId: string, reason: ScanReason, paths?: readonly string[]): void;
```

`ScanReason` gains `'notify'` for a request that arrived over the API with paths.

A request with no paths is a **full** request. A request with paths is a **scoped** one.
The coordinator's existing rules hold, extended as follows.

1. **One scan per library at a time.** Unchanged.
2. **Paths accumulate.** Scoped requests that arrive while a scan is running are collected
   into one set and run as one scoped scan when it ends. `pending` therefore stops being a
   bare reason and becomes either "full" or a set of paths.
3. **Full supersedes scoped.** If anything pending is a full request, the catch-up scan is
   full and the collected paths are dropped — the full scan covers them.
4. **Watch paths settle; notified paths do not.** A watcher event still arms the
   `scan.settleMs` timer and every further event resets it, as today; the difference is
   that the events' paths are kept. A `'notify'` request is not debounced: an \*arr sends
   its webhook after the import is finished, and a burst of them is already collapsed by
   rule 2. A watcher event settles **whether or not a scan is running**. A scan in flight
   is not a substitute for the settle period: a scoped one ends in milliseconds, and a
   file still being written would be probed the moment it did. A burst that finishes
   settling while a scan is still running joins that scan's catch-up (rule 2).
5. **Overflow becomes a full scan.** More than `SCOPED_PATH_LIMIT = 200` distinct pending
   paths for one library is treated as a full request. A constant, not a setting.
6. **The interval and startup scans are always full.** Unchanged, and still re-armed
   unconditionally.
7. **A failed scoped scan is followed by one full scan.** Its paths existed only in the
   plan that failed, so they would otherwise be lost until the next interval scan. The
   full scan is folded into whatever else is pending. A failed full scan is not retried
   this way; that would loop for as long as whatever broke it stays broken.

---

## 4. Feeder 1: the watcher

`WatchInput.onChange` already receives the path of every event. The coordinator's handler
changes from `request(library.id, 'watch')` to `request(library.id, 'watch', [path])`.

- File events (`add`, `change`, `unlink`) scope to the file.
- Directory events (`addDir`, `unlinkDir`) scope to the directory.
- Events for trawlarr's own working files are already dropped in the watcher and stay
  dropped.

No setting is added: `scan.watchEnabled` already governs the watcher, and a watch-triggered
scan becoming narrower is not something an operator needs to choose.

The watcher's limits are unchanged and are why the interval scan remains: over NFS it only
sees writes made through the same host's mount.

---

## 5. Feeder 2: the API

Both endpoints use the daemon's existing authentication (`X-Api-Key`, or a signed-in
session).

### 5.1 Paths on the existing scan endpoint

`POST /libraries/:id/scan` accepts an optional JSON body:

```json
{ "paths": ["/library/movies/Some Film (2001)"] }
```

- No body, or no `paths`: a full scan, exactly as today. Existing callers are unaffected.
- `paths` present: each must be an absolute path, inside one of the library's roots, not
  inside a reserved directory. If any is not, the request is refused with `400` naming the
  first offending path, and nothing is queued.
- More than `SCOPED_PATH_LIMIT` paths is refused with `400`, saying to omit `paths` to
  scan the whole library. The coordinator would run such a request as a full scan, so the
  response could not truthfully say `"scoped"`. The count is checked before any path is
  looked at, so an oversized list costs nothing per path.
- A body that is present but is not a JSON object (an array, a string, a number) is
  refused with `400`. Read as "no `paths`" it would queue the full walk the caller was
  avoiding.
- The check is lexical: the handler reads nothing from the filesystem. It runs on the
  daemon's only thread, and a synchronous stat of a network directory per request is the
  stall this project removed from the watcher and the walk. The same holds for the start
  of the scan the request triggers, which runs on the handler's stack: the scan reads the
  real paths of the library's roots and reserved directories once, without blocking,
  before it validates or walks anything, and re-validates the scope canonically from
  those. The cost of the lexical check: a path spelled through a symlink alias of a
  library root is refused here, so spell the path the way the root is spelled.
- The response stays `202` and says which kind was queued: `"mode": "full" | "scoped"`.

Paths here are trawlarr's own paths. No mapping is applied.

### 5.2 The \*arr endpoint

`POST /notify/arr` takes the webhook body Sonarr, Radarr or Lidarr sends, unmodified.

**It scopes to the folder, not the file.** The payloads name files in different fields for
import, upgrade, rename and delete, and differently per application. Every one of them
carries the folder of the series, movie or artist. The endpoint reads exactly one value:

| Application | Field |
|---|---|
| Sonarr | `series.path` |
| Radarr | `movie.folderPath` |
| Lidarr | `artist.path` |

and requests a scoped scan of that folder. One rule then covers import, upgrade, rename
and delete, at the cost of re-checking a series folder rather than one episode. A scoped
scan of an unchanged folder changes nothing, so over-reporting is harmless.

Handling, in order:

1. `eventType` of `Test` → `200`, nothing scanned. The \*arr's own Test button must pass.
2. `eventType` of `Grab` → `200`, ignored: nothing has been imported yet.
3. No folder field present (health and update events) → `200`, ignored.
4. The folder is translated through `scan.notifyPathMap` ([§5.3](#53-path-mapping)).
5. The library whose root contains the translated path is found. None → `422`, with a
   message naming the path as received, the path after mapping, and the libraries' roots.
6. `request(library.id, 'notify', [folder])`, and `202` with the library id and the path.

The library lookup and the scope check in steps 5 and 6 are lexical, for the reason given
in [§5.1](#51-paths-on-the-existing-scan-endpoint): a path spelled through a symlink alias
of a library root is refused, so spell the mapping the way the root is spelled.

Any other `eventType` that carries a folder is scanned. The list of events is the \*arrs'
to grow; refusing unknown ones would turn an upgrade of Sonarr into a silent gap.

One URL serves all three applications and every library.

### 5.3 Path mapping

The \*arrs and trawlarr usually mount the same storage at different paths (`/data/...`
against `/library/...`).

A new setting, `scan.notifyPathMap`, holds a list of prefix pairs in the shape remote
nodes already use (`PathMapping` in `packages/core/src/path-map.ts`), validated by the
same `validatePathMap`. In each pair `nodePath` is the prefix as the \*arr reports it and
`serverPath` is the prefix as trawlarr sees it: the \*arr stands where a node does.
Default: empty, meaning paths are taken as received.

In the web UI it is its own section under Config, labelled "Notification paths". It
shares the table styling of the Nodes tab's path map; it is not that editor.

---

## 6. Failure handling

| Situation | Behaviour |
|---|---|
| Webhook arrives while the daemon is down | Lost. The interval scan finds the file |
| Watcher misses an event | The interval scan finds the file |
| Path outside every root, or under a reserved directory | Refused; never walked |
| Scope path vanishes between request and scan | Treated as not existing ([§2.1](#21-what-a-scoped-scan-walks)) |
| Scoped scan throws | Reported through the coordinator's `onError`, as a full scan is; the lock is released; one full scan follows ([§3](#3-the-coordinator), rule 7) |
| Daemon stopping | Pending paths are abandoned with the other catch-ups; the startup scan is full |

Nothing durable depends on a notification arriving.

Two limits:

- **A library on a case-insensitive mount (CIFS, casefold ext4) is unsupported for scoped
  scans.** The containment guard compares a path's real path with the path as spelled,
  and `realpath` on Linux does not correct case. A differently-cased spelling of a
  reserved directory is therefore not recognised as reserved.
- **With `scan.rescanIntervalMs` set to 0 there is no backstop.** A lost notification or
  a missed watcher event is then never made up for; the rows of this table that end in
  "the interval scan finds the file" do not apply.

---

## 7. Testing

- **Scanner, scoped:** each row of the table in [§2.3](#23-marking-files-missing) is a
  test against a real temp directory. Plus: a row outside the scope is never marked
  missing however the scope is spelled; a scoped scan performs no working-file sweep; a
  running job's output inside the scope is still refused by the in-flight guard.
- **Scanner, cost:** a scoped scan of one folder in a library of N folders opens the same
  number of directories for N = 2 and N = 40.
- **Coordinator:** paths accumulate during a scan into one catch-up; a full request
  supersedes pending paths; overflow becomes full; watch paths settle and notify paths do
  not. Against the existing fake watch port and injected timers.
- **API:** the scan endpoint with and without a body; each refusal; the \*arr endpoint
  against one recorded-shape payload per application and per event family, written by hand
  from the \*arrs' documented fields (no third-party fixture files).
- **End to end:** a daemon on a temp library, a file added, and the row appearing without
  a full walk.

---

## 8. Verified against the installed applications

Read from the production Sonarr 4.0.20, Radarr 6.4.4 and Lidarr 3.1.0:

- All three expose the webhook settings fields `url`, `method`, `username`, `password` and
  `headers`, so `X-Api-Key` is sent as a custom header from each. No custom-script fallback
  is needed.
- Webhook triggers available:
  - Sonarr: On File Import (Download), On Import Complete, On File Upgrade, On Rename,
    On Series Delete, On Episode File Delete, On Episode File Delete For Upgrade.
  - Radarr: On File Import (Download), On File Upgrade, On Rename, On Movie Delete,
    On Movie File Delete, On Movie File Delete For Upgrade.
  - Lidarr: On Release Import, On Upgrade, On Rename, On Track Retag, On Artist Delete,
    On Album Delete.
- The API resources for series, movie and artist all carry a `path` field.
- Not observed: Lidarr's webhook payload field `artist.path`. It is inferred from Lidarr's
  artist API resource and from the other two applications, not read from a delivered
  webhook.

---

## 9. Documentation

- `README.md`: the scan section says what triggers a scan and that watcher and notified
  scans are scoped.
- `docs/deployment.md`: how to add the webhook in each \*arr (URL, header, which triggers
  to tick) and how to set the path mapping.
