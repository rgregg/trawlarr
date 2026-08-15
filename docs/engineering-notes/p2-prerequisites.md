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

### Flow validation must reject duplicate node ids

Nothing validates node-id uniqueness anywhere. The executor builds a `Map` keyed on node id, so a
duplicate silently drops a node. Separately, `flowDefinitionHash` sorts with a comparator that never
returns 0, so two flows differing only in the array order of duplicate-id nodes can hash
differently.

Spec §6.5 defers flow validation to P2. It must include this check, which also retires the
comparator issue.

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

### Worker cancellation needs a process group

`child.kill('SIGKILL')` signals only the direct child. In P1 that child *is* ffmpeg, so cancellation
works. Once workers are their own child processes and third-party plugins can spawn ffmpeg outside
our runner, cancellation will not reach those descendants. Spec §4.6 promises the process tree — give
the worker its own process group and kill the group.

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
