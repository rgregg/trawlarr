# P2a — Headless Library Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make trawlarr usable: point it at a directory, walk away, and come back to a converged library with originals recoverable.

**Architecture:** `@trawlarr/server` grows the IO half of the system around the existing pure domain and engine. Repositories persist libraries, flows and jobs; a scanner walks roots and folds each file into the ledger; a worker loop claims files and drives the existing flow executor; two new first-party nodes verify output and replace originals through a per-library trash. A CLI ties it together.

**Tech Stack:** Node 22, TypeScript, better-sqlite3, vitest, ffmpeg/ffprobe 6.1.1.

## Why this scope

The engine works and its plugin compatibility is proven, but the only way to use it is to hand-write a flow JSON and invoke a CLI per file. This plan delivers the smallest slice that is genuinely useful, and deliberately excludes the rest of P2:

**In:** persisted libraries, scanner (walk, probe, identity, ledger), a worker loop that drains the queue unattended, `Verify Output` and `Replace Original File` with trash, per-library staging, hardlink and companion-file handling, and a CLI.

**Out, for P2b:** the REST/WebSocket API, the filesystem watcher, worker classes and hardware concurrency caps, schedule windows, the Docker image, and plugin source syncing. None is needed to converge a library; all are convenience on top of a working service.

## Global Constraints

- License MIT. No code, comment, or type file copied from Tdarr, Tdarr_Plugins, or Unmanic.
- `@trawlarr/core` performs no IO and never reads the clock — `nowMs` is always injected. Lint-enforced. All new IO belongs to `@trawlarr/server`.
- Upstream misspellings are contract keys and must survive: `overallOuputArguments`, `lastSuccesfulPlugin`.
- Codec flags in any first-party plugin address streams by **output index** (`-c:{outputIndex}`), never by stream type. `-c:v` overrides per-stream copy directives and destroys cover art.
- Node 22 (`.nvmrc`). `better-sqlite3` will not load on the ambient Node 25 — run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` first or the suite fails confusingly.
- Every new workspace dependency needs a matching tsconfig project reference; `pnpm check:refs` enforces it, and the root `references` array is an explicit list, not a glob.
- If any `package.json` changes, `pnpm-lock.yaml` must be committed in the same commit — CI runs `pnpm install --frozen-lockfile`.
- Verification standard: `pnpm build && pnpm lint && pnpm test`, twice. `pnpm lint` includes `prettier --check .`.
- **No timing-dependent test assertions.** Assert ordering, not elapsed time. A wall-clock assertion in this repo once failed one run in fifteen and survived five reviews.
- Bulk database writes go through `runChunked` — `better-sqlite3` is synchronous and one large transaction freezes everything.
- **Read `docs/engineering-notes/p2-prerequisites.md` before starting.** It records load-bearing constraints this plan depends on, and it is the reason several tasks look the way they do.

## What already exists

Do not rebuild these. Signatures are exact.

**`@trawlarr/core`** (pure, no IO): `canonicalJson`, `sha256Hex`; `buildIdentityCandidate({deviceId, inode, hash})`, `matchIdentity`, `inodeKeyOf`, `contentKeyOf`, `IdentityCandidate`, `PartialHashParts {sizeBytes, headHex, tailHex}`; `extractFacts({probe, container, sizeBytes})`, `factsEquivalent`, `factsHash`, `FactSet`; `FlowDefinition {nodes, edges}`, `FlowNode {id, pluginId, pluginVersion, inputs}`, `FlowEdge {fromNodeId, outputNumber, toNodeId}`, `flowDefinitionHash`, `computeSignature({flowDefinitionHash, facts})`; `FileState`, `LedgerRecord {state, signature, attemptCount, consecutiveNoopCount, holdUntilMs}`, `RunOutcome {success, claimedModified, preFacts, postFacts}`, `newLedgerRecord`, `isKnownGood`, `applyRunOutcome`, `applyStall`, `applyRequeue`, `isEligible`, `MAX_ATTEMPTS`, `BACKOFF_MINUTES`, `NOOP_LIMIT`; `beginFfmpegCommand`, `emptyFfmpegCommand`, `assertCommandInitialised`, `closeFfmpegCommand`, `deriveShouldProcess`, `compileFfmpegArgs`, `shouldCopyStream`, `outputStreamIndex`, `outputStreamTypeIndex`.

**`@trawlarr/server`**: `openDatabase({file})`, `Db`, `migrate(db)`, `SCHEMA_VERSION`, `runChunked({db, items, chunkSize?, apply})`, `DEFAULT_CHUNK_SIZE`; `createMediaFileRepo(db)` → `identityLookup(libraryId)`, `upsertScanned(UpsertScannedInput) → fileId`, `claimNext({workerClass, nowMs, libraryIds?}) → ClaimedFile | null`, `setState({fileId, state, signature?, attemptCount?, consecutiveNoopCount?, holdUntilMs?})`, `getById(fileId) → MediaFileRow | null`; `IdentityConflictError`; `createPluginDocumentRepo(db)`.

**`@trawlarr/engine`**: `createPluginLoader()`, `LoadedPlugin`, `buildPluginInputArgs`, `toPluginFileObject`, `absorbPluginFileObject`, `projectTranscodeDecision`, `buildPluginDeps`, `rejectClassicPluginDeps`, `createCrudTransDbn`, `createAxiosMiddleware`, `runFfmpeg`, `createProgressParser`, `runFlow(RunFlowOptions) → FlowRunResult`, `StepRecord`, `createExecuteRunner`, `resolveEncodeTarget`, `InPlaceOutputError`, `runDryFlow`, `classifySideEffects`.

**`@trawlarr/plugins-core`**: `FIRST_PARTY_PLUGINS` keyed by literal id — `trawlarr:start`, `trawlarr:checkVideoCodec`, `trawlarr:beginCommand`, `trawlarr:setVideoEncoder`, `trawlarr:execute`.

**The schema already has every table and column this plan needs.** `library` carries `roots_json`, `extensions_json`, `companion_extensions_json`, `staging_dir`, `trash_dir`, `flow_id`, `allow_hardlinked`, `enabled`, `paused_reason`, `user_variables_json`. `media_file` carries `probe_json`, `video_codec`, `audio_codec`, `resolution`, `duration_ms`, `bitrate`, `pre_facts_json`, `post_facts_json`, `original_size_bytes`, `last_run_id`, `updated_at`. `job` and `job_step` are ready. **No migration is needed** — if you think you need one, you have misread the schema; check `packages/server/src/db/migrations/001_initial.sql` first and say so in your report.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/server/src/db/library-repo.ts` | Library CRUD; marshals the JSON columns |
| `packages/server/src/db/flow-repo.ts` | Flow storage; stores definition and its hash together |
| `packages/server/src/db/job-repo.ts` | Job and step recording |
| `packages/server/src/db/media-file-repo.ts` | *Modify:* probe/facts/ledger persistence, listing, requeue |
| `packages/server/src/fs/partial-hash.ts` | Head+tail+size content hash — the IO half of identity |
| `packages/server/src/fs/walk.ts` | Recursive walk with extension filter |
| `packages/server/src/fs/companions.ts` | Finding and renaming sidecar files |
| `packages/server/src/probe/ffprobe.ts` | ffprobe invocation and parsing |
| `packages/server/src/library/paths.ts` | Per-library staging and trash resolution |
| `packages/server/src/scanner/scan-library.ts` | Walk → identity → upsert → probe → signature → ledger |
| `packages/server/src/worker/run-job.ts` | One file end to end through the engine |
| `packages/server/src/worker/loop.ts` | Drain the queue until empty or stopped |
| `packages/server/src/cli.ts` | `trawlarr` CLI |
| `packages/plugins-core/src/verifyOutput/index.ts` | Output verification node |
| `packages/plugins-core/src/replaceOriginalFile/index.ts` | The destructive node, with trash |

---

## Task 1: Library repository

**Files:**
- Create: `packages/server/src/db/library-repo.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/db/library-repo.test.ts`

**Interfaces:**
- Consumes: `Db` from `./connection.js`.
- Produces:
  - `interface LibraryRecord { id: string; name: string; roots: string[]; extensions: string[]; companionExtensions: string[]; stagingDir: string | null; trashDir: string | null; flowId: string | null; allowHardlinked: boolean; enabled: boolean; pausedReason: string | null; userVariables: Record<string, string>; createdAt: number }`
  - `interface CreateLibraryInput { name: string; roots: string[]; extensions?: string[]; companionExtensions?: string[]; stagingDir?: string | null; trashDir?: string | null; flowId?: string | null; allowHardlinked?: boolean; nowMs: number }`
  - `createLibraryRepo(db: Db): LibraryRepo` with `create(input): LibraryRecord`, `getById(id): LibraryRecord | null`, `getByName(name): LibraryRecord | null`, `list(): LibraryRecord[]`, `setFlow(id, flowId): void`, `pause(id, reason): void`, `resume(id): void`
  - `DEFAULT_EXTENSIONS: readonly string[]`, `DEFAULT_COMPANION_EXTENSIONS: readonly string[]`
  - `class OverlappingRootsError extends Error`

- [ ] **Step 1: Write the failing test**

