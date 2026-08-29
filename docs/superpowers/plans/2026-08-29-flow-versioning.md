# Flow Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every published version of a flow, let a past version be viewed, compared and restored, and make a job's recorded `flow_hash` resolve to the graph that actually ran.

**Architecture:** A `flow_version` table appended to inside the same transaction that writes a flow's definition, so the live definition and the newest version can never disagree. The graph diff is a pure function in `@trawlarr/core` over `(fromNodeId, outputNumber, toNodeId)` edge triples. The UI hangs off routes that already exist, so nothing here depends on the flow editor.

**Tech Stack:** TypeScript ESM, better-sqlite3, vitest, React 18.

**Spec:** `docs/superpowers/specs/2026-08-29-flow-versioning-design.md`

## Global Constraints

- **Node 22.** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` — do **not** redirect nvm's output, it breaks the shell function.
- **Gate for every task:** `npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`. The `--force` is required: `tsc --build` is incremental and leaves `packages/server/dist/cli.js` older than a touched source, and the end-to-end suites' staleness guards then refuse to run eight tests in four files.
- **Licence audit stays MIT-only and pinned at 291 packages.** Widening it to ISC and BSD-3-Clause belongs to sub-project 2. **No new dependencies in this plan.**
- **No DOM testing library**, and none added. Web logic lives in pure `*-model.ts` modules tested with vitest; components are untested by design, so anything with a branch belongs in a model.
- Browser globals are reached structurally off `globalThis` (the repo typechecks with **no DOM lib**); `noUncheckedIndexedAccess` is on, so indexing yields `T | undefined`.
- **Migrations are plain SQL**, run by `db.exec` inside a transaction (`packages/server/src/db/migrate.ts`). There is no JS migration hook, so any backfill must be expressible in SQL.
- File-level doc comments in this repo say *why*, not *what*. The migrations are the strongest example — read `006_job_worker_identity.sql` before writing `007`.
- **Restore is a publish, not an undo.** It appends a new version; it never rewrites or removes one.
- **Nothing may estimate encode volume.** Publish and restore state how many files re-queue and stop there. See the spec's "What Publish may claim".

### Existing code this plan builds on

- `packages/server/src/db/flow-repo.ts` — `FlowRecord { id, name, description, tags, definition, definitionHash, createdAt, updatedAt }`; `create({name, description?, tags?, definition, nowMs})` and `update({id, definition, nowMs})`. Its own comment calls these *"the only two doors a definition enters through"*. Both call `flowDefinitionHash(definition)` and `assertFlowDefinitionValid(...)`.
- `packages/server/src/api/routes/flows.ts` — `PUT /flows/:id` already validates, calls `checkAllLibraries`, and requests a scan per library using the flow. **Do not duplicate that logic; reuse it.**
- `FlowDefinition` is `{ nodes: Array<{ id, pluginId, pluginVersion, inputs }>, edges: Array<{ fromNodeId, outputNumber, toNodeId }> }`.
- `packages/web/src/screens/flows/flow-graph-model.ts` — `toGraphRows(definition)` renders a definition as an indented list. Reuse it for historical versions.
- `packages/web/src/shell/route.ts` — `parseRoute`/`formatRoute`, `Route` union. `packages/web/src/shell/Link.tsx` takes `{ to, children, className?, navigate, 'aria-current'? }`.

---

### Task 1: Migration 007 — the table and the backfill

**Files:**
- Create: `packages/server/src/db/migrations/007_flow_version.sql`
- Test: `packages/server/src/db/migrate.test.ts`

**Interfaces:**
- Produces: table `flow_version (id, flow_id, definition_hash, definition_json, note, created_at)`; `SCHEMA_VERSION` becomes `7` automatically, since it is derived from the highest migration file.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/db/migrate.test.ts`, following the helpers already in that file:

