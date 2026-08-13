# P2 prerequisites and known divergences

Carried out of P0–P1 (the foundations and engine) and the ffmpegCommand fidelity pass.

These are findings from execution that are **not derivable from the code or the spec**. Each was
reviewed, adjudicated, and deliberately deferred rather than forgotten. Most are latent today and
become real the moment a specific P2 component lands, so each names its trigger.

The design spec (`docs/superpowers/specs/2026-08-10-trawlarr-design.md`) remains the authority on
intent. This file records only what execution learned.

---

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
- **Plugins are arbitrary code.** Process isolation is not a security sandbox; installing a plugin
  runs its author's code as the service user. Documented in the README deliberately.

---

## Testing lessons that cost real time

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