`packages/server/src/db/library-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import {
  DEFAULT_COMPANION_EXTENSIONS,
  DEFAULT_EXTENSIONS,
  OverlappingRootsError,
  createLibraryRepo,
  type LibraryRepo,
} from './library-repo.js';

const NOW = 1_700_000_000_000;
let db: Db;
let repo: LibraryRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createLibraryRepo(db);
});

describe('create', () => {
  it('round-trips every field, including the JSON columns', () => {
    const created = repo.create({
      name: 'Movies',
      roots: ['/media/movies', '/media/movies-4k'],
      extensions: ['mkv', 'mp4'],
      companionExtensions: ['srt', 'nfo'],
      stagingDir: '/media/movies/.trawlarr',
      trashDir: '/media/movies/.trawlarr-trash',
      allowHardlinked: true,
      nowMs: NOW,
    });
    expect(created).toMatchObject({
      name: 'Movies',
      roots: ['/media/movies', '/media/movies-4k'],
      extensions: ['mkv', 'mp4'],
      companionExtensions: ['srt', 'nfo'],
      allowHardlinked: true,
      enabled: true,
      pausedReason: null,
      flowId: null,
    });
    expect(repo.getById(created.id)).toEqual(created);
  });

  it('applies sensible defaults', () => {
    const created = repo.create({ name: 'TV', roots: ['/media/tv'], nowMs: NOW });
    expect(created.extensions).toEqual([...DEFAULT_EXTENSIONS]);
    expect(created.companionExtensions).toEqual([...DEFAULT_COMPANION_EXTENSIONS]);
    expect(created.allowHardlinked).toBe(false);
    expect(created.stagingDir).toBeNull();
  });

  it('rejects a duplicate name', () => {
    repo.create({ name: 'Movies', roots: ['/a'], nowMs: NOW });
    expect(() => repo.create({ name: 'Movies', roots: ['/b'], nowMs: NOW })).toThrow();
  });

  it('rejects an empty roots list', () => {
    expect(() => repo.create({ name: 'Empty', roots: [], nowMs: NOW })).toThrow(/at least one root/i);
  });

  it('rejects roots that overlap each other', () => {
    // One file under two roots of the same library would be scanned twice.
    expect(() =>
      repo.create({ name: 'Nested', roots: ['/media/movies', '/media/movies/4k'], nowMs: NOW }),
    ).toThrow(OverlappingRootsError);
  });

  it('rejects a root that overlaps an existing library', () => {
    // A file in two libraries would be driven toward two different states by
    // two flows, fighting forever.
    repo.create({ name: 'Movies', roots: ['/media/movies'], nowMs: NOW });
    expect(() =>
      repo.create({ name: 'Movies4k', roots: ['/media/movies/4k'], nowMs: NOW }),
    ).toThrow(OverlappingRootsError);
  });

  it('allows sibling roots that merely share a prefix string', () => {
    // '/media/movies-4k' is not inside '/media/movies' despite the prefix.
    repo.create({ name: 'Movies', roots: ['/media/movies'], nowMs: NOW });
    expect(() =>
      repo.create({ name: 'Movies4k', roots: ['/media/movies-4k'], nowMs: NOW }),
    ).not.toThrow();
  });

  it('normalises roots before comparing them', () => {
    repo.create({ name: 'Movies', roots: ['/media/movies/'], nowMs: NOW });
    expect(() =>
      repo.create({ name: 'Dup', roots: ['/media/movies/./'], nowMs: NOW }),
    ).toThrow(OverlappingRootsError);
  });
});

describe('lookup and mutation', () => {
  it('finds a library by name and lists all of them', () => {
    const a = repo.create({ name: 'Movies', roots: ['/a'], nowMs: NOW });
    const b = repo.create({ name: 'TV', roots: ['/b'], nowMs: NOW });
    expect(repo.getByName('Movies')?.id).toBe(a.id);
    expect(repo.list().map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('returns null for a library that does not exist', () => {
    expect(repo.getById('nope')).toBeNull();
    expect(repo.getByName('nope')).toBeNull();
  });

  it('attaches a flow', () => {
    const lib = repo.create({ name: 'Movies', roots: ['/a'], nowMs: NOW });
    db.prepare(
      `INSERT INTO flow (id, name, definition_json, definition_hash, created_at, updated_at)
       VALUES ('f1', 'HEVC', '{}', 'h', ?, ?)`,
    ).run(NOW, NOW);
    repo.setFlow(lib.id, 'f1');
    expect(repo.getById(lib.id)?.flowId).toBe('f1');
  });

  it('pauses with a stated reason and resumes', () => {
    const lib = repo.create({ name: 'Movies', roots: ['/a'], nowMs: NOW });
    repo.pause(lib.id, 'flow references a missing plugin');
    expect(repo.getById(lib.id)).toMatchObject({
      enabled: false,
      pausedReason: 'flow references a missing plugin',
    });
    repo.resume(lib.id);
    expect(repo.getById(lib.id)).toMatchObject({ enabled: true, pausedReason: null });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
pnpm test -- packages/server/src/db/library-repo.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/server/src/db/library-repo.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { Db } from './connection.js';

export interface LibraryRecord {
  id: string;
  name: string;
  roots: string[];
  extensions: string[];
  companionExtensions: string[];
  stagingDir: string | null;
  trashDir: string | null;
  flowId: string | null;
  allowHardlinked: boolean;
  enabled: boolean;
  pausedReason: string | null;
  userVariables: Record<string, string>;
  createdAt: number;
}

export interface CreateLibraryInput {
  name: string;
  roots: string[];
  extensions?: string[];
  companionExtensions?: string[];
  stagingDir?: string | null;
  trashDir?: string | null;
  flowId?: string | null;
  allowHardlinked?: boolean;
  nowMs: number;
}

export interface LibraryRepo {
  create(input: CreateLibraryInput): LibraryRecord;
  getById(id: string): LibraryRecord | null;
  getByName(name: string): LibraryRecord | null;
  list(): LibraryRecord[];
  setFlow(id: string, flowId: string | null): void;
  pause(id: string, reason: string): void;
  resume(id: string): void;
}

export const DEFAULT_EXTENSIONS = ['mkv', 'mp4', 'avi', 'mov', 'm4v', 'ts', 'wmv', 'webm'] as const;

/**
 * Sidecars that belong to a media file and must follow it when a flow changes
 * the container, or a media server loses their association.
 */
export const DEFAULT_COMPANION_EXTENSIONS = ['srt', 'ass', 'sub', 'idx', 'nfo', 'vtt'] as const;

export class OverlappingRootsError extends Error {
  constructor(a: string, b: string) {
    super(
      `Library roots overlap: "${a}" contains or equals "${b}". A file under two roots would be ` +
        `scanned twice, and a file in two libraries would be driven toward two different states ` +
        `by two flows.`,
    );
    this.name = 'OverlappingRootsError';
  }
}

/** Compare as path segments so '/media/movies-4k' is not "inside" '/media/movies'. */
const contains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

const overlaps = (a: string, b: string): boolean => contains(a, b) || contains(b, a);

interface LibraryRow {
  id: string;
  name: string;
  roots_json: string;
  extensions_json: string;
  companion_extensions_json: string;
  staging_dir: string | null;
  trash_dir: string | null;
  flow_id: string | null;
  allow_hardlinked: number;
  enabled: number;
  paused_reason: string | null;
  user_variables_json: string;
  created_at: number;
}

const toRecord = (row: LibraryRow): LibraryRecord => ({
  id: row.id,
  name: row.name,
  roots: JSON.parse(row.roots_json) as string[],
  extensions: JSON.parse(row.extensions_json) as string[],
  companionExtensions: JSON.parse(row.companion_extensions_json) as string[],
  stagingDir: row.staging_dir,
  trashDir: row.trash_dir,
  flowId: row.flow_id,
  allowHardlinked: row.allow_hardlinked === 1,
  enabled: row.enabled === 1,
  pausedReason: row.paused_reason,
  userVariables: JSON.parse(row.user_variables_json) as Record<string, string>,
  createdAt: row.created_at,
});

export const createLibraryRepo = (db: Db): LibraryRepo => {
  const selectById = db.prepare(`SELECT * FROM library WHERE id = ?`);
  const selectByName = db.prepare(`SELECT * FROM library WHERE name = ?`);
  const selectAll = db.prepare(`SELECT * FROM library ORDER BY name`);

  const get = (id: string): LibraryRecord | null => {
    const row = selectById.get(id) as LibraryRow | undefined;
    return row === undefined ? null : toRecord(row);
  };

  return {
    create(input) {
      if (input.roots.length === 0) {
        throw new Error(`Library "${input.name}" needs at least one root directory.`);
      }
      const roots = input.roots.map((root) => resolve(root));

      for (let i = 0; i < roots.length; i += 1) {
        for (let j = i + 1; j < roots.length; j += 1) {
          if (overlaps(roots[i]!, roots[j]!)) throw new OverlappingRootsError(roots[i]!, roots[j]!);
        }
      }
      for (const existing of this.list()) {
        for (const existingRoot of existing.roots) {
          for (const root of roots) {
            if (overlaps(existingRoot, root)) throw new OverlappingRootsError(existingRoot, root);
          }
        }
      }

      const id = randomUUID();
      db.prepare(
        `INSERT INTO library (
           id, name, roots_json, extensions_json, companion_extensions_json,
           staging_dir, trash_dir, flow_id, allow_hardlinked, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        JSON.stringify(roots),
        JSON.stringify(input.extensions ?? [...DEFAULT_EXTENSIONS]),
        JSON.stringify(input.companionExtensions ?? [...DEFAULT_COMPANION_EXTENSIONS]),
        input.stagingDir ?? null,
        input.trashDir ?? null,
        input.flowId ?? null,
        input.allowHardlinked === true ? 1 : 0,
        input.nowMs,
      );
      const created = get(id);
      if (created === null) throw new Error(`Library ${id} vanished immediately after insert.`);
      return created;
    },

    getById: get,

    getByName(name) {
      const row = selectByName.get(name) as LibraryRow | undefined;
      return row === undefined ? null : toRecord(row);
    },

    list() {
      return (selectAll.all() as LibraryRow[]).map(toRecord);
    },

    setFlow(id, flowId) {
      db.prepare(`UPDATE library SET flow_id = ? WHERE id = ?`).run(flowId, id);
    },

    pause(id, reason) {
      db.prepare(`UPDATE library SET enabled = 0, paused_reason = ? WHERE id = ?`).run(reason, id);
    },

    resume(id) {
      db.prepare(`UPDATE library SET enabled = 1, paused_reason = NULL WHERE id = ?`).run(id);
    },
  };
};
```

- [ ] **Step 4: Export from the barrel**

Add `export * from './db/library-repo.js';` to `packages/server/src/index.ts`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- packages/server`
Expected: PASS.

- [ ] **Step 6: Full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/server
git commit -m "feat(server): library repository with overlapping-root rejection

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Flow repository

**Files:**
- Create: `packages/server/src/db/flow-repo.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/db/flow-repo.test.ts`

**Interfaces:**
- Consumes: `Db`; `FlowDefinition` and `flowDefinitionHash` from `@trawlarr/core`.
- Produces:
  - `interface FlowRecord { id: string; name: string; description: string; tags: string; definition: FlowDefinition; definitionHash: string; createdAt: number; updatedAt: number }`
  - `createFlowRepo(db: Db): FlowRepo` with `create({name, description?, tags?, definition, nowMs}): FlowRecord`, `update({id, definition, nowMs}): FlowRecord`, `getById(id): FlowRecord | null`, `getByName(name): FlowRecord | null`, `list(): FlowRecord[]`

