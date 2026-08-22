# P2 prerequisites and known divergences

Carried out of P0–P1 (the foundations and engine) and the ffmpegCommand fidelity pass.

These are findings from execution that are **not derivable from the code or the spec**. Each was
reviewed, adjudicated, and deliberately deferred rather than forgotten. Most are latent today and
become real the moment a specific P2 component lands, so each names its trigger.

The design spec (`docs/superpowers/specs/2026-08-10-trawlarr-design.md`) remains the authority on
intent. This file records only what execution learned.

---

## "The job succeeded" and "the file on disk changed" are different questions

Conflating them caused three separate defects in one task, each rediscovered after the previous was
fixed:

- Persistence was gated on `success && claimedModified`, so a failure *after* a successful Replace threw
  away every record of the replacement. The retry then re-transcoded an already-transcoded file at full
  cost, with generational loss, and pushed the good result into trash.
- `success` was `!result.failed`, but `runFlow` reports `end-of-flow` whenever a node routes to an output
  with no outgoing edge — exactly what `verifyOutput` rejecting or `replaceOriginal` refusing does. Files
  the flow had explicitly rejected were marked `good` on their *pre-transcode* signature, permanently.
- `claimedModified` was derived from Replace reaching output 1, but Replace can swap the file in and
  still return output 2 (swap landed but left hardlinked; media swapped but companions split). Those
  branches changed the filesystem while the row was never updated.

Derive "the library file changed" from the replace step's own output path and identity differing from
the original — never from an output number, and never from whether the job as a whole succeeded.

A fourth instance of the same family surfaced in the P2a final review, and it is the one that
generalises: the fix for the second bullet above was written as a **hard-coded allow-list of two
plugin ids** (Verify Output, Replace Original File). `trawlarr:execute` routes ffmpeg's non-zero exit
to output 2 as well and was not on the list, so a missing hardware encoder — `hevc_nvenc` on a CPU-only
host, the most common first-run misconfiguration for this class of tool — ended the flow at
`end-of-flow`, scored `success = true`, and stored the **pre-transcode** signature as `good`, which
`isKnownGood` then matched forever. A whole library reported "100% converged" with nothing transcoded
and **zero errors anywhere**. Same for a corrupt source, ENOSPC in staging, or an unsupported pixel
format.

The rule that replaced it: *a terminal output the flow author did not route, on a node that is
reporting failure, is not success.* Both halves come from things that already exist — `stopReason ===
'end-of-flow'` is exactly "no edge leaves the output this node took", and the node's own `details()`
declares what its outputs mean (`PluginOutputDescriptor.outcome: 'failure'`, carried onto the step by
`runFlow`). An id list has to be extended for every future first-party node and can never cover a
community plugin at all; a declaration travels with the node that owns the meaning. Undeclared outputs
stay neutral deliberately: inferring "failure" from a tooltip would read a filter node's "no, this file
is not hevc" as a failure and hold files that had genuinely converged.

Also, wire a runner's `log` seam through to the step's `jobLog`. `createExecuteRunner` was built without
one, so `ffmpeg failed (code N): <stderrTail>` — the only record of *why* an encode failed — was
discarded and `job_step.log_excerpt` was empty for the one step that had something to say.

## Scanning and running are separate processes against the same database

`Replace Original File` renames the new file into place, `runJob` probes it, and only then does
`updateAfterRun` record the new identity. **Between those points the on-disk file has an identity no row
claims** — and `trawlarr scan` and `trawlarr run` are separate processes against one WAL database, which
is the normal deployment. A scan landing in that window matched nothing, inserted a second row, and
`updateAfterRun` then hit `UNIQUE (library_id, content_key)` and unwound the run: a ghost row keeping the
**pre-transcode** probe (claimed again after its backoff, re-transcoding the already-hevc file with
generational loss and pushing the good result into trash) beside a second row for the same file, both
eventually `good`. `NEVER_REQUEUE_STATES` cannot help — the file the scanner walked is associated with no
row at all, let alone the `running` one.

Closed in the scanner: a walked file that **no row claims**, at a path an **in-flight run is entitled to
produce** (same directory and stem as a `running` row's path — `Replace Original File` keeps the user's
stem and may only change the container), is not a new file and is left entirely alone. The ordering that
makes it sound: `claimNext` commits `running` strictly before the run can put anything on disk, so any
file a scanner can *see* inside the window is already covered by a `running` row it can read. The
in-flight set is therefore queried **per walked file**, never cached for the length of a scan.

Reserving the identity before the swap was rejected: the pre-swap content key is a guess (a cross-device
replacement copies, a guard can refuse after staging, a run can die mid-swap), and the ledger would stop
being a record of what is on disk. Putting the identity update in "the same transaction as the
observation" closes nothing — the swap is a filesystem operation no sqlite transaction contains.

## A container restart does not change a setting that is already written

Environment variables **seed** settings once and never override, so that a value changed in the UI
survives a restart. The cost is the mirror image, and it bit during the first live deployment: a
container was started with `NUMBER_OF_WORKERS=0` for a deliberately read-only trial, which seeded
`schedule.baseCounts.transcode = 0`. The container was then recreated with `NUMBER_OF_WORKERS=1` — and
that was correctly ignored, so 563 files sat queued with zero running and no error anywhere.

`GET /system/settings` diagnosed it in one line — `NUMBER_OF_WORKERS: ignored-already-set,
matchesEnv=false, live=0` — which is exactly why that provenance reporting was built rather than just
seeding silently. Without it this is an opaque hang, and the operator's compose file says one thing
while the daemon does another.

The deployment guide should say plainly that changing an env var and restarting will **not** change a
setting the daemon has already stored, and point at `GET /system/settings` (or the Settings screen) as
the way to see which variables were applied, which were ignored, and where the live value has drifted
from the file.

## Real media carries streams that cannot be muxed

Found on the first run against a real 5.5 TB library. Some mkv files carry cover-art `mjpeg` streams
with **zero dimensions** (`width=0, height=0`) — degenerate placeholders, often alongside perfectly
valid posters. Trawlarr maps every input stream, and matroska refuses to write a dimensionless video
stream, so the mux fails before a frame is encoded: `dimensions not set` → `Could not write header`.
Proven not encoder-specific: the same file for one second under both `hevc_nvenc` and `libx265`, with
the degenerate stream unmapped, succeeded under each.

The consequence is worse than a failed job: the file burns its three attempts and goes terminal
`failed`, so it can **never** be processed. In that library the three unconverged files out of 563 were
unconverged for exactly this reason — every pipeline that maps all streams chokes on them, and the
incumbent tool had not converted them in two weeks either. A file that defeats every tool tends to look
like a rare curiosity until you notice it is the entire remainder.

The fix must drop *only* genuinely unusable streams. A `1251x1595` mjpeg poster in the same file has to
survive, be copied rather than encoded, and keep its dimensions — this is the same area as the proven
cover-art data-loss bug, so the failure mode of an over-broad rule is destroying artwork in every file
it touches, which is far worse than the bug being fixed.

## A GPU transcode is CPU-bound until decode is offloaded too

Measured on a real 8.4 TB library, converting 1080p/4K episodes with `hevc_nvenc`: load average
**19.56 on 6 vCPU**, CPU 92.9% user with 1.4% idle, ffmpeg processes at 200% and 136% — while the **GPU
encoder sat at 16-31%**. NFS read throughput was 269 MB/s, so I/O was never the constraint. Trawlarr
emits the encoder but no `-hwaccel`, so only the encode runs on the card and the decode saturates the
CPU.

The consequence that makes this worth recording: **raising workers made it slower.** One worker managed
+3 files per five minutes; three managed +2, because the extra processes contended for the same
saturated CPU while the GPU stayed idle. Concurrency is only a lever on the resource that is actually
scarce, and a benchmark on a local SSD with a faked probe cannot tell you which that is — this needed
real media on real hardware.

