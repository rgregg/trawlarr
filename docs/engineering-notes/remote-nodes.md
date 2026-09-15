# Remote nodes — divergences and seams

Written at the end of the remote-nodes phase (`docs/superpowers/specs/2026-09-13-remote-nodes-design.md`).
`docs/engineering-notes/p2-prerequisites.md` is P2-scoped (its own sections are titled P2b/P2c/P2d);
this feature landed after P2 as its own spec, so it gets its own file rather than another P2 section.

These are findings from execution that are **not derivable from the code or the spec**, in the same
spirit as `p2-prerequisites.md`: reviewed, adjudicated, and recorded so the next phase does not
relitigate them.

## Daemon startup order is load-bearing

Lock → adopt leased jobs → `hub.attach` → sweep/reaper/first tick. A daemon refused the lock exits
before touching anything else, so it can never move another daemon's leases into `grace` — the
adopt step only runs for the daemon that actually won the lock. Adoption itself has to run before
`hub.attach`, because the hub needs the adopted leases' `grace` state to exist before a reconnecting
node's `hello` can be answered; and both have to run before the reaper's first pass, or a lease this
daemon just adopted into `grace` looks exactly like a `running` row with a dead worker and gets
reaped as a local stall instead of waiting out its grace window. Reordering any pair of these
reopens one of those races.

## `drain({ includeRemote: false })` and `supervisor.stop()` skip remote slots

A daemon shutting down cancels its own local workers but never a job running on a remote node: the
node keeps running, its own process is unaffected by this daemon exiting, and there is no
correctness reason to interrupt it. What the daemon does own is not stranding the *row* — a remote
cancel is durable via `job.cancel_requested_at` on the job row rather than a live signal, so a
`stop()` that drops the socket immediately still delivers the cancel once the node reconnects
(`packages/server/src/daemon/supervisor.test.ts:1029`, `1015`). This is the same reasoning as the
existing "worker cancellation" invariant in `p2-prerequisites.md`, extended to a node this process
does not supervise a process tree for.

## Offline cancel persisted on the job row, not in memory

`POST /jobs/:id/cancel` against a job whose node is currently offline cannot reach the node, so the
request is written to `job.cancel_requested_at` (migration 013) rather than held as an in-process
flag. An in-memory flag would not survive the daemon restarting while the node was still away, and
this feature's whole premise is that a node can be offline for up to the grace window without losing
anything. The node reads it back on reconnect and cancels locally; `remote-node-end-to-end.test.ts`
proves the round trip across a real disconnect.

## A superseded report on a still-open row that still holds the file is stalled like a release

The spec's error table says a commit refused after grace expiry "changes no ledger state" — true for
the row the reclaiming worker owns. But the *original* node's late report lands on a row that is
still open and still claimed by that original job, because nothing else ever closed it: the reaper
skips leased rows by design (that is what grace is for), and the reclaiming job is a *different* row
entirely. Left alone, that row would sit `running` forever with no worker ever coming back to end it.
So a superseded report on a still-open, still-held row is treated as a stall — it spends an attempt,
the same as a worker that vanished — because a stall is the only mechanism that returns a row to the
queue at all. This is a deliberate, narrow exception to "a superseded report changes no ledger state,"
scoped to the one case where nothing else would ever end the row.

## Node shutdown reports in-flight jobs as `lost`, not `cancelled`

`trawlarr node` stopping (Ctrl-C, service restart, container recreate) kills its forked agents and
reports every job it was still running as `lost` — the same value a genuine crash produces — rather
than sending a `cancelled` final. The reasoning: an agent killed by SIGTERM did not get a chance to
report cleanly, so from the daemon's side a lost job and a killed-mid-shutdown job are
indistinguishable, and pretending otherwise would need the agent to finish its own bookkeeping inside
a shutdown deadline it might not get. A `done` that completes and is queued to send *during* stop is
still sent — shutdown does not discard work that already finished, only work that did not.

## Remote heartbeats are stamped with the server clock

A node's own clock is never trusted for anything the 24-hour stalled-row floor depends on. The server
stamps `heartbeat_at` when it receives a frame, not from any timestamp the node might include, so a
node with a clock skewed a day forward or backward cannot make its own job look stale (or fresh)
relative to the reaper's floor. `hub.test.ts` pins this directly: "stamps remote heartbeats with the
server clock, so a node clock a day behind releases nothing."