The hash is computed on write and stored beside the definition, so a scan never has to recompute it for every file. Recomputing it on read would be cheap but would let the two drift; storing it makes the flow's identity a single fact.

- [ ] **Step 1: Write the failing test**

`packages/server/src/db/flow-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { flowDefinitionHash, type FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createFlowRepo, type FlowRepo } from './flow-repo.js';

const NOW = 1_700_000_000_000;

const definition = (encoder = 'libx265'): FlowDefinition => ({
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'enc',
      pluginId: 'trawlarr:setVideoEncoder',
      pluginVersion: '1.0.0',
      inputs: { encoder, quality: '24' },
    },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'enc' }],
});

let db: Db;
let repo: FlowRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createFlowRepo(db);
});

describe('createFlowRepo', () => {
  it('stores the definition and its hash together', () => {
    const created = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    expect(created.definitionHash).toBe(flowDefinitionHash(definition()));
    expect(repo.getById(created.id)).toEqual(created);
  });

  it('round-trips the definition structurally', () => {
    const created = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    expect(created.definition).toEqual(definition());
  });

  it('recomputes the hash on update, so editing a flow changes its identity', () => {
    const created = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    const updated = repo.update({ id: created.id, definition: definition('libx264'), nowMs: NOW + 1 });
    expect(updated.definitionHash).not.toBe(created.definitionHash);
    expect(updated.definitionHash).toBe(flowDefinitionHash(definition('libx264')));
    expect(updated.updatedAt).toBe(NOW + 1);
  });

  it('finds a flow by name and lists them', () => {
    const a = repo.create({ name: 'HEVC', definition: definition(), nowMs: NOW });
    repo.create({ name: 'Remux', definition: definition(), nowMs: NOW });
    expect(repo.getByName('HEVC')?.id).toBe(a.id);
    expect(repo.list()).toHaveLength(2);
  });

  it('returns null for a flow that does not exist', () => {
    expect(repo.getById('nope')).toBeNull();
    expect(repo.getByName('nope')).toBeNull();
  });

  it('rejects updating a flow that does not exist', () => {
    expect(() => repo.update({ id: 'nope', definition: definition(), nowMs: NOW })).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test -- packages/server/src/db/flow-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/server/src/db/flow-repo.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { flowDefinitionHash, type FlowDefinition } from '@trawlarr/core';
import type { Db } from './connection.js';

export interface FlowRecord {
  id: string;
  name: string;
  description: string;
  tags: string;
  definition: FlowDefinition;
  definitionHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface FlowRepo {
  create(input: {
    name: string;
    description?: string;
    tags?: string;
    definition: FlowDefinition;
    nowMs: number;
  }): FlowRecord;
  update(input: { id: string; definition: FlowDefinition; nowMs: number }): FlowRecord;
  getById(id: string): FlowRecord | null;
  getByName(name: string): FlowRecord | null;
  list(): FlowRecord[];
}

interface FlowRow {
  id: string;
  name: string;
  description: string;
  tags: string;
  definition_json: string;
  definition_hash: string;
  created_at: number;
  updated_at: number;
}

const toRecord = (row: FlowRow): FlowRecord => ({
  id: row.id,
  name: row.name,
  description: row.description,
  tags: row.tags,
  definition: JSON.parse(row.definition_json) as FlowDefinition,
  definitionHash: row.definition_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const createFlowRepo = (db: Db): FlowRepo => {
  const selectById = db.prepare(`SELECT * FROM flow WHERE id = ?`);
  const selectByName = db.prepare(`SELECT * FROM flow WHERE name = ?`);
  const selectAll = db.prepare(`SELECT * FROM flow ORDER BY name`);

  const get = (id: string): FlowRecord | null => {
    const row = selectById.get(id) as FlowRow | undefined;
    return row === undefined ? null : toRecord(row);
  };

  return {
    create(input) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        input.description ?? '',
        input.tags ?? '',
        JSON.stringify(input.definition),
        flowDefinitionHash(input.definition),
        input.nowMs,
        input.nowMs,
      );
      const created = get(id);
      if (created === null) throw new Error(`Flow ${id} vanished immediately after insert.`);
      return created;
    },

    update(input) {
      // The hash is recomputed here rather than read back, because it IS the
      // flow's version: every file whose ledger recorded the old hash becomes
      // stale the moment this returns.
      const result = db
        .prepare(
          `UPDATE flow SET definition_json = ?, definition_hash = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(input.definition),
          flowDefinitionHash(input.definition),
          input.nowMs,
          input.id,
        );
      if (result.changes === 0) throw new Error(`Unknown flow: ${input.id}`);
      const updated = get(input.id);
      if (updated === null) throw new Error(`Flow ${input.id} vanished immediately after update.`);
      return updated;
    },

    getById: get,

    getByName(name) {
      const row = selectByName.get(name) as FlowRow | undefined;
      return row === undefined ? null : toRecord(row);
    },

    list() {
      return (selectAll.all() as FlowRow[]).map(toRecord);
    },
  };
};
```

- [ ] **Step 4: Export from the barrel**

Add `export * from './db/flow-repo.js';` to `packages/server/src/index.ts`.

- [ ] **Step 5: Run the tests, then the full gate and commit**

```bash
pnpm test -- packages/server
pnpm build && pnpm lint && pnpm test
git add packages/server
git commit -m "feat(server): flow repository storing each definition beside its hash

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Partial content hash

**Files:**
- Create: `packages/server/src/fs/partial-hash.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/fs/partial-hash.test.ts`

**Interfaces:**
- Consumes: `PartialHashParts` from `@trawlarr/core`.
- Produces:
  - `HASH_WINDOW_BYTES: 65536`
  - `partialHashFile(path: string): Promise<PartialHashParts>`
  - `identityFromStat(input: { stat: Stats; hash: PartialHashParts }): IdentityCandidate` — re-exported convenience wrapping `buildIdentityCandidate`

This is the IO half of file identity, deliberately deferred out of P0 because `@trawlarr/core` performs no IO. `core` defines the key format; this reads the bytes.

Reading only a window from each end means identity costs the same for a 40 GB file as for a 40 MB one. That matters: a full-content hash of a library is hours of IO, and identity is consulted on every scan.

- [ ] **Step 1: Write the failing test**

`packages/server/src/fs/partial-hash.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HASH_WINDOW_BYTES, partialHashFile } from './partial-hash.js';

const write = (name: string, contents: Buffer | string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-hash-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
};

const filled = (size: number, byte: number): Buffer => Buffer.alloc(size, byte);

describe('partialHashFile', () => {
  it('reports the exact size alongside the digests', async () => {
    const parts = await partialHashFile(write('a.bin', filled(1000, 1)));
    expect(parts.sizeBytes).toBe(1000);
    expect(parts.headHex).toHaveLength(64);
    expect(parts.tailHex).toHaveLength(64);
  });

  it('is stable for identical content', async () => {
    const a = await partialHashFile(write('a.bin', filled(5000, 7)));
    const b = await partialHashFile(write('b.bin', filled(5000, 7)));
    expect(a).toEqual(b);
  });

  it('differs when the head differs', async () => {
    const base = filled(200_000, 0);
    const changed = Buffer.from(base);
    changed[0] = 255;
    const a = await partialHashFile(write('a.bin', base));
    const b = await partialHashFile(write('b.bin', changed));
    expect(a.headHex).not.toBe(b.headHex);
  });

  it('differs when the tail differs', async () => {
    // The interesting case: a file whose only change is far past the head
    // window. A head-only hash would call these identical.
    const base = filled(200_000, 0);
    const changed = Buffer.from(base);
    changed[changed.length - 1] = 255;
    const a = await partialHashFile(write('a.bin', base));
    const b = await partialHashFile(write('b.bin', changed));
    expect(a.headHex).toBe(b.headHex);
    expect(a.tailHex).not.toBe(b.tailHex);
  });

  it('handles a file smaller than the window without reading past its end', async () => {
    const parts = await partialHashFile(write('small.bin', filled(10, 3)));
    expect(parts.sizeBytes).toBe(10);
    expect(parts.headHex).toHaveLength(64);
    expect(parts.tailHex).toHaveLength(64);
  });

  it('handles an empty file', async () => {
    const parts = await partialHashFile(write('empty.bin', Buffer.alloc(0)));
    expect(parts.sizeBytes).toBe(0);
    expect(parts.headHex).toHaveLength(64);
  });

  it('exposes the window size it reads', () => {
    expect(HASH_WINDOW_BYTES).toBe(65536);
  });

  it('rejects a path that does not exist, naming it', async () => {
    await expect(partialHashFile('/nope/missing.bin')).rejects.toThrow(/missing\.bin/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test -- packages/server/src/fs/partial-hash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/server/src/fs/partial-hash.ts`:

```ts
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { buildIdentityCandidate, type IdentityCandidate, type PartialHashParts } from '@trawlarr/core';

/**
 * Bytes read from each end of the file.
 *
 * Deliberately not the whole file: identity is consulted on every scan, and
 * hashing a whole library would be hours of IO. A window from each end plus
 * the exact size distinguishes real media files cheaply — two different
 * encodes share neither their header nor their trailing index.
 */
export const HASH_WINDOW_BYTES = 65_536;

const digest = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

export const partialHashFile = async (path: string): Promise<PartialHashParts> => {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (cause) {
    throw new Error(`Cannot hash ${path}: ${(cause as Error).message}`, { cause });
  }

  const handle = await open(path, 'r');
  try {
    const window = Math.min(HASH_WINDOW_BYTES, size);
    const head = Buffer.alloc(window);
    if (window > 0) await handle.read(head, 0, window, 0);

    // For a file at or below one window, head and tail cover the same bytes.
    // That is correct rather than wasteful: the pair still identifies it.
    const tail = Buffer.alloc(window);
    if (window > 0) await handle.read(tail, 0, window, Math.max(0, size - window));

    return { sizeBytes: size, headHex: digest(head), tailHex: digest(tail) };
  } finally {
    await handle.close();
  }
};

/**
 * `fs.stat` reports `dev`/`ino` as numbers here; large inode values would lose
 * precision as doubles, so identity keys are built from their string forms in
 * `@trawlarr/core`.
 */
export const identityFromStat = (input: {
  stat: Stats;
  hash: PartialHashParts;
}): IdentityCandidate =>
  buildIdentityCandidate({
    deviceId: input.stat.dev,
    inode: input.stat.ino,
    hash: input.hash,
  });
```

