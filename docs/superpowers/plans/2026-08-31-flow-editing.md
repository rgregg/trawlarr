# Flow Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit a flow's whole graph — nodes, wiring and inputs — from Configure, as a
server-side draft that is published explicitly.

**Architecture:** A draft lives in three new nullable columns on `flow` and never
hashes, so a half-finished edit cannot re-queue a library. Publishing goes through the
existing `PUT /flows/:id`, which already validates, appends a version, re-checks
libraries and requests a scan. In the browser the canvas is `@xyflow/react`, but every
decision it makes — layout, translation both ways, the graph mutations, validation
mapping, staleness, the publish summary — lives in pure `*-model.ts` modules with
vitest tests; the canvas component itself is a thin renderer, untested by design.

**Tech Stack:** TypeScript (strict, project references), better-sqlite3 + forward-only
SQL migrations, node:test-free vitest, React 18 + Vite, `@xyflow/react`.

**Spec:** `docs/superpowers/specs/2026-08-29-flow-editing-design.md`

## Global Constraints

- Node 22 (`.nvmrc`), pnpm 9. Run `pnpm test`, `pnpm typecheck`, `pnpm lint` before every commit.
- `@trawlarr/core` performs no I/O and reads no clock. Nothing in this plan adds either.
- The signature is the hash of the whole flow definition. A draft is **never** hashed,
  never read by the engine, and never affects convergence.
- Publishing is the only thing that changes `flow.definition_json`, and it must keep
  going through `publishFlow` in `packages/server/src/api/routes/flows.ts` — version
  append, `checkAllLibraries`, and a scan request per affected library.
- Web tests are pure-model vitest only. No DOM testing library, and none added.
- Migrations are forward-only, numbered, in `packages/server/src/db/migrations/`.
- Commit messages: `type(scope): a sentence saying what changed and why it matters`,
  lowercase, stating the invariant.
- Comments explain *why*, naming the defect a guard prevents.

## Decisions this plan makes that the spec left open

1. **Node positions are derived, never stored.** `FlowDefinition` has no position field
   and its hash is the flow's version, so persisting a position would mean dragging a
   node re-queues thousands of files. The canvas lays out from graph structure
   (`layoutDefinition`), and a drag is session-local only.
2. **A third draft column, `draft_base_hash`.** The spec's SQL sketch has two columns,
   but its own error-handling section requires detecting a draft taken against a
   definition that has since changed. The base hash is that detection; hiding it inside
   `draft_json` would make `draft_json` stop being a flow definition.
3. **Publish sends `baseHash`.** `PUT /flows/:id` gains an optional `baseHash`; when it
   is present and does not equal the live hash the write is refused with 409
   `flow-changed`. Optional, so every existing caller (CLI, curl, restore) is unaffected.
4. **The licence widening in the spec is already done.** `scripts/audit-licenses.mjs`
   already allows MIT, ISC and BSD-3-Clause and has no pinned package count. Task 4
   verifies rather than edits it.

---

### Task 1: Validation problems name the node they are about

The editor draws errors on the offending node. `POST /flows/validate` currently drops
`nodeId` and `edge` from each problem, so today an editor could only show a list of
sentences with no way to point at anything.

**Files:**
- Modify: `packages/server/src/api/routes/flows.ts` (the `/flows/validate` handler)
- Test: `packages/server/src/api/api.test.ts` (in the existing `describe('flows')`)

**Interfaces:**
- Produces: `POST /flows/validate` → `{ ok: boolean; stored: false; problems: Array<{ code: string; message: string; nodeId?: string; edge?: { fromNodeId: string; outputNumber: number; toNodeId: string } }> }`

- [ ] **Step 1: Write the failing test**

Add inside `describe('flows', …)` in `packages/server/src/api/api.test.ts`:

```ts
it('names the node and edge each problem is about, so an editor can point at one', async () => {
  const response = await api('POST', '/flows/validate', { definition: FLOW_WITH_TWO_PROBLEMS });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(false);
  const startProblem = response.body.problems.find(
    (problem: { code: string }) => problem.code === 'multiple-start-nodes',
  );
  // A sentence alone cannot be drawn on a node.
  expect(startProblem.nodeId).toBeDefined();
  const edgeProblem = response.body.problems.find(
    (problem: { code: string }) => problem.code === 'edge-unknown-node',
  );
  expect(edgeProblem.edge).toEqual({ fromNodeId: 'start-a', outputNumber: 1, toNodeId: 'ghost' });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test -- packages/server/src/api/api.test.ts -t 'names the node and edge'`
Expected: FAIL — `startProblem.nodeId` is `undefined`, because the handler maps only
`code` and `message`.

- [ ] **Step 3: Carry the two fields through**

In the `/flows/validate` handler, replace the `problems.map(...)` with:

```ts
      return {
        ok: problems.length === 0,
        // `nodeId` and `edge` travel too: the flow editor draws a problem ON the node
        // or edge it is about, and a list of sentences with nothing to anchor them to
        // is exactly the "read the JSON and find it yourself" experience this editor
        // exists to replace. Both are optional on the validator's own type, so a
        // flow-level problem (no nodes at all) still carries neither.
        problems: problems.map((problem) => ({
          code: problem.code,
          message: problem.message,
          ...(problem.nodeId === undefined ? {} : { nodeId: problem.nodeId }),
          ...(problem.edge === undefined ? {} : { edge: problem.edge }),
        })),
        stored: false,
      };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm test -- packages/server/src/api/api.test.ts -t 'names the node and edge'`