```ts
it('backfills each existing flow as its first version', () => {
  const db = openTestDb();            // use whatever this file already uses
  migrateTo(db, 6);                   // stop before 007
  db.prepare(
    `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                       created_at, updated_at)
     VALUES ('f1', 'Shows Conform', '', '', '{"nodes":[],"edges":[]}', 'abc123', 10, 10)`,
  ).run();

  migrate(db);

  const rows = db
    .prepare(`SELECT * FROM flow_version WHERE flow_id = 'f1'`)
    .all() as Array<{ definition_hash: string; definition_json: string; note: string; id: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.definition_hash).toBe('abc123');
  expect(rows[0]!.definition_json).toBe('{"nodes":[],"edges":[]}');
  expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
});

it('deletes a flow''s versions with the flow', () => {
  const db = openTestDb();
  migrate(db);
  db.prepare(
    `INSERT INTO flow (id, name, description, tags, definition_json, definition_hash,
                       created_at, updated_at)
     VALUES ('f2', 'Trial', '', '', '{"nodes":[],"edges":[]}', 'h', 10, 10)`,
  ).run();
  db.prepare(
    `INSERT INTO flow_version (id, flow_id, definition_hash, definition_json, note, created_at)
     VALUES ('v1', 'f2', 'h', '{}', '', 10)`,
  ).run();

  db.prepare(`DELETE FROM flow WHERE id = 'f2'`).run();

  expect(db.prepare(`SELECT COUNT(*) c FROM flow_version`).get()).toEqual({ c: 0 });
});
```

If `migrate.test.ts` has no helper for migrating to a specific version, add the backfill test only and assert against a database migrated fully from empty with a flow inserted at version 6 by whatever means the file already uses. **Read the file first and match its helpers exactly — do not invent new ones.**

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/server/src/db/migrate.test.ts`
Expected: FAIL — `no such table: flow_version`.

- [ ] **Step 3: Write the migration**

`packages/server/src/db/migrations/007_flow_version.sql`. Open with a doc comment in the register of `006`, saying *why*: publishing replaces a definition in place and re-queues every file using the flow, so the previous graph is unrecoverable; and `job.flow_hash` has always recorded which definition ran while nothing stored what it was.

```sql
CREATE TABLE flow_version (
  id               TEXT PRIMARY KEY,
  flow_id          TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
  definition_hash  TEXT NOT NULL,
  definition_json  TEXT NOT NULL,
  note             TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL
);

CREATE INDEX flow_version_flow_idx ON flow_version (flow_id, created_at DESC);
CREATE INDEX flow_version_hash_idx ON flow_version (definition_hash);

-- The backfill. `randomUUID()` is not available in SQL, so the id is assembled
-- from randomblob to the same v4 shape the application generates -- an id that
-- looks different from every other id in the schema would be a lasting puzzle
-- for the sake of one migration.
INSERT INTO flow_version (id, flow_id, definition_hash, definition_json, note, created_at)
SELECT
  lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
  ),
  id,
  definition_hash,
  definition_json,
  'Recorded when versioning was added',
  updated_at
FROM flow;
```

**Note on `definition_hash` not being unique:** publishing A, then B, then A again yields three rows, the first and third sharing a hash. That is deliberate — the timeline is the record, and deduplicating would lose that a change was reverted. Say so in the migration's comment so nobody later adds a unique index.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/server/src/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/db
git commit -m "feat(db): keep every published version of a flow"
```

---

### Task 2: The version repo

**Files:**
- Create: `packages/server/src/db/flow-version-repo.ts`
- Create: `packages/server/src/db/flow-version-repo.test.ts`

**Interfaces:**
- Produces:
  - `interface FlowVersionRecord { id: string; flowId: string; definitionHash: string; definition: FlowDefinition; note: string; createdAt: number }`
  - `interface FlowVersionSummary { id: string; flowId: string; definitionHash: string; note: string; createdAt: number }` — no definition
  - `createFlowVersionRepo(db: Db): FlowVersionRepo` with:
    - `append(input: { flowId: string; definitionHash: string; definition: FlowDefinition; note: string; nowMs: number }): FlowVersionRecord`
    - `list(input: { flowId: string; limit: number; offset: number }): { total: number; items: FlowVersionSummary[] }` — newest first
    - `get(id: string): FlowVersionRecord | null`
    - `byHash(hash: string): FlowVersionRecord | null` — newest match

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createFlowVersionRepo } from './flow-version-repo.js';

const DEF = { nodes: [], edges: [] };