Anyone reaching for "add more workers" when a transcode is slow should check which of encoder, decoder
and I/O is saturated first. The answer here was none of the obvious ones.

## An allow-list is not a rule

"A terminal output the flow author did not route is not success" was implemented as a hard-coded list of
two plugin ids — `verifyOutput` and `replaceOriginal`. `trawlarr:execute` also routes failure to output 2
and was not on the list, so **an ffmpeg that exits non-zero was recorded as convergence**: the file was
written `good` with its pre-transcode signature, matched by `isKnownGood` on every later scan, and never
retried. Reproduced with `hevc_nvenc` on a CPU-only host — the commonest first-run misconfiguration for
this class of tool — where the CLI reported three files converged, "100% converged", zero errors, and
three untouched h264 files on disk.

Whenever a rule is expressed by enumerating the things it applies to, every future addition silently
opts out. The flow definition already knows which outputs have no outgoing edge and `details()` already
declares what each output means; derive the rule from those.

## A file mid-replacement belongs to no row

Replace renames the new file into place, then the runner probes it, and only afterwards records the new
identity. In that window the file on disk has an identity no database row claims. A scanner walking the
path there matches nothing and inserts a *second* row, after which the runner's identity update hits the
unique constraint and unwinds into a stall. The scanner's `running`-state guard cannot help, because the
file it walked is not associated with the running row.

The ghost row keeps the pre-transcode probe, so after its backoff it is claimed again, the codec check
reads stale facts, and an already-transcoded file is transcoded a second time — generational loss — with
the good result pushed into trash. End state: two `good` rows for one file, "100% converged", one of
them a phantom whose content exists only in trash.

`trawlarr scan` and `trawlarr run` are separate processes against the same WAL database, so this is
ordinary use, not an exotic race. Any window where an on-disk file is claimed by no row is a window a
concurrent scan will find.

## The loop itself must be tested, not only its parts

Tasks 1-9 each shipped with a green suite, a passing review, and empirical verification of their own
behaviour. Then the first end-to-end run of the actual loop — scan, claim, run, scan again — showed the
library **never converges**: a file transcoded to hevc in round 1 was re-queued and re-transcoded in
rounds 2, 3 and 4, indefinitely, with `alreadyGood` stuck at 0 and the stored signature stable the whole
time. On a real library that is an unattended worker re-encoding everything forever, with generational
quality loss on files that were already correct.

Nothing in 987 tests caught it, because every test verified a component against its own contract and the
defect lived in the agreement *between* two components — the signature the runner stores and the
signature the scanner recomputes never matched. This is the third seam bug in this project (scanner vs
trash directories, engine vs server dependency direction, and now runner vs scanner signatures), and the
most damaging, because it disables the feature the whole system exists to provide while every part
reports success.

Keep a test that drives the real loop over a real file for several rounds and asserts it goes quiet —
and asserts the other direction too, that editing the flow makes it noisy again. A fix that converges by
never re-queueing passes the first assertion and destroys the feature just as thoroughly.

## Load-bearing — a P2 component is wrong without these

### The scanner must recompute signatures and move converged files out of `good`

Nothing else transitions a file from `good` back to `queued`, and the queue only ever claims
`queued` or `held`. If the scanner does not recompute each file's signature and compare it against
the stored one, then editing a flow or updating a plugin will silently never re-evaluate anything —
the headline convergence feature stops working with no error anywhere.

Spec §4.1 says signatures are recomputed on scan. Make it explicit in the P2 plan, and test it: edit
a flow, rescan, assert the affected files leave `good`.

This is also what limits the damage from recycled inodes (see *Accepted risks* below).

### `Replace Original File` must re-stat the file

Nothing in P1 re-stats after a transcode, so `file_size`, `oldSize` and `newSize` all report the
pre-transcode value. Every community plugin that compares old against new size — and there are
several — would compute a zero saving.

Note the units: the plugin-facing file object reports **megabytes**, while trawlarr stores bytes.
See *Divergences worth remembering* below.

### Absorbed plugin changes must round-trip `container` and `lastPluginDetails`

`absorbPluginFileObject` currently returns path, health status, transcode decision, hold, bumped and
new size. Real plugins also write `container` (after a remux) and `lastPluginDetails` (processing
notes). Both are silently dropped. Latent only because nothing persists absorbed changes yet — add
them when P2 wires writeback.

When persisting, round `newSizeBytes` to an integer first: the megabyte round-trip is floating point,
so an awkward byte count can come back as `999.0000000000001`.

---

### The filename belongs to the user; only the container is ours

`Replace Original File` takes the **original's stem and the new file's extension**. It must never adopt
the staged file's name: that name is an implementation detail of whatever produced it, and Plex,
Jellyfin, Sonarr and Radarr all identify content by filename, so adopting it renames the user's library
in bulk under an unattended worker. This was briefly changed and caught by running it — `movie.mkv`
came back as `out.mp4` with the sidecars renamed to `out.en.srt`/`out.nfo`.

The change was made to give a test something to observe, because preserving the stem means
`moveCompanions` computes `target === companion` and correctly does nothing. That is the tell: when a
test can only be made meaningful by changing the behaviour it tests, the test is wrong, not the
behaviour. Companion *moving* belongs to `moveCompanions`' own unit tests, where a rename really
happens; the replacement-level test asserts the outcome — companions still beside the new file under
their original names.

The trash entry keeps the original's own name and extension, because a human recovering from trash has
to recognise it.

### A verification check that cannot run is a failure, not a pass

`Verify Output` originally skipped its duration comparison whenever the value was unreadable —
`parseFloat` of a missing field is `NaN`, ffprobe writes a literal `"N/A"`, and a zero-byte original
skipped the size-ratio check too. Each skip was silent, producing `ok` with *zero* reasons. An ffmpeg
run that hits a corrupt region, stops early and exits 0 leaves a truncated output whose duration
element was never written: streams pass, duration is skipped, and a size ratio sitting exactly on the
floor passed a strict `<`. Verification approved it and Replace trashed the good original.

The rule is general: for a gate protecting a destructive step, "I could not check this" must produce a
reason, never a pass, and boundary comparisons must be inclusive on the failing side. This one was
mandated verbatim by the implementation plan and reproduced faithfully — a plan defect, not an
implementer defect, which is why reviewing against the plan is not sufficient on its own.

### Concurrency: check-then-act on a filesystem path is not safe, and `rename(2)` replaces silently

Two failures of this exact shape reached review in one task. The trash directory is per library *root*,
so the trash name derives from the file's basename — and two different files sharing a basename
(`title00.mkv` under two show folders is ordinary for disc rips) collide. Both workers `lstat` the same
candidate, both see `ENOENT`, and the second `rename` unlinks the first original. Both then report
success. A retry counter does not help: it only sees what is already on disk, never what is in flight.
The same shape appears when two files converge on one replacement path (`movie.mkv` and `movie.avi`
both targeting mp4) — the second swap destroys the first's freshly-transcoded output.

Create exclusively instead. Anywhere a destructive step chooses a path by checking whether it is free,
assume two workers choose it simultaneously.

`link(2)` is a tempting primitive here — it fails `EEXIST` atomically and is same-device by construction
— but it needs a fallback, and the fallback is where the bug comes back. Two trigger classes are
ordinary rather than exotic:

- Filesystems without hardlinks: SMB/CIFS without unix extensions, exFAT/FAT32, several FUSE mounts —
  exactly where media libraries live.
- **`EPERM` does not mean "no hardlinks".** With `fs.protected_hardlinks=1`, the kernel default,
  `link(2)` returns `EPERM` whenever the caller neither owns the source nor has read+write on it. A
  container running as PUID 1000 over media owned by another uid at 0644, on plain ext4, hits this on
  every move.

A fallback that degrades to check-then-rename therefore reopens the race permanently, silently, for a
large class of real deployments, while the code reads as safe. Reserve the destination with
`open(path, 'wx')` (`O_CREAT|O_EXCL`) and rename over your own placeholder instead.

