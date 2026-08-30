# AGENTS.md

Guidance for coding agents working in this repository. This is the canonical file;
`CLAUDE.md` (Claude Code) and `GEMINI.md` (Gemini CLI) are symlinks to it, so edit
`AGENTS.md` and every agent sees the change. Codex and Antigravity read `AGENTS.md`
directly.

## What this project is

Trawlarr drives every file in a media library toward a _known-good state_ defined by a
user-authored flowchart (transcodes, remuxes, tag fixes, cleanup), and re-converges the
library as files, tools and rules change. It runs the community's existing **Tdarr flow
plugins unmodified** — the plugin contract is reimplemented from scratch here;
no Tdarr/Unmanic source is present, and none may be added. Compatibility is
interoperability, not derivation.

`README.md` is the user-facing tour (CLI, daemon, Docker) and is kept accurate — read it
before changing behaviour it describes. The authority on intent is
`docs/superpowers/specs/2026-08-10-trawlarr-design.md`; per-phase plans live in
`docs/superpowers/plans/`, and `docs/engineering-notes/p2-prerequisites.md` records
deliberately-deferred divergences discovered during execution (not derivable from code).

## Commands

Node 22 (`.nvmrc`, `nvm use`) and pnpm 9. `better-sqlite3` prebuilds are Node-22-only.

```bash
pnpm install
pnpm build            # tsc --build, copy SQL migrations into dist, vite build for web
pnpm test             # vitest run --typecheck
pnpm lint             # eslint . && prettier --check .
pnpm format
pnpm check:refs       # tsconfig project references match package deps (CI runs it first)
pnpm audit:licenses
pnpm compat:fetch     # fetch the pinned community-plugin corpus into cache/ (gitignored)
pnpm bench:scan       # synthetic 100k-file scan benchmark
```

Single test file / single test:

```bash
pnpm test -- packages/core/src/ledger.test.ts
pnpm test -- packages/engine/test/compat
pnpm test -- -t 'name of the test'
pnpm test:watch
```

Running the built artifacts: `node packages/server/dist/cli.js …` (the `trawlarr` CLI and
`trawlarr daemon`), `node packages/engine/dist/cli.js --flow f.json --file x.mkv` (the
single-file engine harness). Both require `pnpm build` first. `packages/web` dev server:
`pnpm --filter @trawlarr/web dev`.

Tests are Vitest with **typecheck enabled**: package build tsconfigs exclude `*.test.ts`,
so `tsconfig.typecheck.json` is what type-checks tests. A type error in a test fails
`pnpm test` — that is intentional, because several tests are structural guards written as
type-level literals.

Suites that need real `ffmpeg`/`ffprobe` gate on `test-support/tool-availability.ts`.
Only `ENOENT` skips; a check that _fails_ throws, because a skipped suite is green and
this repo has been bitten twice by silently-skipped real-media tests.

## Workspace layout

pnpm workspace, `packages/*`, strict TypeScript with project references (`tsconfig.json`
at the root references every package except `web`, which builds through Vite).

