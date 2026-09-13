# Library Dry Run From the Flow Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Dry run button in the flow editor walks every file the flow governs against the canvas definition and the published one, and shows what would change.

**Architecture:** The engine's dry run already records every Execute decision; it gains which stream types each command encodes. The server's `dryRunFlow` takes a definition override; a pure classifier turns a result into an outcome; an in-memory per-flow run coordinator walks the library in the daemon and groups outcome changes; four routes expose it. The web editor starts a run with the canvas definition, polls it, and renders counts, changes and per-file detail.

**Tech Stack:** TypeScript (strict), Node 22, pnpm workspace, vitest, better-sqlite3, React + Vite.

**Spec:** `docs/superpowers/specs/2026-09-13-flow-dry-run-design.md`

## Global Constraints

- Node 22 for everything (`source ~/.nvm/nvm.sh && nvm use 22`). `better-sqlite3` fails on other versions.
- `@trawlarr/core` does no I/O and reads no clock. `@trawlarr/web` imports only TYPES from `@trawlarr/core` (a runtime import breaks the Vite bundle, core uses `node:crypto`).
- A dry run never writes to the database and never runs ffmpeg.
- A stopped walk is never reported as complete: `incomplete` is its own outcome, never folded into `no-change`.
- UI copy is terse: short labels, no explanatory paragraphs. One line of limits in the panel, nothing more.
- Comments explain _why_; commit messages are `type(scope): lowercase sentence`, ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- `pnpm typecheck` does not cover `.tsx` errors that `pnpm build` catches; run both before committing web work.
- Server e2e suites have a dist freshness guard: run `./node_modules/.bin/tsc --build --force` after editing server/engine sources before running `packages/server/test/*`.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/engine/src/executor/dry-run.ts` (modify) | `encodes` on each `DryRunExecuteDecision` |
| `packages/engine/src/executor/command-encodes.ts` (create) | `commandEncodes(command)` — which stream types a command re-encodes |
| `packages/server/src/flow/dry-run.ts` (modify) | optional `definition` override |
| `packages/server/src/flow/dry-run-outcome.ts` (create) | `classifyDryRun`, `outcomeKey`, `DryRunOutcome` |
| `packages/server/src/flow/dry-run-runs.ts` (create) | `createFlowDryRunCoordinator` — runs, progress, grouping, cancel |
| `packages/server/src/api/router.ts`, `api/server.ts`, `daemon/daemon.ts` (modify) | `dryRuns` on `ApiContext`, shutdown cancels runs |
| `packages/server/src/api/routes/flows.ts` (modify) | four routes |
| `packages/web/src/screens/flows/dry-run-model.ts` (create) | types, labels, stale check, count ordering |
| `packages/web/src/screens/flows/DryRunPanel.tsx` (create) | panel rendering + polling |
| `packages/web/src/screens/flows/FlowEditor.tsx` (modify) | button, panel, publish-dialog line |
| `packages/server/test/flow-dry-run-end-to-end.test.ts` (create) | real ffmpeg end to end |

---

### Task 1: Engine — record which stream types each planned command encodes

**Files:**
- Create: `packages/engine/src/executor/command-encodes.ts`
- Create: `packages/engine/src/executor/command-encodes.test.ts`
- Modify: `packages/engine/src/executor/dry-run.ts` (the `DryRunExecuteDecision` interface and the `!gate.skip` branch of `inertStandIn`)
- Modify: `packages/engine/src/executor/dry-run.test.ts`
- Modify: `packages/engine/src/index.ts` (export)

**Interfaces:**
- Produces: `export interface CommandEncodes { video: boolean; audio: boolean }`, `export const commandEncodes = (command: FfmpegCommand): CommandEncodes`, and `DryRunExecuteDecision.encodes: CommandEncodes | null` (null when the gate skipped).

Why from the command model and not argv: argv spells encoders as `-c:0 libx265`, `-codec:1 aac` or `-c:v hevc_nvenc`, and a positional `-c:N` does not say whether N is video. The compiler already decides "this stream needs an encode" with `forceEncoding || !shouldCopyStream(outputArgs)`; using the same rule means the classification matches the command that would run.

- [ ] **Step 1: Write the failing test** — `command-encodes.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { FfmpegCommand, FfmpegCommandStream } from '@trawlarr/plugin-api';
import { commandEncodes } from './command-encodes.js';

const stream = (codec_type: string, over: Partial<FfmpegCommandStream> = {}): FfmpegCommandStream =>
  ({
    index: 0,
    codec_type,
    codec_name: codec_type === 'video' ? 'h264' : 'aac',
    removed: false,
    forceEncoding: false,
    inputArgs: [],
    outputArgs: [],
    mapArgs: [],
    ...over,
  }) as FfmpegCommandStream;