- [ ] **Step 4: Export from the barrel**

Add `export * from './fs/partial-hash.js';` to `packages/server/src/index.ts`.

- [ ] **Step 5: Run the tests, then the full gate and commit**

```bash
pnpm test -- packages/server
pnpm build && pnpm lint && pnpm test
git add packages/server
git commit -m "feat(server): partial content hash for file identity

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ffprobe, and persisting probe / facts / ledger

**Files:**
- Create: `packages/server/src/probe/ffprobe.ts`
- Modify: `packages/server/src/db/media-file-repo.ts`, `packages/server/src/index.ts`
- Test: `packages/server/src/probe/ffprobe.test.ts`, `packages/server/src/db/media-file-repo.test.ts`

**Interfaces:**
- Consumes: `ProbeData` from `@trawlarr/plugin-api`; `FactSet`, `extractFacts` from `@trawlarr/core`; the existing `MediaFileRepo`.
- Produces:
  - `probeFile(input: { ffprobePath: string; path: string }): Promise<ProbeData>`
  - `class ProbeError extends Error` carrying `path`
  - `MediaFileRepo` gains:
    - `setProbe(input: { fileId: string; probe: ProbeData; facts: FactSet }): void` — stores `probe_json` plus the denormalised `video_codec`, `audio_codec`, `resolution`, `duration_ms`, `bitrate`
    - `setLedger(input: { fileId: string; record: LedgerRecord; preFacts?: FactSet | null; postFacts?: FactSet | null; lastRunId?: string | null }): void`
    - `getLedger(fileId: string): LedgerRecord | null`
    - `getProbe(fileId: string): { probe: ProbeData; facts: FactSet } | null`
    - `listByLibrary(input: { libraryId: string; state?: FileState }): MediaFileRow[]`
    - `requeue(fileId: string): void` — applies `applyRequeue` and persists
    - `countsByState(libraryId: string): Record<FileState, number>`

`setLedger` supersedes `setState` for anything that has run; keep `setState` since the scanner and the claim path use it.

- [ ] **Step 1: Write the failing ffprobe test**

`packages/server/src/probe/ffprobe.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProbeError, probeFile } from './ffprobe.js';

const execFileAsync = promisify(execFile);
let media: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-probe-'));
  media = join(dir, 'sample.mkv');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=5',
    '-f', 'lavfi', '-i', 'sine=duration=1',
    '-c:v', 'libx264', '-c:a', 'aac', media,
  ]);
}, 60_000);

describe('probeFile', () => {
  it('returns the streams and format ffprobe reports', async () => {
    const probe = await probeFile({ ffprobePath: 'ffprobe', path: media });
    expect(probe.streams?.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
    expect(probe.format?.duration).toBeDefined();
  });

  it('preserves each stream index, which identity and mapping depend on', async () => {
    const probe = await probeFile({ ffprobePath: 'ffprobe', path: media });
    expect(probe.streams?.map((s) => s.index)).toEqual([0, 1]);
  });

  it('fails with the path named when the file is not media', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trawlarr-probe-'));
    const notMedia = join(dir, 'notes.txt');
    await execFileAsync('bash', ['-c', `echo hello > ${notMedia}`]);
    await expect(probeFile({ ffprobePath: 'ffprobe', path: notMedia })).rejects.toThrow(ProbeError);
    await expect(probeFile({ ffprobePath: 'ffprobe', path: notMedia })).rejects.toThrow(/notes\.txt/);
  });

  it('fails with the path named when the file is absent', async () => {
    await expect(probeFile({ ffprobePath: 'ffprobe', path: '/nope/x.mkv' })).rejects.toThrow(/x\.mkv/);
  });

  it('fails clearly when ffprobe itself cannot be run', async () => {
    await expect(
      probeFile({ ffprobePath: '/nonexistent-ffprobe', path: media }),
    ).rejects.toThrow(ProbeError);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test -- packages/server/src/probe`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ffprobe**

`packages/server/src/probe/ffprobe.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeData } from '@trawlarr/plugin-api';

const execFileAsync = promisify(execFile);

export class ProbeError extends Error {
  readonly path: string;

  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(`Cannot probe ${path}: ${message}`, options);
    this.name = 'ProbeError';
    this.path = path;
  }
}

/** Large enough for a probe of a file with many streams and chapters. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const probeFile = async (input: {
  ffprobePath: string;
  path: string;
}): Promise<ProbeData> => {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      input.ffprobePath,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input.path],
      { maxBuffer: MAX_OUTPUT_BYTES },
    ));
  } catch (cause) {
    throw new ProbeError(input.path, (cause as Error).message, { cause });
  }

  let parsed: ProbeData;
  try {
    parsed = JSON.parse(stdout) as ProbeData;
  } catch (cause) {
    throw new ProbeError(input.path, 'ffprobe produced output that is not JSON', { cause });
  }

  // ffprobe exits 0 with an empty object for a file it cannot decode, so an
  // absent streams array is a failure rather than a file with no streams.
  if (parsed.streams === undefined) {
    throw new ProbeError(input.path, 'ffprobe reported no streams — not a media file?');
  }
  return parsed;
};
```

- [ ] **Step 4: Write the failing repo tests**

Append to `packages/server/src/db/media-file-repo.test.ts`. The file already has a `beforeEach` seeding a library and a `scan()` helper — reuse them.

```ts
describe('probe, facts and ledger persistence', () => {
  const probe = {
    format: { duration: '1440.5', bit_rate: '8000000' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      { index: 1, codec_type: 'audio', codec_name: 'eac3' },
    ],
  };

  it('stores the probe and the denormalised columns used for filtering', () => {
    const id = scan();
    const facts = extractFacts({ probe: probe as never, container: 'mkv', sizeBytes: 4096 });
    repo.setProbe({ fileId: id, probe: probe as never, facts });

    const stored = repo.getProbe(id);
    expect(stored?.probe).toEqual(probe);
    expect(stored?.facts).toEqual(facts);

    const row = db.prepare(`SELECT * FROM media_file WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row.video_codec).toBe('h264');
    expect(row.audio_codec).toBe('eac3');
    expect(row.resolution).toBe('1080p');
    expect(row.duration_ms).toBe(1_440_500);
    expect(row.bitrate).toBe(8_000_000);
  });

  it('returns null for a file that has never been probed', () => {
    expect(repo.getProbe(scan())).toBeNull();
  });

  it('round-trips a ledger record', () => {
    const id = scan();
    const record = {
      state: 'held' as const,
      signature: 'sig-1',
      attemptCount: 2,
      consecutiveNoopCount: 1,
      holdUntilMs: NOW + 5000,
    };
    repo.setLedger({ fileId: id, record });
    expect(repo.getLedger(id)).toEqual(record);
  });

  it('stores the pre and post fact sets a run recorded', () => {
    const id = scan();
    const pre = extractFacts({ probe: probe as never, container: 'mkv', sizeBytes: 4096 });
    const post = extractFacts({ probe: probe as never, container: 'mkv', sizeBytes: 2048 });
    repo.setLedger({ fileId: id, record: newLedgerRecord(), preFacts: pre, postFacts: post, lastRunId: 'job-1' });
    const row = db.prepare(`SELECT * FROM media_file WHERE id = ?`).get(id) as Record<string, string>;
    expect(JSON.parse(row.pre_facts_json)).toEqual(pre);
    expect(JSON.parse(row.post_facts_json)).toEqual(post);
    expect(row.last_run_id).toBe('job-1');
  });

  it('lists a library, optionally filtered by state', () => {
    const a = scan();
    repo.setState({ fileId: a, state: 'good' });
    const b = scan({
      identity: buildIdentityCandidate({ deviceId: 2049, inode: 43, hash: { ...hash, headHex: 'cc' } }),
      path: '/media/movies/Other.mkv',
    });
    repo.setState({ fileId: b, state: 'queued' });

    expect(repo.listByLibrary({ libraryId: LIB })).toHaveLength(2);
    expect(repo.listByLibrary({ libraryId: LIB, state: 'queued' }).map((r) => r.id)).toEqual([b]);
  });

  it('counts by state, reporting zero for states with no files', () => {
    const a = scan();
    repo.setState({ fileId: a, state: 'good' });
    const counts = repo.countsByState(LIB);
    expect(counts.good).toBe(1);
    expect(counts.queued).toBe(0);
    expect(counts.not_converging).toBe(0);
  });

  it('requeue clears both counters and returns the file to the queue', () => {
    const id = scan();
    repo.setLedger({
      fileId: id,
      record: { state: 'not_converging', signature: 'sig', attemptCount: 3, consecutiveNoopCount: 1, holdUntilMs: NOW },
    });
    repo.requeue(id);
    expect(repo.getLedger(id)).toMatchObject({
      state: 'queued', attemptCount: 0, consecutiveNoopCount: 0, holdUntilMs: null,
    });
  });
});
```

Add the imports this block needs to the top of that test file: `extractFacts`, `newLedgerRecord`, `buildIdentityCandidate` from `@trawlarr/core`.

- [ ] **Step 5: Run them and confirm they fail**

Run: `pnpm test -- packages/server/src/db/media-file-repo.test.ts`
Expected: FAIL — `setProbe` is not a function.

- [ ] **Step 6: Implement the repo additions**

Extend `MediaFileRepo` in `packages/server/src/db/media-file-repo.ts`. Notes that matter:

- Derive the denormalised columns from the `FactSet`, not by re-reading the probe — the fact set is already the canonical reduction, and deriving them twice invites drift. Resolution comes from the projection's vocabulary; reuse the same width buckets the file-object projection uses by importing nothing and instead storing `facts.width`/`facts.height` derived label computed here, documented as matching `video_resolution`.
- `countsByState` must return an entry for every `FileState`, zero-filled, so a caller can render a dashboard without special-casing absent keys.
- `requeue` applies `applyRequeue` from `@trawlarr/core` to the stored record rather than writing literals, so the reset rule lives in one place.

```ts
const RESOLUTION_LABELS: ReadonlyArray<{ minWidth: number; label: string }> = [
  { minWidth: 7000, label: '8KUHD' },
  { minWidth: 3000, label: '4KUHD' },
  { minWidth: 1800, label: '1080p' },
  { minWidth: 1200, label: '720p' },
  { minWidth: 1000, label: '576p' },
  { minWidth: 700, label: '480p' },
];

/** Matches the `video_resolution` vocabulary community plugins compare against. */
const resolutionOf = (width: number | null): string | null => {
  if (width === null) return null;
  return RESOLUTION_LABELS.find((entry) => width >= entry.minWidth)?.label ?? 'other';
};

const ALL_STATES: readonly FileState[] = [
  'unknown', 'queued', 'running', 'good', 'failed', 'not_converging', 'held',
];
```

- [ ] **Step 7: Run the tests, then the full gate and commit**

```bash
pnpm test -- packages/server
pnpm build && pnpm lint && pnpm test
git add packages/server
git commit -m "feat(server): ffprobe wrapper and probe/facts/ledger persistence

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Directory walk and the scanner

**Files:**
- Create: `packages/server/src/fs/walk.ts`, `packages/server/src/scanner/scan-library.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/fs/walk.test.ts`, `packages/server/src/scanner/scan-library.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `matchIdentity`, `extractFacts`, `computeSignature`, `isKnownGood`, `newLedgerRecord` from `@trawlarr/core`; `runChunked`.
- Produces:
  - `walkFiles(input: { roots: readonly string[]; extensions: readonly string[] }): AsyncGenerator<{ path: string; stat: Stats }>`
  - `interface ScanSummary { seen: number; added: number; updated: number; queued: number; skippedHardlinked: number; unreadable: number; alreadyGood: number }`
  - `scanLibrary(input: ScanLibraryInput): Promise<ScanSummary>` where
    `ScanLibraryInput = { db: Db; libraryId: string; ffprobePath: string; nowMs: () => number; onProgress?: (seen: number) => void }`

### What the scanner must do, and why each step is there

For every file under the library's roots whose extension matches:

1. `stat` it. An unreadable file increments `unreadable` and is skipped — one bad file must never abort a scan.
2. Compute the partial hash and resolve identity by inode, then content. Path is **not** the key: media managers rename constantly, and keying on path would re-transcode a converged library after every rename sweep.
3. `upsertScanned`, which preserves the existing record on a rename. Catch `IdentityConflictError` and skip that one file with a count — do not let it abort the scan.
4. If `nlink > 1` and the library does not allow hardlinked files, leave the file alone, count it in `skippedHardlinked`, and do not queue it. Replacing a hardlinked file either breaks the link or mutates a copy someone is still seeding.
5. Probe only when the file is new or its `size`/`mtime` changed. Probing is the expensive part of a scan; re-probing an unchanged file is pure waste.
6. Extract facts, compute the signature from the library's flow hash, and compare against the stored one.
7. **If the signature matches and the state is `good`, leave it alone** and count `alreadyGood`. **If it does not match, move the file to `queued`** — resetting nothing else. This is the step the whole convergence design depends on: nothing else transitions `good` back to `queued`, so omitting it means a flow edit silently never re-evaluates anything.
8. Leave `failed` and `not_converging` files alone. Those are terminal until someone requeues them; a scan must not silently retry a file the system has given up on.

A library with no flow attached cannot compute a signature. Skip queueing entirely in that case and report it — do not invent a signature.

- [ ] **Step 1: Write the failing walk test**

`packages/server/src/fs/walk.test.ts`:

```ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkFiles } from './walk.js';

const tree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-walk-'));
  mkdirSync(join(root, 'nested', 'deep'), { recursive: true });
  writeFileSync(join(root, 'a.mkv'), 'x');
  writeFileSync(join(root, 'b.MP4'), 'x');
  writeFileSync(join(root, 'notes.txt'), 'x');
  writeFileSync(join(root, 'nested', 'c.mkv'), 'x');
  writeFileSync(join(root, 'nested', 'deep', 'd.mkv'), 'x');
  return root;
};