describe('flow version repo', () => {
  it('lists newest first without carrying definitions', () => {
    const { db, flowId } = seed();          // match this file's sibling test helpers
    const repo = createFlowVersionRepo(db);
    repo.append({ flowId, definitionHash: 'h1', definition: DEF, note: 'first', nowMs: 10 });
    repo.append({ flowId, definitionHash: 'h2', definition: DEF, note: 'second', nowMs: 20 });

    const page = repo.list({ flowId, limit: 10, offset: 0 });

    expect(page.total).toBe(2);
    expect(page.items.map((v) => v.note)).toEqual(['second', 'first']);
    expect(page.items[0]).not.toHaveProperty('definition');
  });

  it('keeps both rows when a definition is published, reverted, and published again', () => {
    const { db, flowId } = seed();
    const repo = createFlowVersionRepo(db);
    repo.append({ flowId, definitionHash: 'a', definition: DEF, note: '', nowMs: 10 });
    repo.append({ flowId, definitionHash: 'b', definition: DEF, note: '', nowMs: 20 });
    repo.append({ flowId, definitionHash: 'a', definition: DEF, note: '', nowMs: 30 });

    expect(repo.list({ flowId, limit: 10, offset: 0 }).total).toBe(3);
  });

  it('resolves a hash to the newest version carrying it', () => {
    const { db, flowId } = seed();
    const repo = createFlowVersionRepo(db);
    repo.append({ flowId, definitionHash: 'a', definition: DEF, note: 'old', nowMs: 10 });
    repo.append({ flowId, definitionHash: 'a', definition: DEF, note: 'new', nowMs: 30 });

    expect(repo.byHash('a')?.note).toBe('new');
  });

  it('answers null for a hash that was never recorded', () => {
    const { db } = seed();
    expect(createFlowVersionRepo(db).byHash('never')).toBeNull();
  });

  it('round-trips the definition through JSON', () => {
    const { db, flowId } = seed();
    const repo = createFlowVersionRepo(db);
    const def = {
      nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} }],
      edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'end' }],
    };
    const appended = repo.append({
      flowId, definitionHash: 'h', definition: def, note: '', nowMs: 10,
    });

    expect(repo.get(appended.id)?.definition).toEqual(def);
  });
});
```

Write `seed()` to create an in-memory database, run `migrate`, and insert one flow — copying how the sibling repo tests in `packages/server/src/db/` already do it. Read one before writing.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/server/src/db/flow-version-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the repo**

Follow `flow-repo.ts`'s shape: prepared statements at the top of the factory, a `toRecord`/`toSummary` mapper, and a file-level doc comment saying why the listing omits definitions (a flow with a long history would otherwise return hundreds of kilobytes to render a list of dates).

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/server/src/db/flow-version-repo.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/db
git commit -m "feat(db): read and append flow versions"
```

---

### Task 3: Append a version on every publish, in the same transaction

**Files:**
- Modify: `packages/server/src/db/flow-repo.ts` (`create` and `update`)
- Test: `packages/server/src/db/flow-repo.test.ts`

**Interfaces:**
- Consumes: `createFlowVersionRepo` from Task 2.
- Produces: `create` and `update` both accept an optional `note?: string`, and both append a `flow_version` row inside the same transaction as the definition write.

- [ ] **Step 1: Write the failing test**

```ts
it('records a version for a newly created flow', () => {
  const { db, repo } = seed();
  const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });

  const versions = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 });
  expect(versions.total).toBe(1);
  expect(versions.items[0]!.definitionHash).toBe(flow.definitionHash);
});

it('records a version on update, carrying the note', () => {
  const { db, repo } = seed();
  const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });
  repo.update({ id: flow.id, definition: OTHER_DEF, nowMs: 20, note: 'moved muxqueue' });

  const versions = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 });
  expect(versions.total).toBe(2);
  expect(versions.items[0]!.note).toBe('moved muxqueue');
});

it('leaves the live definition and the newest version in agreement', () => {
  const { db, repo } = seed();
  const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });
  const updated = repo.update({ id: flow.id, definition: OTHER_DEF, nowMs: 20 });

  const newest = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 1, offset: 0 }).items[0]!;
  expect(newest.definitionHash).toBe(updated.definitionHash);
});

it('writes NO version when the update is rejected as invalid', () => {
  const { db, repo } = seed();
  const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });

  expect(() => repo.update({ id: flow.id, definition: INVALID_DEF, nowMs: 20 })).toThrow();

  // still just the create's version
  expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total).toBe(1);
});

it('appends a row for a re-publish that changes nothing', () => {
  const { db, repo } = seed();
  const flow = repo.create({ name: 'New', definition: DEF, nowMs: 10 });
  const again = repo.update({ id: flow.id, definition: DEF, nowMs: 20 });

  expect(again.definitionHash).toBe(flow.definitionHash);
  expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 10, offset: 0 }).total).toBe(2);
});
```