Expected: PASS. Then `pnpm test -- packages/server/src/api/api.test.ts` — the whole
flows suite still green.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/routes/flows.ts packages/server/src/api/api.test.ts
git commit -m "feat(api): a validation problem says which node it is about"
```

---

### Task 2: A flow can hold an unpublished draft

**Files:**
- Create: `packages/server/src/db/migrations/008_flow_draft.sql`
- Modify: `packages/server/src/db/flow-repo.ts`
- Test: `packages/server/src/db/flow-repo.test.ts`

**Interfaces:**
- Produces, on `FlowRecord`: `draft: FlowDefinition | null`, `draftBaseHash: string | null`, `draftUpdatedAt: number | null`.
- Produces, on `FlowRepo`:
  - `saveDraft(input: { id: string; draft: FlowDefinition; baseHash: string; nowMs: number }): FlowRecord`
  - `clearDraft(id: string): void`
- Consumes: `FlowDefinition` from `@trawlarr/core`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/db/flow-repo.test.ts` (it already builds a migrated db and
a repo; follow the file's existing setup helpers rather than inventing new ones):

```ts
describe('drafts', () => {
  it('stores a draft without touching the definition or its hash', () => {
    const repo = createFlowRepo(db, { resolveNodeCapabilities });
    const flow = repo.create({ name: 'drafty', definition: VALID_FLOW, nowMs: NOW });

    const withDraft = repo.saveDraft({
      id: flow.id,
      draft: TWO_NODE_FLOW,
      baseHash: flow.definitionHash,
      nowMs: NOW + 1000,
    });

    // THE POINT OF A DRAFT: nothing a library converges against moved.
    expect(withDraft.definition).toEqual(VALID_FLOW);
    expect(withDraft.definitionHash).toBe(flow.definitionHash);
    expect(withDraft.updatedAt).toBe(flow.updatedAt);
    expect(withDraft.draft).toEqual(TWO_NODE_FLOW);
    expect(withDraft.draftBaseHash).toBe(flow.definitionHash);
    expect(withDraft.draftUpdatedAt).toBe(NOW + 1000);
  });

  it('appends no version for a draft — a draft never ran', () => {
    const repo = createFlowRepo(db, { resolveNodeCapabilities });
    const flow = repo.create({ name: 'unversioned', definition: VALID_FLOW, nowMs: NOW });
    const before = createFlowVersionRepo(db).list({ flowId: flow.id, limit: 50, offset: 0 }).total;

    repo.saveDraft({ id: flow.id, draft: TWO_NODE_FLOW, baseHash: flow.definitionHash, nowMs: NOW });

    expect(createFlowVersionRepo(db).list({ flowId: flow.id, limit: 50, offset: 0 }).total).toBe(
      before,
    );
  });

  it('stores an INVALID draft — half-finished work is the point', () => {
    const repo = createFlowRepo(db, { resolveNodeCapabilities });
    const flow = repo.create({ name: 'half-done', definition: VALID_FLOW, nowMs: NOW });

    const saved = repo.saveDraft({
      id: flow.id,
      // An edge to a node that is not there: exactly what a graph looks like
      // between two clicks.
      draft: { nodes: VALID_FLOW.nodes, edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'ghost' }] },
      baseHash: flow.definitionHash,
      nowMs: NOW,
    });

    expect(saved.draft?.edges[0]?.toNodeId).toBe('ghost');
  });

  it('clears a draft', () => {
    const repo = createFlowRepo(db, { resolveNodeCapabilities });
    const flow = repo.create({ name: 'discard', definition: VALID_FLOW, nowMs: NOW });
    repo.saveDraft({ id: flow.id, draft: TWO_NODE_FLOW, baseHash: flow.definitionHash, nowMs: NOW });

    repo.clearDraft(flow.id);

    const after = repo.getById(flow.id);
    expect(after?.draft).toBeNull();
    expect(after?.draftBaseHash).toBeNull();
    expect(after?.draftUpdatedAt).toBeNull();
  });

  it('publishing clears the draft it published', () => {
    const repo = createFlowRepo(db, { resolveNodeCapabilities });
    const flow = repo.create({ name: 'promote', definition: VALID_FLOW, nowMs: NOW });
    repo.saveDraft({ id: flow.id, draft: TWO_NODE_FLOW, baseHash: flow.definitionHash, nowMs: NOW });

    const published = repo.update({ id: flow.id, definition: TWO_NODE_FLOW, nowMs: NOW + 5 });

    // A draft that survived its own publish would show as unpublished work
    // forever, and "publish" would stop meaning anything.
    expect(published.draft).toBeNull();
    expect(published.definition).toEqual(TWO_NODE_FLOW);
  });
});
```

If `TWO_NODE_FLOW` and `resolveNodeCapabilities` are not already in the file, define
them next to the existing fixtures:

```ts
const TWO_NODE_FLOW: FlowDefinition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
    { id: 'codec', pluginId: 'trawlarr:checkVideoCodec', pluginVersion: '1.0.0', inputs: {} },
  ],
  edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'codec' }],
};
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- packages/server/src/db/flow-repo.test.ts`
Expected: FAIL — `repo.saveDraft is not a function`.

- [ ] **Step 3: Write the migration**

Create `packages/server/src/db/migrations/008_flow_draft.sql`:

```sql
-- AN EDIT THAT HAS NOT HAPPENED YET.
--
-- Publishing a flow changes its hash, and a file's convergence signature is
-- that hash -- so publishing re-queues every file in every library using the
-- flow (4,621 files, about 9.2 TB, on the install this was designed against).
-- Editing a graph takes more than one click. Without somewhere to put a
-- half-finished graph, every intermediate state would either be published or
-- lost, and "save" would mean "re-queue the library".
--
-- `draft_json` is NEVER hashed, never read by the engine, and never consulted
-- by convergence. A flow with a draft is still running `definition_json`, and
-- that must remain the only column any of those three read.
--
-- `draft_base_hash` is the `definition_hash` the draft was taken against. It
-- exists so publishing can refuse a draft whose base has moved: two operators,
-- or one operator and a `flow restore`, would otherwise have the second
-- publish silently revert the first -- and a reverted flow re-queues a library
-- just as loudly as a correct one.
ALTER TABLE flow ADD COLUMN draft_json TEXT;
ALTER TABLE flow ADD COLUMN draft_base_hash TEXT;
ALTER TABLE flow ADD COLUMN draft_updated_at INTEGER;
```

- [ ] **Step 4: Widen the repo**

In `packages/server/src/db/flow-repo.ts`:

Add to `FlowRecord`:

```ts
  /** The unpublished graph, or null. NEVER hashed and never run — see migration 008. */
  draft: FlowDefinition | null;
  /** The `definitionHash` the draft was taken against, for staleness on publish. */
  draftBaseHash: string | null;
  draftUpdatedAt: number | null;
```

Add to `FlowRow`: `draft_json: string | null; draft_base_hash: string | null; draft_updated_at: number | null;`

Extend `toRecord`:

```ts
  draft: row.draft_json === null ? null : (JSON.parse(row.draft_json) as FlowDefinition),
  draftBaseHash: row.draft_base_hash,
  draftUpdatedAt: row.draft_updated_at,
```

Add to the `FlowRepo` interface:

```ts
  /**
   * Writes the draft and NOTHING else: no hash, no `updated_at`, no version
   * row, no library re-check. Deliberately does NOT validate — a draft that
   * had to be valid could not be saved between two clicks, which is the one
   * thing a draft is for. Publishing validates.
   */
  saveDraft(input: {
    id: string;
    draft: FlowDefinition;
    baseHash: string;
    nowMs: number;
  }): FlowRecord;
  clearDraft(id: string): void;
```

Add the statements and methods:

```ts
  const updateDraft = db.prepare(
    `UPDATE flow SET draft_json = ?, draft_base_hash = ?, draft_updated_at = ? WHERE id = ?`,
  );
  const deleteDraft = db.prepare(
    `UPDATE flow SET draft_json = NULL, draft_base_hash = NULL, draft_updated_at = NULL
     WHERE id = ?`,
  );
```

```ts
    saveDraft(input) {
      const result = updateDraft.run(
        JSON.stringify(input.draft),
        input.baseHash,
        input.nowMs,
        input.id,
      );
      if (result.changes === 0) throw new Error(`Unknown flow: ${input.id}`);
      const saved = get(input.id);
      if (saved === null) throw new Error(`Flow ${input.id} vanished immediately after a draft save.`);
      return saved;
    },

    clearDraft(id) {
      deleteDraft.run(id);
    },
```

And inside `updateTx`, immediately after `updateFlow.run(...)`'s `changes === 0` check:

```ts
      // Publishing consumes the draft. A draft that outlived its own publish
      // would keep the flow marked "has unpublished work" forever, and the
      // next editor would reopen a graph identical to the live one and be
      // told it was a change.
      deleteDraft.run(input.id);
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm test -- packages/server/src/db/flow-repo.test.ts && pnpm test -- packages/server/src/db/migrate.test.ts`
Expected: PASS. `migrate.test.ts` asserts the schema version advances; if it pins a
number, update it to 8 with the same reasoning the file already states.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/migrations/008_flow_draft.sql packages/server/src/db/flow-repo.ts packages/server/src/db/flow-repo.test.ts packages/server/src/db/migrate.test.ts
git commit -m "feat(db): a flow can hold an unpublished draft that is never hashed"
```

---

### Task 3: The draft over the API, and a publish that refuses a stale one

**Files:**
- Modify: `packages/server/src/api/routes/flows.ts`
- Test: `packages/server/src/api/api.test.ts`

**Interfaces:**
- Consumes: `FlowRepo.saveDraft`, `FlowRepo.clearDraft`, `FlowRecord.draft*` from Task 2.
- Produces:
  - `PUT /flows/:id/draft` body `{ definition }` → the flow resource. Validates and
    reports problems, but stores regardless and changes nothing else.
  - `DELETE /flows/:id/draft` → 204.
  - `GET /flows` and `GET /flows/:id` resources gain
    `draft: FlowDefinition | null`, `draftBaseHash: string | null`, `draftUpdatedAt: number | null`.
  - `PUT /flows/:id` accepts optional `baseHash`; mismatch → 409 `flow-changed`.

- [ ] **Step 1: Write the failing tests**

Add to `describe('flows')` in `packages/server/src/api/api.test.ts`:

```ts
it('saves a draft without re-hashing, re-checking libraries or requesting a scan', async () => {
  const created = await api('POST', '/flows', { name: 'draft-api', definition: VALID_FLOW });
  const scansBefore = scans.requested.length;

  const response = await api('PUT', `/flows/${created.body.id}/draft`, {
    definition: FLOW_WITH_TWO_PROBLEMS,
  });

  expect(response.status).toBe(200);
  expect(response.body.definitionHash).toBe(created.body.definitionHash);
  expect(response.body.draft).toEqual(FLOW_WITH_TWO_PROBLEMS);
  expect(response.body.draftBaseHash).toBe(created.body.definitionHash);
  // A draft must not re-queue anything. That is the whole reason it exists.
  expect(scans.requested.length).toBe(scansBefore);
});

it('reports a draft\'s problems while still storing it', async () => {
  const created = await api('POST', '/flows', { name: 'draft-invalid', definition: VALID_FLOW });

  const response = await api('PUT', `/flows/${created.body.id}/draft`, {
    definition: FLOW_WITH_TWO_PROBLEMS,
  });

  expect(response.status).toBe(200);
  expect(response.body.draftProblems.length).toBe(2);
  expect(await api('GET', `/flows/${created.body.id}`)).toMatchObject({
    body: { draft: FLOW_WITH_TWO_PROBLEMS },
  });
});

it('discards a draft', async () => {
  const created = await api('POST', '/flows', { name: 'draft-discard', definition: VALID_FLOW });
  await api('PUT', `/flows/${created.body.id}/draft`, { definition: VALID_FLOW });

  const response = await api('DELETE', `/flows/${created.body.id}/draft`);

  expect(response.status).toBe(204);
  expect((await api('GET', `/flows/${created.body.id}`)).body.draft).toBeNull();
});

it('publishing clears the draft and re-queues, exactly as an edit always has', async () => {
  const created = await api('POST', '/flows', { name: 'draft-publish', definition: VALID_FLOW });
  const library = seedLibrary({ flowId: created.body.id });
  await api('PUT', `/flows/${created.body.id}/draft`, { definition: TWO_NODE_FLOW });
  const scansBefore = scans.requested.length;

  const response = await api('PUT', `/flows/${created.body.id}`, {
    definition: TWO_NODE_FLOW,
    baseHash: created.body.definitionHash,
  });

  expect(response.status).toBe(200);
  expect(response.body.draft).toBeNull();
  expect(response.body.definitionHash).not.toBe(created.body.definitionHash);
  // Publishing re-queues: the library's files are stale the moment the hash
  // changes, and only a scan re-derives that.
  expect(scans.requested.slice(scansBefore).map((entry) => entry.libraryId)).toContain(library.id);
});

it('refuses to publish a draft whose base has moved, rather than reverting the other edit', async () => {
  const created = await api('POST', '/flows', { name: 'draft-stale', definition: VALID_FLOW });
  // Someone else publishes first.
  await api('PUT', `/flows/${created.body.id}`, { definition: TWO_NODE_FLOW });

  const response = await api('PUT', `/flows/${created.body.id}`, {
    definition: VALID_FLOW,
    baseHash: created.body.definitionHash,
  });

  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('flow-changed');
  // The other edit is still what runs.
  expect((await api('GET', `/flows/${created.body.id}`)).body.definition).toEqual(TWO_NODE_FLOW);
});

it('publishes without a baseHash, so the CLI and curl are unaffected', async () => {
  const created = await api('POST', '/flows', { name: 'no-base-hash', definition: VALID_FLOW });

  const response = await api('PUT', `/flows/${created.body.id}`, { definition: TWO_NODE_FLOW });

  expect(response.status).toBe(200);
});
```

Add `TWO_NODE_FLOW` beside `VALID_FLOW` at the top of the file if it is not already
there (same literal as Task 2). Use the suite's existing scan-coordinator double for
`scans`; if the double does not record requests, follow the pattern the existing
"requests a scan for every library using the flow" test already relies on rather than
adding a second recorder.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- packages/server/src/api/api.test.ts -t 'draft'`
Expected: FAIL — 404 from the router for `PUT /flows/:id/draft`.

- [ ] **Step 3: Add the routes**

In `packages/server/src/api/routes/flows.ts`, extend `toFlowResource`:

```ts
  // The draft travels with the flow rather than living behind its own GET:
  // every screen that shows a flow has to say whether it has unpublished work,
  // and a second round trip to find out would make "has a draft" the one fact
  // the list could not show.
  draft: flow.draft,
  draftBaseHash: flow.draftBaseHash,
  draftUpdatedAt: flow.draftUpdatedAt,
```

Add the two routes (place them next to `PUT /flows/:id` for a reader; the router picks
by segment count then literal count, so `/flows/:id/draft`'s three segments never
compete with `/flows/:id`'s two):

```ts
  /**
   * A draft is saved WHETHER OR NOT it validates, and reports its problems
   * either way.
   *
   * Refusing to store an invalid draft would mean an operator could only save
   * a graph at the moments it happened to be runnable — and a graph is invalid
   * for most of the time it takes to rewire one. Publishing is where a bad
   * flow is refused; that is `PUT /flows/:id`, which is unchanged in this
   * respect.
   *
   * This endpoint deliberately does NOT re-hash, re-check libraries or request
   * a scan. Everything downstream of a flow keys off `definition_hash`, which
   * this cannot touch.
   */
  {
    method: 'PUT',
    path: '/flows/:id/draft',
    handler: ({ params, body, ctx }) => {
      const flow = requireFlow(ctx, params.id!);
      const definition = requireDefinition(body);
      const problems = validateFlowDefinition(
        definition,
        createNodeCapabilityResolver({ registry: createPluginRegistry(ctx.db) }),
      );
      const saved = createFlowRepo(ctx.db).saveDraft({
        id: flow.id,
        draft: definition,
        baseHash: flow.definitionHash,
        nowMs: ctx.nowMs(),
      });
      return {
        ...toFlowResource(saved),
        draftProblems: problems.map((problem) => ({
          code: problem.code,
          message: problem.message,
          ...(problem.nodeId === undefined ? {} : { nodeId: problem.nodeId }),
          ...(problem.edge === undefined ? {} : { edge: problem.edge }),
        })),
      };
    },
  },

  {
    method: 'DELETE',
    path: '/flows/:id/draft',
    handler: ({ params, ctx }) => {
      const flow = requireFlow(ctx, params.id!);
      createFlowRepo(ctx.db).clearDraft(flow.id);
      return noContent();
    },
  },
```

And in `PUT /flows/:id`, before publishing:

```ts
      // OPTIONAL, and only checked when sent: the CLI and curl publish without
      // one and must keep working. When the editor sends it, a mismatch means
      // the draft was taken against a definition someone (or a restore) has
      // since replaced — publishing anyway would silently revert that edit AND
      // re-queue the library to do it.
      const baseHash = patch.baseHash;
      if (typeof baseHash === 'string' && baseHash !== flow.definitionHash) {
        throw new ApiError(
          409,
          'flow-changed',
          `This flow was published by someone else while you were editing (it is now ` +
            `${flow.definitionHash}, your draft started from ${baseHash}). Publishing would ` +
            `revert that change and re-queue every file in the libraries using this flow. ` +
            `Reopen the editor to see the current graph.`,
        );
      }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm test -- packages/server/src/api/api.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/routes/flows.ts packages/server/src/api/api.test.ts
git commit -m "feat(api): a flow's draft is stored, reported and refused when its base moved"
```

---

### Task 4: The canvas library, and the licence gate that lets it in

**Files:**
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml` (by `pnpm install`)
- Test: `pnpm audit:licenses` (existing gate — no new test file)

**Interfaces:**
- Produces: `@xyflow/react` importable from `packages/web`, and its stylesheet at
  `@xyflow/react/dist/style.css`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @trawlarr/web add @xyflow/react@^12
```

- [ ] **Step 2: Run the licence gate**

Run: `pnpm audit:licenses`
Expected: PASS. `scripts/audit-licenses.mjs` already allows MIT, ISC and BSD-3-Clause
and prints a count rather than asserting a pinned one, so the spec's "widen the
allow-list" item needs no edit. **If it fails**, it will name the package and licence:
add that licence to `ALLOWED` only after confirming it is permissive and
MIT-distributable, and say so in the commit message.

- [ ] **Step 3: Prove it builds**

Run: `pnpm --filter @trawlarr/web build`
Expected: PASS (nothing imports it yet; this proves the install and the types resolve).

- [ ] **Step 4: Commit**

```bash
git add packages/web/package.json pnpm-lock.yaml
git commit -m "build(web): add @xyflow/react, the canvas the flow editor draws on"
```

---

### Task 5: Routes for the flows tab and the editor

**Files:**
- Modify: `packages/web/src/shell/route.ts`
- Test: `packages/web/src/shell/route.test.ts`

**Interfaces:**
- Produces: `ConfigTab` gains `'flows'`; `Route` gains `{ name: 'flowEdit'; id: string }`.
- `formatRoute({ name: 'flowEdit', id })` → `/flows/<id>/edit`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/shell/route.test.ts`:

```ts
it('routes the flow editor, and does not collide with a flow version', () => {
  expect(parseRoute('/flows/f1/edit', '')).toEqual({ name: 'flowEdit', id: 'f1' });
  // Same three segments as `/flows/versions/:id` and `/flows/:id/compare`;
  // the literal falls in a different position in each.
  expect(parseRoute('/flows/versions/v1', '')).toEqual({ name: 'flowVersionDirect', versionId: 'v1' });
  expect(parseRoute('/flows/f1/compare', '')).toEqual({
    name: 'flowCompare',
    flowId: 'f1',
    from: null,
    to: null,
  });
});

it('reads the flows tab on Configure', () => {
  expect(parseRoute('/config', '?tab=flows')).toEqual({ name: 'config', tab: 'flows' });
});

it('round-trips the editor route through formatRoute', () => {
  expect(formatRoute({ name: 'flowEdit', id: 'f1' })).toBe('/flows/f1/edit');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- packages/web/src/shell/route.test.ts`
Expected: FAIL — `/flows/f1/edit` parses as `notFound`, and `'flows'` is not a `ConfigTab`.

- [ ] **Step 3: Add both routes**

In `packages/web/src/shell/route.ts`:

```ts
export type ConfigTab = 'workers' | 'libraries' | 'flows' | 'plugins' | 'system';
```

```ts
  // The editor is its OWN route, not a mode on `/flows/:id`: an edit in
  // progress has to be linkable and has to survive a reload, and a flow with a
  // draft is a thing an operator comes back to on another machine.
  | { name: 'flowEdit'; id: string }
```

```ts
const CONFIG_TABS: ConfigTab[] = ['workers', 'libraries', 'flows', 'plugins', 'system'];
```

In `parseRoute`, beside the other three-segment flow routes:

```ts
  if (segments[0] === 'flows' && segments.length === 3 && segments[2] === 'edit') {
    return { name: 'flowEdit', id: segments[1]! };
  }
```

In `formatRoute`, beside the `flow` case:

```ts
    case 'flowEdit':
      return `/flows/${route.id}/edit`;
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm test -- packages/web/src/shell/route.test.ts && pnpm typecheck`
Expected: PASS. `typecheck` also proves the `formatRoute` switch is exhaustive over the
new route.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/shell/route.ts packages/web/src/shell/route.test.ts
git commit -m "feat(web): the flow editor and the flows tab have their own URLs"
```

---

### Task 6: The graph mutations, as pure functions

This is where correctness lives. Deleting a node from the middle of a chain without
orphaning what followed it is exactly the operation that produces a muxqueue-shaped
defect, and none of it may live inside a React component.

**Files:**
- Create: `packages/web/src/screens/flows/flow-edit-model.ts`
- Test: `packages/web/src/screens/flows/flow-edit-model.test.ts`

**Interfaces:**
- Consumes: `type { FlowDefinition, FlowEdge, FlowNode } from '@trawlarr/core'` (type-only; erased at build).
- Produces (every one pure, returning a new definition, never mutating its input):
  - `addNode(definition: FlowDefinition, node: FlowNode): FlowDefinition`
  - `connect(definition: FlowDefinition, edge: FlowEdge): FlowDefinition`
  - `disconnect(definition: FlowDefinition, edge: FlowEdge): FlowDefinition`
  - `repointBranch(definition: FlowDefinition, input: { fromNodeId: string; outputNumber: number; toNodeId: string | null }): FlowDefinition`
  - `insertNodeOnEdge(definition: FlowDefinition, input: { edge: FlowEdge; node: FlowNode; firstOutputNumber: number }): FlowDefinition`
  - `deleteNode(definition: FlowDefinition, nodeId: string): FlowDefinition`
  - `setNodeInput(definition: FlowDefinition, input: { nodeId: string; name: string; value: unknown }): FlowDefinition`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/screens/flows/flow-edit-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import {
  addNode,
  connect,
  deleteNode,
  disconnect,
  insertNodeOnEdge,
  repointBranch,
  setNodeInput,
} from './flow-edit-model.js';

const node = (id: string, pluginId = `tdarr:${id}`) => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs: {},
});

/** start → codec →(1) muxqueue →(1) encode, with codec's output 2 also reaching encode. */
const BRANCHED: FlowDefinition = {
  nodes: [node('start'), node('codec'), node('muxqueue'), node('encode')],
  edges: [
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'codec' },
    { fromNodeId: 'codec', outputNumber: 1, toNodeId: 'muxqueue' },
    { fromNodeId: 'codec', outputNumber: 2, toNodeId: 'encode' },
    { fromNodeId: 'muxqueue', outputNumber: 1, toNodeId: 'encode' },
  ],
};

describe('connect', () => {
  it('replaces the edge already on that output, because an output leads to one node', () => {
    const next = connect(BRANCHED, { fromNodeId: 'codec', outputNumber: 1, toNodeId: 'encode' });

    const fromCodecOne = next.edges.filter(
      (edge) => edge.fromNodeId === 'codec' && edge.outputNumber === 1,
    );
    // Two edges off one output is `ambiguous-edge`: the executor refuses the
    // flow, so an editor that could produce it would be building unsavable
    // graphs by dragging.
    expect(fromCodecOne).toEqual([{ fromNodeId: 'codec', outputNumber: 1, toNodeId: 'encode' }]);
  });

  it('leaves the definition it was given alone', () => {
    const before = JSON.stringify(BRANCHED);
    connect(BRANCHED, { fromNodeId: 'codec', outputNumber: 1, toNodeId: 'encode' });
    expect(JSON.stringify(BRANCHED)).toBe(before);
  });
});

describe('disconnect and repointBranch', () => {
  it('removes exactly the edge named, not every edge between the two nodes', () => {
    const next = disconnect(BRANCHED, { fromNodeId: 'codec', outputNumber: 2, toNodeId: 'encode' });
    expect(next.edges).toHaveLength(3);
    expect(next.edges).toContainEqual({ fromNodeId: 'muxqueue', outputNumber: 1, toNodeId: 'encode' });
  });

  it('moves a branch off a node it should never have been on', () => {
    // THE MUXQUEUE FIX, as one operation: output 2 (needs encoding) keeps the
    // muxqueue node; output 1 (already correct) must not touch it.
    const next = repointBranch(BRANCHED, {
      fromNodeId: 'codec',
      outputNumber: 1,
      toNodeId: 'encode',
    });
    expect(next.edges).toContainEqual({ fromNodeId: 'codec', outputNumber: 1, toNodeId: 'encode' });
    expect(next.edges).not.toContainEqual({
      fromNodeId: 'codec',
      outputNumber: 1,
      toNodeId: 'muxqueue',
    });
  });

  it('leaves an output wired to nothing when pointed at null', () => {
    const next = repointBranch(BRANCHED, { fromNodeId: 'codec', outputNumber: 1, toNodeId: null });
    expect(next.edges.some((edge) => edge.fromNodeId === 'codec' && edge.outputNumber === 1)).toBe(
      false,
    );
  });
});

describe('insertNodeOnEdge', () => {
  it('puts the new node between the two, keeping the branch it was dropped on', () => {
    const next = insertNodeOnEdge(BRANCHED, {
      edge: { fromNodeId: 'codec', outputNumber: 2, toNodeId: 'encode' },
      node: node('tag'),
      firstOutputNumber: 1,
    });

    expect(next.nodes.map((entry) => entry.id)).toContain('tag');
    expect(next.edges).toContainEqual({ fromNodeId: 'codec', outputNumber: 2, toNodeId: 'tag' });
    expect(next.edges).toContainEqual({ fromNodeId: 'tag', outputNumber: 1, toNodeId: 'encode' });
    // The edge it replaced is gone — otherwise the branch reaches `encode`
    // both through the new node and around it.
    expect(next.edges).not.toContainEqual({
      fromNodeId: 'codec',
      outputNumber: 2,
      toNodeId: 'encode',
    });
  });
});

describe('deleteNode', () => {
  it('heals the chain: what pointed at it now points at what it pointed at', () => {
    const next = deleteNode(BRANCHED, 'muxqueue');

    expect(next.nodes.map((entry) => entry.id)).not.toContain('muxqueue');
    // Without healing, `encode` is reachable only from codec's output 2 and
    // half the flow silently stops running — the defect class this whole
    // editor exists to prevent.
    expect(next.edges).toContainEqual({ fromNodeId: 'codec', outputNumber: 1, toNodeId: 'encode' });
    expect(next.edges.some((edge) => edge.fromNodeId === 'muxqueue')).toBe(false);
    expect(next.edges.some((edge) => edge.toNodeId === 'muxqueue')).toBe(false);
  });

  it('heals through the LOWEST-numbered output when the deleted node branched', () => {
    const branchy: FlowDefinition = {
      nodes: [node('start'), node('check'), node('a'), node('b')],
      edges: [
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
        { fromNodeId: 'check', outputNumber: 2, toNodeId: 'b' },
        { fromNodeId: 'check', outputNumber: 1, toNodeId: 'a' },
      ],
    };

    const next = deleteNode(branchy, 'check');

    // One inbound edge cannot become two, so the choice is stated rather than
    // arbitrary: the lowest-numbered output, which is the branch a flow's
    // author wrote first. `b` is left unreachable and the canvas MARKS it,
    // rather than this function silently deleting someone's subtree.
    expect(next.edges).toContainEqual({ fromNodeId: 'start', outputNumber: 1, toNodeId: 'a' });
    expect(next.nodes.map((entry) => entry.id)).toContain('b');
  });

  it('drops the inbound edge when the deleted node led nowhere', () => {
    const next = deleteNode(BRANCHED, 'encode');
    expect(next.edges.some((edge) => edge.toNodeId === 'encode')).toBe(false);
    expect(next.edges).toHaveLength(2);
  });

  it('never heals a node into a loop back onto itself', () => {
    const looping: FlowDefinition = {
      nodes: [node('a'), node('b')],
      edges: [
        { fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' },
        { fromNodeId: 'b', outputNumber: 1, toNodeId: 'a' },
      ],
    };

    const next = deleteNode(looping, 'b');

    // `a → a` validates fine and runs forever.
    expect(next.edges).toEqual([]);
  });
});

describe('setNodeInput', () => {
  it('changes one input on one node and nothing else', () => {
    const next = setNodeInput(BRANCHED, { nodeId: 'encode', name: 'codec', value: 'hevc' });
    expect(next.nodes.find((entry) => entry.id === 'encode')?.inputs).toEqual({ codec: 'hevc' });
    expect(next.nodes.find((entry) => entry.id === 'codec')?.inputs).toEqual({});
    expect(next.edges).toEqual(BRANCHED.edges);
  });
});

describe('addNode', () => {
  it('adds a node wired to nothing', () => {
    const next = addNode(BRANCHED, node('fresh'));
    expect(next.nodes).toHaveLength(5);
    expect(next.edges).toEqual(BRANCHED.edges);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- packages/web/src/screens/flows/flow-edit-model.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Create `packages/web/src/screens/flows/flow-edit-model.ts`:

```ts
import type { FlowDefinition, FlowEdge, FlowNode } from '@trawlarr/core';

/**
 * Every edit a canvas can make to a flow, as a pure function.
 *
 * NONE OF THIS MAY LIVE IN THE COMPONENT. The canvas itself is untested by
 * design (no DOM testing library in this repo), so anything that decides what
 * the graph becomes has to be here, where it is tested — and the operation
 * that matters most, deleting a node from the middle of a chain, is precisely
 * the one that produces a `-max_muxing_queue_size`-shaped defect when it goes
 * wrong: a node left on the wrong branch, or a branch left leading nowhere,
 * queued about 9.2 TB of pointless rewrites and was invisible in the JSON.
 *
 * Every function returns a NEW definition. Mutating in place would make React
 * skip a re-render and show the operator a graph that is not the one they are
 * about to publish.
 */

const sameEdge = (left: FlowEdge, right: FlowEdge): boolean =>
  left.fromNodeId === right.fromNodeId &&
  left.outputNumber === right.outputNumber &&
  left.toNodeId === right.toNodeId;

export const addNode = (definition: FlowDefinition, node: FlowNode): FlowDefinition => ({
  nodes: [...definition.nodes, node],
  edges: [...definition.edges],
});

/**
 * ONE TARGET PER OUTPUT. Two edges off the same output is the validator's
 * `ambiguous-edge` — the executor refuses the flow — so a second connection to
 * the same output REPLACES the first rather than joining it. Dragging must not
 * be able to build a graph that cannot be saved.
 */
export const connect = (definition: FlowDefinition, edge: FlowEdge): FlowDefinition => ({
  nodes: [...definition.nodes],
  edges: [
    ...definition.edges.filter(
      (existing) =>
        !(existing.fromNodeId === edge.fromNodeId && existing.outputNumber === edge.outputNumber),
    ),
    edge,
  ],
});

export const disconnect = (definition: FlowDefinition, edge: FlowEdge): FlowDefinition => ({
  nodes: [...definition.nodes],
  edges: definition.edges.filter((existing) => !sameEdge(existing, edge)),
});

/** Where one output leads, including nowhere. */
export const repointBranch = (
  definition: FlowDefinition,
  input: { fromNodeId: string; outputNumber: number; toNodeId: string | null },
): FlowDefinition => {
  const withoutBranch: FlowDefinition = {
    nodes: [...definition.nodes],
    edges: definition.edges.filter(
      (edge) =>
        !(edge.fromNodeId === input.fromNodeId && edge.outputNumber === input.outputNumber),
    ),
  };
  if (input.toNodeId === null) return withoutBranch;
  return connect(withoutBranch, {
    fromNodeId: input.fromNodeId,
    outputNumber: input.outputNumber,
    toNodeId: input.toNodeId,
  });
};

/**
 * Drop a node onto an existing edge: the branch keeps going where it went,
 * through the new node. `firstOutputNumber` comes from the plugin's declared
 * outputs (`details.outputs[0].number`), not assumed to be 1 — a community
 * plugin is free to number its outputs however it likes.
 */
export const insertNodeOnEdge = (
  definition: FlowDefinition,
  input: { edge: FlowEdge; node: FlowNode; firstOutputNumber: number },
): FlowDefinition => {
  const withNode = addNode(definition, input.node);
  const upstream = connect(withNode, {
    fromNodeId: input.edge.fromNodeId,
    outputNumber: input.edge.outputNumber,
    toNodeId: input.node.id,
  });
  return connect(upstream, {
    fromNodeId: input.node.id,
    outputNumber: input.firstOutputNumber,
    toNodeId: input.edge.toNodeId,
  });
};

/**
 * Delete a node and HEAL what ran through it.
 *
 * Everything that pointed at the deleted node is re-pointed at what the
 * deleted node's LOWEST-numbered output pointed at. That choice is stated
 * rather than clever: one inbound edge cannot become two, so deleting a
 * branching node has to leave the other branches' subtrees somewhere. They are
 * left in the definition, unreachable, and the canvas marks them — because a
 * delete that silently removed a subtree is a data-loss defect wearing a
 * cosmetic disguise.
 *
 * A heal that would point a node at itself is dropped instead: `a → a`
 * validates and then runs forever.
 */
export const deleteNode = (definition: FlowDefinition, nodeId: string): FlowDefinition => {
  const successor = definition.edges
    .filter((edge) => edge.fromNodeId === nodeId)
    .sort((left, right) => left.outputNumber - right.outputNumber)[0]?.toNodeId;

  const healed = definition.edges.flatMap((edge): FlowEdge[] => {
    if (edge.fromNodeId === nodeId) return [];
    if (edge.toNodeId !== nodeId) return [edge];
    if (successor === undefined || successor === edge.fromNodeId || successor === nodeId) return [];
    return [{ ...edge, toNodeId: successor }];
  });

  return {
    nodes: definition.nodes.filter((node) => node.id !== nodeId),
    // The heal can collide with an edge that already exists on the same
    // output; keep the first and drop the duplicate, or the result is the
    // `ambiguous-edge` the executor refuses.
    edges: healed.filter(
      (edge, index) =>
        healed.findIndex(
          (other) =>
            other.fromNodeId === edge.fromNodeId && other.outputNumber === edge.outputNumber,
        ) === index,
    ),
  };
};

export const setNodeInput = (
  definition: FlowDefinition,
  input: { nodeId: string; name: string; value: unknown },
): FlowDefinition => ({
  nodes: definition.nodes.map((node) =>
    node.id === input.nodeId
      ? { ...node, inputs: { ...node.inputs, [input.name]: input.value } }
      : node,
  ),
  edges: [...definition.edges],
});
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm test -- packages/web/src/screens/flows/flow-edit-model.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens/flows/flow-edit-model.ts packages/web/src/screens/flows/flow-edit-model.test.ts
git commit -m "feat(web): graph edits as pure functions, so deleting a node cannot orphan what followed it"
```

---

### Task 7: The canvas translation — definition ↔ react-flow, and where the errors land

**Files:**
- Create: `packages/web/src/screens/flows/flow-canvas-model.ts`
- Test: `packages/web/src/screens/flows/flow-canvas-model.test.ts`

**Interfaces:**
- Consumes: `type { FlowDefinition, FlowEdge, FlowNode } from '@trawlarr/core'`; the
  plugin resource shape from `GET /plugins` (`id`, `isStartPlugin`, `details.name`,
  `details.style.borderColor`, `details.icon`, `details.tags`, `details.sidebarPosition`,
  `details.inputs[]`, `details.outputs[]`); validation problems from Task 1.
- Produces:
  - `interface ApiPlugin`, `interface ValidationProblem`
  - `edgeId(edge: FlowEdge): string`
  - `layoutDefinition(definition: FlowDefinition): Map<string, { x: number; y: number }>`
  - `toCanvas(input: { definition, plugins, problems }): { nodes: CanvasNode[]; edges: CanvasEdge[] }`
  - `fromCanvas(input: { nodes: CanvasNode[]; edges: CanvasEdge[] }): FlowDefinition`
  - `newNodeId(pluginId: string, existing: string[]): string`
  - `paletteEntries(plugins: ApiPlugin[]): ApiPlugin[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/screens/flows/flow-canvas-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from '@trawlarr/core';
import {
  edgeId,
  fromCanvas,
  layoutDefinition,
  newNodeId,
  paletteEntries,
  toCanvas,
  type ApiPlugin,
} from './flow-canvas-model.js';

const plugin = (id: string, over: Partial<ApiPlugin['details']> = {}): ApiPlugin => ({
  id,
  isStartPlugin: id === 'trawlarr:start',
  details: {
    name: id,
    description: '',
    tags: 'video',
    icon: '',
    sidebarPosition: 1,
    style: { borderColor: '#123456' },
    inputs: [],
    outputs: [{ number: 1, tooltip: 'continue' }],
    ...over,
  },
});

const PLUGINS: ApiPlugin[] = [
  plugin('trawlarr:start'),
  plugin('trawlarr:checkVideoCodec', {
    outputs: [
      { number: 1, tooltip: 'already hevc' },
      { number: 2, tooltip: 'needs encoding' },
    ],
  }),
  plugin('trawlarr:setVideoEncoder', {
    inputs: [
      {
        label: 'Encoder',
        name: 'encoder',
        type: 'string',
        defaultValue: 'hevc_nvenc',
        tooltip: '',
        inputUI: { type: 'text' },
      },
    ],
  }),
];

const node = (id: string, pluginId: string) => ({ id, pluginId, pluginVersion: '1.0.0', inputs: {} });

const CHAIN: FlowDefinition = {
  nodes: [node('s', 'trawlarr:start'), node('c', 'trawlarr:checkVideoCodec'), node('e', 'trawlarr:setVideoEncoder')],
  edges: [
    { fromNodeId: 's', outputNumber: 1, toNodeId: 'c' },
    { fromNodeId: 'c', outputNumber: 2, toNodeId: 'e' },
  ],
};

describe('layoutDefinition', () => {
  it('puts each node one column right of the furthest thing that reaches it', () => {
    const layout = layoutDefinition(CHAIN);
    expect(layout.get('s')!.x).toBeLessThan(layout.get('c')!.x);
    expect(layout.get('c')!.x).toBeLessThan(layout.get('e')!.x);
  });

  it('draws a rejoin at the deeper column, so no edge points backwards', () => {
    // start → a → b → join, and start → join directly. `join` belongs after
    // `b`, not next to `a`.
    const rejoin: FlowDefinition = {
      nodes: [node('s', 'trawlarr:start'), node('a', 'p'), node('b', 'p'), node('join', 'p')],
      edges: [
        { fromNodeId: 's', outputNumber: 1, toNodeId: 'a' },
        { fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' },
        { fromNodeId: 'b', outputNumber: 1, toNodeId: 'join' },
        { fromNodeId: 's', outputNumber: 2, toNodeId: 'join' },
      ],
    };
    const layout = layoutDefinition(rejoin);
    expect(layout.get('join')!.x).toBeGreaterThan(layout.get('b')!.x);
  });

  it('lays out a cyclic graph instead of hanging', () => {
    const cyclic: FlowDefinition = {
      nodes: [node('a', 'p'), node('b', 'p')],
      edges: [
        { fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' },
        { fromNodeId: 'b', outputNumber: 1, toNodeId: 'a' },
      ],
    };
    // A malformed flow is exactly what this editor is for; refusing to draw
    // one leaves the operator with the JSON they already could not read.
    expect(layoutDefinition(cyclic).size).toBe(2);
  });

  it('gives two nodes in the same column different rows', () => {
    const forked: FlowDefinition = {
      nodes: [node('s', 'trawlarr:start'), node('a', 'p'), node('b', 'p')],
      edges: [
        { fromNodeId: 's', outputNumber: 1, toNodeId: 'a' },
        { fromNodeId: 's', outputNumber: 2, toNodeId: 'b' },
      ],
    };
    const layout = layoutDefinition(forked);
    expect(layout.get('a')!.y).not.toBe(layout.get('b')!.y);
  });
});

describe('toCanvas', () => {
  it('gives every edge a handle naming the output it leaves from', () => {
    const canvas = toCanvas({ definition: CHAIN, plugins: PLUGINS, problems: [] });
    const branch = canvas.edges.find((edge) => edge.source === 'c')!;
    // "output 1 versus output 2" is the distinction the muxqueue defect turned
    // on. An unlabelled edge hides it exactly as the JSON did.
    expect(branch.sourceHandle).toBe('out-2');
    expect(branch.label).toBe('output 2');
  });

  it('carries the plugin\'s declared outputs and colour onto the node', () => {
    const canvas = toCanvas({ definition: CHAIN, plugins: PLUGINS, problems: [] });
    const check = canvas.nodes.find((entry) => entry.id === 'c')!;
    expect(check.data.outputs).toEqual([
      { number: 1, tooltip: 'already hevc' },
      { number: 2, tooltip: 'needs encoding' },
    ]);
    expect(check.data.borderColor).toBe('#123456');
  });

  it('marks a node whose plugin this daemon cannot resolve, rather than dropping it', () => {
    const withGhost: FlowDefinition = {
      nodes: [...CHAIN.nodes, node('x', 'community:notInstalled')],
      edges: CHAIN.edges,
    };
    const canvas = toCanvas({ definition: withGhost, plugins: PLUGINS, problems: [] });
    const ghost = canvas.nodes.find((entry) => entry.id === 'x')!;
    // A flow is written on one machine and run on another; an unresolved
    // plugin says nothing about whether the flow is right, so it is drawn.
    expect(ghost.data.unknownPlugin).toBe(true);
    expect(ghost.data.outputs).toEqual([]);
  });

  it('marks a node no path from the start reaches', () => {
    const orphaned: FlowDefinition = { nodes: [...CHAIN.nodes, node('o', 'p')], edges: CHAIN.edges };
    const canvas = toCanvas({ definition: orphaned, plugins: PLUGINS, problems: [] });
    expect(canvas.nodes.find((entry) => entry.id === 'o')!.data.unreachable).toBe(true);
    expect(canvas.nodes.find((entry) => entry.id === 'c')!.data.unreachable).toBe(false);
  });

  it('lands a problem on the node or edge it names, and keeps the rest for the flow', () => {
    const canvas = toCanvas({
      definition: CHAIN,
      plugins: PLUGINS,
      problems: [
        { code: 'multiple-start-nodes', message: 'two starts', nodeId: 'c' },
        {
          code: 'edge-undeclared-output',
          message: 'no output 2',
          edge: { fromNodeId: 'c', outputNumber: 2, toNodeId: 'e' },
        },
        { code: 'no-nodes', message: 'this flow has no nodes' },
      ],
    });

    expect(canvas.nodes.find((entry) => entry.id === 'c')!.data.problems).toEqual(['two starts']);
    expect(canvas.edges.find((edge) => edge.source === 'c')!.data.problems).toEqual(['no output 2']);
    expect(canvas.flowProblems).toEqual(['this flow has no nodes']);
  });
});

describe('fromCanvas', () => {
  it('round-trips a definition, positions and all the drawing dropped', () => {
    const canvas = toCanvas({ definition: CHAIN, plugins: PLUGINS, problems: [] });
    // Positions are NOT part of a flow: the definition's hash is the flow's
    // version, so if a drag changed the definition it would re-queue a library.
    expect(fromCanvas(canvas)).toEqual(CHAIN);
  });

  it('reads the output number back off the handle, not off the edge order', () => {
    const canvas = toCanvas({ definition: CHAIN, plugins: PLUGINS, problems: [] });
    const moved = {
      ...canvas,
      edges: [{ ...canvas.edges[1]!, sourceHandle: 'out-1', id: 'anything' }],
    };
    expect(fromCanvas({ nodes: canvas.nodes, edges: moved.edges })).toMatchObject({
      edges: [{ fromNodeId: 'c', outputNumber: 1, toNodeId: 'e' }],
    });
  });
});

describe('newNodeId', () => {
  it('names a node after its plugin and never collides', () => {
    expect(newNodeId('trawlarr:setVideoEncoder', [])).toBe('setVideoEncoder');
    expect(newNodeId('trawlarr:setVideoEncoder', ['setVideoEncoder'])).toBe('setVideoEncoder-2');
    expect(newNodeId('trawlarr:setVideoEncoder', ['setVideoEncoder', 'setVideoEncoder-2'])).toBe(
      'setVideoEncoder-3',
    );
  });
});

describe('paletteEntries', () => {
  it('orders by the plugin\'s own sidebarPosition, then name, and drops start plugins', () => {
    const entries = paletteEntries([
      plugin('b', { sidebarPosition: 2 }),
      plugin('a', { sidebarPosition: 5 }),
      plugin('trawlarr:start'),
    ]);
    // A flow has exactly one start node and it already exists; offering
    // another is offering `multiple-start-nodes`.
    expect(entries.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- packages/web/src/screens/flows/flow-canvas-model.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Create `packages/web/src/screens/flows/flow-canvas-model.ts`:

```ts
import type { FlowDefinition, FlowEdge, FlowNode } from '@trawlarr/core';

/**
 * The flow, translated for `@xyflow/react`, and back again.
 *
 * POSITIONS ARE DERIVED, NEVER STORED. `FlowDefinition` has no position field
 * and its hash IS the flow's version — a stored position would mean nudging a
 * node re-queues every file in every library using the flow (4,621 files on
 * the install this was designed against). So the layout is computed from the
 * graph's own shape every time, and a drag is session-local.
 *
 * The wire shape of `GET /plugins` is mirrored here rather than imported: the
 * server package is not a dependency of `packages/web`, and only these fields
 * matter to a canvas.
 */
export interface ApiPluginInput {
  label: string;
  name: string;
  type: 'string' | 'boolean' | 'number';
  defaultValue: string;
  tooltip: string;
  inputUI: { type: string; options?: string[] };
}

export interface ApiPluginOutput {
  number: number;
  tooltip: string;
}

export interface ApiPlugin {
  id: string;
  isStartPlugin: boolean;
  details: {
    name: string;
    description: string;
    tags: string;
    icon: string;
    sidebarPosition: number;
    style: { borderColor: string };
    inputs: ApiPluginInput[];
    outputs: ApiPluginOutput[];
  };
}

/** A problem as `POST /flows/validate` reports it (see Task 1). */
export interface ValidationProblem {
  code: string;
  message: string;
  nodeId?: string;
  edge?: FlowEdge;
}

export interface CanvasNodeData {
  pluginId: string;
  label: string;
  borderColor: string;
  icon: string;
  /** The node's own stored inputs, beside what the plugin declares. */
  inputs: Record<string, unknown>;
  declaredInputs: ApiPluginInput[];
  outputs: ApiPluginOutput[];
  pluginVersion: string;
  isStart: boolean;
  /** This daemon has no such plugin installed. Drawn anyway — see below. */
  unknownPlugin: boolean;
  unreachable: boolean;
  problems: string[];
}

export interface CanvasNode {
  id: string;
  type: 'flowNode';
  position: { x: number; y: number };
  data: CanvasNodeData;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  label: string;
  data: { outputNumber: number; problems: string[] };
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Problems that name neither a node nor an edge — they are about the flow. */
  flowProblems: string[];
}

const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 130;

export const edgeId = (edge: FlowEdge): string =>
  `${edge.fromNodeId}:${String(edge.outputNumber)}->${edge.toNodeId}`;

export const handleId = (outputNumber: number): string => `out-${String(outputNumber)}`;

export const outputFromHandle = (handle: string | null | undefined): number => {
  const parsed = Number.parseInt((handle ?? '').replace(/^out-/, ''), 10);
  return Number.isNaN(parsed) ? 1 : parsed;
};

/**
 * A column per hop from the start node, using the LONGEST path rather than the
 * shortest: real flows rejoin (both branches of the codec check meet again at
 * the audio node), and placing a rejoin by its shortest path draws an edge
 * pointing backwards past the branch it came from.
 *
 * Relaxation, bounded by the node count, rather than a recursive walk: a
 * malformed flow may contain a cycle, and this screen exists to make a
 * malformed flow visible, so it must terminate on one rather than refuse it.
 */
export const layoutDefinition = (
  definition: FlowDefinition,
): Map<string, { x: number; y: number }> => {
  const targets = new Set(definition.edges.map((edge) => edge.toNodeId));
  const roots = definition.nodes.filter((node) => !targets.has(node.id));
  const depths = new Map<string, number>();
  for (const root of roots.length > 0 ? roots : definition.nodes.slice(0, 1)) {
    depths.set(root.id, 0);
  }

  const limit = definition.nodes.length;
  for (let pass = 0; pass < limit; pass += 1) {
    let changed = false;
    for (const edge of definition.edges) {
      const from = depths.get(edge.fromNodeId);
      if (from === undefined) continue;
      const next = Math.min(from + 1, limit);
      if ((depths.get(edge.toNodeId) ?? -1) < next) {
        depths.set(edge.toNodeId, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const rows = new Map<number, number>();
  const layout = new Map<string, { x: number; y: number }>();
  for (const node of definition.nodes) {
    // A node nothing reaches still gets drawn: it goes in column 0, under
    // whatever is already there, and `toCanvas` marks it.
    const depth = depths.get(node.id) ?? 0;
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    layout.set(node.id, { x: depth * COLUMN_WIDTH, y: row * ROW_HEIGHT });
  }
  return layout;
};

/** Which nodes a path from the start node actually reaches. */
const reachable = (definition: FlowDefinition): Set<string> => {
  const targets = new Set(definition.edges.map((edge) => edge.toNodeId));
  const root = definition.nodes.find((node) => !targets.has(node.id))?.id;
  const seen = new Set<string>();
  const queue = root === undefined ? [] : [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of definition.edges) {
      if (edge.fromNodeId === current) queue.push(edge.toNodeId);
    }
  }
  return seen;
};

export const toCanvas = (input: {
  definition: FlowDefinition;
  plugins: ApiPlugin[];
  problems: ValidationProblem[];
}): Canvas => {
  const byPluginId = new Map(input.plugins.map((plugin) => [plugin.id, plugin]));
  const layout = layoutDefinition(input.definition);
  const live = reachable(input.definition);

  const nodeProblems = new Map<string, string[]>();
  const edgeProblems = new Map<string, string[]>();
  const flowProblems: string[] = [];
  for (const problem of input.problems) {
    if (problem.nodeId !== undefined) {
      nodeProblems.set(problem.nodeId, [
        ...(nodeProblems.get(problem.nodeId) ?? []),
        problem.message,
      ]);
    } else if (problem.edge !== undefined) {
      const key = edgeId(problem.edge);
      edgeProblems.set(key, [...(edgeProblems.get(key) ?? []), problem.message]);
    } else {
      flowProblems.push(problem.message);
    }
  }

  const nodes: CanvasNode[] = input.definition.nodes.map((node) => {
    const plugin = byPluginId.get(node.pluginId);
    return {
      id: node.id,
      type: 'flowNode',
      position: layout.get(node.id) ?? { x: 0, y: 0 },
      data: {
        pluginId: node.pluginId,
        label: plugin?.details.name ?? node.pluginId,
        borderColor: plugin?.details.style.borderColor ?? '#888888',
        icon: plugin?.details.icon ?? '',
        inputs: node.inputs,
        declaredInputs: plugin?.details.inputs ?? [],
        outputs: plugin?.details.outputs ?? [],
        pluginVersion: node.pluginVersion,
        isStart: plugin?.isStartPlugin ?? false,
        // A flow is routinely written on one machine and run on another, so a
        // plugin this daemon has never seen says nothing about whether the
        // flow is correct. Drawn and marked, never dropped: a node silently
        // absent reads as a node that is not in the flow.
        unknownPlugin: plugin === undefined,
        unreachable: !live.has(node.id),
        problems: nodeProblems.get(node.id) ?? [],
      },
    };
  });

  const edges: CanvasEdge[] = input.definition.edges.map((edge) => ({
    id: edgeId(edge),
    source: edge.fromNodeId,
    target: edge.toNodeId,
    sourceHandle: handleId(edge.outputNumber),
    label: `output ${String(edge.outputNumber)}`,
    data: { outputNumber: edge.outputNumber, problems: edgeProblems.get(edgeId(edge)) ?? [] },
  }));

  return { nodes, edges, flowProblems };
};

/**
 * Back to a definition — the ONLY thing that is ever saved or published.
 * Everything the canvas added for drawing (positions, colours, labels,
 * problems) is dropped here, which is what keeps a drag from changing a hash.
 */
export const fromCanvas = (input: { nodes: CanvasNode[]; edges: CanvasEdge[] }): FlowDefinition => ({
  nodes: input.nodes.map(
    (node): FlowNode => ({
      id: node.id,
      pluginId: node.data.pluginId,
      pluginVersion: node.data.pluginVersion,
      inputs: node.data.inputs,
    }),
  ),
  edges: input.edges.map(
    (edge): FlowEdge => ({
      fromNodeId: edge.source,
      // Read off the HANDLE: react-flow reports which handle a connection was
      // dragged from, and that — not the order edges happen to be in — is
      // which branch the operator wired.
      outputNumber: outputFromHandle(edge.sourceHandle),
      toNodeId: edge.target,
    }),
  ),
});

/**
 * A readable node id derived from the plugin, unique within the flow. Node ids
 * are what every error message, every graph row and every diff names, so a
 * uuid here would make the editor's own messages unreadable.
 */
export const newNodeId = (pluginId: string, existing: string[]): string => {
  const base = (pluginId.split(':').at(-1) ?? 'node').replace(/[^A-Za-z0-9_-]/g, '');
  if (!existing.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!existing.includes(candidate)) return candidate;
  }
};

/**
 * The palette, in the order the plugins themselves ask for. Start plugins are
 * excluded: a flow has exactly one start node and it already exists, so
 * offering another offers `multiple-start-nodes`.
 */
export const paletteEntries = (plugins: ApiPlugin[]): ApiPlugin[] =>
  plugins
    .filter((plugin) => !plugin.isStartPlugin)
    .sort(
      (left, right) =>
        left.details.sidebarPosition - right.details.sidebarPosition ||
        left.details.name.localeCompare(right.details.name),
    );
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm test -- packages/web/src/screens/flows/flow-canvas-model.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens/flows/flow-canvas-model.ts packages/web/src/screens/flows/flow-canvas-model.test.ts
git commit -m "feat(web): translate a flow to a canvas and back, without letting a drag change its hash"
```

---

### Task 8: What a draft is, and what Publish is allowed to claim

**Files:**
- Create: `packages/web/src/screens/flows/flow-publish-model.ts`
- Test: `packages/web/src/screens/flows/flow-publish-model.test.ts`

**Interfaces:**
- Consumes: `type { FlowDefinition } from '@trawlarr/core'`; `LibraryStats` shape from
  `GET /libraries/:id/stats` (only `libraryId` and `total` are read).
- Produces:
  - `describeDraft(input: { flow: ApiFlowWithDraft; problems: ValidationProblem[] | null }): DraftState`
    where `DraftState = { kind: 'none' | 'saved' | 'invalid' | 'stale'; canPublish: boolean; reason: string | null }`
  - `publishSummary(input: { flowName, fromHash, toHash, libraries, stats }): PublishSummary`

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/screens/flows/flow-publish-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describeDraft, publishSummary } from './flow-publish-model.js';

const FLOW = {
  id: 'f1',
  name: 'Conform',
  definitionHash: 'hash-live',
  draft: { nodes: [], edges: [] },
  draftBaseHash: 'hash-live',
  draftUpdatedAt: 1_700_000_000_000,
};

describe('describeDraft', () => {
  it('says there is nothing to publish when there is no draft', () => {
    const state = describeDraft({ flow: { ...FLOW, draft: null, draftBaseHash: null }, problems: [] });
    expect(state.kind).toBe('none');
    expect(state.canPublish).toBe(false);
  });

  it('lets a valid draft be published', () => {
    expect(describeDraft({ flow: FLOW, problems: [] })).toMatchObject({
      kind: 'saved',
      canPublish: true,
    });
  });

  it('keeps an invalid draft saved but refuses to publish it, with the reason', () => {
    const state = describeDraft({
      flow: FLOW,
      problems: [{ code: 'edge-unknown-node', message: 'Edge points at "ghost", which is not in this flow.' }],
    });
    expect(state.kind).toBe('invalid');
    expect(state.canPublish).toBe(false);
    expect(state.reason).toContain('ghost');
  });

  it('refuses a draft whose base has moved, rather than reverting the other edit', () => {
    const state = describeDraft({
      flow: { ...FLOW, definitionHash: 'hash-someone-else' },
      problems: [],
    });
    expect(state.kind).toBe('stale');
    expect(state.canPublish).toBe(false);
  });

  it('is not "saved" while validation has not answered yet', () => {
    // Empty, loading and error must never render alike.
    expect(describeDraft({ flow: FLOW, problems: null }).canPublish).toBe(false);
  });
});

describe('publishSummary', () => {
  it('counts the files that re-queue, per library and in total', () => {
    const summary = publishSummary({
      flowName: 'Conform',
      fromHash: 'hash-live',
      toHash: 'hash-next',
      libraries: [
        { id: 'l1', name: 'Movies', flowId: 'f1' },
        { id: 'l2', name: 'TV', flowId: 'f1' },
        { id: 'l3', name: 'Music videos', flowId: 'other' },
      ],
      flowId: 'f1',
      stats: [
        { libraryId: 'l1', total: 4621 },
        { libraryId: 'l2', total: 573 },
        { libraryId: 'l3', total: 12 },
      ],
    });

    expect(summary.libraries).toEqual([
      { id: 'l1', name: 'Movies', files: 4621 },
      { id: 'l2', name: 'TV', files: 573 },
    ]);
    expect(summary.totalFiles).toBe(5194);
    expect(summary.hashFrom).toBe('hash-live');
    expect(summary.hashTo).toBe('hash-next');
  });

  it('says a library whose file count it has not got is unknown, not zero', () => {
    const summary = publishSummary({
      flowName: 'Conform',
      fromHash: 'a',
      toHash: 'b',
      libraries: [{ id: 'l1', name: 'Movies', flowId: 'f1' }],
      flowId: 'f1',
      stats: [],
    });
    expect(summary.libraries[0]!.files).toBeNull();
    expect(summary.countIsComplete).toBe(false);
  });

  it('never claims how many files will actually encode', () => {
    const summary = publishSummary({
      flowName: 'Conform',
      fromHash: 'a',
      toHash: 'b',
      libraries: [{ id: 'l1', name: 'Movies', flowId: 'f1' }],
      flowId: 'f1',
      stats: [{ libraryId: 'l1', total: 10 }],
    });
    // The count is "re-examined", not "re-encoded". A dry run stops at the
    // first plugin trawlarr did not write, so the encode figure is not
    // cheaply computable and a number the UI cannot stand behind is worse
    // than no number.
    expect(summary.caveat).toMatch(/depends on the files/i);
    expect(JSON.stringify(summary)).not.toMatch(/will encode|will re-encode/i);
  });

  it('says plainly when nothing uses this flow', () => {
    const summary = publishSummary({
      flowName: 'Trial',
      fromHash: 'a',
      toHash: 'b',
      libraries: [{ id: 'l1', name: 'Movies', flowId: 'other' }],
      flowId: 'f1',
      stats: [{ libraryId: 'l1', total: 10 }],
    });
    expect(summary.totalFiles).toBe(0);
    expect(summary.libraries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- packages/web/src/screens/flows/flow-publish-model.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Create `packages/web/src/screens/flows/flow-publish-model.ts`:

```ts
import type { FlowDefinition } from '@trawlarr/core';
import type { ValidationProblem } from './flow-canvas-model.js';

export interface ApiFlowWithDraft {
  id: string;
  name: string;
  definitionHash: string;
  draft: FlowDefinition | null;
  draftBaseHash: string | null;
  draftUpdatedAt: number | null;
}

export interface DraftState {
  kind: 'none' | 'saved' | 'invalid' | 'stale';
  canPublish: boolean;
  /** Why publishing is refused, in the words the operator needs. */
  reason: string | null;
}

/**
 * What the editor may say about the draft in front of it.
 *
 * A draft that fails validation is still SAVED — half-finished work is the
 * point of a draft — but must not be publishable, and the reason has to be the
 * validator's own message, which names the consequence.
 *
 * `problems: null` means validation has not answered yet. That is deliberately
 * not "valid": empty, loading and error must never render alike, and a Publish
 * button that is enabled while the answer is outstanding is a button that
 * publishes an unvalidated graph over a library.
 */
export const describeDraft = (input: {
  flow: ApiFlowWithDraft;
  problems: ValidationProblem[] | null;
}): DraftState => {
  const { flow } = input;
  if (flow.draft === null) {
    return { kind: 'none', canPublish: false, reason: null };
  }
  if (flow.draftBaseHash !== null && flow.draftBaseHash !== flow.definitionHash) {
    return {
      kind: 'stale',
      canPublish: false,
      reason:
        `This flow was published by someone else while you were editing. Publishing now would ` +
        `revert that change and re-queue every file in the libraries using it. Reopen the ` +
        `editor to start from the current graph.`,
    };
  }
  if (input.problems === null) {
    return { kind: 'saved', canPublish: false, reason: 'Checking this flow…' };
  }
  if (input.problems.length > 0) {
    return {
      kind: 'invalid',
      canPublish: false,
      reason: input.problems.map((problem) => problem.message).join(' '),
    };
  }
  return { kind: 'saved', canPublish: true, reason: null };
};

export interface PublishSummary {
  flowName: string;
  hashFrom: string;
  hashTo: string;
  libraries: Array<{ id: string; name: string; files: number | null }>;
  totalFiles: number;
  /** False when any affected library's file count is not known yet. */
  countIsComplete: boolean;
  caveat: string;
}

/**
 * WHAT PUBLISH IS ALLOWED TO CLAIM: which libraries use this flow, how many
 * files re-queue, and the hash transition. Nothing else.
 *
 * It must NOT estimate how many files will actually encode. `POST
 * /flows/:id/dry-run` halts at the first plugin trawlarr did not write — a
 * deliberate safety ruling, since walking past an unvouched plugin means
 * guessing at its side effects — and every real flow reaches a `tdarr:*` node
 * within three steps. The one census that produced a true figure required
 * reading four plugin sources by hand. A number the UI cannot stand behind is
 * worse than no number.
 */
export const publishSummary = (input: {
  flowName: string;
  flowId: string;
  fromHash: string;
  toHash: string;
  libraries: Array<{ id: string; name: string; flowId: string | null }>;
  stats: Array<{ libraryId: string; total: number }>;
}): PublishSummary => {
  const totals = new Map(input.stats.map((entry) => [entry.libraryId, entry.total]));
  const affected = input.libraries
    .filter((library) => library.flowId === input.flowId)
    .map((library) => ({
      id: library.id,
      name: library.name,
      // Null, never 0: "no files" and "we have not counted yet" are different
      // answers, and only one of them means publishing is free.
      files: totals.get(library.id) ?? null,
    }));

  return {
    flowName: input.flowName,
    hashFrom: input.fromHash,
    hashTo: input.toHash,
    libraries: affected,
    totalFiles: affected.reduce((sum, library) => sum + (library.files ?? 0), 0),
    countIsComplete: affected.every((library) => library.files !== null),
    caveat:
      'Every one of these files will be re-examined against the new flow. How many are actually ' +
      're-encoded depends on the files themselves.',
  };
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm test -- packages/web/src/screens/flows/flow-publish-model.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/screens/flows/flow-publish-model.ts packages/web/src/screens/flows/flow-publish-model.test.ts
git commit -m "feat(web): publish states the files it re-queues, and refuses to guess at encodes"
```

---

### Task 9: The Flows tab — where an orphan flow becomes visible

A flow is a system-wide object, but `/flows/:id` is reachable only through
Configure → Libraries today, so a flow no library uses cannot be opened at all. The
install this was designed against has two of them.

**Files:**
- Create: `packages/web/src/screens/config/flows-tab-model.ts`
- Create: `packages/web/src/screens/config/flows-tab-model.test.ts`
- Create: `packages/web/src/screens/config/Flows.tsx`
- Modify: `packages/web/src/screens/config/Config.tsx` (TABS + render)
- Modify: `packages/web/src/styles.css`

**Interfaces:**
- Consumes: `ApiFlowWithDraft` (Task 8); `GET /flows`, `GET /libraries`.
- Produces: `toFlowRows(input: { flows, libraries }): FlowRow[]` where
  `FlowRow = { id, name, hash, nodeCount, hasDraft, draftUpdatedAt, usedBy: Array<{ id; name }>, orphan: boolean }`
  and `deleteWarning(row: FlowRow): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/screens/config/flows-tab-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deleteWarning, toFlowRows } from './flows-tab-model.js';

const flow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  definitionHash: `hash-${id}`,
  definition: { nodes: [{ id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1', inputs: {} }], edges: [] },
  draft: null,
  draftBaseHash: null,
  draftUpdatedAt: null,
  ...over,
});

describe('toFlowRows', () => {
  it('names the libraries using each flow, and marks the ones nothing uses', () => {
    const rows = toFlowRows({
      flows: [flow('conform'), flow('NvencHW')],
      libraries: [
        { id: 'l1', name: 'Movies', flowId: 'conform' },
        { id: 'l2', name: 'TV', flowId: 'conform' },
      ],
    });

    expect(rows[0]).toMatchObject({ id: 'conform', orphan: false });
    expect(rows[0]!.usedBy.map((entry) => entry.name)).toEqual(['Movies', 'TV']);
    // The whole reason this tab exists: a flow no library uses was previously
    // unreachable in the UI, while still occupying the name space.
    expect(rows[1]).toMatchObject({ id: 'NvencHW', orphan: true, usedBy: [] });
  });

  it('reports the node count and whether there is unpublished work', () => {
    const rows = toFlowRows({
      flows: [flow('drafty', { draft: { nodes: [], edges: [] }, draftUpdatedAt: 42 })],
      libraries: [],
    });
    expect(rows[0]).toMatchObject({ nodeCount: 1, hasDraft: true, draftUpdatedAt: 42 });
  });
});

describe('deleteWarning', () => {
  it('names the libraries that stop converging, rather than asking "are you sure?"', () => {
    const [row] = toFlowRows({
      flows: [flow('conform')],
      libraries: [{ id: 'l1', name: 'Movies', flowId: 'conform' }],
    });
    const warning = deleteWarning(row!);
    expect(warning).toContain('Movies');
    expect(warning).toMatch(/stop converging|paused/i);
  });

  it('has nothing to warn about for a flow nothing uses', () => {
    const [row] = toFlowRows({ flows: [flow('orphan')], libraries: [] });
    expect(deleteWarning(row!)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- packages/web/src/screens/config/flows-tab-model.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the model**

Create `packages/web/src/screens/config/flows-tab-model.ts`:

```ts
import type { FlowDefinition } from '@trawlarr/core';

export interface ApiFlowListEntry {
  id: string;
  name: string;
  definition: FlowDefinition;
  definitionHash: string;
  draft: FlowDefinition | null;
  draftUpdatedAt: number | null;
}

export interface FlowRow {
  id: string;
  name: string;
  hash: string;
  nodeCount: number;
  hasDraft: boolean;
  draftUpdatedAt: number | null;
  usedBy: Array<{ id: string; name: string }>;
  /** No library uses this flow. It was invisible in this UI until this tab. */
  orphan: boolean;
}

export const toFlowRows = (input: {
  flows: ApiFlowListEntry[];
  libraries: Array<{ id: string; name: string; flowId: string | null }>;
}): FlowRow[] =>
  input.flows.map((flow) => {
    const usedBy = input.libraries
      .filter((library) => library.flowId === flow.id)
      .map((library) => ({ id: library.id, name: library.name }));
    return {
      id: flow.id,
      name: flow.name,
      hash: flow.definitionHash,
      nodeCount: flow.definition.nodes.length,
      hasDraft: flow.draft !== null,
      draftUpdatedAt: flow.draftUpdatedAt,
      usedBy,
      orphan: usedBy.length === 0,
    };
  });

/**
 * Deleting a flow sets `library.flow_id` to null (`ON DELETE SET NULL`), and
 * `checkAllLibraries` then pauses those libraries with a stated reason. That is
 * a correct outcome but a surprising one, so the confirmation NAMES the
 * libraries that stop converging instead of asking "are you sure?" — the
 * question nobody has ever answered with new information.
 */
export const deleteWarning = (row: FlowRow): string | null =>
  row.usedBy.length === 0
    ? null
    : `${row.usedBy.map((library) => library.name).join(' and ')} ${
        row.usedBy.length === 1 ? 'uses' : 'use'
      } this flow. Deleting it detaches ${
        row.usedBy.length === 1 ? 'that library' : 'those libraries'
      }, which pauses ${row.usedBy.length === 1 ? 'it' : 'them'}: ${
        row.usedBy.length === 1 ? 'it' : 'they'
      } stop converging until a flow is attached again.`;
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm test -- packages/web/src/screens/config/flows-tab-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the tab**

Create `packages/web/src/screens/config/Flows.tsx`, following `Libraries.tsx`'s existing
shape exactly — the same fetch effect with a `cancelled` flag, the same
`describeFailure` for errors, the same distinct empty / loading / error branches.
It renders:

- a table of `toFlowRows(...)`: name (a `Link` to `/flows/:id`), libraries using it or
  `Used by no library` for an orphan, node count, a short hash, an `Unpublished draft`
  badge when `hasDraft`, and an `Edit` link to `formatRoute({ name: 'flowEdit', id })`;
- a **New flow** control that `POST /flows` with a name and
  `{ templateId }` chosen from `GET /flows/templates`, then navigates straight to
  `/flows/<new id>/edit`;
- a **Delete** control that shows `deleteWarning(row)` inline and requires a second
  click, then `DELETE /flows/:id` and re-fetches.

Then in `packages/web/src/screens/config/Config.tsx`:

```ts
const TABS: Array<{ tab: ConfigTab; label: string }> = [
  { tab: 'workers', label: 'Workers' },
  { tab: 'libraries', label: 'Libraries' },
  { tab: 'flows', label: 'Flows' },
  { tab: 'plugins', label: 'Plugins' },
  { tab: 'system', label: 'System' },
];
```

```tsx
    {props.tab === 'flows' && <Flows client={props.client} navigate={props.navigate} />}
```

Add the styles this needs to `packages/web/src/styles.css` beside the existing
`.libraries-*` rules, reusing `.badge` / `.badge-bad` rather than inventing new colours.

- [ ] **Step 6: Verify**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @trawlarr/web build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/screens/config/flows-tab-model.ts packages/web/src/screens/config/flows-tab-model.test.ts packages/web/src/screens/config/Flows.tsx packages/web/src/screens/config/Config.tsx packages/web/src/styles.css
git commit -m "feat(web): every flow is reachable, including the ones no library uses"
```

---

### Task 10: The canvas editor

**Files:**
- Create: `packages/web/src/screens/flows/FlowEditor.tsx`
- Create: `packages/web/src/screens/flows/FlowNodeCard.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/styles.css`

**Interfaces:**
- Consumes: everything from Tasks 6, 7 and 8; `GET /plugins`, `GET /flows/:id`,
  `POST /flows/validate`, `PUT /flows/:id/draft`, `DELETE /flows/:id/draft`.
- Produces: `<FlowEditor client id navigate />`, mounted for `route.name === 'flowEdit'`.

- [ ] **Step 1: Wire the route**

In `packages/web/src/App.tsx`:

```tsx
        {route.name === 'flowEdit' && (
          <FlowEditor client={props.client} id={route.id} navigate={navigate} />
        )}
```

- [ ] **Step 2: Write the node card**

`FlowNodeCard.tsx` is the `flowNode` type registered with react-flow. Given
`CanvasNodeData` it renders: the plugin's name and the node id, a left `Handle`
(`type="target"`), one right `Handle` per declared output
(`id={handleId(output.number)}`, tooltip as its title), the node's non-default inputs as
`key: value`, and — when present — the `problems`, the `unreachable` marker and the
`unknownPlugin` marker as badges. Border colour comes from `data.borderColor`.

The markers are not decoration:

```tsx
{/* A node no path from the start reaches is drawn and MARKED. The screen
    that exists to make a misplaced node visible must not be the one thing
    that hides it — a node silently absent reads as a node that is not in
    the flow, which is the opposite of the truth. */}
{data.unreachable && <span className="badge badge-bad">not reached from the start</span>}
```

- [ ] **Step 3: Write the editor**

`FlowEditor.tsx` holds ONE piece of authoritative state — `definition: FlowDefinition` —
and derives the canvas from it on every render with `toCanvas`. Every user action calls
a `flow-edit-model` function and sets the new definition. React-flow's own
`onNodesChange` is used only for drag positions (session-local, per Task 7's decision);
`onConnect`, node deletion and edge deletion all route through the model:

```tsx
const onConnect = useCallback(
  (connection: Connection) => {
    setDefinition((current) =>
      connect(current, {
        fromNodeId: connection.source!,
        outputNumber: outputFromHandle(connection.sourceHandle),
        toNodeId: connection.target!,
      }),
    );
  },
  [],
);
```

Behaviour it must have:

- **Continuous validation.** A `useEffect` on `definition` POSTs `/flows/validate`,
  debounced ~300 ms, keeps the problems in state as `ValidationProblem[] | null`, and
  passes them to `toCanvas`. `null` while a request is outstanding — Task 8 depends on
  that distinction.
- **Autosave the draft.** The same debounce PUTs `/flows/:id/draft`. The header shows
  `Saved <time>` / `Saving…` / the failure, and a failure to reach the daemon must read
  differently from an invalid draft — one means the work is not stored, the other means
  it is stored and not publishable.
- **The palette.** `paletteEntries(plugins)` in a sidebar; clicking one calls `addNode`
  with `newNodeId(plugin.id, existingIds)` and the plugin's default inputs. Dropping one
  onto a selected edge calls `insertNodeOnEdge` with
  `plugin.details.outputs[0].number` as `firstOutputNumber`.
- **The inspector.** The selected node's `declaredInputs` rendered from
  `inputUI.type` — `dropdown` as a `<select>` over `inputUI.options`, `switch` as a
  checkbox, everything else as a text field — writing through `setNodeInput`.
- **The start node cannot be deleted.** `data.isStart` disables the delete control and
  says why (`a flow with no start node will not run`).
- **Discard.** `DELETE /flows/:id/draft`, then re-fetch the flow and reset `definition`
  to the published one.
- **Publish** is Task 11.

Import `@xyflow/react/dist/style.css` at the top of this file, and keep every colour
the repo already defines in `styles.css` rather than adopting the library's defaults.

- [ ] **Step 4: Verify**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @trawlarr/web build`
Expected: PASS. There are no new tests here by design — everything this component
decides was tested in Tasks 6–8; if you find yourself wanting a test for logic in this
file, that logic belongs in a model module instead.

- [ ] **Step 5: See it work**

```bash
pnpm build
node packages/server/dist/cli.js daemon --data-dir ./trawlarr-data
```

Open `/config?tab=flows`, edit a flow, move a node onto the other branch of a codec
check, reload the page mid-edit and confirm the draft is still there.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/screens/flows/FlowEditor.tsx packages/web/src/screens/flows/FlowNodeCard.tsx packages/web/src/App.tsx packages/web/src/styles.css
git commit -m "feat(web): edit a flow's wiring on a canvas, saved as a draft that re-queues nothing"
```

---

### Task 11: Publish, with the blast radius stated

**Files:**
- Create: `packages/web/src/screens/flows/PublishDialog.tsx`
- Modify: `packages/web/src/screens/flows/FlowEditor.tsx`
- Modify: `packages/web/src/screens/flows/FlowDetail.tsx`
- Modify: `packages/web/src/styles.css`

**Interfaces:**
- Consumes: `describeDraft`, `publishSummary` (Task 8); `GET /libraries`,
  `GET /libraries/:id/stats`; `PUT /flows/:id` with `{ definition, baseHash, note }`.

- [ ] **Step 1: Build the dialog**

`PublishDialog.tsx` takes the flow, the draft definition and the `PublishSummary`, and
renders exactly three things: the affected libraries with their file counts, the total
that re-queues, and the hash transition — plus `summary.caveat` verbatim. When
`countIsComplete` is false it says which library's count is still unknown rather than
showing a total that is quietly short.

It must not offer an encode estimate, and it must not show a Publish button when
`describeDraft(...).canPublish` is false; the `reason` is shown in its place.

- [ ] **Step 2: Handle the two failures**

```tsx
// 409 `flow-changed`: someone published while this draft was open. The draft
// is NOT discarded — it is the user's work — but publishing it now would
// revert the other edit and re-queue the library to do it.
if (error instanceof ApiClientError && error.code === 'flow-changed') {
  setStale(error.message);
  return;
}
```

Any other failure leaves the draft intact and shows `describeFailure(error)`, the same
way every other write in this UI does.

- [ ] **Step 3: Surface a draft on the read-only flow screen**

In `FlowDetail.tsx`, when `flow.draft !== null`, show a banner above the graph:
`This flow has unpublished changes` with an `Open the editor` link and the draft's
timestamp. The graph below it stays the PUBLISHED definition — that is what is running,
and a screen that quietly drew the draft would misreport what every library is
converging against. Add an `Edit` link beside the existing History link.

- [ ] **Step 4: Verify**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @trawlarr/web build`
Expected: PASS.

- [ ] **Step 5: See it work**

With the daemon running and a library attached to the flow: publish an edit, confirm the
dialog's file count matches that library's total on Watch, and confirm the library
re-queues afterwards (`trawlarr files --state pending` or the Files screen).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/screens/flows/PublishDialog.tsx packages/web/src/screens/flows/FlowEditor.tsx packages/web/src/screens/flows/FlowDetail.tsx packages/web/src/styles.css
git commit -m "feat(web): publishing states the files it re-queues, and refuses a draft whose base moved"
```

---

### Task 12: Say so in the docs

**Files:**
- Modify: `README.md`
- Modify: `docs/engineering-notes/p2-prerequisites.md`
- Modify: `docs/superpowers/specs/2026-08-29-flow-editing-design.md` (status line only)

- [ ] **Step 1: README**

In the web-UI section, add Configure → Flows and the editor: every flow is listed with
the libraries using it, editing is a draft, publishing re-queues. State plainly that
node positions are not saved — the layout is derived from the graph — and why (a stored
position would change the flow's hash and re-queue the library).

- [ ] **Step 2: Engineering note**

Add to `docs/engineering-notes/p2-prerequisites.md` the two divergences from the design
doc, since neither is derivable from the code:

- migration 008 has a third column, `draft_base_hash`, because the design's own
  error-handling section requires staleness detection that its two-column sketch could
  not express;
- the licence widening the design called for was already in
  `scripts/audit-licenses.mjs` (MIT, ISC and BSD-3-Clause, no pinned count), so nothing
  changed there.

- [ ] **Step 3: Mark the design shipped**

Update the design doc's status line to `implemented <date>, see
docs/superpowers/plans/2026-08-31-flow-editing.md`.

- [ ] **Step 4: Verify the whole tree**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm check:refs && pnpm audit:licenses`
Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/
git commit -m "docs: flow editing, and why a node's position is not part of a flow"
```

---

## Self-review against the spec

| Spec section | Where it lands |
| --- | --- |
| Full graph editing, not inputs-only | Tasks 6, 7, 10 |
| `@xyflow/react` | Task 4, 10 |
| Licence allow-list MIT/ISC/BSD-3-Clause | Task 4 — already satisfied, verified not edited |
| Draft, then explicit publish | Tasks 2, 3, 11 |
| Draft stored server-side | Task 2 |
| Publish shows the re-queue count only | Task 8, 11 |
| `/config?tab=flows`, orphan flows visible | Tasks 5, 9 |
| `/flows/:id` unchanged, reachable from the list | Tasks 9, 11 (banner + Edit link only) |
| `/flows/:id/edit` its own route | Tasks 5, 10 |
| Create and delete a flow, warning when in use | Task 9 |
| Migration 008 | Task 2 (three columns — deviation stated) |
| `PUT`/`DELETE /flows/:id/draft`, `GET` gains draft fields | Task 3 |
| Publish through the existing `PUT /flows/:id` | Task 3, 11 |
| Canvas driven by `GET /plugins` metadata | Task 7, 10 |
| Continuous validation, errors on the node | Tasks 1, 7, 10 |
| A node reached twice drawn once; unreachable nodes marked | Task 7 |
| Draft saved but not publishable when invalid | Tasks 3, 8, 11 |
| Failed publish leaves the draft | Task 11 |
| Empty / loading / error never render alike | Tasks 8, 9, 10, 11 |
| Stale draft refused | Tasks 3, 8, 11 |
| Testing: pure models, canvas untested | Tasks 6, 7, 8, 9; stated in 10 and 11 |
| Out of scope: onboarding, plugin trust, inputs-from-library | Not planned |