const collect = async (root: string, extensions: string[]): Promise<string[]> => {
  const found: string[] = [];
  for await (const entry of walkFiles({ roots: [root], extensions })) found.push(entry.path);
  return found.map((p) => p.slice(root.length + 1)).sort();
};

describe('walkFiles', () => {
  it('finds matching files recursively', async () => {
    const root = tree();
    expect(await collect(root, ['mkv'])).toEqual(['a.mkv', 'nested/c.mkv', 'nested/deep/d.mkv']);
  });

  it('matches extensions case-insensitively', async () => {
    const root = tree();
    expect(await collect(root, ['mp4'])).toEqual(['b.MP4']);
  });

  it('ignores non-matching extensions', async () => {
    const root = tree();
    expect(await collect(root, ['mkv'])).not.toContain('notes.txt');
  });

  it('yields a stat alongside each path, so callers need not stat again', async () => {
    const root = tree();
    for await (const entry of walkFiles({ roots: [root], extensions: ['mkv'] })) {
      expect(entry.stat.isFile()).toBe(true);
      expect(entry.stat.size).toBeGreaterThan(0);
    }
  });

  it('does not follow directory symlinks, which could loop forever', async () => {
    const root = tree();
    symlinkSync(root, join(root, 'nested', 'loop'), 'dir');
    const found = await collect(root, ['mkv']);
    expect(found).toEqual(['a.mkv', 'nested/c.mkv', 'nested/deep/d.mkv']);
  });

  it('skips an unreadable directory rather than aborting the walk', async () => {
    const root = tree();
    const found: string[] = [];
    for await (const entry of walkFiles({ roots: [root, '/nonexistent-root'], extensions: ['mkv'] })) {
      found.push(entry.path);
    }
    expect(found).toHaveLength(3);
  });

  it('yields nothing for an empty extension list', async () => {
    expect(await collect(tree(), [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails, then implement the walk**

`packages/server/src/fs/walk.ts`:

```ts
import { opendir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Yield every file under `roots` whose extension matches, with its stat.
 *
 * Directory symlinks are not followed: a link pointing at an ancestor would
 * make the walk run forever, and media libraries do contain such links.
 * An unreadable directory or root is skipped rather than fatal — one bad
 * mount must not stop a library scan.
 */
export async function* walkFiles(input: {
  roots: readonly string[];
  extensions: readonly string[];
}): AsyncGenerator<{ path: string; stat: Stats }> {
  const wanted = new Set(input.extensions.map((extension) => extension.toLowerCase()));
  if (wanted.size === 0) return;

  const pending = [...input.roots];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      continue;
    }

    for await (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = extname(entry.name).replace('.', '').toLowerCase();
      if (!wanted.has(extension)) continue;

      try {
        yield { path, stat: await stat(path) };
      } catch {
        continue;
      }
    }
  }
}
```

- [ ] **Step 3: Write the failing scanner test**

`packages/server/src/scanner/scan-library.test.ts`. Build a real temp library with real media generated by ffmpeg — the scanner's job is filesystem reality, and a mocked filesystem would not exercise identity, hardlinks or probing.

```ts
import { execFile } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createFlowRepo } from '../db/flow-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { scanLibrary } from './scan-library.js';

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const now = () => NOW;

const definition: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'check', pluginId: 'trawlarr:checkVideoCodec', pluginVersion: '1.0.0', inputs: { codec: 'hevc' } },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' }],
};

const makeMedia = async (path: string): Promise<void> => {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=5',
    '-c:v', 'libx264', path,
  ]);
};

let root: string;
let db: Db;
let libraryId: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'trawlarr-scan-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  await makeMedia(join(root, 'one.mkv'));
  await makeMedia(join(root, 'sub', 'two.mkv'));
  writeFileSync(join(root, 'ignore.txt'), 'not media');
}, 120_000);

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  const flow = createFlowRepo(db).create({ name: 'HEVC', definition, nowMs: NOW });
  const library = createLibraryRepo(db).create({
    name: 'Movies', roots: [root], extensions: ['mkv'], flowId: flow.id, nowMs: NOW,
  });
  libraryId = library.id;
});

const scan = () => scanLibrary({ db, libraryId, ffprobePath: 'ffprobe', nowMs: now });

describe('scanLibrary', () => {
  it('finds media, ignores non-media, and queues what is not yet converged', async () => {
    const summary = await scan();
    expect(summary.seen).toBe(2);
    expect(summary.added).toBe(2);
    expect(summary.queued).toBe(2);
    expect(createMediaFileRepo(db).listByLibrary({ libraryId, state: 'queued' })).toHaveLength(2);
  });

  it('stores the probe and the denormalised codec', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const [file] = repo.listByLibrary({ libraryId });
    expect(repo.getProbe(file!.id)?.probe.streams?.[0]?.codec_name).toBe('h264');
  });

  it('is idempotent: a second scan adds nothing and re-probes nothing', async () => {
    await scan();
    const second = await scan();
    expect(second.added).toBe(0);
    expect(second.seen).toBe(2);
    expect(createMediaFileRepo(db).listByLibrary({ libraryId })).toHaveLength(2);
  });

  it('leaves a converged file alone', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const files = repo.listByLibrary({ libraryId });
    // Mark both good with their current signature, as a successful run would.
    for (const file of files) {
      const ledger = repo.getLedger(file.id)!;
      repo.setLedger({ fileId: file.id, record: { ...ledger, state: 'good' } });
    }
    const summary = await scan();
    expect(summary.alreadyGood).toBe(2);
    expect(summary.queued).toBe(0);
  });

  it('re-queues a converged file after the flow changes', async () => {
    // The step the whole convergence design depends on.
    await scan();
    const repo = createMediaFileRepo(db);
    for (const file of repo.listByLibrary({ libraryId })) {
      const ledger = repo.getLedger(file.id)!;
      repo.setLedger({ fileId: file.id, record: { ...ledger, state: 'good' } });
    }
    createFlowRepo(db).update({
      id: createFlowRepo(db).getByName('HEVC')!.id,
      definition: {
        ...definition,
        nodes: definition.nodes.map((n) =>
          n.id === 'check' ? { ...n, inputs: { codec: 'av1' } } : n,
        ),
      },
      nowMs: NOW + 1,
    });
    const summary = await scan();
    expect(summary.queued).toBe(2);
    expect(summary.alreadyGood).toBe(0);
  });

  it('keeps the same record when a file is renamed', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const before = repo.listByLibrary({ libraryId }).map((r) => r.id).sort();
    renameSync(join(root, 'one.mkv'), join(root, 'one-renamed.mkv'));
    try {
      await scan();
      const after = repo.listByLibrary({ libraryId }).map((r) => r.id).sort();
      expect(after).toEqual(before);
    } finally {
      renameSync(join(root, 'one-renamed.mkv'), join(root, 'one.mkv'));
    }
  });

  it('skips a hardlinked file unless the library allows it', async () => {
    const linked = join(root, 'sub', 'linked.mkv');
    linkSync(join(root, 'one.mkv'), linked);
    try {
      const summary = await scan();
      expect(summary.skippedHardlinked).toBeGreaterThan(0);
    } finally {
      execFileAsync('rm', ['-f', linked]);
    }
  });

  it('does not retry a terminal file', async () => {
    await scan();
    const repo = createMediaFileRepo(db);
    const [file] = repo.listByLibrary({ libraryId });
    const ledger = repo.getLedger(file!.id)!;
    repo.setLedger({ fileId: file!.id, record: { ...ledger, state: 'not_converging' } });
    await scan();
    expect(repo.getLedger(file!.id)?.state).toBe('not_converging');
  });

  it('reports rather than queues when the library has no flow', async () => {
    createLibraryRepo(db).setFlow(libraryId, null);
    const summary = await scan();
    expect(summary.seen).toBe(2);
    expect(summary.queued).toBe(0);
  });

  it('counts an unreadable file without aborting the scan', async () => {
    writeFileSync(join(root, 'broken.mkv'), 'this is not media');
    try {
      const summary = await scan();
      expect(summary.unreadable).toBe(1);
      expect(summary.seen).toBe(3);
    } finally {
      execFileAsync('rm', ['-f', join(root, 'broken.mkv')]);
    }
  });
});
```

- [ ] **Step 4: Run them and confirm they fail, then implement the scanner**

Implement `scanLibrary` in `packages/server/src/scanner/scan-library.ts` following the eight numbered rules above. Requirements the tests pin:

- Probe only when the record is new or `size_bytes`/`mtime_ms` differ from the stat.
- A probe failure increments `unreadable`, leaves the record's state alone, and continues.
- Persist in chunks with `runChunked` rather than one transaction per file or one for the whole library.
- Report progress through `onProgress` so a CLI can show a count without the scanner knowing about output.

- [ ] **Step 5: Export from the barrel, run the gate, commit**

Add `export * from './fs/walk.js';` and `export * from './scanner/scan-library.js';` to `packages/server/src/index.ts`.

```bash
pnpm build && pnpm lint && pnpm test
git add packages/server
git commit -m "feat(server): directory walk and library scanner

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Staging, trash and companion files

**Files:**
- Create: `packages/server/src/library/paths.ts`, `packages/server/src/fs/companions.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/library/paths.test.ts`, `packages/server/src/fs/companions.test.ts`

**Interfaces:**
- Consumes: `LibraryRecord`.
- Produces:
  - `resolveStagingDir(input: { library: LibraryRecord; filePath: string }): string` — the library's configured `stagingDir`, else a hidden directory beside the file's root
  - `resolveTrashDir(input: { library: LibraryRecord; filePath: string }): string` — same rule for trash
  - `ensureDir(path: string): Promise<void>`
  - `isSameFilesystem(a: string, b: string): Promise<boolean>`
  - `class CrossDeviceStagingError extends Error`
  - `findCompanions(input: { filePath: string; companionExtensions: readonly string[] }): Promise<string[]>`
  - `companionTargetFor(input: { companionPath: string; oldMediaPath: string; newMediaPath: string }): string`
  - `moveCompanions(input: { companions: readonly string[]; oldMediaPath: string; newMediaPath: string }): Promise<void>`

### Why staging location matters

Replacement must be an atomic `rename(2)`, which only works within one filesystem. A staging directory under `/config` while the library sits on a NAS makes every replacement a long copy with a window where the file is neither the old nor the new one. So staging defaults to a hidden directory at the library root, and a configured directory on a different device is a detectable, reportable condition rather than a silent degradation.

### Why companions matter

A flow that changes container renames `movie.mkv` to `movie.mp4`. Left behind, `movie.en.srt` and `movie.nfo` stop being associated by the media server. Companions are found by matching the media file's basename, so `movie.en.srt` and `movie.srt` both belong to `movie.mkv` while `movie2.srt` does not.

- [ ] **Step 1: Write the failing tests**

`packages/server/src/fs/companions.test.ts`:

```ts
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { companionTargetFor, findCompanions, moveCompanions } from './companions.js';

const EXTENSIONS = ['srt', 'nfo', 'ass'];

const libraryDir = (names: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-comp-'));
  for (const name of names) writeFileSync(join(dir, name), 'x');
  return dir;
};

describe('findCompanions', () => {
  it('finds sidecars sharing the media basename, including language-tagged ones', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.srt', 'movie.en.srt', 'movie.nfo']);
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: EXTENSIONS,
    });
    expect(found.map((p) => p.slice(dir.length + 1)).sort()).toEqual([
      'movie.en.srt', 'movie.nfo', 'movie.srt',
    ]);
  });

  it('does not claim a different film whose name merely starts the same', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.srt', 'movie2.srt', 'movie-extended.srt']);
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: EXTENSIONS,
    });
    expect(found.map((p) => p.slice(dir.length + 1))).toEqual(['movie.srt']);
  });

  it('ignores extensions the library does not list', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.txt']);
    expect(await findCompanions({ filePath: join(dir, 'movie.mkv'), companionExtensions: EXTENSIONS }))
      .toEqual([]);
  });

  it('never returns the media file itself', async () => {
    const dir = libraryDir(['movie.mkv']);
    const found = await findCompanions({
      filePath: join(dir, 'movie.mkv'),
      companionExtensions: ['mkv', 'srt'],
    });
    expect(found).toEqual([]);
  });
});