| Package                  | Role                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@trawlarr/plugin-api`   | Types only: the Tdarr plugin contract (`args`, `details()`, inputs/outputs, injected `deps`).                                                                                                                                                      |
| `@trawlarr/core`         | Pure domain. Identity, facts, the convergence ledger, flow definitions + signature hash, the ffmpeg command model (build → compile to argv), schedule, worker classes.                                                                             |
| `@trawlarr/plugins-core` | First-party flow nodes (Start, Check Video Codec, Begin Command, Set Video Encoder, Execute, Verify Output, Replace Original File).                                                                                                                |
| `@trawlarr/engine`       | Plugin host + executor: validating CommonJS loader, `deps` implementations (`crudTransDBN`, `axiosMiddleware`, injected npm modules), the file-object projection plugins expect, ffmpeg invocation and progress parsing, the flow walker, dry run. |
| `@trawlarr/server`       | SQLite persistence and migrations, scanner, worker supervisor + forked agents, watcher and scan coordinator, REST API and event stream, the daemon, and the `trawlarr` CLI.                                                                        |
| `@trawlarr/web`          | React + Vite UI, served as static files by the daemon.                                                                                                                                                                                             |

Dependencies flow one way: `plugin-api` → `core` → `plugins-core` → `engine` → `server`.

## Invariants worth knowing before editing

**`@trawlarr/core` performs no I/O and reads no clock.** ESLint enforces both
(`no-restricted-imports` on fs/child_process/http/net, `no-restricted-globals` on `fetch`,
and a `no-restricted-syntax` ban on `Date.now()` outside tests). Time enters core as a
`nowMs` parameter. Keep new domain logic pure and push the I/O to `server`/`engine`.

**The signature is the whole flow definition's hash**, not the set of plugins a run
executed — it must be computable _before_ the run it makes unnecessary. It doubles as the
flow's version; there is no separate counter. `isKnownGood` = state `good` **and**
signature equal to the flow's current one, which is how a flow edit re-queues a library.

**"The job succeeded" and "the file on disk changed" are different questions.** Derive
"the library file changed" from the replace step's own output path and identity differing
from the original — never from a node's output number, and never from whether the flow as a
whole reached the end. Conflating them has produced four distinct data-loss/false-converged
defects; `docs/engineering-notes/p2-prerequisites.md` has the case histories, including the
one where a whole library reported 100% converged with nothing transcoded and no errors.

**Terminal states need a human.** `failed` (retry budget spent) and `not_converging` (the
flow keeps changing the file without settling) are never re-touched by the scanner or the
queue; `requeue` is the only way out. Backoff and attempt counting live in
`packages/core/src/ledger.ts`.

**Two workers on one file is how a replacement destroys data.** Hence: atomic claiming in
the DB, `trawlarr run` refusing to drain beside a running daemon, a 24h floor on the stalled-row
reaper (a heartbeat only advances between flow steps, and one step can be a multi-hour
transcode), and cancellation through the process _group_ so a plugin-spawned ffmpeg dies too.

**Nothing is marked missing under a root that cannot be shown to be present.** An unmounted
NAS looks like an empty root; treating that as deletions would purge a library.

**The daemon owns its data directory by a kernel file lock**, not by the pid in
`daemon.json` — every daemon in a container is pid 1, so a pid check would see a dead
daemon's number on itself. A daemon that is killed must not lock the user out.

**The daemon↔agent protocol (`packages/server/src/worker/protocol.ts`) is a wire format.**
Plain JSON only — it becomes the WebSocket payload for remote nodes in v1.2. `progress`
and `log` are liveness only; nothing durable may depend on one arriving.

**Plugins are unsandboxed, by design and by documentation.** They run in-process as the
service user. Don't add code that implies otherwise; a dry run must stop at the first node
whose side effects the engine cannot vouch for (`executor/vouchable.ts`).

## Conventions

- **No third-party plugin code in the tree.** The compatibility corpus is fetched to
  `cache/` at a pinned SHA for PR CI; a nightly workflow re-runs it against upstream
  `master` and opens an issue on drift.
- **No committed binary media fixtures** — generate them with `lavfi testsrc` at setup.
- Tests live next to the code as `src/**/*.test.ts` for units; cross-cutting and
  end-to-end suites live in `packages/*/test/`. `docker/*.test.ts` asserts the compose
  contract and entrypoint.
- SQLite migrations are forward-only, numbered files in
  `packages/server/src/db/migrations/`, copied to `dist` by the package's `build:sql`.
- Commit messages are `type(scope): a sentence saying what changed and why it matters`,
  lowercase, often stating the invariant rather than the file — e.g.
  `fix(engine): never install a replacement bigger than the file it replaces`.
- Comments in this codebase explain _why_, frequently citing the defect that motivated the
  rule. Match that: a non-obvious guard should say what breaks without it.