`INVALID_DEF` must be something `assertFlowDefinitionValid` genuinely rejects — read that function and build one; do not guess.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/server/src/db/flow-repo.test.ts`
Expected: FAIL — no versions recorded.

- [ ] **Step 3: Wrap both writes in a transaction**

better-sqlite3 gives `db.transaction(fn)`, which is synchronous and rolls back if `fn` throws. Wrap the existing INSERT/UPDATE together with the version append so a rejected definition leaves no version row. Note `assertFlowDefinitionValid` already runs **before** the write in both methods; keep it there so validation failures never open a transaction.

Extend the doc comment above `update` — it already explains that the hash *is* the flow's version. Add why the append belongs in the same transaction: a live definition whose newest version disagreed with it would make the history lie about what ran.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/server/src/db/flow-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/db
git commit -m "feat(db): a published definition and its newest version cannot disagree"
```

---

### Task 4: The graph diff

**Files:**
- Create: `packages/core/src/flow-diff.ts`
- Create: `packages/core/src/flow-diff.test.ts`
- Modify: `packages/core/src/index.ts` (export it)

**Interfaces:**
- Produces:
  - `interface FlowDiff { nodesAdded: string[]; nodesRemoved: string[]; nodePluginChanged: Array<{ nodeId: string; from: string; to: string }>; inputsChanged: Array<{ nodeId: string; key: string; from: string | null; to: string | null }>; edgesAdded: EdgeRef[]; edgesRemoved: EdgeRef[] }`
  - `interface EdgeRef { fromNodeId: string; outputNumber: number; toNodeId: string }`
  - `diffFlowDefinitions(from: FlowDefinition, to: FlowDefinition): FlowDiff`
  - `isEmptyDiff(diff: FlowDiff): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { diffFlowDefinitions, isEmptyDiff } from './flow-diff.js';

const node = (id: string, pluginId: string, inputs: Record<string, unknown> = {}) => ({
  id, pluginId, pluginVersion: '1.0.0', inputs,
});

describe('diffFlowDefinitions', () => {
  it('reads a re-pointed branch as one edge removed and one added', () => {
    // The muxqueue defect exactly: the node hung off output 1, the branch for
    // files that are ALREADY correct, instead of the encode branch.
    const before = {
      nodes: [node('check', 'tdarr:checkVideoCodec'), node('muxqueue', 'tdarr:custom'), node('audio', 'tdarr:audio')],
      edges: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' }],
    };
    const after = {
      nodes: [node('check', 'tdarr:checkVideoCodec'), node('muxqueue', 'tdarr:custom'), node('audio', 'tdarr:audio')],
      edges: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' }],
    };

    const diff = diffFlowDefinitions(before, after);

    expect(diff.edgesRemoved).toEqual([{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' }]);
    expect(diff.edgesAdded).toEqual([{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' }]);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.nodesRemoved).toEqual([]);
  });

  it('treats the same output number to a different node as a real change', () => {
    const before = { nodes: [], edges: [{ fromNodeId: 'a', outputNumber: 2, toNodeId: 'b' }] };
    const after = { nodes: [], edges: [{ fromNodeId: 'a', outputNumber: 2, toNodeId: 'c' }] };
    expect(diffFlowDefinitions(before, after).edgesAdded).toHaveLength(1);
  });

  it('reports a changed input with both values', () => {
    const before = { nodes: [node('lang', 'tdarr:remove', { keepLanguages: 'eng' })], edges: [] };
    const after = { nodes: [node('lang', 'tdarr:remove', { keepLanguages: 'eng,kor,swe' })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([
      { nodeId: 'lang', key: 'keepLanguages', from: 'eng', to: 'eng,kor,swe' },
    ]);
  });

  it('reports an input that appeared or disappeared as null on one side', () => {
    const before = { nodes: [node('e', 'tdarr:enc', {})], edges: [] };
    const after = { nodes: [node('e', 'tdarr:enc', { quality: '23' })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([
      { nodeId: 'e', key: 'quality', from: null, to: '23' },
    ]);
  });

  it('reports a node id reused for a different plugin', () => {
    const before = { nodes: [node('x', 'tdarr:one')], edges: [] };
    const after = { nodes: [node('x', 'tdarr:two')], edges: [] };

    expect(diffFlowDefinitions(before, after).nodePluginChanged).toEqual([
      { nodeId: 'x', from: 'tdarr:one', to: 'tdarr:two' },
    ]);
  });

  it('is blind to node and edge ORDER', () => {
    const a = {
      nodes: [node('p', 'x'), node('q', 'y')],
      edges: [
        { fromNodeId: 'p', outputNumber: 1, toNodeId: 'q' },
        { fromNodeId: 'q', outputNumber: 1, toNodeId: 'p' },
      ],
    };
    const b = {
      nodes: [node('q', 'y'), node('p', 'x')],
      edges: [
        { fromNodeId: 'q', outputNumber: 1, toNodeId: 'p' },
        { fromNodeId: 'p', outputNumber: 1, toNodeId: 'q' },
      ],
    };

    expect(isEmptyDiff(diffFlowDefinitions(a, b))).toBe(true);
  });

  it('reports an added node and the edge that reaches it', () => {
    const before = { nodes: [node('a', 'x')], edges: [] };
    const after = {
      nodes: [node('a', 'x'), node('b', 'y')],
      edges: [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
    };

    const diff = diffFlowDefinitions(before, after);
    expect(diff.nodesAdded).toEqual(['b']);
    expect(diff.edgesAdded).toHaveLength(1);
  });

  it('does not report inputs for a node that was added or removed outright', () => {
    // Its inputs are not a CHANGE; the whole node is.
    const before = { nodes: [], edges: [] };
    const after = { nodes: [node('n', 'x', { a: '1' })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([]);
  });

  it('compares non-string input values by their JSON form', () => {
    const before = { nodes: [node('n', 'x', { flag: true })], edges: [] };
    const after = { nodes: [node('n', 'x', { flag: false })], edges: [] };

    expect(diffFlowDefinitions(before, after).inputsChanged).toEqual([
      { nodeId: 'n', key: 'flag', from: 'true', to: 'false' },
    ]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/core/src/flow-diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the diff**

Key rules, all pinned by the tests above: compare nodes by `id` through a `Map`, never by array position; compare edges as `${fromNodeId} ${outputNumber} ${toNodeId}` keys in a `Set`; skip `inputsChanged` for nodes that were added or removed; stringify non-string input values so `true` and `false` compare as `'true'` and `'false'`; sort every output array so the result is stable.

The file-level doc comment should say why this exists: a flow defect that cost 9.2 TB of pointless rewrites was one edge pointing at the wrong node, and a diff that renders it as one removed and one added edge is the whole value of the feature.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/core/src/flow-diff.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Export and gate**

Add `export * from './flow-diff.js';` to `packages/core/src/index.ts` following its existing style.

```bash
npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/core/src
git commit -m "feat(core): diff two flow definitions as a graph, not as text"
```

---

### Task 5: The version API

**Files:**
- Modify: `packages/server/src/api/routes/flows.ts`
- Test: `packages/server/src/api/api.test.ts`

**Interfaces:**
- Consumes: `createFlowVersionRepo` (Task 2).
- Produces:
  - `GET /flows/:id/versions?limit&offset` → `{ total, limit, offset, items: FlowVersionSummary[] }`, each with `isCurrent: boolean`
  - `GET /flows/:id/versions/:versionId` → the version including `definition`
  - `POST /flows/:id/versions/:versionId/restore` → the updated flow resource
  - `GET /flows/versions/by-hash/:hash` → the version, or 404 with code `version-not-recorded`
  - `PUT /flows/:id` accepts an optional `note` string

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/api/api.test.ts` beside the existing flow-route tests. **Read them first and use the file's real helpers** — it has a module-level `beforeEach` and an `api(method, path, body?)` helper, not a `harness()`.