describe('companionTargetFor', () => {
  it('carries the language tag across a container change', () => {
    expect(
      companionTargetFor({
        companionPath: '/m/movie.en.srt',
        oldMediaPath: '/m/movie.mkv',
        newMediaPath: '/m/movie.mp4',
      }),
    ).toBe('/m/movie.en.srt');
  });

  it('follows a basename change', () => {
    expect(
      companionTargetFor({
        companionPath: '/m/movie.en.srt',
        oldMediaPath: '/m/movie.mkv',
        newMediaPath: '/m/Movie (2016).mkv',
      }),
    ).toBe('/m/Movie (2016).en.srt');
  });
});

describe('moveCompanions', () => {
  it('renames each companion alongside the media file', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.en.srt', 'movie.nfo']);
    await moveCompanions({
      companions: [join(dir, 'movie.en.srt'), join(dir, 'movie.nfo')],
      oldMediaPath: join(dir, 'movie.mkv'),
      newMediaPath: join(dir, 'film.mkv'),
    });
    expect(existsSync(join(dir, 'film.en.srt'))).toBe(true);
    expect(existsSync(join(dir, 'film.nfo'))).toBe(true);
    expect(existsSync(join(dir, 'movie.en.srt'))).toBe(false);
  });

  it('does nothing when the media path is unchanged', async () => {
    const dir = libraryDir(['movie.mkv', 'movie.srt']);
    await moveCompanions({
      companions: [join(dir, 'movie.srt')],
      oldMediaPath: join(dir, 'movie.mkv'),
      newMediaPath: join(dir, 'movie.mkv'),
    });
    expect(existsSync(join(dir, 'movie.srt'))).toBe(true);
  });
});
```

`packages/server/src/library/paths.test.ts` must cover: the configured `stagingDir` winning; the default being a hidden directory under the root that contains the file; `resolveTrashDir` following the same rule; `ensureDir` being idempotent; and `isSameFilesystem` returning true for two paths in one temp directory. Write those tests in the same style — real directories, no mocks.

- [ ] **Step 2: Run them, confirm they fail, implement both modules**

Notes:
- `findCompanions` matches on the basename **without** its extension, then requires the remainder to be either empty or a dot-separated suffix — that is what admits `movie.en.srt` while rejecting `movie2.srt` and `movie-extended.srt`.
- `resolveStagingDir` picks the library root that contains the file so that a multi-root library stages beside the right filesystem.
- `isSameFilesystem` compares `stat().dev` of two existing directories; for a target that does not exist yet, compare against its nearest existing ancestor.

- [ ] **Step 3: Export from the barrel, run the gate, commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/server
git commit -m "feat(server): staging and trash resolution, companion-file handling

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Verify Output and Replace Original File

**Files:**
- Create: `packages/plugins-core/src/verifyOutput/index.ts`, `packages/plugins-core/src/replaceOriginalFile/index.ts`
- Modify: `packages/plugins-core/src/index.ts`, `packages/engine/src/executor/vouchable.ts`
- Test: `packages/plugins-core/src/plugins.test.ts`

**Interfaces:**
- Consumes: `PluginDetails`, `PluginInputArgs`, `PluginOutputArgs`.
- Produces: `FIRST_PARTY_PLUGINS` gains `trawlarr:verifyOutput` and `trawlarr:replaceOriginal`. Both ids join `FIRST_PARTY_ENGINE_CONTROLLED` in `vouchable.ts`, because the engine performs their effects and must be able to render them inert for a dry run.

### This is the destructive step — the checks live inside the node

Spec §6.1: the engine never implicitly replaces a file; replacement is a node the flow author places deliberately, so a flow's destructive effects are visible in the graph. The safety checks belong **inside** the node, where they cannot be forgotten, with tolerances as node inputs:

- the output probes cleanly
- duration within tolerance of the original
- expected stream count present
- size sanity — a 40 GB file becoming 200 MB is a failure, not a success
- free space checked before work begins
- **the file is not hardlinked** unless the library allows it
- replacement is an atomic rename from same-filesystem staging; a cross-device fallback is reported in the step trace because its failure window is wider
- the original goes to the library's trash, not `unlink`
- companions are renamed in the same step

Failed verification routes out the node's **failure output** rather than throwing, so a flow can branch on it.

**These plugins declare their inputs and outputs and delegate the actual filesystem work to the engine**, exactly as `trawlarr:execute` does — their `plugin()` body throws if invoked directly, because `createExecuteRunner`-style substitution supplies the real behaviour. That is what makes a dry run possible. Implementing the filesystem work inside the plugin would make the node unvouchable and break dry runs.

- [ ] **Step 1: Write the failing tests**

Add to `packages/plugins-core/src/plugins.test.ts`:

```ts
describe('trawlarr:verifyOutput', () => {
  const plugin = () => FIRST_PARTY_PLUGINS['trawlarr:verifyOutput']!.module;

  it('declares pass and fail outputs so a flow can branch on verification', () => {
    const details = plugin().details();
    expect(details.outputs.map((o) => o.number)).toEqual([1, 2]);
    expect(details.outputs[1]?.tooltip.toLowerCase()).toMatch(/fail|did not/);
  });

  it('exposes the tolerances as inputs rather than hard-coding them', () => {
    const names = plugin().details().inputs.map((i) => i.name);
    expect(names).toContain('durationToleranceSeconds');
    expect(names).toContain('minSizeRatio');
  });

  it('refuses to run outside an engine that supplies its behaviour', async () => {
    await expect(plugin().plugin(argsFor())).rejects.toThrow(/engine/i);
  });
});