`link`-then-`unlink` also has an interruption profile `rename(2)` does not: if the unlink fails or the
process dies between them, the file exists under both names. That is safe for data but not inert — a
later run sees `nlink=2`, refuses the file as hardlinked, and blames the user for a link trawlarr
created. Clean up the link you just made on the failure path, and never report a failure for a
replacement that actually landed.

### Nothing purges the trash

`Replace Original File` declares a `trashRetentionDays` input, but no code reads it and nothing sweeps
`resolveTrashDir()`. Replacement therefore accumulates a full copy of every replaced original for the
life of the library. The node's tooltip says so explicitly rather than implying cleanup that does not
happen, but a retention sweeper is required before replacement is genuinely user-facing — on a library
being transcoded wholesale this is unbounded growth measured in terabytes.

### Cross-device replacement must copy to a temp path on the destination filesystem, then rename

`allowCrossDevice` defaults to `true`, because defaulting to failure would break the common setup where
staging sits on a different mount from the library. That default is only safe because the fallback is
required to land the copy on a temporary path on the *destination* filesystem and finish with an atomic
`rename(2)`. A naive copy written directly onto the destination path would leave a truncated file where
the original used to be if it were interrupted — on the one step in the system that destroys data. The
requirement is stated in the node's own tooltip so it cannot be quietly implemented the naive way.

## Divergences worth remembering

### `file_size`, `oldSize` and `newSize` are megabytes to plugins

Tdarr's contract expresses these in megabytes; trawlarr stores bytes and converts at the projection
boundary. This was found by the compatibility harness, not by reading: an 8 GB file reported as
`8000000000` made `checkFileSize` compute eight exabytes. Corroborated four ways in the corpus.

`bit_rate` is bits per second, matching ffprobe. Do not "unify" the units.

### `deriveShouldProcess` is deliberately broader than upstream

We additionally treat a stream having `outputArgs`, or `forceEncoding`, as needing work. Upstream
would *skip* several of its own plugins standalone as a result — `10BitVideo`, `HdrToSdr`,
`SetVideoBitrate` and `SetVdeoFramerate` all set `outputArgs` without touching `shouldProcess`. Ours
is the intended behaviour; the divergence is recorded at the function.

### Codec flags must be addressed by output index, never by stream type

`-c:v` is a *type* specifier, and ffmpeg resolves `-c` by last-matching specifier. Because cover art
is reclassified to `attachment` but remains a video-typed *output* stream to ffmpeg, a `-c:v` flag
overrides the per-stream copy directive and encodes the poster. Verified against real ffmpeg:
`-c:v libx265` produced `hevc, hevc, aac`; `-c:1 libx265` produced `mjpeg, hevc, aac`.

Any new first-party plugin that sets a codec must use `-c:{outputIndex}`.

### Trimming compiled arguments strips meaningful trailing whitespace

The compiler trims every argument and drops empties, because `ffmpegCommandCustomArguments` splits on
spaces and would otherwise produce empty argv elements that make ffmpeg fail outright. A side effect
is that a metadata value like `title=The Movie ` loses its trailing space. This is byte-for-byte what
upstream does, so matching it is correct for a compatibility project.

---

### Anything trawlarr writes inside a library root must be pruned from the walk

Staging and trash default to `<root>/.trawlarr/staging` and `<root>/.trawlarr/trash` — inside the
library root, deliberately, so a move is a same-device atomic rename. The scanner walks roots and had
no hidden-directory skip, so it ingested both as library media. Confirmed by running the real scanner
over a root containing one real file plus one file in each directory: `added=3`, with rows for the
staged and trashed copies.

Three consequences, the third being the one that corrupts state rather than merely wasting work:

1. A half-written staged transcode is probed mid-write and admitted as media.
2. A trashed file is re-added and re-queued, so trash stops being deletion and becomes a loop that
   resurrects what the user deleted.
3. Identity is `(device, inode)` and a move preserves the inode. So `Replace Original File` trashing
   an original makes the *existing* record match the trashed copy and rewrite its path into the trash,
   while the replacement at the original path is admitted as a second, separate record.

The walk therefore prunes excluded directory subtrees. The rule generalises: **any directory trawlarr
writes into inside a library root must be excluded from the walk by construction**, which is why the
whole `.trawlarr` directory is pruned rather than its two current children. Pruning must use the
segment-aware containment helper — `<root>/.trawlarr-old` is not inside `<root>/.trawlarr`.

Containment must also *canonicalise*, not merely resolve. A configured `stagingDir` of `/media/staging`
where `/media` is a symlink to `/mnt/media` — the shape essentially every Docker media stack uses —
does not match the walked path `/mnt/media/staging/...` under a `resolve`-only comparison, silently
reopening the ingestion bug. One canonicalising helper serves the whole repo; the `realpathSync`-with-
`resolve`-fallback in `packages/engine/src/executor/encode-target.ts` was written for the in-place-write
incident and is the pattern to reuse. Every duplicate of a path-containment check is a latent version of
the same bug — the weaker copy is the one that will be called.

A relative `stagingDir` or `trashDir` is rejected at library-creation time rather than resolved. There is
no defensible base to resolve against: the library has several roots and the service's cwd is meaningless
to the user, so silently choosing one is what made this a bug — a relative value staged multi-gigabyte
transcodes into whatever directory the service happened to be started from, on whatever device that was.
Note that "resolve it at creation time instead" is *not* a fix, and was briefly adopted as one:
`path.resolve` is defined against `process.cwd()`, so resolving early stores the wrong answer rather than
computing it later. Creation also rejects a staging or trash directory that equals or
contains a root: because containment is reflexive, such a configuration prunes the root itself and the
library scans as permanently empty with no error at all. Staging *inside* a root remains the default and
must stay legal.

### `ScanSummary` counters are broader than their names

Two counters mean less than a CLI author would assume, and both are load-bearing for P2a Task 11's
output:

- **`unreadable`** conflates three distinct failures — a file that could not be read, a file whose
  probe failed, and an `IdentityConflictError`. A user seeing "3 unreadable" cannot tell which
  happened. Split it, or label it vaguely, when the CLI reports diagnostics.
- **`updated`** counts rows the upsert touched, not rows whose content changed. A rescan where
  nothing changed at all still reports every file as updated — verified end-to-end: a two-file
  library reports `updated=2` on every scan including no-op ones. Do not print it as "N files
  changed".

`probed` is the counter that means what it says: it increments only where `probeFile` is actually
invoked, so "found 2000, probed 3" is the honest summary line for a rescan.

## Accepted risks

- **Recycled inodes.** A deleted file's inode may be reused, so a new file can inherit an old
  record. It cannot be wrongly skipped, because the signature is recomputed from current probe facts
  and will not match — the damage is limited to inherited attempt counters and size statistics.
- **True duplicate files merge.** Two byte-identical files in one library resolve to a single record
  by content hash, enforced by a unique constraint. Arguably desirable for a transcode ledger.
- **A demoted record keeps its stale path**, so two rows can transiently share a path value. `path`
  is indexed, not unique. The scanner's missing-file handling should clean this up — confirm it does.
- **Resolution labels bucket by width only**, so a vertical 1080×1920 video labels as `576p`. This
  matches the vocabulary community plugins compare against.
- **Only input 0's streams are reachable**; `mapArgs` is seeded per stream from input 0 and no
  first-party flow uses multiple inputs.
- **Per-stream `inputArgs` are hoisted into one global preamble**, so two streams demanding different
  `-hwaccel` values both land and ffmpeg's parsing decides.
- **`canonicalPath` falls back to `resolve` on any `realpathSync` failure**, not only `ENOENT`, unlike
  the narrow catches elsewhere in the same module. Not exploitable: the walker only ever yields paths
  that already exist, so the exclusion side either canonicalises to the same real path or nothing under
  it can be walked anyway. Confirmed by running a fresh-install ordering — staging configured through a
  symlink alias before the directory exists — which prunes correctly once the directory appears.
  Narrowing the catch would risk throwing on the walk path for no proven gain.