```ts
it('lists a flow''s versions newest first, marking the current one', async () => {
  const flow = await createFlowViaApi();          // use the file's existing helper style
  await api('PUT', `/api/v1/flows/${flow.id}`, { definition: OTHER_DEF, note: 'second' });

  const res = await api('GET', `/api/v1/flows/${flow.id}/versions`);

  expect(res.status).toBe(200);
  const body = res.body as { total: number; items: Array<{ note: string; isCurrent: boolean }> };
  expect(body.total).toBe(2);
  expect(body.items[0]!.note).toBe('second');
  expect(body.items[0]!.isCurrent).toBe(true);
  expect(body.items[1]!.isCurrent).toBe(false);
});

it('restores a past version by publishing it as a new one', async () => {
  const flow = await createFlowViaApi();
  const first = flow.definitionHash;
  await api('PUT', `/api/v1/flows/${flow.id}`, { definition: OTHER_DEF });
  const versions = (await api('GET', `/api/v1/flows/${flow.id}/versions`)).body as {
    items: Array<{ id: string; definitionHash: string }>;
  };
  const original = versions.items.find((v) => v.definitionHash === first)!;

  const res = await api('POST', `/api/v1/flows/${flow.id}/versions/${original.id}/restore`, {});

  expect(res.status).toBe(200);
  expect((res.body as { definitionHash: string }).definitionHash).toBe(first);
  const after = (await api('GET', `/api/v1/flows/${flow.id}/versions`)).body as { total: number };
  expect(after.total).toBe(3);                 // appended, never rewritten
});

it('resolves a hash to the definition that ran under it', async () => {
  const flow = await createFlowViaApi();
  const res = await api('GET', `/api/v1/flows/versions/by-hash/${flow.definitionHash}`);

  expect(res.status).toBe(200);
  expect((res.body as { definition: unknown }).definition).toBeDefined();
});

it('says a hash was never recorded rather than answering a bare 404', async () => {
  const res = await api('GET', '/api/v1/flows/versions/by-hash/deadbeef');

  expect(res.status).toBe(404);
  expect((res.body as { error: { code: string } }).error.code).toBe('version-not-recorded');
});

it('omits definitions from the listing', async () => {
  const flow = await createFlowViaApi();
  const body = (await api('GET', `/api/v1/flows/${flow.id}/versions`)).body as {
    items: Array<Record<string, unknown>>;
  };
  expect(body.items[0]).not.toHaveProperty('definition');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/server/src/api/api.test.ts -t version`