## `NodeRepo.authenticate` caches a verified secret digest

Every bundle-file request during a job carries the node's secret, and argon2 at a cost that resists
offline cracking is deliberately expensive — roughly 30ms times however many files a plugin bundle
has, which adds up to real daemon CPU per job if paid on every request. So a secret that verifies
once has its digest cached, and later requests compare against the cache. Revocation is re-read on
every call regardless of the cache, because a revoked node must be refused immediately, not after its
cache entry happens to expire. A wrong secret always pays the full argon2 cost — never short-circuited
against the cache — so a timing side-channel cannot distinguish "wrong secret" from "not cached yet."
`db/node-repo.test.ts` pins both the cost saving and that a wrong secret is never given a discount.

## Plugin bundles are whole source trees, manifest cached on the walk signature

A bundle is not a diff or a single file; it is the plugin's entire installed directory, because a
plugin can `require()` sibling files trawlarr does not otherwise know about. Recomputing that
manifest (a sha256 per file plus the aggregate `bundleHash`) on every request would mean re-hashing
every file in every plugin on every job, which is wasted work for a directory nobody touched. The
manifest is cached keyed on a walk signature — the full `(relPath, size, mtime)` list — not on a
single newest-mtime check, because a file that is not the tree's newest can still change (a rewrite
to an older-but-different mtime, or a deletion of a non-newest file) and a coarser key would serve a
stale manifest silently. `nodes/bundles.test.ts` pins both invalidation cases.

## A remote replacement's identity is the server's own stat (C-1)

A node's `ReplacedFile.deviceId`/`inode` come from ITS `stat`, and a device
number is per host: an NFS client gets an anonymous `st_dev` that never equals
the server's. Keyed on `dev:ino`, a Replace that swapped nothing reported the
untouched original under a key that no longer matched its row, read as "the
file changed", tripped the no-op limit and went terminal `not_converging`; a
real replacement stored the node's key and poisoned later local comparisons.
So the remote handle, after mapping the report back, re-stats `replaced.path`
on the server and substitutes `deviceId`, `inode`, `nlink`, `mtimeMs`,
`ctimeMs` and `sizeBytes`, keeping the node's content-derived partial `hash`
and `probe`. A path the server cannot stat settles the run as a reported
failure naming it — a stalled attempt is better than a foreign identity.

## A refused commit after a landed Replace is reported, not thrown (I-2)

`FlowAbort` used to leave `runPayload` as a rejection in every case. After
Replace had installed, a later refused commit (operator cancel, lease expired)
threw away `replaced`, and the row was requeued or stalled under its OLD
identity although the disk had changed. Now, once any Replace invocation
recorded an output, the abort returns a `JobReport` (`failed`, not `success`,
`superseded` when it was a `SupersededError`, `replaced` computed as for a
finished flow). The daemon records the identity through `recordReplacement`
(shared with `applyJobReport`) in the cancelled fold and in the superseded fold
while the row still holds the file; a superseded report on a row that already
ended still only appends its outcome, because a newer claim may own the file
and will re-probe it. A remote handle that was cancelled marks such a report
`cancelled`, as it marks a `failed` frame, since the refusal can reach the node
before the cancel does.

## A claim a map edit raced is requeued without spending an attempt (I-4c)

A library or path-map edit between a claim and `prepare` makes the payload
unmappable (`UnmappedPathError`). That is an operator's change, not evidence
about the file, so it settles as `AgentFailure.unmapped` and
`applyJobUnmapped` puts the row back unpenalised with the path in the outcome.
It is not a requeue: `applyRequeue` clears `attemptCount` and the backoff, so a
genuinely failing file that kept losing this race got a fresh retry budget
each time and never reached `failed`. The fold uses core's
`applyReleaseUnpenalised`, which undoes only what the claim changed (`running`
back to `queued`) and keeps attempts, backoff, no-op count and signature; a row
something else moved off `running` meanwhile is left alone. To keep
that from looping (requeue, re-claim onto the same node, fail again), the hub
marks the node's library probe stale on an unmapped `prepare`, and
`onlineNodes` counts no library reachable on a node until a `libraries` frame
arrives after its latest config push, and never one whose roots do not map
under the node's CURRENT map. A probe already in flight when a config was
pushed can still mark the node fresh; the unpenalised fold bounds the cost of
that race to one requeue per probe.

## Path maps: nested entries sit at the same suffix on both sides