- **Plugins are arbitrary code.** Process isolation is not a security sandbox; installing a plugin
  runs its author's code as the service user. Documented in the README deliberately.

---

## An unbounded loop fails as a timeout, which is not a failure

`trawlarr run` without `--max` drains until `claimNext` returns null. That is the correct loop, and it
was also once a nine-minute spin: a regression made converged files claimable again, and the same
three files were re-transcoded until the suite gave up. It surfaced as a **timeout, not a failure** —
the worst shape available, because a drain that cannot end produces no summary, names no file, and
reports no error, while on a real library it is an unattended worker re-encoding the same files with
generational loss.

`runQueue` now bounds claims **per file id per drain**, derived from outcomes rather than from a
number: one claim, plus one more for each time that file ended `held`. Ending `held` is what records a
backoff, and a backoff is the only thing that legitimately makes a file claimable again inside one
drain — so "re-claimed after a real backoff expired mid-drain" keeps working exactly as before, while
"claimable again having converged last time" stops the drain and reports
`LoopSummary.repeatClaimStop`, naming the file, its id, and how many times it ran.
`DEFAULT_MAX_CLAIMS_PER_FILE` (8, above the ledger's `MAX_ATTEMPTS` of 3) caps the allowance outright,
because a backoff that never exhausts would otherwise buy itself one more claim for ever.

Two details worth keeping: the refused claim has already been committed `running` by `claimNext`
before the loop can see it, so it is **requeued** rather than stranded — the loop refusing to run a
file is not the file's fault. And the guard is deliberately a diagnostic, not a repair: it says the
drain was making no progress and stops, leaving the rest of the queue for the next `run`.

## Testing lessons that cost real time

- **A concurrency test that lets the scheduler interleave usually passes against broken code**, because
  racers mostly miss each other. A first attempt at the reservation-race test passed against a lock that
  was provably broken; it was caught only because the result contradicted the prediction. Force the
  interleaving through seams and assert the *invariant* — "exactly one worker claimed the reservation" —
  not the outcome. Asserting the outcome makes the test non-deterministic in both directions.
- **A test that constructs an identity collision cannot test an identity check.** A substitute
  reservation built with `unlink` then `create` got the just-freed inode back from tmpfs, so the "other
  worker's" lock had an identical `(device, inode)` and the ownership check correctly treated it as its
  own. Build the rival by creating a sibling and renaming it over.
- **A frozen clock can make a whole branch unreachable.** The abandoned-reservation reclamation had no
  test at all, and the suite's fixed `CLOCK_MS` (Nov 2023) made `now - mtime` negative against real file
  mtimes, so the branch could not be entered even by accident. Whenever a fixed clock meets a real
  filesystem timestamp, check which direction the subtraction runs.
- **A proxy test can fail the caricature of a bug and not the bug.** After the "Replace changed the file
  but reported failure" defect, the branch was unreachable black-box, so a proxy test was written
  instead. It failed a *last-step-output-number* implementation but passed the shape that had actually
  shipped — so the defect class stayed unpinned while looking covered. Before accepting a proxy, revert
  to the real previous implementation and confirm the proxy goes red. If it does not, inject at the
  composition root instead: the seams passed into the runner are overridable there even when the branch
  is unreachable from outside.
- **"This mutant is unkillable without a brittle test" is usually wrong.** A surviving start-of-job
  heartbeat mutant was accepted on the grounds that only an exact-tick or timing assertion could catch
  it. It could not — a flow with no start node produces zero steps, so the later heartbeat that masked it
  never runs, and the assertion becomes a plain null check. When a mutant looks unkillable, look for an
  input that stops the masking path from running at all, rather than reaching for timing.
- **`toContain` on a formatted number is a substring trap.** `expect(stdout).toContain('0% converged')`
  passes against the string `100% converged`, because `'100% converged'.includes('0% converged')` is
  true. The convergence percentage is the number this product exists to report, it had exactly one
  assertion, and that assertion stayed green when every library was forced to report 100%. Assert with
  the delimiters included (`'(0% converged)'`) or parse the number and compare it numerically.
- **A test that invokes a built artifact silently validates a stale one.** The end-to-end test drives
  `dist/cli.js`, so `pnpm test` alone proves nothing about `src/` unless `pnpm build` ran first. This
  surfaced the hard way: an agent deleted `dist/cli.js` to check the test failed for the right reason,
  and `tsc --build` — being incremental — would not regenerate it, because its build info said the
  output was current. `tsc --build --force` was needed. Any test driving a build output should fail
  loudly when that output is older than its sources.
- **A guard that only runs in production is a guard no test covers.** An `isMain()` check comparing
  `import.meta.url` against a raw `process.argv[1]` path made the installed `bin` a silent no-op —
  package managers install bins as symlinks, which Node resolves in `import.meta.url` but not in the raw
  path, so the two never matched. The end-to-end test could not see it because it invoked the script by
  its real path. When a code path only differs under installation, test it under installation.
- **A rare flake is invisible to single-run verification.** A test asserting that a 1 ms timer had
  ticked failed about one run in fifteen and survived five reviews. When a test asserts a timing side
  effect, assert *order* instead.
- **`describe.runIf(cond)` evaluates before an async `beforeAll` sets `cond`.** The end-to-end suite
  silently skipped every run until someone noticed. Compute such conditions synchronously.
- **Gating a case on `existsSync(path)` makes a renamed fixture skip silently** — which also makes a
  drift alarm pass green. Assert the path exists instead.
- **An assertion can pass while proving nothing.** A sorted-set comparison cannot detect a
  reordering; an expectation derived from the same formula as the value under test cannot detect
  whether the value was read or recomputed. Both shipped and both were caught later.
- **Contract-level tests do not catch semantics-level bugs.** Every test in the fidelity pass checked
  which strings we emit; the cover-art bug lived in what those strings *mean to ffmpeg*, and only a
  real-ffmpeg assertion found it. Keep at least one test per subsystem that runs the real tool.
- **Run the whole gate, not just the tests.** A formatting slip broke CI's lint step for three
  commits while implementers reported "lint clean".
- **A green local build can depend on stale artifacts.** A missing tsconfig project reference passed
  locally for fifteen tasks because `dist/` was always already populated, and failed on the first
  clean checkout. `pnpm check:refs` now guards it.

---

## Retired

- **Worker cancellation now kills the process tree (spec §4.6).** `runFfmpeg` spawns with
  `detached: true`, which makes the child a process-group LEADER, and cancellation sends SIGKILL to
  `-pid` — the group — with the old direct `child.kill` kept as the fallback for a child that never
  got a pid or a group that returns EPERM. A plugin that spawns ffmpeg itself is therefore reached.

  **`detached` has a cost that had to be paid in the same change**, and it is the reason this is more
  than a one-line fix: a detached child is no longer in the terminal's foreground process group, so
  Ctrl-C on `trawlarr run` stops reaching ffmpeg. Every live leader is tracked in
  `packages/engine/src/ffmpeg/process-group.ts`, and the host's `SIGINT`/`SIGTERM`/`SIGHUP`
  (re-raised after our handler runs, so the host still dies of the signal it was sent) and its
  `exit` sweep those groups. Handlers are installed on the first live child and removed with the
  last, so a host that never transcodes has its signal handling untouched.

  Two guards are load-bearing in `killProcessGroup`: pgid `0` means "my own group" and would kill the
  host and every sibling worker, and pgid `1` means "everything I may signal". Neither can be a child
  we spawned, so both are refused rather than translated. And `killFn` is injectable purely so a test
  driving a FAKE child cannot signal a real group — the fake child's pid is `undefined` by default
  for the same reason. A fake pid plus a real `process.kill(-pid)` is a live grenade in a test suite.
- **Flow validation (spec §6.5).** `validateFlowDefinition` in core now gates `flowRepo.create` and
  `flowRepo.update` — the only two doors a definition enters by — and rejects rather than repairs:
  duplicate node ids, an edge naming a node that does not exist, an output number the node's own
  `details()` does not declare, a flow with no start node (or no nodes at all), MORE THAN ONE start
  node, more than one edge leaving a single output, and a malformed document. The last two were added
  on the same reasoning as the first: `runFlow` picks the first match in ARRAY order while
  `flowDefinitionHash` sorts, so both let the route taken — and therefore every convergence decision
  — depend on the order of a JSON array while the flow's version does not move.

  Deliberately allowed: **cycles** (a remediation branch rejoining the main path is one, and
  `DEFAULT_MAX_STEPS` already bounds every flow) and **unreachable nodes** (an `onFlowError` handler
  is reached by no edge at all, and a parked branch is an author's choice; the hash deliberately
  covers unreachable branches, so the cost is a re-evaluation, never a wrong answer). A node whose
  plugin this host cannot resolve is treated as unknown, not wrong — a flow is routinely authored on
  a machine where a community plugin is not installed — and one unresolvable node suppresses the
  no-start-node verdict entirely, because it may be the start.

  This retires the `flowDefinitionHash` comparator concern with no change to `flowDefinitionHash`:
  the comparator does now return 0 for equal keys (fixed earlier, with the reasoning recorded at
  `byKey`), and the residual hazard — two definitions with an identical id set hashing differently
  because two nodes share an id — is unreachable once such a definition cannot be stored.
  `packages/core/src/flow-validate.test.ts` pins both halves.

  Rows written before the check are **not migrated and not revalidated on read**: the executor is
  unchanged, so a live database keeps working exactly as it did, and repairing a stored definition
  would silently change the graph a library is converging against — which IS the flow's identity.
  Such a flow is rejected the next time anyone tries to store it. Note a stored flow can also become
  invalid without anyone editing it, by a plugin update changing what `details()` declares; that is
  why `runFlow` keeps its own `no-start-node` / `missing-node` handling.
- **Plugin version and loader cache key from `requiresVersion`/mtime.** Both now derive from a
  SHA-256 of the plugin file's contents, so a plugin code change invalidates affected files and a
  same-mtime rewrite cannot serve stale code. Spec §5.3's promise that updating a plugin invalidates
  exactly the affected files is therefore true as written.
- **Spec §2.5's claim that no map-argument field exists.** Corrected; `mapArgs` is documented.

## Still inaccurate in the spec — owner's call

- **§5.4** describes two-strike convergence detection "within tolerance". The implementation is
  one-strike with an exact comparison, decided deliberately during P0 because the two-strike rule was
  unreachable and a tolerant comparison false-flagged metadata-only flows.
- **§2.10** describes contract-level reporting and a warning when a plugin's `requiresVersion`
  exceeds ours. Not implemented.
- **§7** anticipates 10–15 first-party plugins, naming "set audio codec, remux container, webhook
  notify" among them. Divergent by the owner's call as of P2d: **a capability that already has a
  Tdarr community flow plugin is not reimplemented first-party.** Trawlarr exists to run that
  ecosystem, and shipping a duplicate node fragments it — two nodes that do the same thing
  differently, and flows that are no longer portable. The first-party set stays at the seven
  host-integration nodes (Start, Check Video Codec, Begin Command, Set Video Encoder, Execute,
  Verify Output, Replace Original File); everything else is installed.

---

## P2b — the daemon phase, and what its end-to-end test found

Written at the end of P2b (`trawlarr daemon`: settings, schedule windows, forked worker agents,
supervisor, watcher, scan coordinator, library health, HTTP API, WebSocket, lock file, daemon-aware
CLI). This section is the record the next phase should read before relitigating anything here.

### Constraints this phase DISCHARGED

- **"Nothing purges the trash"** (recorded above) is discharged for a running daemon.
  `sweepLibraryTrash` is called on a `TRASH_PURGE_INTERVAL_MS` (24h) re-armed timer in `daemon.ts`,
  per library, sequentially, against each library's own flow-declared `trashRetentionDays` — the same
  sweep `trawlarr run` performs, so the retention rule has one definition and not two. One library
  whose trash directory is unreachable is reported and skipped; it never costs the others their
  sweep. Note what is NOT discharged: a deployment that never runs the daemon and only ever invokes
  `trawlarr run` still sweeps only when `run` is invoked.
- **"Stall detection has no watcher."** `reapStalled` now runs on a `REAP_INTERVAL_MS` (1h) re-armed
  timer, so a row left `running` by a worker that vanished (OOM killer, `process.exit()` in a plugin,
  a host reboot) returns to the queue without a human noticing it. Both timers are re-armed in a
  `finally`, deliberately: one failed pass costs one interval, whereas a timer that died costs
  everything for ever and looks exactly like a healthy idle system.
- **"Worker cancellation needs a process group once workers become child processes."** Discharged in
  Task 6. Workers are forked `detached: true`, so a worker's pgid is its own pid and a plugin's own
  ffmpeg grandchildren inherit it; cancellation asks the worker to stop, then signals the whole GROUP
  (SIGTERM, then SIGKILL after a short grace). The daemon's `stop()` drains with a deadline
  (`DEFAULT_DRAIN_DEADLINE_MS`, 5 min) and cancels through that same path past it — an unbounded wait
  would make `systemctl stop` hang for hours, and no wait at all would leave an ffmpeg writing into a
  library with no daemon left to record what it did.

### Constraints that REMAIN OPEN after P2b

- **Absorbed plugin changes still do not round-trip `container` or `lastPluginDetails`** (see the
  section above). Untouched by this phase.
- **`job.log_path` is still NULL.** There are no per-job log files on disk; what exists is each
  step's `logExcerpt` in `job_step` and the live `job.log` frames on the WebSocket.
  `GET /jobs/:id/log` therefore returns a NAMED 501 rather than a 404, so a client author does not go
  hunting for a path they already got right.
- **Contract-level reporting (spec §2.10) is still unimplemented.** `GET /system/version` reports
  `contractLevel: null` with a note saying why: a client that read a level trawlarr does not honour
  would silently enable plugins this build cannot run correctly.
- **Hardware is declared, never detected** (`settings.hardware.available`). Declaring `nvenc` on a
  machine without one produces failing jobs.

### The four design decisions of this phase, and why

**1. Worker concurrency is process concurrency, and the claim happens in the daemon.** A worker is a
forked child process that never opens the database: the daemon claims the file (committing `running`),
builds a self-contained payload, forks, and folds the returned report back in. The reason is not
isolation for its own sake — it is that the scanner's in-flight-output guard depends on `running`
being committed strictly BEFORE any replacement byte can land on disk, and on `listRunningPaths` being
queried fresh per walked file. Both survive N workers by construction under this arrangement, and the
same payload/report split becomes the remote-node transport in v1.2 with no second code path. The
corollary is that every ending of a run must arrive at the daemon as a value: a child that vanished
authored nothing, so only the daemon can write that outcome, and a row left `running` by a dead worker
is a file nothing will ever claim again.

**2. One writer, advertised in a lock file; the CLI becomes a client.** A daemon that owns a data
directory writes `<data-dir>/daemon.json` with `open(path, 'wx')` and removes it on exit. Every CLI
invocation resolves that file first: no file (or a file whose pid is dead — a SIGKILLed daemon leaves
one behind) means open the database directly, exactly as before; a live pid means route every command
through the API with that file's key and never open the database at all. `run` is the one command that
cannot be delegated — it IS a drain, and the daemon is already draining — so it is refused with a
message naming the daemon's pid and its API. The lock is released after the HTTP server is closed and
before the database is, so a CLI that read it a moment ago finds either a daemon that still answers or
no lock at all, never a lock pointing at a port that has stopped listening.

**3. A schedule window sets the target pool size; it never interrupts work in progress.** When the
target falls the supervisor stops starting work and lets running workers retire on completion. The
asymmetry decides it: finishing costs at most one job's remaining runtime past the boundary, once,
while cancelling costs the whole elapsed runtime and pays it again later — in exactly the hours the
window was configured to protect. A user who wants a hard stop has `POST /jobs/:id/cancel`, which is
explicit, per-job, requeues the file unpenalised, and leaves an audit trail. This is asserted directly
by the daemon end-to-end suite: the window is closed to zero workers while a transcode is running, and
that job is required to finish `succeeded`.

**4. Every scan trigger goes through one code path, and the periodic rescan is not optional.** A full
walk, a watch event and the interval all end in `ScanCoordinator.request()`, which calls `scanLibrary`
and nothing else — deliberately with no "just this one file" fast path, however much cheaper it looks,
because identity resolution, the in-flight-output guard, signature recomputation and reconciliation are
one algorithm and a second copy of it on the newest, least-tested path is the copy that will be wrong.
A watch event is a HINT that something moved; the walk decides what it means. Watch events settle per
LIBRARY (not per file) for `scan.settleMs`, so a scan happens once the tree has been quiet rather than
in the middle of a download; and the interval rescan exists because chokidar over NFS/SMB drops events
— the mounts this product runs on are exactly the ones where it does — which makes the interval the
correctness backstop rather than redundancy.

### What the end-to-end test found

`packages/server/test/daemon-end-to-end.test.ts` drives a real `node dist/cli.js daemon` process,
configured only through its own HTTP API, and never issues `scan` or `run` after it starts. It found
one real defect and two latency gaps of the same shape; all three are fixed.

- **A library created through the API was never WATCHED.** Filesystem watchers were derived once, in
  `ScanCoordinator.start()`, over the libraries that existed at that instant — and since the API is
  the only way a UI creates a library, every library created through it had no watch until the daemon
  was restarted. A file dropped into such a library was found only by the periodic rescan, up to an
  hour later, with nothing anywhere saying why; and because the rescan does eventually find it, the
  symptom is a mysterious delay rather than an error. Fixed with
  `ScanCoordinator.syncWatchers()`, which makes the live watches EQUAL the set of libraries: a library
  with unchanged roots keeps the watch it already has (re-creating it would drop inotify
  registrations and lose events in the gap), one whose roots moved is re-watched, and one that has
  been deleted has its watch closed — a watch outliving its row keeps requesting scans of a library id
  `scanLibrary` refuses by name, for ever. `POST`, `PATCH` and `DELETE /libraries` all call it.
- **A newly created library was not walked until the next interval**, so "I added my library and
  nothing happened" was indistinguishable from broken for up to an hour. `POST /libraries` now
  requests a scan, on exactly the reasoning the daemon's own startup already used.
- **Editing a flow, or attaching a different flow to a library, left the library reporting "100%
  converged" under a flow none of its files had ever been run through** until the next interval —
  because `scanLibrary` is the only thing that re-derives a signature and moves a file out of `good`.
  `PUT /flows/:id` now requests a scan for each library attached to that flow, and `PATCH
  /libraries/:id` does so when the flow or the roots changed (and NOT when something cosmetic like the
  name changed: a walk of a 100,000-file library is not the right cost for a rename).

Two properties worth keeping in mind when reading that suite:

- **A pid is not on the event stream.** `job.started` carries `jobId`, `fileId`, `libraryId`, `path`
  and `workerId` — no pid — so "no worker process survived the shutdown" is checked against pids
  sampled from `GET /workers` while jobs were in flight. That is a real API surface, not a peek behind
  the daemon's back, but it does mean a worker that started and finished entirely between two samples
  contributes no pid. Adding a pid to `job.started` would make the check exhaustive.
- **The suite must never be allowed to skip.** Its ffmpeg condition is computed synchronously at
  module scope (`describe.runIf` reads it at collection time, before any async `beforeAll`), and
  `toolAvailableSync` answers `false` only for a genuine `ENOENT` while THROWING for every other
  failure — a spawn that failed under load reporting "ffmpeg is missing" would silently skip the one
  suite that proves the product works, and report green. It also refuses to run against a stale
  `dist/`: editing anything under `packages/server/src`, INCLUDING a test file there, means
  `tsc --build --force` before this suite will run.

---

## P2d — plugin distribution, and what it cost

Written at the end of P2d (`trawlarr plugin source add|sync`, installed-plugin resolution at every
call site, and the `conform-library` template that expresses the owner's real Unmanic pipeline).

### `Verify Output` compared the output's stream count against the ORIGINAL's

The single most expensive finding of the phase. `Verify Output` refused any output with fewer
streams than the input file had — which made **every stream-removing community plugin unusable in
any flow that replaces its original**: `Remove Stream By Property`, `Remove Streams By Type`,
`Set Container` with `forceConform`, and `Keep Stream By Property` all produce fewer streams *by
design*. Each one failed three attempts per file and landed the file in `failed`, with an error
naming the file rather than the check.

One of those four is in the owner's own pipeline, so this was not a hypothetical.

The fix compares against **what the flow's own ffmpeg command intended to write** —
`ffmpegCommand.streams` minus the ones a node marked `removed` — and falls back to "no expectation"
when nothing described one (no Begin Command, so no intent to check). It is one-sided on purpose:
more streams than intended is fine, fewer is not.

Recognise what that removed: an **accidental fail-safe**. The old check happened to catch a filter
that matched everything and deleted all the audio. That protection is deliberately replaced by the
`requireAudioIfOriginalHadAudio` gate — an output with no audio when the original had some is
refused, because a language filter matching nothing removes every audio track and the result probes
perfectly cleanly.

**Why the gate is in the host and not on a node.** A node-level input would protect against the one
plugin that carries it, and only when someone remembered to put that node in the flow. The failure
is not "this plugin misbehaved", it is "the compiled command lost the audio" — which any of ninety
plugins, or a combination of two well-behaved ones, can cause. The host is the only place that sees
the original probe and the output probe, so it is the only place the check is complete.

### `keep_undefined` needed no work — do not "add" it

Unmanic's language filters have a `keep_undefined` option, and the natural assumption is that
`Remove Stream By Property` needs an equivalent. It does not. The plugin reads the property and
returns early when it is `undefined` or `null`, so a stream with no `tags.language` is **never
judged and therefore never removed**. That is exactly `keep_undefined: true`, and it is not
configurable off. Pinned by a compat test so nobody re-derives it, and recorded here so nobody
"adds" the input.

### No `git` in the runtime image

Sources are HTTPS tarballs and local directories, not clones, because the runtime image has no
`git` binary. This is a deliberate constraint, not an oversight: a future phase that wants git
sources must add the binary to the `Dockerfile` first, and weigh that against the image size and
the attack surface of shipping a VCS client in a media transcoder.

### `<data-dir>/plugins` is not scratch

For a tarball source, the extraction **is** the installed plugin — the row in the database points at
the extracted file and the loader reads it there. There is no second copy and no re-fetch on start.
Two consequences:

- `syncSource`'s cleanup is **asymmetric by kind**: a tarball sync removes the previous extraction
  before installing the new one, while a local source is read in place and never cleaned, because
  cleaning it would delete a directory the user owns.
- `<data-dir>/plugins` must be **backed up alongside the database, or re-synced after a restore**.
  A backup that takes `trawlarr.db` and not `plugins/` restores a set of flows naming plugins that
  are no longer on disk.

### The standalone validate endpoint — checked, and already threaded through

This phase's plan carried an item saying `packages/server/src/api/routes/flows.ts`'s standalone
`POST /flows/validate` still constructed a registry-less `createNodeCapabilityResolver()`, so it
under-validated a flow naming an installed plugin. **That is no longer true**: it passes
`{ registry: createPluginRegistry(ctx.db) }` as of `2638a7c`, so `validate` and `store` now answer
the same question. Recorded because the stale item would otherwise be re-opened; the resolver is
registry-less only where there is genuinely no database, which is its documented default.

### Both of the owner's Unmanic pipelines became one flow

His Movies and Shows libraries differ only in whether "Ensure 2ch AAC Audio" sits before or after
"Transcode". In Unmanic that is meaningful: each plugin is its own ffmpeg pass, so plugin order is
encode order. In trawlarr every command-building node contributes to a **single** invocation
compiled once by `compileFfmpegArgs`, and those two nodes touch different streams — so their order
cannot change the argv. One template, `conform-library`, covers both. This is written in
`docs/migrating-from-unmanic.md` §4.3 as well, because "why did my two pipelines become one?" is
otherwise an unanswered question.

### Where the template is NOT parity, and is documented as such

- **`Ensure Audio Stream` adds; `ensure_2ch_aac_audio` converts.** Proven on disk: a file with a
  6-channel English AAC track comes out with the 6-channel track *and* a new stereo one, where
  Unmanic would have left only the stereo. Documented in §4.4 of the migration guide with three
  ways out, including a `Custom Arguments` pan formula that reproduces the downmix exactly.
- **NVENC is unverified.** `hevc_nvenc` takes `-cq` rather than `-crf` and `p1`–`p7` rather than a
  numeric preset, so the translation of the owner's "CRF 23, preset 4" is precisely the thing that
  needs his card. The `libx265` form of the same template is proven end to end against real ffmpeg
  in `packages/server/test/plugin-install-end-to-end.test.ts`; the NVENC form ships beside it,
  generated from the same template and validated, but never executed.

---

## P2c — what the 100k scan benchmark measured

Spec §4.1 says probing "runs at a bounded concurrency and is resumable: a scan interrupted at
60,000 of 100,000 files does not restart from zero", and §3.3 asks that no single database
transaction take much more than about 50 ms, because `better-sqlite3` is synchronous and a long
transaction freezes the HTTP API and the WebSocket with it. `pnpm bench:scan` is what turns those
from assertions into numbers, and `packages/server/test/scan-bounded.test.ts` is what keeps the
properties those numbers depend on from regressing at a size the gate can afford.

**The split is deliberate.** This project never asserts elapsed time — a timing assertion is flaky
in both directions, and this repository has already shipped one that failed one run in fifteen. So
the benchmark *reports* and the suite *asserts*, and they assert different kinds of thing: rows per
committed transaction, HTTP statuses answered while a walk is in flight, probes performed by the
scan that follows an interrupted one, rows marked missing, and the query plan SQLite chooses.
Never a duration. A benchmark that failed CI on a slow machine would be worse than no benchmark; a
benchmark whose properties were unasserted would be theatre.

### The machine these numbers came from

A 6-vCPU KVM guest: Intel Core Processor (Skylake, IBRS, no TSX), 4 GiB RAM, Linux 6.8.0-136,
Node v22.22.1. The library lived on **ext4 on a non-rotational `/dev/sda2`** — a local SSD, not the
NFS the owner's real library is on, so every filesystem number here is a *floor*: NFS makes the
`lstat`/`open`/`read` per file dramatically more expensive, and it is the walk, not SQLite, that
pays that.

`ffprobe` is faked (a `/bin/sh` script printing a fixed document). Real `ffprobe` at 100,000 files
would be a benchmark of `ffprobe`. The consequence is stated plainly below, because it is the whole
argument for or against bounded-concurrency probing.

### What it measured, at 100,000 files

Two passes over the same tree: `cold` (nothing known, every file probed) and `warm` (nothing
changed, every probe skipped).

| | cold, before the fix | cold, after the fix | warm, after the fix |
|---|---|---|---|
| files | 100,000 | 100,000 | 100,000 |
| probed | 100,000 | 100,000 | **0** |
| wall | **3,108,437 ms (51.8 min)** | **771,925 ms (12.9 min)** | 217,358 ms (3.6 min) |
| files/second | **32** | **130** | 460 |
| transactions | 100,000 | 100,000 | **200** |
| max transaction | 661 ms | 374.2 ms | 11.6 ms |
| p99 transaction | 6.8 ms | 6.8 ms | 10.7 ms |
| peak RSS | 155 MB | 143 MB | 419 MB |

The cold pass went from **51.8 minutes to 12.9 minutes — 4.0× — for one index**, and it stopped
decelerating: throughput is flat at ~130 files/s from the first thousand rows to the hundred
thousandth, where before it fell from 150 to 30.

Reading them:

- **`probed: 0` on the warm pass is the headline.** The skip rule works at scale: a rescan of an
  unchanged 100,000-file library spawns no probes at all.
- **The transaction-count asymmetry is intact and is worth 500×.** The cold pass commits 100,000
  transactions, because a file that was actually probed is flushed immediately so that at most one
  probe's work is ever at risk. The warm pass commits **200** — one per 500-row chunk — because a
  file that was *skipped* accumulates to a full chunk instead. Disturbing that asymmetry in either
  direction is the difference between a fast rescan and a pathological one.
- **`p99TransactionMs` meets §3.3 comfortably** (6.8 ms cold, 12.8 ms warm), and a 500-row chunk
  commits in about 14 ms — well inside the 50 ms budget the target is about.
- **`maxTransactionMs` does not, and the outlier is not the row count.** The worst single-row
  commit in the cold pass took **661 ms**. It cannot be the write itself — a one-row insert is
  microseconds — so it is a WAL auto-checkpoint (default 1,000 pages) landing inside that
  transaction and fsyncing the accumulated WAL back into the database. The consequence is real and
  should be said out loud: **a few times per full scan, the API and the WebSocket freeze for a
  significant fraction of a second.** It is rare (p99 is 6.8 ms) and it is not caused by anything
  the chunking controls, so it is recorded here rather than papered over. If it ever needs fixing,
  the lever is an explicit `wal_autocheckpoint`/`PASSIVE` checkpoint policy on a timer outside the
  scan, not a smaller chunk.
- **Peak RSS is not flat, and the cause is reconciliation, not the walk.** `reconcileMissing` calls
  `listByLibrary`, which materialises *every* row in the library — `probe_json` included — into one
  array. With this benchmark's tiny fake probes that cost a few hundred MB; with real probe
  documents (kilobytes each, sometimes far more for many-stream files) a 100,000-file library would
  make that array large enough to matter on a 2 GB container. The walk itself is bounded; the
  reconcile is not. Recorded as a known divergence, not fixed here.

### The finding: the in-flight-output guard was quadratic in the size of the library

The cold pass did not merely run slowly, it **decelerated**: 150 files/s at 5,000 rows, 77/s at
14,000, 68/s at 21,000, 43/s at 26,000, ~30/s at 38,000. Throughput falling as 1/n is the signature
of an O(n) step being paid per file.

It was `listRunningPaths`. `scanLibrary` asks it — `SELECT path FROM media_file WHERE library_id = ?
AND state = 'running'` — for **every walked file that matches no existing row**, and it must keep
asking freshly: a job that started after this scan began still has to be seen, or the scan inserts
a second row for a file an in-flight run already owns, and `updateAfterRun` then collides on
`UNIQUE (library_id, content_key)` and unwinds the run. That freshness is correct and is
deliberately **not** weakened.

What was wrong was the *cost* of asking. No index covered `(library_id, state)`, so SQLite answered
through `media_file_missing_idx` on `library_id` alone: it visited every row in the library and
filtered on `state` afterwards. On a first scan every file is new, so that is one library-wide
index scan per file. Measured directly against the live benchmark database:

| | before | after |
|---|---|---|
| `listRunningPaths`, one call at ~28,000 rows | **15.15 ms** | **0.0115 ms** |
| cold throughput at ~28,000 rows | 43 files/s | 128 files/s |
| cold throughput at ~40,000 rows | ~30 files/s | 126 files/s |

For scale, the sibling identity lookup on the same table (`byContentKey`, which *is* indexed by the
`UNIQUE` constraint) costs 0.007 ms. The guard was three orders of magnitude off its neighbours.

The fix is `005_media_file_running_idx.sql`: a **partial** index,
`ON media_file (library_id) WHERE state = 'running'`. It changes no query, no semantics and no
freshness — only the plan. Partial rather than a plain `(library_id, state)` composite for two
reasons: it contains only the handful of rows that are actually running, so the guard becomes
O(number of running jobs) rather than O(size of library); and it is almost never written to, since
rows enter and leave it on claim and completion rather than on the scan writes that touch every
row. Verified not to disturb the plans for `claimNext` (still `media_file_queue_idx`) or
`countsByState` (still `media_file_missing_idx`).

This is exactly the class of defect a benchmark exists to find: invisible in every suite small
enough to run in CI, and fatal at the size the spec names by number. It is now guarded structurally
— the suite asserts the *query plan*, which is observable state rather than a stopwatch, and fails
if the index is removed.

### Bounded-concurrency probing (spec §4.1): the case for it

*This was the case made from the numbers above, before Task 14 built it. Kept as it was written;
what was actually built, and what it measured, is the section after it.*

Probing was bounded at a concurrency of **one**: `scanLibrary` awaits each `probeFile` before
walking on. Against a fake probe that costs ~7 ms, that is 100,000 × 7 ms and the cold pass takes
about 13 minutes. Against **real `ffprobe` on real media over NFS**, a probe is tens to hundreds of
milliseconds, dominated by process spawn and network round-trips rather than CPU — so the same
100,000-file first scan is somewhere between one and six hours, on a box with six idle cores and a
mount whose throughput is nowhere near saturated by one outstanding request.

The measurement that makes this concrete: with the index fix, the cold pass's cost is now almost
entirely the serialised probe. That is a latency-bound serial loop, which is the case concurrency
helps most and the case where it is nearly free. The structural work that makes it safe is already
done — probing happens strictly *outside* any transaction, and the flush-after-probe rule bounds
what an interruption costs — so a bounded pool changes "at most one probe is at risk" to "at most
N", which is still bounded and still resumable.

### Bounded-concurrency probing, measured (Task 14)

Built as a **window**: files needing a probe accumulate up to `scan.probeConcurrency`, the window's
probes run together, their results are written in one transaction, and only then does the walk
continue. Not a streaming pool, and the reason is the ghost-row fix: `observeFile`'s confirming
`stat` has to be the last `await` before a wholly synchronous block, and a pool would have probes
resolving inside exactly that gap. With a window there is never a probe in flight while the walk is
observing anything — either the walk runs or the window does — so the property holds by
construction rather than by review. The cost is that the walk's own IO does not overlap the probes
(`walk + probes/N` rather than `max(walk, probes/N)`), which is small because the cold pass is
almost entirely the probe term.

Same box, same tree, 100,000 files, `ffprobe` still faked:

| | cold, serial (before) | cold, window of 4 (after) | warm, before | warm, after |
|---|---|---|---|---|
| probed | 100,000 | 100,000 | 0 | 0 |
| wall | 746,680 ms (12.4 min) | **548,900 ms (9.1 min)** | 203,269 ms | 198,108 ms |
| files/second | 134 | **182** | 492 | 505 |
| transactions | 100,000 | **25,000** | 200 | **200** |
| p99 transaction | 6.7 ms | 8.4 ms | 12.2 ms | 9.5 ms |
| max transaction | 360.9 ms | 342.0 ms | 21.6 ms | 42.6 ms |
| peak RSS | 155 MB | 155 MB | 421 MB | 419 MB |

**1.36×, not 4×, and the shortfall is the fake probe rather than the window.** This benchmark's
`ffprobe` is a `/bin/sh` that prints a document and exits: it is *spawn* cost, and spawning is
partly serial in the Node process doing the spawning, on six vCPUs it is competing with itself.
The owner's library is on NFS, where a probe is mostly *waiting* — and waiting is what
concurrency is for. Measured directly, with
`pnpm bench:scan --files 2000 --probe-latency-ms 50 --probe-concurrency N` — a fake probe that
waits 50 ms before answering, which is what a probe over a network mount mostly does:

| probes at once | cold wall | files/second | speedup |
|---|---|---|---|
| 1 | 124,458 ms | 16 | 1.0× |
| 2 | 66,784 ms | 30 | 1.9× |
| 4 | **36,376 ms** | **55** | **3.4×** |
| 8 | 20,491 ms | 98 | 6.1× |
| 16 | 12,602 ms | 159 | 9.9× |

`--probe-latency-ms` was added to the benchmark for exactly this: without it the tool can only
measure the case concurrency helps least.

So the fake-probe number (1.36×) is the FLOOR and the latency-bound number (3.4× at four) is what
the owner's first scan should see: the same 100,000-file scan at a 50 ms probe goes from about 1.7
hours to about 30 minutes. Scaling is near-linear to 8 and falls off after, which is the spawn cost
reappearing.

**The default is 4, and it is not `cpus().length`.** A probe is spawn- and round-trip-bound rather
than CPU-bound, so the cores are not the constraint the number should track — and the scan runs
*beside* the transcodes, which are what the cores are actually for. Four is a floor on the benefit
and a ceiling on the harm. It is configurable end to end (`scan.probeConcurrency`, 1–64,
`TRAWLARR_PROBE_CONCURRENCY`, `PATCH /system/settings`), so a slow mount can have 8 or 16 and a
machine that hates parallel reads can have 1, which is byte-for-byte the old behaviour.

**What an interruption now costs: one window, not one probe.** At most `probeConcurrency` probes
are in flight and unwritten at any instant, so a scan killed mid-walk loses at most that many
probe results and the next scan re-derives exactly those from `probe_json IS NULL`. That is
bounded by the setting and not by the size of the library, it is 4 out of 100,000 at the default,
and the work lost is re-derivable by definition — which is the same argument that made the
one-probe version acceptable, with N substituted for 1. What did NOT change: `reconcileMissing` is
still one call outside the `for await`, reachable only by the walk running to completion, so an
interrupted scan still marks nothing missing.

**The rescan asymmetry is untouched**, and the table above is the evidence: the warm pass still
commits 200 transactions for 100,000 files, because a file that was *skipped* still accumulates to
a full chunk and only a closing window forces a flush. The cold pass's transaction count fell from
100,000 to 25,000 for the same reason it fell in wall time — one transaction per window of four
rather than one per probe.

### What the suite asserts, and why each assertion is there

`packages/server/test/scan-bounded.test.ts`, at 5,000 files — not 100,000, because a four-minute
test is a test people learn to skip:

1. **The in-flight-output guard is answered from an index.** Asserts the `EXPLAIN QUERY PLAN`
   output names `media_file_running_idx` and contains no `SCAN media_file`. The only guard against
   the quadratic defect above, and the only one that can be written without a stopwatch.
2. **No transaction exceeds the chunk size**, and the committed row counts sum to every file, so a
   seam reporting chunks nobody committed could not satisfy it.
3. **A rescan commits in chunks, not one transaction per file.** The skip asymmetry, pinned: a
   100,000-file rescan must pay ~200 transactions, not 100,000.
4. **The API answers 200 while a scan of that size runs** — and the row count it reports *goes up*
   while `scanning` is still true. The second half is the falsifiable one: a scanner that buffered
   every row until the end would answer 200 just as happily and report zero the whole way.
5. **An interrupted scan resumes rather than restarting**: the following scan re-probes at most one
   chunk more than the interruption cost, and a third scan probes nothing.
6. **An interrupted scan marks nothing missing**, a completed scan marks exactly the 100 files that
   went away, and the *next* completed scan marks nothing further — so `missing` is a count of what
   that scan discovered, not a total that grows every hour a daemon is up.