Expected: FAIL — 404 on the listing route.

- [ ] **Step 3: Add the routes**

Restore must reuse the publish path — read the version, then run the **same** code `PUT /flows/:id` runs: `createFlowRepo(ctx.db).update(...)`, then `checkAllLibraries({ db, bus })`, then `ctx.scans.request(library.id, 'manual')` for each library whose `flowId` matches. Extract that into a local helper both routes call rather than copying it; a restore that skipped the rescan would leave libraries claiming convergence under a definition they never ran.

Set the restored version's note to `Restored from ${hash}`.

**Route ordering matters:** `/flows/versions/by-hash/:hash` must be registered before any `/flows/:id` pattern that could swallow `versions` as an id. Check how `packages/server/src/api/router.ts` resolves competing patterns and place accordingly — if it matches in registration order, this route goes first.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/server/src/api/api.test.ts -t version`
Expected: PASS, 5 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/api
git commit -m "feat(api): read, compare and restore a flow's past versions"
```

---

### Task 6: Routes and the History section

**Files:**
- Modify: `packages/web/src/shell/route.ts`, `route.test.ts`
- Create: `packages/web/src/screens/flows/flow-version-model.ts`, `flow-version-model.test.ts`
- Modify: `packages/web/src/screens/flows/FlowDetail.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `Route`, `parseRoute`, `formatRoute`, `Link` (existing).
- Produces:
  - `Route` gains `{ name: 'flowVersion'; flowId: string; versionId: string }` and `{ name: 'flowCompare'; flowId: string; from: string | null; to: string | null }`
  - `interface VersionRow { id: string; hash: string; shortHash: string; note: string; when: string; isCurrent: boolean }`
  - `toVersionRows(items: ApiVersionSummary[], nowMs: number): VersionRow[]`

- [ ] **Step 1: Write the failing test**

Add to `route.test.ts`:

```ts
it('routes a single flow version and a comparison', () => {
  expect(parseRoute('/flows/f1/versions/v9', '')).toEqual({
    name: 'flowVersion', flowId: 'f1', versionId: 'v9',
  });
  expect(parseRoute('/flows/f1/compare', '?from=v1&to=v2')).toEqual({
    name: 'flowCompare', flowId: 'f1', from: 'v1', to: 'v2',
  });
});

it('round-trips the new flow routes', () => {
  for (const route of [
    { name: 'flowVersion', flowId: 'f1', versionId: 'v9' } as const,
    { name: 'flowCompare', flowId: 'f1', from: 'v1', to: 'v2' } as const,
  ]) {
    const url = new URL(formatRoute(route), 'http://x');
    expect(parseRoute(url.pathname, url.search)).toEqual(route);
  }
});
```

And `flow-version-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toVersionRows } from './flow-version-model.js';

const v = (id: string, hash: string, note: string, createdAt: number, isCurrent = false) => ({
  id, flowId: 'f1', definitionHash: hash, note, createdAt, isCurrent,
});