`validatePathMap` requires, for every pair of entries where one nests inside
the other on either side, that it nests on both sides AND at the same relative
suffix (`rel(serverA, serverB) === rel(nodeA, nodeB)`). The old rule only
checked the first half, and accepted `/media -> /mnt` with
`/media/tv -> /mnt/shows`: `/media/shows/x` goes out as `/mnt/shows/x` and
comes back as `/media/tv/x`, another file. With both halves, longest-prefix
mapping is a bijection over mapped paths, so every round trip holds.

The run-time round-trip guards stay as defence in depth: `payloadToNode` for
`payload.path`, and now `reportToServer` for `replaced.path` (where a plugin put
its output, which the server never sent). A mismatch there throws
`UnmappedPathError`, which the remote handle's `done` settles as an ordinary
failed attempt (not `unmapped`: the flow ran, and a replacement may have landed).

A map stored before the rule is not rewritten or rejected on read. `NodeRepo`
re-validates on every read and returns the map as stored plus `pathMapError`;
throwing would break `GET /nodes` and leave the operator unable to see what to
fix, and using it silently would allow exactly the wrong-identity record the
rule prevents. A node with a `pathMapError` has no reachable libraries in
`onlineNodes`, `prepare` refuses it as unmapped (for a claim that raced), and
`GET /nodes` and the Nodes tab show the reason. An edit that does not touch the
map (rename, pause) leaves the stored JSON byte for byte; saving a valid map
clears it.

## A claim the daemon died preparing is stalled at start (minor 3)

`prepare` is async (bundle manifests), and the lease is written only after it.
A daemon that dies inside it leaves an open job naming a remote node with no
lease: adoption never sees it, no node has it, and the reaper would wait its
24 h floor. `stallUnsentRemoteJobs` runs at startup after the lock and before
adoption and stalls each as an ordinary failed attempt (it is a crash, not a
cancel). After the lock for the same reason adoption is: a second daemon
refused the lock must not stall the running daemon's mid-prepare claims.

## Test-only seams, honoured only under `NODE_ENV=test`

- `TRAWLARR_PROTOCOL_VERSION_OVERRIDE` — lets a test node claim a different protocol version than the
  one it actually runs, to exercise the mismatch-refusal path without maintaining two builds.
- `TRAWLARR_TEST_LEASE_SWEEP_MS` — the real sweep interval is too slow for a test to wait out; this
  shortens it so grace-expiry tests run in milliseconds rather than the production window.
- `TRAWLARR_TEST_ALLOW_SHORT_GRACE` — the real grace window (an hour) is a production safety margin,
  not something a test should wait for; this allows a much shorter one so the state machine can be
  driven end to end without a real clock.
- The end-to-end harness wraps the node's own ffmpeg invocation with `-re` (read input at native
  frame rate), which is what makes a real transcode last long enough for a test to sever the
  connection mid-`Execute` and observe grace, rather than the job finishing before the test can act.

All four are guarded by `NODE_ENV=test`, so none of them are reachable from a production build no
matter how they are invoked.

## Known gaps

- **A held report carrying a replacement is applied exactly once — proven at the unit level
  (`hub.test.ts`), not end-to-end.** The end-to-end suite's equivalent case
  (`remote-node-end-to-end.test.ts`, "applies a report held across a node restart exactly once")
  exercises the restart-and-redeliver path but with a job that does not itself replace a file; the
  double-apply guard for a replacement specifically is unit-level only.
- **A granted `plugin` commit holds `committing` for the whole plugin run.** Grace never
  expires a committing lease, so a long community plugin that writes near its end and loses
  its connection is reclaimed only by the 24 h floor.
- **Node flapping during payload prepare spends an attempt per in-flight claim.** A node that
  disconnects and reconnects rapidly while the daemon is still building a job's payload (before any
  frame is sent) is not distinguished from a node that took the job and immediately lost it — each
  such window costs the file one attempt. Rare in practice (the window is milliseconds), left as a
  known cost rather than special-cased.
- **The rendered Nodes tab is not component-tested.** `packages/web` has no DOM test setup (no
  `jsdom`/`@testing-library` harness in the workspace), so `nodes-model.test.ts` covers the tab's pure
  logic (status labels, `unreachableSummary`, path-map validation) but nothing renders the actual
  React tree in CI. Consistent with the rest of `packages/web`'s test suite, which is model-only
  throughout, not a gap specific to this feature.