describe('trawlarr:replaceOriginal', () => {
  const plugin = () => FIRST_PARTY_PLUGINS['trawlarr:replaceOriginal']!.module;

  it('declares success and failure outputs', () => {
    expect(plugin().details().outputs.map((o) => o.number)).toEqual([1, 2]);
  });

  it('says plainly in its description that it replaces the original', () => {
    // A flow author reading the palette must not be surprised by this node.
    expect(plugin().details().description.toLowerCase()).toMatch(/replace|original/);
  });

  it('refuses to run outside an engine that supplies its behaviour', async () => {
    await expect(plugin().plugin(argsFor())).rejects.toThrow(/engine/i);
  });
});

describe('side-effect classification', () => {
  it('classifies both new nodes as engine-controlled so a dry run can render them inert', () => {
    for (const id of ['trawlarr:verifyOutput', 'trawlarr:replaceOriginal']) {
      const entry = FIRST_PARTY_PLUGINS[id]!;
      expect(
        classifySideEffects({
          id: entry.id, absPath: 'builtin', version: '1',
          details: entry.module.details(), module: entry.module,
        } as never),
      ).toBe('engine-controlled');
    }
  });
});
```

Import `classifySideEffects` from `@trawlarr/engine` in that test file. Note `plugins-core` must NOT depend on `@trawlarr/engine` — but its **test** may, since `engine` already depends on `plugins-core` only at runtime and vitest resolves both from source. If `pnpm check:refs` or the build objects, put this one classification test in `packages/engine/src/executor/vouchable.test.ts` instead and say so in your report.

- [ ] **Step 2: Run them, confirm they fail, implement both nodes**

Follow the shape of `packages/plugins-core/src/execute/index.ts` exactly: a full `details()` with real labels and tooltips, and a `plugin()` that throws naming the engine. `verifyOutput`'s inputs are `durationToleranceSeconds` (default `'1'`) and `minSizeRatio` (default `'0.05'`); `replaceOriginal`'s are `trashRetentionDays` (default `'14'`) and `allowCrossDevice` (default `'true'`).

Then add both ids to `FIRST_PARTY_ENGINE_CONTROLLED` in `packages/engine/src/executor/vouchable.ts`, and register both in `FIRST_PARTY_PLUGINS`.

- [ ] **Step 3: Run the gate and commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/plugins-core packages/engine
git commit -m "feat(plugins-core): declare Verify Output and Replace Original File nodes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: The engine runners that do the destructive work

**Files:**
- Create: `packages/engine/src/executor/verify-output.ts`, `packages/engine/src/executor/replace-original.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/executor/verify-output.test.ts`, `packages/engine/src/executor/replace-original.test.ts`

**Interfaces:**
- Consumes: Task 7's node declarations; `probeFile`-shaped probing injected as a function so these stay testable; `LoadedPlugin`, `PluginModule`.
- Produces:
  - `interface VerifyReport { ok: boolean; reasons: string[] }`
  - `verifyOutput(input: { probe: ProbeData; originalProbe: ProbeData; outputSizeBytes: number; originalSizeBytes: number; durationToleranceSeconds: number; minSizeRatio: number }): VerifyReport` — pure, exported and tested directly
  - `createVerifyOutputRunner(input: { probeFile: (path: string) => Promise<ProbeData>; statFile: (path: string) => Promise<{ size: number; nlink: number }>; log?: (text: string) => void }): (plugin: LoadedPlugin) => PluginModule | null`
  - `createReplaceOriginalRunner(input: ReplaceRunnerInput): (plugin: LoadedPlugin) => PluginModule | null` where `ReplaceRunnerInput = { trashDirFor: (originalPath: string) => string; companionExtensions: readonly string[]; allowHardlinked: boolean; statFile: (path: string) => Promise<{ size: number; nlink: number }>; nowMs: () => number; log?: (text: string) => void }`

`verifyOutput` is pure so the whole decision table can be tested without touching a filesystem. The runners wrap it with the IO.

- [ ] **Step 1: Write the failing verify tests**

Test `verifyOutput` directly with constructed probes. Cover, each as its own case:

- identical duration, sane size → `ok: true`, no reasons
- output duration shorter than the original beyond tolerance → `ok: false`, a reason naming duration
- duration difference within tolerance → ok
- output size below `minSizeRatio` of the original → `ok: false`, a reason naming size. Use the spec's example: a 40 GB original and a 200 MB output must fail.
- output size *larger* than the original → ok, with no reason. A bigger file is a legitimate outcome (a remux, or a higher-quality encode), and rejecting it would refuse work the user asked for.
- a stream missing from the output that the original had → `ok: false`, a reason naming streams
- multiple problems → `ok: false` with **all** reasons, not just the first. A user fixing one and rediscovering the next is a bad experience.
- an unprobeable output (empty `streams`) → `ok: false`

Then test the runner: it returns `null` for any plugin other than `trawlarr:verifyOutput`; on a passing verification it routes to output 1; on failure it routes to output **2** and does not throw; and the reasons appear in the job log.

- [ ] **Step 2: Implement `verifyOutput` and its runner**

```ts
export const verifyOutput = (input: {
  probe: ProbeData;
  originalProbe: ProbeData;
  outputSizeBytes: number;
  originalSizeBytes: number;
  durationToleranceSeconds: number;
  minSizeRatio: number;
}): VerifyReport => {
  const reasons: string[] = [];
  const streams = input.probe.streams ?? [];

  if (streams.length === 0) {
    reasons.push('the output has no streams — ffprobe could not read it');
    // Nothing else is meaningful once the file is unreadable.
    return { ok: false, reasons };
  }

  const expected = (input.originalProbe.streams ?? []).length;
  if (streams.length < expected) {
    reasons.push(`the output has ${streams.length} streams, fewer than the original's ${expected}`);
  }

  const outDuration = Number.parseFloat(String(input.probe.format?.duration ?? ''));
  const origDuration = Number.parseFloat(String(input.originalProbe.format?.duration ?? ''));
  if (Number.isFinite(outDuration) && Number.isFinite(origDuration)) {
    const drift = Math.abs(outDuration - origDuration);
    if (drift > input.durationToleranceSeconds) {
      reasons.push(
        `the output runs ${outDuration.toFixed(1)}s against the original's ` +
          `${origDuration.toFixed(1)}s, a ${drift.toFixed(1)}s difference`,
      );
    }
  }

  // Only a suspiciously SMALL output is a failure. A larger file is a normal
  // outcome of a remux or a higher-quality encode.
  if (input.originalSizeBytes > 0) {
    const ratio = input.outputSizeBytes / input.originalSizeBytes;
    if (ratio < input.minSizeRatio) {
      reasons.push(
        `the output is ${(ratio * 100).toFixed(1)}% of the original's size, below the ` +
          `${(input.minSizeRatio * 100).toFixed(1)}% floor — this usually means a truncated encode`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
};
```

The runner reads `args.inputFileObj._id` for the output path and `args.originalLibraryFile._id` for the original, probes and stats both, and routes on the report.

- [ ] **Step 3: Write the failing replace tests**

Use a real temp directory — this is the destructive node and a mocked filesystem would prove nothing. Cover:

- the original ends up in the trash directory, not deleted
- the output takes the original's path, byte-for-byte (compare a checksum)
- a companion (`movie.en.srt`) follows a container change to `movie.mp4`
- a hardlinked original (`nlink > 1`) is refused with the reason logged, routes to output 2, and **leaves both files untouched**
- a hardlinked original IS replaced when `allowHardlinked` is true
- when the resolved trash directory does not exist it is created
- the runner returns `null` for any plugin other than `trawlarr:replaceOriginal`
- the node routes to output 2 rather than throwing when the output file is missing

- [ ] **Step 4: Implement the replace runner**

Order of operations, which the tests pin:

1. Stat the original. If `nlink > 1` and `!allowHardlinked`, log the reason and route to output 2 **without touching anything**.
2. Ensure the trash directory exists.
3. Move the original into trash under a name that cannot collide — include a timestamp from the injected clock.
4. Rename the output onto the original's path. If that fails cross-device, copy-then-rename and note the fallback in the log, because its failure window is wider. Surface Task 6's `CrossDeviceStagingError` when `allowCrossDevice` is false, so an operator who wants replacement to be strictly atomic can insist on it.
5. Move companions to follow the new media path.
6. Return output 1 with `outputFileObj._id` set to the **final** path.

If step 4 fails after step 3 moved the original, restore the original from trash before routing to output 2. A half-applied replacement that loses the user's file is the worst outcome this node can produce, and it is the one case worth explicit recovery.

- [ ] **Step 5: Export from the barrel, run the gate, commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/engine
git commit -m "feat(engine): output verification and original replacement through trash

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Job recording and running one file

**Files:**
- Create: `packages/server/src/db/job-repo.ts`, `packages/server/src/worker/run-job.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/db/job-repo.test.ts`, `packages/server/src/worker/run-job.test.ts`

**Interfaces:**
- Produces:
  - `createJobRepo(db: Db): JobRepo` with `start({fileId, flowId, flowHash, nowMs}): string`, `recordStep({jobId, step}): void`, `finish({jobId, state, outcome, nowMs}): void`, `heartbeat({jobId, nowMs}): void`, `listForFile(fileId): JobRow[]`, `getSteps(jobId): JobStepRow[]`
  - `runJob(input: RunJobInput): Promise<RunJobResult>` where
    `RunJobInput = { db: Db; claimed: ClaimedFile; ffmpegPath: string; ffprobePath: string; nowMs: () => number }` and
    `RunJobResult = { jobId: string; state: FileState; stepCount: number; outcome: string }`

`runJob` is the single place that turns a claimed file into a completed ledger transition. It loads the library and flow, builds the plugin args, assembles the node runners (execute, verify, replace), calls `runFlow`, records every step, re-probes when the flow claims it modified the file, and folds the result through `applyRunOutcome`.

Wire these through `buildPluginInputArgs` explicitly, because each is a column or record that already exists and would otherwise silently arrive empty:

- `librarySettings` — the `LibraryRecord`, which community plugins read (30 hits in the corpus)
- `userVariables.library` — the library's `userVariables`; `userVariables.global` stays `{}` until settings exist in P2b
- `configVars.config.ffmpegPath` / `ffprobePath` — from this task's inputs, not hard-coded
- `deps.crudTransDBN` — built from `createCrudTransDbn` over `createPluginDocumentRepo(db)`, so a plugin's skip-list survives restarts. Passing a fresh in-memory map per job would make `processedCheck` report "not processed" forever.
- `job.footprintId` — the file's stable identity, not its path

The step trace is what makes "why did this file get this decision?" answerable, so record every step including a failing one — that is the point of `job_step`.

- [ ] **Step 1: Write the failing job-repo test**

Cover: `start` returns an id and writes a row with state `running`; `recordStep` stores sequence, node, plugin, output number, duration and log excerpt; the `(job_id, seq)` uniqueness is enforced; `finish` sets state, outcome and `ended_at`; `heartbeat` advances `heartbeat_at` without touching state; `listForFile` returns newest first; `getSteps` returns them in sequence order.

- [ ] **Step 2: Write the failing run-job test**

Build a real library with real media and a real flow — `start → checkVideoCodec(hevc) → beginCommand → setVideoEncoder → execute → verifyOutput → replaceOriginal → end`. Cover:

- an h264 file is transcoded, verified, and the original replaced; afterwards the library path holds an **hevc** file and the original is in trash
- the ledger record becomes `good` with the current signature stored
- every step is recorded in `job_step`, in order
- a second run over the now-converged file takes the "already correct" branch, records the two steps it walked, does no ffmpeg work, and leaves the file alone
- a flow whose plugin cannot be loaded fails the job, records the step with its error, and moves the file to `held` with a backoff rather than `failed` on the first attempt
- when the flow claims it modified the file but the facts are unchanged, the ledger goes to `not_converging` — the one-strike rule

- [ ] **Step 3: Implement, run the gate, commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/server
git commit -m "feat(server): job recording and running a single file end to end

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: The worker loop

**Files:**
- Create: `packages/server/src/worker/loop.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/worker/loop.test.ts`

**Interfaces:**
- Produces:
  - `interface LoopSummary { claimed: number; succeeded: number; failed: number; skipped: number }`
  - `runQueue(input: { db: Db; ffmpegPath: string; ffprobePath: string; nowMs: () => number; libraryIds?: string[]; maxFiles?: number; signal?: AbortSignal; onFile?: (event: { fileId: string; path: string; state: FileState }) => void }): Promise<LoopSummary>`

The loop claims one file at a time through the existing atomic `claimNext`, runs it, and repeats until nothing is eligible, `maxFiles` is reached, or the signal aborts. Sequential by design: worker classes and concurrency caps are P2b, and a single worker is enough to converge a library unattended.

- [ ] **Step 1: Write the failing tests**

Cover, with a real library and real media:

- an empty queue returns all zeros without error
- three queued files are all processed, and the summary counts match
- `maxFiles: 1` stops after one, leaving the rest queued
- an aborted signal stops the loop promptly and leaves the remaining files claimable — assert on the **counts and states**, never on elapsed time
- a file that fails does not stop the loop; the next file is still processed
- a library that is paused (`enabled = 0`) has its files skipped
- `onFile` is called once per file with its resulting state

The abort test is the one most likely to be written as a timing assertion. Do not: abort after the first `onFile` callback fires, then assert the second file is still `queued`.

- [ ] **Step 2: Implement, run the gate, commit**

Requirements the tests pin: never claim from a disabled library; check the signal between files, not mid-file; and surface each file's resulting state through `onFile` so a CLI can report progress without the loop knowing about output.

```bash
pnpm build && pnpm lint && pnpm test
git add packages/server
git commit -m "feat(server): worker loop that drains the queue unattended

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: The CLI, and proving the whole thing works

**Files:**
- Create: `packages/server/src/cli.ts`
- Modify: `packages/server/package.json` (add a `bin` entry `trawlarr`), root `package.json` if a convenience script helps
- Test: `packages/server/test/end-to-end.test.ts`

**Interfaces:**
- Produces a CLI with these commands, parsed with `node:util`'s `parseArgs` as the engine CLI does:
  - `trawlarr library add --name <name> --root <path> [--root <path>...] [--extensions mkv,mp4] [--allow-hardlinked]`
  - `trawlarr flow add --name <name> --file <flow.json>`
  - `trawlarr library set-flow --library <name> --flow <name>`
  - `trawlarr scan --library <name>`
  - `trawlarr run [--library <name>] [--max <n>]`
  - `trawlarr status [--library <name>]`
  - a `--data-dir <path>` option, defaulting to `./trawlarr-data`, holding `trawlarr.db`

`status` prints per-library counts by state plus a convergence percentage — the number the whole product exists to report.

- [ ] **Step 1: Write the failing end-to-end test**

This is the deliverable. It must exercise the real CLI as a subprocess against a real library of real media, with no mocks:

```
1. Generate three h264 files in a temp directory, one with a companion .srt.
2. trawlarr library add --name Movies --root <dir>
3. trawlarr flow add --name HEVC --file <flow.json>   (the full transcode-and-replace flow)
4. trawlarr library set-flow --library Movies --flow HEVC
5. trawlarr scan --library Movies      → reports 3 files found and queued
6. trawlarr status                     → 0% converged
7. trawlarr run                        → processes 3 files
8. Assert with ffprobe that all three library files are now hevc
9. Assert the originals are in the library's trash
10. Assert the companion .srt still sits beside its media file
11. trawlarr status                    → 100% converged
12. trawlarr scan again                → 0 queued, 3 already good
13. trawlarr run again                 → claims nothing
```

Steps 11–13 are the ones that prove convergence rather than mere processing: a system that reprocessed everything on the second pass would pass steps 1–10 and fail here.

Remember `describe.runIf(...)` evaluates before an async `beforeAll`, so compute any ffmpeg-availability condition **synchronously** at module scope. This repo's end-to-end suite silently skipped every run for several commits because of exactly that.

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL — the CLI does not exist.

- [ ] **Step 3: Implement the CLI**

Follow `packages/engine/src/cli.ts` for structure. Requirements:
- Every command exits non-zero with a diagnosable message on failure; no raw stack traces.
- `run` prints each file's path and resulting state as it goes, so a long run is legible.
- The database is opened once and migrated on startup.
- `scan` and `run` both work when invoked repeatedly — idempotence is the point.

- [ ] **Step 4: Run the end-to-end test, then the full gate**

```
pnpm build && pnpm lint && pnpm test
```

Confirm the end-to-end suite RUNS rather than skipping, and show its named output.

- [ ] **Step 5: Update the README**

Add a short "Try it" section showing the six commands above against a real folder. Keep it factual; do not oversell. This is the first time trawlarr can be used, and the README currently offers no way to do so.

- [ ] **Step 6: Commit**

```bash
git add packages/server README.md
git commit -m "feat(server): trawlarr CLI and an end-to-end library convergence test

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Definition of done

- `pnpm build && pnpm lint && pnpm test` green from a clean checkout, twice; `pnpm check:refs` and `pnpm audit:licenses` green; CI green on GitHub.
- Pointing the CLI at a folder of h264 files and running `scan` then `run` leaves every file hevc, every original in trash, and every companion beside its media file.
- A second `scan` queues nothing and a second `run` claims nothing — the library is converged, not merely processed.
- Editing the flow re-queues exactly the affected files.
- A hardlinked file is skipped with a stated reason unless the library allows it.
- `status` reports a convergence percentage per library.
- No test asserts elapsed time.

## Not in this plan — P2b

The REST/WebSocket API; the filesystem watcher and cron rescan; worker classes, hardware concurrency caps and schedule windows; the Docker image with all six binaries; plugin source syncing and the plugin browser backend; flow validation that pauses a library with a stated reason (`library.paused_reason` exists and the loop honours it, but nothing populates it yet); the 100k-file scan benchmark.

Three things this plan deliberately declares without enforcing, so that nobody mistakes them for working:

- **Trash retention.** `Replace Original File` takes a `trashRetentionDays` input and moves originals into the library trash, but nothing prunes it. Trash grows without limit until P2b adds the sweep. Say so in the README's "Try it" section — a user filling a disk because we implied a cap would be our fault.
- **Per-job log files.** `job.log_path` stays null. Step excerpts are recorded in `job_step`, which is enough to answer "why did this file get this decision", but there is no full log on disk yet.
- **Stall detection.** `applyStall` and the heartbeat exist and `runJob` records heartbeats, but nothing watches for a job that stopped reporting. A single sequential worker cannot outlive its own loop, so this only matters once workers are separate processes.

Two constraints from `docs/engineering-notes/p2-prerequisites.md` are **discharged by this plan** — the scanner's signature recomputation (Task 5) and Replace Original File re-stating the file (Tasks 8–9). The rest of that document still applies, in particular that absorbed plugin changes do not yet round-trip `container` or `lastPluginDetails`, and that worker cancellation will need a process group once workers become child processes.