describe('toVersionRows', () => {
  it('shortens the hash for display while keeping the whole one', () => {
    const [row] = toVersionRows([v('a', '17dce8bd5e3482bf', 'x', 1000)], 1000);
    expect(row!.shortHash).toBe('17dce8bd');
    expect(row!.hash).toBe('17dce8bd5e3482bf');
  });

  it('marks the current version', () => {
    const rows = toVersionRows([v('a', 'h1', '', 2000, true), v('b', 'h2', '', 1000)], 2000);
    expect(rows.map((r) => r.isCurrent)).toEqual([true, false]);
  });

  it('describes an empty note as the publish it was, not as blank', () => {
    const [row] = toVersionRows([v('a', 'h', '', 1000)], 1000);
    expect(row!.note).toBe('Published');
  });
});
```

- [ ] **Step 2: Run and watch both fail**

Run: `pnpm vitest run packages/web/src/shell/route.test.ts packages/web/src/screens/flows/flow-version-model.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend the `Route` union, `parseRoute` and `formatRoute` following the existing patterns exactly — `/flows/:id/versions/:versionId` and `/flows/:id/compare` with `from`/`to` in the query string, so a comparison is linkable.

Write `flow-version-model.ts` with `toVersionRows`. Format `when` with the same helper `Files.tsx` uses for its `Updated` column if one is exported; otherwise a local `formatWhen` in this model, tested.