const command = (streams: FfmpegCommandStream[]): FfmpegCommand => ({
  init: true,
  inputFiles: ['/in.mkv'],
  streams,
  container: 'mkv',
  hardwareDecoding: false,
  shouldProcess: true,
  overallInputArguments: [],
  overallOuputArguments: [],
});

describe('commandEncodes', () => {
  it('reports a video encode', () => {
    expect(
      commandEncodes(command([stream('video', { outputArgs: ['-c:{outputIndex}', 'libx265'] }), stream('audio')])),
    ).toEqual({ video: true, audio: false });
  });

  it('reports an audio-only encode', () => {
    expect(
      commandEncodes(command([stream('video'), stream('audio', { outputArgs: ['-c:{outputIndex}', 'aac'] })])),
    ).toEqual({ video: false, audio: true });
  });

  it('counts a forced encode and ignores tagging-only and removed streams', () => {
    expect(
      commandEncodes(
        command([
          stream('video', { outputArgs: ['-disposition:{outputIndex}', '+default'] }),
          stream('audio', { removed: true, outputArgs: ['-c:{outputIndex}', 'aac'] }),
          stream('audio', { forceEncoding: true }),
        ]),
      ),
    ).toEqual({ video: false, audio: true });
  });

  it('reports nothing for a copy-only remux', () => {
    expect(commandEncodes(command([stream('video'), stream('audio')]))).toEqual({ video: false, audio: false });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm test -- packages/engine/src/executor/command-encodes.test.ts`
Expected: FAIL — cannot find module `./command-encodes.js`.

- [ ] **Step 3: Implement** — `command-encodes.ts`

```ts
import type { FfmpegCommand } from '@trawlarr/plugin-api';
import { shouldCopyStream } from '@trawlarr/core';

export interface CommandEncodes {
  video: boolean;
  audio: boolean;
}

/**
 * Which stream types this command re-encodes, by the compiler's own rule
 * (`compileFfmpegArgs`' `needsEncode`). A dry run reports this so "re-encodes
 * video" and "only rewrites audio" can be told apart without parsing argv,
 * where `-c:1 aac` does not say what stream 1 is.
 */
export const commandEncodes = (command: FfmpegCommand): CommandEncodes => {
  const encoding = command.streams.filter(
    (stream) => !stream.removed && (stream.forceEncoding === true || !shouldCopyStream(stream.outputArgs)),
  );
  return {
    video: encoding.some((stream) => stream.codec_type === 'video'),
    audio: encoding.some((stream) => stream.codec_type === 'audio'),
  };
};
```

- [ ] **Step 4: Wire into the dry run.** In `dry-run.ts` add `encodes: CommandEncodes | null;` to `DryRunExecuteDecision` (with a one-line doc comment: "What the command re-encodes; null when the gate skipped."). In the `!gate.skip` branch push `{ ...gate, nodeId, command: compiled, encodes: commandEncodes(args.variables.ffmpegCommand) }` — computed BEFORE `closeFfmpegCommand`. In the skip branch push `encodes: null`. Export from `packages/engine/src/index.ts`: `export * from './executor/command-encodes.js';`.

- [ ] **Step 5: Extend `dry-run.test.ts`.** Find the existing test that asserts a planned command for a transcode (search `plannedCommands`), and add `expect(result.executeDecisions[0]!.encodes).toEqual({ video: true, audio: false })` for it (adjust the expectation to the streams that test's flow encodes); in the existing skip-gate test add `expect(result.executeDecisions[0]!.encodes).toBeNull()`.

- [ ] **Step 6: Run and pass**

Run: `pnpm test -- packages/engine/src/executor`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src
git commit -m "feat(engine): say which stream types a dry-run command would re-encode"
```

---

### Task 2: Server — dry-run a given definition, and classify the result

**Files:**
- Modify: `packages/server/src/flow/dry-run.ts`
- Create: `packages/server/src/flow/dry-run-outcome.ts`
- Create: `packages/server/src/flow/dry-run-outcome.test.ts`
- Modify: `packages/server/src/api/api.test.ts` (inside `describe('dry run')`)

**Interfaces:**
- Consumes: `DryRunExecuteDecision.encodes` (Task 1).
- Produces:
  - `dryRunFlow(input: { …existing; definition?: FlowDefinition })`
  - ```ts
    export type DryRunOutcome =
      | { kind: 'no-change' }
      | { kind: 'change'; detail: 'video' | 'audio' | 'streams' }
      | { kind: 'hold'; detail: string }
      | { kind: 'fail'; detail: string }
      | { kind: 'incomplete'; detail: string };
    export const classifyDryRun: (result: FlowDryRunResult) => DryRunOutcome;
    export const outcomeKey: (outcome: DryRunOutcome) => string;
    ```

- [ ] **Step 1: Failing tests** — `dry-run-outcome.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { FlowDryRunResult } from './dry-run.js';
import { classifyDryRun, outcomeKey } from './dry-run-outcome.js';

const result = (over: Partial<FlowDryRunResult>): FlowDryRunResult =>
  ({
    complete: true,
    stoppedAtNodeId: null,
    stopReason: 'end-of-flow',
    failed: false,
    error: null,
    reviewReason: null,
    wouldRunFfmpeg: false,
    executeDecisions: [],
    ...over,
  }) as FlowDryRunResult;

const ran = (encodes: { video: boolean; audio: boolean }) =>
  result({
    wouldRunFfmpeg: true,
    executeDecisions: [{ skip: false, changes: [], nodeId: 'execute', command: ['ffmpeg'], encodes }],
  } as unknown as Partial<FlowDryRunResult>);

describe('classifyDryRun', () => {
  it('a hold wins, with its reason', () => {
    expect(classifyDryRun(result({ complete: false, stopReason: 'held-for-review', reviewReason: 'Too short.' }))).toEqual({
      kind: 'hold',
      detail: 'Too short.',
    });
  });

  it('a failure carries its error', () => {
    expect(classifyDryRun(result({ complete: false, failed: true, error: 'Boom.' }))).toEqual({ kind: 'fail', detail: 'Boom.' });
  });

  it('a walk stopped at a node is incomplete, never no-change', () => {
    expect(classifyDryRun(result({ complete: false, stoppedAtNodeId: 'community' }))).toEqual({
      kind: 'incomplete',
      detail: 'community',
    });
  });

  it('names what a change re-encodes', () => {
    expect(classifyDryRun(ran({ video: true, audio: true }))).toEqual({ kind: 'change', detail: 'video' });
    expect(classifyDryRun(ran({ video: false, audio: true }))).toEqual({ kind: 'change', detail: 'audio' });
    expect(classifyDryRun(ran({ video: false, audio: false }))).toEqual({ kind: 'change', detail: 'streams' });
  });

  it('otherwise nothing changes', () => {
    expect(classifyDryRun(result({}))).toEqual({ kind: 'no-change' });
  });
});

describe('outcomeKey', () => {
  it('keeps details that group, and drops per-file error text', () => {
    expect(outcomeKey({ kind: 'change', detail: 'audio' })).toBe('change:audio');
    expect(outcomeKey({ kind: 'hold', detail: 'Too short.' })).toBe('hold:Too short.');
    expect(outcomeKey({ kind: 'fail', detail: 'Boom.' })).toBe('fail');
    expect(outcomeKey({ kind: 'no-change' })).toBe('no-change');
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm test -- packages/server/src/flow/dry-run-outcome.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `dry-run-outcome.ts`

```ts
import type { FlowDryRunResult } from './dry-run.js';

export type DryRunOutcome =
  | { kind: 'no-change' }
  | { kind: 'change'; detail: 'video' | 'audio' | 'streams' }
  | { kind: 'hold'; detail: string }
  | { kind: 'fail'; detail: string }
  | { kind: 'incomplete'; detail: string };

/**
 * One file's dry run as a single outcome. Order matters: a hold and a failure
 * both end a walk early, and must not be read as "incomplete"; an incomplete
 * walk must never be read as "no change", because the nodes that would have
 * changed the file were never reached.
 */
export const classifyDryRun = (result: FlowDryRunResult): DryRunOutcome => {
  if (result.stopReason === 'held-for-review') {
    return { kind: 'hold', detail: result.reviewReason ?? 'Review requested by the flow.' };
  }
  if (result.failed || result.error !== null) {
    return { kind: 'fail', detail: result.error ?? 'The flow failed.' };
  }
  if (!result.complete) {
    return { kind: 'incomplete', detail: result.stoppedAtNodeId ?? result.stopReason };
  }
  if (result.wouldRunFfmpeg) {
    const ran = result.executeDecisions.filter((decision) => !decision.skip);
    if (ran.some((decision) => decision.encodes?.video === true)) return { kind: 'change', detail: 'video' };
    if (ran.some((decision) => decision.encodes?.audio === true)) return { kind: 'change', detail: 'audio' };
    return { kind: 'change', detail: 'streams' };
  }
  return { kind: 'no-change' };
};

/** Files with the same key are "the same outcome". Error text varies per file, so failures group together. */
export const outcomeKey = (outcome: DryRunOutcome): string =>
  outcome.kind === 'no-change' || outcome.kind === 'fail' ? outcome.kind : `${outcome.kind}:${outcome.detail}`;
```

- [ ] **Step 4: Run, pass.** `pnpm test -- packages/server/src/flow/dry-run-outcome.test.ts` → PASS.

- [ ] **Step 5: Definition override — failing API-level test.** In `api.test.ts` inside `describe('dry run')`, add (it calls `dryRunFlow` directly; import it from `../flow/dry-run.js` if not already imported):

```ts
it('walks a definition it is given instead of the stored one, and writes nothing', async () => {
  const flow = createFlowRepo(db).create({ name: 'override', definition: VALID_FLOW, nowMs: NOW });
  const library = seedLibrary({ flowId: flow.id });
  const fileId = await seedProbedFile(library.id);
  const before = createMediaFileRepo(db).getLedger(fileId);
  const held = {
    nodes: [
      ...VALID_FLOW.nodes,
      { id: 'review', pluginId: 'trawlarr:holdForReview', pluginVersion: '1.0.0', inputs: { reason: 'From the canvas.' } },
    ],
    edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'review' }],
  };

  const result = await dryRunFlow({
    db,
    flowId: flow.id,
    fileId,
    definition: held,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    nowMs: () => NOW,
  });

  expect(result.reviewReason).toBe('From the canvas.');
  expect(createFlowRepo(db).getById(flow.id)!.definition).toEqual(VALID_FLOW);
  expect(createMediaFileRepo(db).getLedger(fileId)).toEqual(before);
});
```

Run: `pnpm test -- packages/server/src/api/api.test.ts -t 'instead of the stored one'` → FAIL (type error / walks stored flow).

- [ ] **Step 6: Implement the override** in `dry-run.ts`: add `definition?: FlowDefinition;` to the input with doc comment "Walk this instead of the flow's stored definition — the editor's canvas. Never stored.", then `const definition = input.definition ?? (flow.definition as FlowDefinition);` right after the flow lookup. Use `definition` in `buildJobPayload`'s `flow` argument (`{ id: flow.id, definition, definitionHash: flow.definitionHash }`) and in the `for (const node of … .nodes)` verdict loop. Everything downstream already reads `payload.flow.definition`.

- [ ] **Step 7: Run, pass.** `pnpm test -- packages/server/src/api/api.test.ts -t 'dry run'` → PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/flow packages/server/src/api/api.test.ts
git commit -m "feat(server): dry-run a definition that is not stored, and name each file's outcome"
```

---

### Task 3: Server — the dry-run coordinator

**Files:**
- Create: `packages/server/src/flow/dry-run-runs.ts`
- Create: `packages/server/src/flow/dry-run-runs.test.ts`
- Modify: `packages/server/src/api/router.ts` (`ApiContext.dryRuns`), `packages/server/src/api/server.ts` (`CreateApiContextInput.dryRuns?`, default construction), `packages/server/src/daemon/daemon.ts` (shutdown)

**Interfaces:**
- Consumes: `dryRunFlow` with `definition` (Task 2), `classifyDryRun`, `outcomeKey`, `DryRunOutcome`.
- Produces:

```ts
export type DryRunStatus = 'running' | 'done' | 'cancelled' | 'failed';
export interface DryRunFileRow {
  fileId: string;
  path: string;
  outcome: DryRunOutcome;
  publishedOutcome: DryRunOutcome;
}
export interface DryRunChangeGroup {
  from: DryRunOutcome;
  to: DryRunOutcome;
  files: Array<{ fileId: string; path: string }>;
}
export interface DryRunRunView {
  runId: string;
  flowId: string;
  status: DryRunStatus;
  error: string | null;
  processed: number;
  total: number;
  definitionHash: string;
  publishedHash: string;
  /** Count per outcomeKey, for the canvas definition. */
  counts: Record<string, number>;
  /** Only files whose outcomeKey differs; largest group first. */
  changes: DryRunChangeGroup[];
  files: DryRunFileRow[];
}
export interface FlowDryRunDetail {
  fileId: string;
  path: string;
  canvas: FlowDryRunResult;
  published: FlowDryRunResult;
}
export interface FlowDryRunCoordinator {
  start(input: { flowId: string; definition: FlowDefinition; definitionHash: string }): { runId: string };
  get(flowId: string, runId: string): DryRunRunView | null;
  file(flowId: string, runId: string, fileId: string): FlowDryRunDetail | null;
  cancel(flowId: string, runId: string): boolean;
  /** Cancels every run and resolves when none is walking. Daemon shutdown awaits this before closing the db. */
  stopAll(): Promise<void>;
}
export const createFlowDryRunCoordinator: (input: {
  db: Db;
  binaries: () => { ffmpeg: string; ffprobe: string };
  nowMs: () => number;
  /** Seam for tests. Defaults to `dryRunFlow`. */
  dryRun?: typeof dryRunFlow;
}) => FlowDryRunCoordinator;
```

Behaviour:
- `start` throws `DryRunInputError` for an unknown flow. It snapshots files with `SELECT f.id, f.path FROM media_file f JOIN library l ON l.id = f.library_id WHERE l.flow_id = ? AND f.missing_since_ms IS NULL ORDER BY f.path`, records `publishedHash = flow.definitionHash`, cancels any running run for the flow, stores the new run as the flow's only run, and begins walking without awaiting (`void walk()`).
- Walk: for each file, `await new Promise((r) => setImmediate(r))` first (so the API and supervisor stay responsive between files), stop if cancelled, then dry-run with `definition` and without (published), each wrapped so a thrown error becomes a `fail` outcome with the error message (and a synthetic result isn't needed for detail — store `null` and have `file()` return null for that half; see type below). Increment `processed`.
- On an unexpected throw outside per-file handling: `status = 'failed'`, `error = message`.
- `get` builds `counts`/`changes` from `files` on each call (5k rows, cheap).

Store full results per file in a `Map<fileId, { canvas: FlowDryRunResult | null; published: FlowDryRunResult | null }>`; adjust `FlowDryRunDetail` halves to `FlowDryRunResult | null` accordingly.

- [ ] **Step 1: Failing tests** — `dry-run-runs.test.ts`. Use a real migrated in-memory db the way other `src/flow` or `src/db` tests do (search for `openDb`/`createDb` in `packages/server/src/db/*.test.ts` and copy that setup), `createFlowRepo(db).create`, `createLibraryRepo(db).create`, and insert `media_file` rows as `api.test.ts`'s `seedFile` does. Inject `dryRun` so no plugins or ffmpeg are involved:

```ts
const fakeResult = (over: Partial<FlowDryRunResult>): FlowDryRunResult =>
  ({ complete: true, stoppedAtNodeId: null, stopReason: 'end-of-flow', failed: false, error: null,
     reviewReason: null, wouldRunFfmpeg: false, executeDecisions: [], steps: [], plannedCommands: [], ...over }) as FlowDryRunResult;

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};
```

Tests:
1. **groups changes against published** — three files `/a.mkv`, `/b.mkv`, `/c.mkv`. Fake `dryRun`: when `input.definition` is set and path ends `b.mkv` → `fakeResult({ stopReason: 'held-for-review', complete: false, reviewReason: 'Short.' })`; otherwise `fakeResult({})`. Start, `until(() => get(...)!.status === 'done')`, expect `processed === 3`, `counts` = `{ 'no-change': 2, 'hold:Short.': 1 }`, `changes` = `[{ from: { kind: 'no-change' }, to: { kind: 'hold', detail: 'Short.' }, files: [{ fileId: <b id>, path: '/b.mkv' }] }]`, `publishedHash` equals the stored flow hash.
2. **ignores missing files and other flows' libraries** — a file with `missing_since_ms` set and a file in a library with a different flow; `total === 1`.
3. **a file that cannot be dry-run is a failure, not a crashed run** — fake throws `new Error('never probed')` for one file; run ends `done`, that row's `outcome` is `{ kind: 'fail', detail: 'never probed' }`.
4. **starting again cancels the first run** — fake awaits a promise you control; start run 1, start run 2, release; expect `get(flow, run1)` is `null` (only the latest run is kept) and run 2 reaches `done`.
5. **cancel stops the walk** — 5 files, fake resolves after `setTimeout(…, 5)`; cancel after first `processed > 0`; `until(status === 'cancelled')`; `processed < 5`.
6. **stopAll resolves once walking ends** — start, `await stopAll()`, status `cancelled`.
7. **file() returns both walks** — after test 1's run, `file(flow, run, bId)!.canvas!.reviewReason === 'Short.'` and `published!.stopReason === 'end-of-flow'`.

Run: `pnpm test -- packages/server/src/flow/dry-run-runs.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `dry-run-runs.ts`** to the interface and behaviour above. Grouping:

```ts
const summarise = (files: DryRunFileRow[]) => {
  const counts: Record<string, number> = {};
  const groups = new Map<string, DryRunChangeGroup>();
  for (const row of files) {
    const key = outcomeKey(row.outcome);
    counts[key] = (counts[key] ?? 0) + 1;
    const from = outcomeKey(row.publishedOutcome);
    if (from === key) continue;
    const id = `${from} -> ${key}`;
    const group = groups.get(id) ?? { from: row.publishedOutcome, to: row.outcome, files: [] };
    group.files.push({ fileId: row.fileId, path: row.path });
    groups.set(id, group);
  }
  return { counts, changes: [...groups.values()].sort((a, b) => b.files.length - a.files.length) };
};
```

Header comment must say why: in memory because a preview is out of date as soon as the flow is edited; one run per flow because a second is always a newer question; yield per file because the walk shares the daemon's event loop with the API and the supervisor.

- [ ] **Step 3: Run, pass.** Same command → PASS.

- [ ] **Step 4: Wire into the context.** `router.ts`: add `dryRuns: FlowDryRunCoordinator;` to `ApiContext` with a comment ("Library dry runs from the editor. Held in memory; see flow/dry-run-runs.ts."). `server.ts`: add `dryRuns?: FlowDryRunCoordinator;` to `CreateApiContextInput` ("Seam for tests") and in `createApiContext`: `dryRuns: input.dryRuns ?? createFlowDryRunCoordinator({ db: input.db, binaries: () => input.settings.getBinaries(), nowMs }),`. Fix any other `ApiContext` literal the typecheck flags (search `pluginSyncs:` in test files — add `dryRuns` the same way). `daemon.ts`: next to `await ctx.pluginSyncs.idle();` add `await ctx.dryRuns.stopAll();` with a comment: a walk reads the database, so it must end before `db.close()`.

- [ ] **Step 5: Verify.** `pnpm typecheck && pnpm test -- packages/server/src` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src
git commit -m "feat(server): walk a whole library against a draft in the daemon, one run per flow"
```

---

### Task 4: Server — dry-run routes

**Files:**
- Modify: `packages/server/src/api/routes/flows.ts`
- Modify: `packages/server/src/api/api.test.ts`
- Modify: `README.md` (the API section that lists `POST /flows/:id/dry-run` — search for it and add the new routes beside it, one line each)

**Interfaces:**
- Consumes: `ctx.dryRuns` (Task 3).
- Produces (JSON): `POST /flows/:id/dry-runs {definition}` → `202 {runId}`; `GET /flows/:id/dry-runs/:runId` → `DryRunRunView`; `GET /flows/:id/dry-runs/:runId/files/:fileId` → `FlowDryRunDetail`; `DELETE /flows/:id/dry-runs/:runId` → `204`.

- [ ] **Step 1: Failing tests** in `api.test.ts`, new `describe('library dry runs')`:

```ts
const waitForRun = async (flowId: string, runId: string) => {
  for (let i = 0; i < 400; i += 1) {
    const response = await api('GET', `/flows/${flowId}/dry-runs/${runId}`);
    if ((response.body as { status: string }).status !== 'running') return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('dry run did not finish');
};

it('runs the canvas definition across the library and reports what changes', async () => {
  const flow = createFlowRepo(db).create({ name: 'lib-dry', definition: VALID_FLOW, nowMs: NOW });
  const library = seedLibrary({ flowId: flow.id });
  const fileId = await seedProbedFile(library.id);
  const canvas = {
    nodes: [...VALID_FLOW.nodes, { id: 'review', pluginId: 'trawlarr:holdForReview', pluginVersion: '1.0.0', inputs: { reason: 'Canvas.' } }],
    edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'review' }],
  };

  const started = await api('POST', `/flows/${flow.id}/dry-runs`, { definition: canvas });
  expect(started.status).toBe(202);
  const { runId } = started.body as { runId: string };
  const done = await waitForRun(flow.id, runId);

  expect(done.body).toMatchObject({
    status: 'done',
    processed: 1,
    total: 1,
    counts: { 'hold:Canvas.': 1 },
    changes: [{ to: { kind: 'hold', detail: 'Canvas.' }, files: [{ fileId }] }],
  });
  const detail = await api('GET', `/flows/${flow.id}/dry-runs/${runId}/files/${fileId}`);
  expect(detail.body).toMatchObject({ canvas: { reviewReason: 'Canvas.' } });
});

it('refuses a definition that does not validate', async () => {
  const flow = createFlowRepo(db).create({ name: 'bad-dry', definition: VALID_FLOW, nowMs: NOW });
  const response = await api('POST', `/flows/${flow.id}/dry-runs`, { definition: { nodes: [], edges: [] } });
  expect(response.status).toBe(400);
});

it('answers 404 for a run it does not have, and 204 to a cancel', async () => {
  const flow = createFlowRepo(db).create({ name: 'gone-dry', definition: VALID_FLOW, nowMs: NOW });
  expect((await api('GET', `/flows/${flow.id}/dry-runs/nope`)).status).toBe(404);
  seedLibrary({ flowId: flow.id });
  const { runId } = (await api('POST', `/flows/${flow.id}/dry-runs`, { definition: VALID_FLOW })).body as { runId: string };
  expect((await api('DELETE', `/flows/${flow.id}/dry-runs/${runId}`)).status).toBe(204);
});
```

Run: `pnpm test -- packages/server/src/api/api.test.ts -t 'library dry runs'` → FAIL (404s).

- [ ] **Step 2: Implement routes** after the existing `/flows/:id/dry-run` route, using the same helpers the file already uses (`requireFlow`, `requireDefinition`, `validateFlowDefinition` with `createNodeCapabilityResolver({ registry: createPluginRegistry(ctx.db) })`, `flowDefinitionHash`, `ApiError`, `noContent`). For 202, look at how the plugin-sync route in `packages/server/src/api/routes/` returns 202 and do the same. Validation failure: `throw new ApiError(400, 'invalid-flow', problems.map((p) => p.message).join(' '))` — or, if the file already has a helper that returns problems in a 400 body for publish, use that helper so the web can show them identically. 404: `throw new ApiError(404, 'not-found', 'No such dry run.')` (match the code string the file uses for other 404s).

- [ ] **Step 3: Run, pass.** `pnpm test -- packages/server/src/api/api.test.ts` → PASS.

- [ ] **Step 4: README** — add the four routes beside the existing dry-run route, one line each, same table/list format.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api README.md
git commit -m "feat(api): start, read and cancel a library dry run of a flow definition"
```

---

### Task 5: Web — dry-run model

**Files:**
- Create: `packages/web/src/screens/flows/dry-run-model.ts`
- Create: `packages/web/src/screens/flows/dry-run-model.test.ts`

**Interfaces:**
- Produces:

```ts
export type DryRunOutcome =
  | { kind: 'no-change' }
  | { kind: 'change'; detail: 'video' | 'audio' | 'streams' }
  | { kind: 'hold'; detail: string }
  | { kind: 'fail'; detail: string }
  | { kind: 'incomplete'; detail: string };
export interface DryRunRun { /* same fields as server DryRunRunView, typed locally */ }
export interface DryRunFileDetail { fileId: string; path: string; canvas: DryRunWalk | null; published: DryRunWalk | null }
export interface DryRunWalk { steps: Array<{ nodeId: string; outputNumber: number | null; error: string | null }>; plannedCommands: string[][]; partialWalkWarning: string | null }
export const outcomeLabel: (outcome: DryRunOutcome) => string;
export const countLabel: (key: string) => string;
export const orderedCounts: (counts: Record<string, number>) => Array<{ key: string; label: string; count: number }>;
export const isRunStale: (run: Pick<DryRunRun, 'definitionHash' | 'publishedHash'>, canvasHash: string | null, liveHash: string) => boolean;
export const routeText: (walk: DryRunWalk | null, labels: Record<string, string>) => string;
```

Labels (terse): `no-change` → "No change"; `change:video` → "Re-encode video"; `change:audio` → "Convert audio"; `change:streams` → "Remux"; `hold:<r>` → "Hold: <r>"; `fail` → "Fail"; `incomplete:<node>` → "Stops at <node>". Order: No change, Re-encode video, Convert audio, Remux, holds, incomplete, Fail. `isRunStale` is true when the canvas hash is null (not yet validated) or differs from the run's `definitionHash`, or the published hash moved. `routeText` joins step node labels with ` → ` (use `labels[nodeId] ?? nodeId`).

- [ ] **Step 1: Failing tests** covering: every label above; `orderedCounts({ fail: 1, 'no-change': 3, 'change:video': 2 })` returns keys in the order `no-change, change:video, fail`; `isRunStale` true/false cases (same hashes → false; canvas edited → true; canvas null → true; published moved → true); `routeText` with a named and an unnamed node.

Run: `pnpm test -- packages/web/src/screens/flows/dry-run-model.test.ts` → FAIL.

- [ ] **Step 2: Implement**, add a `satisfies` guard only if you copy a runtime constant from server code (you should not need to).

- [ ] **Step 3: Run, pass. Commit**

```bash
git add packages/web/src/screens/flows/dry-run-model*
git commit -m "feat(web): name dry-run outcomes and tell when a run no longer matches the canvas"
```

---

### Task 6: Web — Dry run button, panel, and the Publish dialog

**Files:**
- Create: `packages/web/src/screens/flows/DryRunPanel.tsx`
- Modify: `packages/web/src/screens/flows/FlowEditor.tsx`
- Modify: the flow editor stylesheet (find where `.editor-publish` is styled under `packages/web/src/styles/`) for `.dry-run-*` classes; reuse existing panel/table classes where they exist (search `flow-canvas-validation`, `detail`, `row-actions`).

**Interfaces:**
- Consumes: Task 4 routes, Task 5 model, `ApiClient` (`get`, `post`, `delete` — check `packages/web/src/api/client.ts` for the delete method's exact name).
- Produces: `DryRunPanel(props: { client: ApiClient; flowId: string; runId: string; canvasHash: string | null; liveHash: string; labels: Record<string, string>; onRun: (run: DryRunRun) => void; onClose: () => void }): JSX.Element`.

Behaviour:
- Editor toolbar: a `Dry run` button before `Review & publish`, disabled when `busy || !valid`. Click → `client.post<{ runId: string }>(`/flows/${id}/dry-runs`, { definition })` → store `runId` in state, show the panel. Starting again replaces it.
- Panel polls `GET …/dry-runs/:runId` every 1000 ms while `status === 'running'` (clear the timer on unmount and on runId change). Shows `Dry run · 1,850 / 5,242` and a `Cancel` button (`DELETE`) while running.
- Done: a header line `Dry run · 5,242 files` plus `Out of date` badge when `isRunStale`. Count list from `orderedCounts`. Then `Changes vs published` — one `<details>` per group, summary `12 · No change → Remux`, body a list of file buttons (path relative display: strip everything up to and including the library root is not known to the web, so show the full path with CSS `text-overflow: ellipsis` and `title`). When `changes` is empty: `Same outcome as published for every file.`
- Selecting a file fetches `…/files/:fileId` and shows `Canvas: <routeText>`, `Published: <routeText>`, each planned command in a `<pre>` (`command.join(' ')`), and `partialWalkWarning` if present.
- Limits line (one, small): `Walks stop at community nodes the engine can't vouch for. Size checks aren't measured.`
- `status === 'failed'` → `role="alert"` with `error`. `cancelled` → `Cancelled at N / M.`
- `onRun` is called with each fetched run so the editor can hand the latest run to the Publish dialog.
- Publish dialog: pass `dryRun: DryRunRun | null` (the latest `done` run). When it is not stale for `toHash`/`liveHash`, replace the "how many files will actually re-encode is not known" sentence with `Dry run: <N> file(s) change outcome.` followed by the top three groups as `<li>` (`12 · No change → Remux`). Otherwise keep the existing sentence.

- [ ] **Step 1: Implement the panel and editor wiring** as above. Keep all grouping/label logic in the model (Task 5); the component only renders and fetches.

- [ ] **Step 2: Build and typecheck.** `pnpm typecheck && pnpm build` → both succeed (build is what catches `.tsx` ordering errors).

- [ ] **Step 3: Render check.** Start a dev daemon with a small fixture library (or use the existing web test harness if the repo has one for FlowEditor — search `FlowEditor` under `packages/web/src/**/*.test.tsx`). If a component test harness exists, add a test that a done run renders the count list and a change group, and that the Publish dialog shows `Dry run:` for a non-stale run. If none exists, drive the page in a browser against a local daemon and check: button disabled while invalid, progress then results, out-of-date badge after an edit, dark theme legible, 400px width without horizontal scroll.

- [ ] **Step 4: Lint and test.** `pnpm lint && pnpm test -- packages/web` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): dry-run the canvas across the library from the flow editor"
```

---

### Task 7: End to end with real ffmpeg

**Files:**
- Create: `packages/server/test/flow-dry-run-end-to-end.test.ts`

**Interfaces:**
- Consumes: everything above, through the HTTP API of a real daemon/API server as the other `packages/server/test/*end-to-end*.test.ts` suites start one.

- [ ] **Step 1: Write the test.** Model setup on `packages/server/test/end-to-end.test.ts` (fixtures generated with `lavfi testsrc`, gated on `test-support/tool-availability.ts`, never skipped on a failing check). Library of two generated files: one h264 and one hevc. Published flow: the `transcodeFlow` from that suite targeting `hevc` (h264 file → change:video, hevc file → no-change). Scan so both files are probed. Canvas definition: same flow with Check Video Codec targeting `h264` instead. Start a run with the canvas, wait for `done`, assert:
  - `counts` is `{ 'change:video': 1, 'no-change': 1 }` (the roles swap, so the totals are the same),
  - `changes` has exactly two groups: the h264 file `change:video → no-change`, the hevc file `no-change → change:video`,
  - the hevc file's detail has one planned command containing the encoder the flow sets,
  - both files' bytes and the `media_file` rows are unchanged after the run.

- [ ] **Step 2: Run it.** `./node_modules/.bin/tsc --build --force && pnpm test -- packages/server/test/flow-dry-run-end-to-end.test.ts --reporter=verbose` → PASS, and the verbose output shows the test ran (not skipped).

- [ ] **Step 3: Full gate.** `pnpm lint && pnpm typecheck && ./node_modules/.bin/tsc --build --force && pnpm build && pnpm test` → all PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/flow-dry-run-end-to-end.test.ts
git commit -m "test(server): a library dry run reports exactly the outcomes a definition change swaps"
```