Add a **History** section to `FlowDetail.tsx`: fetch `GET /flows/:id/versions?limit=50`, render the rows, each linking to `/flows/:id/versions/:versionId`, with a **Compare with current** link. Follow the screen's existing loading/empty/error convention — three distinct renders, `describeFailure` + `.failure` + Retry.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run packages/web/src/shell/route.test.ts packages/web/src/screens/flows/flow-version-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): a flow's history, on the flow"
```

---

### Task 7: The version view and the comparison

**Files:**
- Create: `packages/web/src/screens/flows/FlowVersion.tsx`
- Create: `packages/web/src/screens/flows/FlowCompare.tsx`
- Modify: `packages/web/src/screens/flows/flow-version-model.ts`, `flow-version-model.test.ts`
- Modify: `packages/web/src/App.tsx`, `packages/web/src/styles.css`

**Interfaces:**
- Consumes: `diffFlowDefinitions`, `isEmptyDiff`, `FlowDiff` from `@trawlarr/core` (Task 4); `toGraphRows` from `flow-graph-model.ts`.
- Produces: `interface DiffLine { kind: 'node-added' | 'node-removed' | 'plugin-changed' | 'input-changed' | 'edge-added' | 'edge-removed'; text: string }` and `toDiffLines(diff: FlowDiff): DiffLine[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { toDiffLines } from './flow-version-model.js';

describe('toDiffLines', () => {
  it('renders a re-pointed edge as a removal and an addition', () => {
    const lines = toDiffLines({
      nodesAdded: [], nodesRemoved: [], nodePluginChanged: [], inputsChanged: [],
      edgesRemoved: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' }],
      edgesAdded: [{ fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' }],
    });

    expect(lines).toEqual([
      { kind: 'edge-removed', text: 'check output 1 → muxqueue' },
      { kind: 'edge-added', text: 'check output 1 → audio' },
    ]);
  });

  it('renders an input change with both values', () => {
    const lines = toDiffLines({
      nodesAdded: [], nodesRemoved: [], nodePluginChanged: [],
      inputsChanged: [{ nodeId: 'lang', key: 'keepLanguages', from: 'eng', to: 'eng,kor' }],
      edgesAdded: [], edgesRemoved: [],
    });

    expect(lines).toEqual([
      { kind: 'input-changed', text: 'lang.keepLanguages: eng → eng,kor' },
    ]);
  });

  it('names an absent value rather than printing "null"', () => {
    const lines = toDiffLines({
      nodesAdded: [], nodesRemoved: [], nodePluginChanged: [],
      inputsChanged: [{ nodeId: 'e', key: 'quality', from: null, to: '23' }],
      edgesAdded: [], edgesRemoved: [],
    });

    expect(lines[0]!.text).toBe('e.quality: not set → 23');
  });

  it('returns nothing for two identical definitions', () => {
    expect(toDiffLines({
      nodesAdded: [], nodesRemoved: [], nodePluginChanged: [], inputsChanged: [],
      edgesAdded: [], edgesRemoved: [],
    })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/screens/flows/flow-version-model.test.ts`
Expected: FAIL — `toDiffLines` is not exported.

- [ ] **Step 3: Implement**

`toDiffLines` orders lines: nodes removed, nodes added, plugin changes, input changes, edges removed, edges added — so a re-pointed branch reads as a pair.

`FlowVersion.tsx` fetches `GET /flows/:id/versions/:versionId`, renders the graph with the existing `toGraphRows`, and marks it clearly as **historical, not current**. It offers **Restore** and **Compare with current**. Restore posts to the restore route and must state its blast radius first, in the register the shipped UI already uses for destructive confirmations: which libraries use this flow, and **exactly how many files re-queue** — and it must not estimate how many will re-encode. Read `Config.tsx`'s trash-purge confirmation and follow that shape.

`FlowCompare.tsx` fetches both versions, calls `diffFlowDefinitions`, renders `toDiffLines`. When the diff is empty it says the two versions are identical — which is a real case, since a definition can be published, changed and published back.

Style diff kinds with the file's existing variables: `--bad` for removals, `--good` for additions, and a text prefix (`−`, `+`, `~`) so colour is never the only carrier of meaning.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/web/src/screens/flows/flow-version-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): view a past flow version, and see what changed"
```

---

### Task 8: Make a job's flow hash resolve

**Files:**
- Modify: `packages/web/src/screens/jobs/JobDetail.tsx`
- Modify: `packages/web/src/screens/jobs/job-detail-model.ts`, `job-detail-model.test.ts`

**Interfaces:**
- Produces: `describeFlowVersion(input: { hash: string; versionId: string | null }): { text: string; to: string | null }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { describeFlowVersion } from './job-detail-model.js';

describe('describeFlowVersion', () => {
  it('links a hash that was recorded', () => {
    expect(describeFlowVersion({ hash: '17dce8bd5e34', versionId: 'v9' })).toEqual({
      text: '17dce8bd', to: '/flows/versions/v9',
    });
  });

  it('says a hash predating versioning was never recorded, and links nowhere', () => {
    expect(describeFlowVersion({ hash: 'c49b5f39aaaa', versionId: null })).toEqual({
      text: 'c49b5f39 — this version was not recorded', to: null,
    });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/screens/jobs/job-detail-model.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

`JobDetail.tsx` resolves the job's `flowHash` through `GET /flows/versions/by-hash/:hash`. A `404` with code `version-not-recorded` is **not an error** — it is the expected answer for the roughly 5,500 job rows that predate the backfill, and must render as plain text, never as a failure box. Any other failure is a real failure.

That lookup is secondary to the job: **its failure must not blank the screen.** Catch it inline rather than letting it join a shared `Promise.all` — this exact regression shipped twice in the previous UI work and cost a fix round each time.

The link target `/flows/versions/:versionId` needs a route arm; add it to `route.ts` beside the others from Task 6, with a round-trip test, and render it with `FlowVersion.tsx`.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/web/src/screens/jobs/job-detail-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
npx tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): a job's flow hash resolves to the graph that ran"
```

---

## Self-review notes

- **Spec coverage.** Table and backfill → Task 1; repo → Task 2; append-on-publish transactionally → Task 3; graph diff → Task 4; the four API routes and the optional `note` → Task 5; History on `/flows/:id` and the new routes → Task 6; version view, restore, compare → Task 7; job hash resolution → Task 8. Retention ("keep everything") is a non-action, correctly implemented by no pruning code existing. Restore-as-publish is enforced in Task 5 by reusing the publish helper and asserted in its third test.
- **Route-order hazard.** `/flows/versions/by-hash/:hash` can be swallowed by `/flows/:id`. Task 5 requires checking `router.ts`'s matching rule rather than assuming registration order wins.
- **Two routes named `/flows/versions/:versionId`** (Task 8's link target) and `/flows/:id/versions/:versionId` (Task 6) both exist by design: the first reaches a version without knowing its flow, which is what a job row has. Task 8 adds the former.
- **Type consistency.** `FlowVersionRecord`/`FlowVersionSummary` are defined once in Task 2 and consumed by Tasks 3, 5, 6. `FlowDiff`/`EdgeRef` are defined once in Task 4 (core) and consumed by Task 7. `VersionRow` and `DiffLine` both live in `flow-version-model.ts`, extended in Task 7 rather than duplicated.
- **Where the risk is.** Task 3 — a version appended outside the definition's transaction, or a validation failure that still writes a row, would make history lie about what ran. Its fourth and fifth tests exist for exactly that.
