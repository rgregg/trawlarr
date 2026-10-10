# Targeted Scans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A changed file is examined on its own — fed by the file watcher and by a Sonarr/Radarr/Lidarr webhook — instead of every trigger walking the whole library.

**Architecture:** `scanLibrary` gains an optional `scope` (files or folders). A scoped scan iterates a scoped walk instead of the library roots and runs the unchanged per-file loop; marking files missing is restricted to rows at or under the scope. The scan coordinator carries paths alongside reasons, accumulating them into one scan per library. Two feeders supply paths: the watcher's own events, and two API endpoints.

**Tech Stack:** TypeScript (strict), Node 22, better-sqlite3, chokidar, vitest, React + Vite for the one UI section.

**Spec:** `docs/superpowers/specs/2026-10-10-targeted-scan-design.md` — read it first; section numbers below (§) refer to it.

## Global Constraints

- Node 22 only. In every shell: `export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"` (`nvm` is not available in agent shells).
- **Never run the bare `pnpm test` locally** — it exhausts memory on the dev machine. Run the test files named in each task. CI runs the full suite.
- `pnpm typecheck` needs a prior `pnpm build`; run both before the final commit of any task that changes an exported type.
- `@trawlarr/core` performs no I/O and reads no clock. Nothing in this plan adds code to core.
- No third-party fixture files and no copied \*arr or Tdarr source. Webhook payloads in tests are written by hand.
- With `scope` absent, a scan must behave exactly as it does today (§2).
- The per-file loop in `scanLibrary` (`observeFile` → in-flight guard → `upsertScanned` → probe) is not moved, copied or extracted (§2.2).
- Nothing is marked missing under a root that cannot be shown to be present (§2.3).
- `SCOPED_PATH_LIMIT = 200`, a constant, not a setting (§3 rule 5).
- UI copy is terse: short labels, no explanatory paragraph.
- Commit messages: `type(scope): a lowercase sentence saying what changed and why it matters`, ending with the `Co-Authored-By` trailer the session specifies.
- Comments explain why, citing what breaks without the guard.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task that owns the code.

1. **A scope path that is relative, has `..` segments or a trailing slash.** Expected: relative and `..` are refused; a trailing slash is normalised away. (Task 2)
2. **The same file reported twice — once by name, once through its folder.** Expected: observed and probed once. (Task 1)
3. **A sibling folder whose name merely starts with the scope folder's name** (`/lib/Show` against `/lib/Show 2`). Expected: its rows are never candidates for missing. (Task 3)
4. **A notified folder that no longer exists while the share is unmounted.** Expected: nothing is marked missing. (Task 4)
5. **A webhook body that is not an object, or whose folder is not an absolute POSIX path** (a Windows \*arr sends `C:\...`). Expected: a 4xx naming the problem, never a 500 and never a scan. (Task 7)

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/src/fs/walk.ts` (modify) | Accept `pruneRoots`, so a walk started below a root still prunes by the library's roots |
| `packages/server/src/scanner/scoped-walk.ts` (create) | Yield the media files named by a scope: files directly, folders by walking |
| `packages/server/src/scanner/scope.ts` (create) | Validate and normalise scope paths against one library |
| `packages/server/src/db/media-file-repo.ts` (modify) | `listUnderPaths`: rows at or under given paths |
| `packages/server/src/scanner/reconcile.ts` (modify) | Restrict missing-candidates to a scope |
| `packages/server/src/scanner/scan-library.ts` (modify) | The `scope` input, wiring the three above, `scopedPaths` in the summary |
| `packages/server/src/daemon/scan-coordinator.ts` (modify) | Paths on `request`, accumulation, overflow, watcher wiring |
| `packages/server/src/api/routes/libraries.ts` (modify) | `paths` on `POST /libraries/:id/scan` |
| `packages/server/src/db/settings-repo.ts` (modify) | `scan.notifyPathMap` |
| `packages/server/src/notify/arr-payload.ts` (create) | Read the folder out of an \*arr webhook body. Pure |
| `packages/server/src/api/routes/notify.ts` (create) | `POST /notify/arr` |
| `packages/web/src/screens/config/notification-paths-model.ts` (create) | Rows ↔ setting payload for the UI. Pure |
| `packages/web/src/screens/config/NotificationPaths.tsx` (create) | The "Notification paths" section of Config → System |

---

### Task 1: The scoped walk

**Files:**
- Modify: `packages/server/src/fs/walk.ts`
- Create: `packages/server/src/scanner/scoped-walk.ts`
- Test: `packages/server/src/scanner/scoped-walk.test.ts`

**Interfaces:**
- Consumes: `walkFiles`, `createSubtreeMatcher`, `isWorkingFileName` (all existing).
- Produces:
  - `walkFiles` input gains `pruneRoots?: readonly string[]`.
  - `walkScope(input: { scope: readonly string[]; libraryRoots: readonly string[]; extensions: readonly string[]; exclude: readonly string[]; openDir?: (path: string) => Promise<AsyncIterable<Dirent>> }): AsyncGenerator<{ path: string; stat: Stats }>`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/scanner/scoped-walk.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkScope } from './scoped-walk.js';

let base: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-scoped-walk-'));
  root = join(base, 'library');
  mkdirSync(join(root, 'Film A'), { recursive: true });
  mkdirSync(join(root, 'Film B', 'extras'), { recursive: true });
  mkdirSync(join(root, '.trawlarr', 'trash'), { recursive: true });
  writeFileSync(join(root, 'Film A', 'a.mkv'), 'a');
  writeFileSync(join(root, 'Film A', 'a.nfo'), 'a');
  writeFileSync(join(root, 'Film B', 'b.mkv'), 'b');
  writeFileSync(join(root, 'Film B', 'extras', 'b-extra.mkv'), 'b');
  writeFileSync(join(root, '.trawlarr', 'trash', 'deleted.mkv'), 'x');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const collect = async (scope: string[], libraryRoots: string[] = [root]): Promise<string[]> => {
  const found: string[] = [];
  for await (const entry of walkScope({
    scope,
    libraryRoots,
    extensions: ['mkv'],
    exclude: [join(root, '.trawlarr')],
  })) {
    found.push(entry.path);
  }
  return found.sort();
};

describe('walkScope', () => {
  it('yields a file named directly, without reading any directory', async () => {
    expect(await collect([join(root, 'Film A', 'a.mkv')])).toEqual([join(root, 'Film A', 'a.mkv')]);
  });

  it('walks a folder, and only that folder', async () => {
    expect(await collect([join(root, 'Film B')])).toEqual([
      join(root, 'Film B', 'b.mkv'),
      join(root, 'Film B', 'extras', 'b-extra.mkv'),
    ]);
  });

  it('yields nothing for a path that does not exist', async () => {
    expect(await collect([join(root, 'Film C', 'gone.mkv'), join(root, 'Film C')])).toEqual([]);
  });

  it('skips a file whose extension the library does not want', async () => {
    expect(await collect([join(root, 'Film A', 'a.nfo')])).toEqual([]);
  });

  it("never yields trawlarr's own scratch, even when it is named directly", async () => {
    const scratch = join(root, 'Film A', '.trawlarr-replace-1234.mkv');
    writeFileSync(scratch, 'x');
    expect(await collect([scratch])).toEqual([]);
  });

  it('never yields a symlink named directly, as the full walk never does', async () => {
    const link = join(root, 'Film A', 'link.mkv');
    symlinkSync(join(root, 'Film B', 'b.mkv'), link);
    expect(await collect([link])).toEqual([]);
  });

  // Review Focus 2: a watcher burst reports a new folder AND the file in it.
  it('yields a file once when it is named and its folder is too', async () => {
    expect(await collect([join(root, 'Film A', 'a.mkv'), join(root, 'Film A')])).toEqual([
      join(root, 'Film A', 'a.mkv'),
    ]);
  });

  it('prunes a reserved directory inside a scoped folder', async () => {
    expect(await collect([root])).toEqual([
      join(root, 'Film A', 'a.mkv'),
      join(root, 'Film B', 'b.mkv'),
      join(root, 'Film B', 'extras', 'b-extra.mkv'),
    ]);
  });

  // The reason the feature exists (spec §7): what a scoped scan reads must
  // depend on the scope, not on how big the library around it is.
  it('opens the same directories however many other folders the library has', async () => {
    const opened = async (others: number): Promise<number> => {
      for (let index = 0; index < others; index += 1) {
        mkdirSync(join(root, `Other ${String(index)}`), { recursive: true });
        writeFileSync(join(root, `Other ${String(index)}`, 'x.mkv'), 'x');
      }
      let count = 0;
      for await (const entry of walkScope({
        scope: [join(root, 'Film B')],
        libraryRoots: [root],
        extensions: ['mkv'],
        exclude: [join(root, '.trawlarr')],
        openDir: async (path) => {
          count += 1;
          return await opendir(path);
        },
      })) {
        void entry;
      }
      return count;
    };

    const small = await opened(2);
    const large = await opened(40);

    expect(small).toBe(2); // Film B and Film B/extras.
    expect(large).toBe(small);
  });

  // The reserved directory is configured by its real path while the library
  // root — and so every scope path — is spelled through a symlink alias.
  // Pruning judged against the scope folder alone would not see the alias.
  it('prunes by the library roots, so an aliased root still hides its reserved directory', async () => {
    const alias = join(base, 'alias');
    symlinkSync(root, alias);
    mkdirSync(join(root, 'Film B', 'staging'));
    writeFileSync(join(root, 'Film B', 'staging', 'part.mkv'), 'x');

    const found: string[] = [];
    for await (const entry of walkScope({
      scope: [join(alias, 'Film B')],
      libraryRoots: [alias],
      extensions: ['mkv'],
      exclude: [join(root, 'Film B', 'staging')],
    })) {
      found.push(entry.path);
    }

    expect(found.sort()).toEqual([
      join(alias, 'Film B', 'b.mkv'),
      join(alias, 'Film B', 'extras', 'b-extra.mkv'),
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- packages/server/src/scanner/scoped-walk.test.ts`
Expected: FAIL — cannot resolve `./scoped-walk.js`.

- [ ] **Step 3: Add `pruneRoots` to `walkFiles`**

In `packages/server/src/fs/walk.ts`, add to the input type, after `exclude`:

```ts
  /**
   * The roots `exclude` is judged against, when the walk starts BELOW them.
   * A scoped scan walks one folder of a library; its reserved directories are
   * still configured relative to the library's roots, and a root reached
   * through a symlink alias is only recognised from the root's own spelling.
   * Defaults to `roots`.
   */
  pruneRoots?: readonly string[];
```

and change the matcher construction to:

```ts
  const isExcluded = createSubtreeMatcher({
    roots: input.pruneRoots ?? input.roots,
    subtrees: input.exclude ?? [],
  });
```

- [ ] **Step 4: Write `walkScope`**

Create `packages/server/src/scanner/scoped-walk.ts`:

```ts
import { lstat } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { basename, extname } from 'node:path';
import { isWorkingFileName } from '@trawlarr/core';
import { walkFiles } from '../fs/walk.js';

/**
 * Yield the media files a scoped scan is about: each scope path that is a
 * file, and every file under each scope path that is a folder.
 *
 * It applies exactly the rules `walkFiles` applies to a whole library — the
 * extension filter, the refusal of trawlarr's own scratch by name, regular
 * files only, reserved directories pruned — because a file must not become
 * library media by being reported when it would not have by being found.
 *
 * A scope path that does not exist yields nothing and is not an error: a
 * deletion is reported by the path that is now gone, and what that means is
 * the missing pass's question, not the walk's.
 *
 * A file is yielded at most once however many scope paths cover it: a watcher
 * burst for a new folder names the folder and the files in it.
 */
export async function* walkScope(input: {
  scope: readonly string[];
  libraryRoots: readonly string[];
  extensions: readonly string[];
  exclude: readonly string[];
  /** Seam, passed to `walkFiles`: a test counts the directories opened. */
  openDir?: (path: string) => Promise<AsyncIterable<Dirent>>;
}): AsyncGenerator<{ path: string; stat: Stats }> {
  const wanted = new Set(input.extensions.map((extension) => extension.toLowerCase()));
  if (wanted.size === 0) return;
  const yielded = new Set<string>();

  for (const target of input.scope) {
    let stats: Stats;
    try {
      stats = await lstat(target);
    } catch {
      continue; // Gone, or unreadable: nothing here to observe.
    }

    if (stats.isDirectory()) {
      for await (const entry of walkFiles({
        roots: [target],
        pruneRoots: input.libraryRoots,
        extensions: input.extensions,
        exclude: input.exclude,
        openDir: input.openDir,
      })) {
        if (yielded.has(entry.path)) continue;
        yielded.add(entry.path);
        yield entry;
      }
      continue;
    }

    // `lstat`, so a symlink is not a file here — as it is not to `walkFiles`,
    // which asks the directory entry and never follows one.
    if (!stats.isFile()) continue;
    if (isWorkingFileName(basename(target))) continue;
    if (!wanted.has(extname(target).slice(1).toLowerCase())) continue;
    if (yielded.has(target)) continue;
    yielded.add(target);
    yield { path: target, stat: stats };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- packages/server/src/scanner/scoped-walk.test.ts packages/server/src/fs`
Expected: PASS, including the existing `walk.test.ts` and `walk-blocking.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/fs/walk.ts packages/server/src/scanner/scoped-walk.ts packages/server/src/scanner/scoped-walk.test.ts
git commit -m "feat(server): walk only the files and folders a scan is scoped to, under the same rules as a full walk"
```

---

### Task 2: Scope validation

**Files:**
- Create: `packages/server/src/scanner/scope.ts`
- Test: `packages/server/src/scanner/scope.test.ts`

**Interfaces:**
- Consumes: `createSubtreeMatcher` (`../fs/path-contains.js`), `reservedDirsForLibrary` (`../library/paths.js`), `LibraryRecord` (`../db/library-repo.js`).
- Produces:
  - `class ScopeError extends Error { readonly path: string }`
  - `validateScope(input: { library: LibraryRecord; paths: readonly string[] }): string[]` — normalised, de-duplicated; throws `ScopeError` for the first path that is not acceptable.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/scanner/scope.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { ScopeError, validateScope } from './scope.js';

let base: string;
let root: string;
let db: Db;
let library: LibraryRecord;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-scope-'));
  root = join(base, 'library');
  mkdirSync(join(root, '.trawlarr', 'trash'), { recursive: true });
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  library = createLibraryRepo(db).create({ name: 'Movies', roots: [root], nowMs: 0 });
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('validateScope', () => {
  it('accepts a file and a folder inside a root, and the root itself', () => {
    const paths = [join(root, 'Film', 'film.mkv'), join(root, 'Film'), root];
    expect(validateScope({ library, paths })).toEqual(paths);
  });

  it('accepts a path that does not exist: a deletion is reported by what is gone', () => {
    const gone = join(root, 'Deleted Film', 'gone.mkv');
    expect(validateScope({ library, paths: [gone] })).toEqual([gone]);
  });

  // Review Focus 1.
  it('normalises a trailing slash and collapses duplicates', () => {
    expect(validateScope({ library, paths: [`${join(root, 'Film')}/`, join(root, 'Film')] })).toEqual([
      join(root, 'Film'),
    ]);
  });

  it('refuses a relative path', () => {
    expect(() => validateScope({ library, paths: ['Film/film.mkv'] })).toThrow(ScopeError);
  });

  it('refuses a path with ".." segments, wherever it would land', () => {
    expect(() => validateScope({ library, paths: [`${root}/Film/../Film/film.mkv`] })).toThrow(
      ScopeError,
    );
  });

  it('refuses a path outside every root, naming it', () => {
    const outside = join(base, 'elsewhere', 'x.mkv');
    expect(() => validateScope({ library, paths: [join(root, 'ok.mkv'), outside] })).toThrow(
      expect.objectContaining({ path: outside }),
    );
  });

  it('refuses a sibling of the root that shares its name as a prefix', () => {
    expect(() => validateScope({ library, paths: [`${root}-old/x.mkv`] })).toThrow(ScopeError);
  });

  it('refuses a path inside a reserved directory', () => {
    expect(() =>
      validateScope({ library, paths: [join(root, '.trawlarr', 'trash', 'deleted.mkv')] }),
    ).toThrow(ScopeError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- packages/server/src/scanner/scope.test.ts`
Expected: FAIL — cannot resolve `./scope.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/scanner/scope.ts`:

```ts
import { isAbsolute, resolve } from 'node:path';
import type { LibraryRecord } from '../db/library-repo.js';
import { createSubtreeMatcher } from '../fs/path-contains.js';
import { reservedDirsForLibrary } from '../library/paths.js';

/** A scope path a scan of this library must not be given. */
export class ScopeError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ScopeError';
    this.path = path;
  }
}

/**
 * The scope paths of one scan, normalised and checked against its library.
 *
 * A scoped scan stats, probes and may mark rows missing under whatever it is
 * handed, and the paths arrive from outside: a webhook, an API caller. So a
 * path is refused unless it is absolute, free of `..`, inside one of the
 * library's roots, and outside its reserved directories — the same boundary
 * the full walk never crosses, stated up front instead of discovered by it.
 *
 * Existence is NOT required. A deleted file is reported by the path that is
 * now gone.
 *
 * All-or-nothing: the first unacceptable path throws, naming it. Quietly
 * dropping one would have the caller believe it had been scanned.
 */
export const validateScope = (input: {
  library: LibraryRecord;
  paths: readonly string[];
}): string[] => {
  const { library } = input;
  const inRoots = createSubtreeMatcher({ roots: library.roots, subtrees: library.roots });
  const inReserved = createSubtreeMatcher({
    roots: library.roots,
    subtrees: reservedDirsForLibrary(library),
  });

  const accepted = new Set<string>();
  for (const path of input.paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new ScopeError(String(path), `"${String(path)}" is not an absolute path.`);
    }
    if (path.split('/').includes('..')) {
      throw new ScopeError(path, `"${path}" contains a ".." segment.`);
    }
    const normalised = resolve(path);
    if (!inRoots(normalised)) {
      throw new ScopeError(
        path,
        `"${path}" is not inside any root of library "${library.name}" (roots: ` +
          `${library.roots.join(', ')}).`,
      );
    }
    if (inReserved(normalised)) {
      throw new ScopeError(
        path,
        `"${path}" is inside a directory trawlarr reserves for its own staging and trash, ` +
          `which is never scanned.`,
      );
    }
    accepted.add(normalised);
  }
  return [...accepted];
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- packages/server/src/scanner/scope.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scanner/scope.ts packages/server/src/scanner/scope.test.ts
git commit -m "feat(server): refuse a scan scope outside the library's roots or inside its reserved directories"
```

---

### Task 3: Marking files missing within a scope

**Files:**
- Modify: `packages/server/src/db/media-file-repo.ts` (interface near line 251, implementation near line 825)
- Modify: `packages/server/src/scanner/reconcile.ts`
- Test: `packages/server/src/scanner/reconcile-scoped.test.ts`

**Interfaces:**
- Produces:
  - `MediaFileRepo.listUnderPaths(input: { libraryId: string; paths: readonly string[] }): MediaFileRow[]`
  - `ReconcileInput.scope?: readonly string[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/scanner/reconcile-scoped.test.ts`. Rows are created through a real scan so they carry real identities; the probe is faked through the scanner's existing seam.

```ts
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo, type LibraryRecord } from '../db/library-repo.js';
import { createMediaFileRepo, type MediaFileRepo } from '../db/media-file-repo.js';
import { FAKE_PROBE_DOCUMENT } from '../../test/helpers/fake-ffprobe.js';
import { reconcileMissing } from './reconcile.js';
import { scanLibrary } from './scan-library.js';

const fixedProbe = (path: string): ProbeData =>
  ({ ...FAKE_PROBE_DOCUMENT, format: { ...FAKE_PROBE_DOCUMENT.format, filename: path } }) as ProbeData;

let base: string;
let root: string;
let db: Db;
let library: LibraryRecord;
let repo: MediaFileRepo;

const missingPaths = (): string[] =>
  repo
    .listByLibrary({ libraryId: library.id })
    .filter((row) => row.missing_since_ms !== null)
    .map((row) => row.path)
    .sort();

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-reconcile-scoped-'));
  root = join(base, 'library');
  mkdirSync(join(root, 'Show'), { recursive: true });
  mkdirSync(join(root, 'Show 2'), { recursive: true });
  writeFileSync(join(root, 'Show', 'e1.mkv'), 'show e1');
  writeFileSync(join(root, 'Show', 'e2.mkv'), 'show e2');
  writeFileSync(join(root, 'Show 2', 'e1.mkv'), 'show two e1');
  writeFileSync(join(root, 'film.mkv'), 'film');
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  library = createLibraryRepo(db).create({
    name: 'Shows',
    roots: [root],
    extensions: ['mkv'],
    nowMs: 0,
  });
  repo = createMediaFileRepo(db);
  await scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: 'unused',
    nowMs: () => 0,
    probeFileImpl: async (input) => fixedProbe(input.path),
  });
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('listUnderPaths', () => {
  it('returns the row at a path and the rows under a folder', () => {
    const rows = repo.listUnderPaths({
      libraryId: library.id,
      paths: [join(root, 'Show'), join(root, 'film.mkv')],
    });
    expect(rows.map((row) => row.path).sort()).toEqual([
      join(root, 'Show', 'e1.mkv'),
      join(root, 'Show', 'e2.mkv'),
      join(root, 'film.mkv'),
    ]);
  });

  // Review Focus 3.
  it('does not return a sibling folder whose name starts with the scope folder name', () => {
    const rows = repo.listUnderPaths({ libraryId: library.id, paths: [join(root, 'Show')] });
    expect(rows.some((row) => row.path.startsWith(join(root, 'Show 2')))).toBe(false);
  });

  it('returns a row once when two scope paths cover it', () => {
    const rows = repo.listUnderPaths({
      libraryId: library.id,
      paths: [join(root, 'Show'), join(root, 'Show', 'e1.mkv')],
    });
    expect(rows.filter((row) => row.path === join(root, 'Show', 'e1.mkv'))).toHaveLength(1);
  });
});

describe('reconcileMissing with a scope', () => {
  it('marks a deleted file missing when its path is in scope', async () => {
    unlinkSync(join(root, 'Show', 'e1.mkv'));

    const summary = await reconcileMissing({
      library,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
      scope: [join(root, 'Show', 'e1.mkv')],
    });

    expect(summary.missing).toBe(1);
    expect(missingPaths()).toEqual([join(root, 'Show', 'e1.mkv')]);
  });

  // The whole point of the restriction: a scoped scan saw almost nothing, and
  // "not seen" must not mean "gone" for the rest of the library.
  it('never marks a row outside the scope, even though this scan did not see it', async () => {
    unlinkSync(join(root, 'film.mkv'));

    const summary = await reconcileMissing({
      library,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
      scope: [join(root, 'Show')],
    });

    expect(summary.missing).toBe(0);
    expect(missingPaths()).toEqual([]);
  });

  it('marks every row under a deleted folder that is in scope', async () => {
    rmSync(join(root, 'Show'), { recursive: true });

    await reconcileMissing({
      library,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
      scope: [join(root, 'Show')],
    });

    expect(missingPaths()).toEqual([join(root, 'Show', 'e1.mkv'), join(root, 'Show', 'e2.mkv')]);
  });

  it('leaves a row that is in scope and still on disk alone', async () => {
    const summary = await reconcileMissing({
      library,
      mediaFileRepo: repo,
      seenFileIds: new Set(),
      nowMs: 5,
      scope: [join(root, 'Show')],
    });
    expect(summary.missing).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- packages/server/src/scanner/reconcile-scoped.test.ts`
Expected: FAIL — `repo.listUnderPaths is not a function`.

- [ ] **Step 3: Add `listUnderPaths` to the repo**

In `packages/server/src/db/media-file-repo.ts`, add to the `MediaFileRepo` interface directly after `listByLibrary`:

```ts
  /**
   * Rows whose recorded path IS one of `paths` or lies under one — what a
   * scoped scan is entitled to ask about, and nothing else.
   *
   * Compared by exact prefix plus a separator, never `LIKE`: a path is full
   * of `%` and `_`, and `/lib/Show` must not match `/lib/Show 2/...`.
   */
  listUnderPaths(input: { libraryId: string; paths: readonly string[] }): MediaFileRow[];
```

and to the implementation object directly after `listByLibrary(input) { ... },`:

```ts
    listUnderPaths(input) {
      const statement = db.prepare(
        `SELECT * FROM media_file
          WHERE library_id = ? AND (path = ? OR substr(path, 1, ?) = ?)`,
      );
      const rows = new Map<string, MediaFileRow>();
      for (const path of input.paths) {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        for (const row of statement.all(
          input.libraryId,
          path,
          prefix.length,
          prefix,
        ) as MediaFileRow[]) {
          rows.set(row.id, row);
        }
      }
      return [...rows.values()];
    },
```

- [ ] **Step 4: Add `scope` to `reconcileMissing`**

In `packages/server/src/scanner/reconcile.ts`, add to `ReconcileInput` after `seenFileIds`:

```ts
  /**
   * Restrict the pass to rows at or under these paths. A scoped scan walked
   * a handful of files, so "this scan did not see the row" says nothing
   * about any row outside what it walked; without this a scoped scan would
   * stat every row of the library, and a mistake in it could mark them.
   * Absent for a full scan, whose completed walk speaks for the whole library.
   */
  scope?: readonly string[];
```

and replace the start of the `candidates` expression:

```ts
  const considered: MediaFileRow[] =
    input.scope === undefined
      ? input.mediaFileRepo.listByLibrary({ libraryId: input.library.id })
      : input.mediaFileRepo.listUnderPaths({ libraryId: input.library.id, paths: input.scope });

  const candidates: MediaFileRow[] = considered.filter(
    (row) =>
      row.missing_since_ms === null &&
      row.state !== 'running' &&
      !input.seenFileIds.has(row.id) &&
      availableRoots.some((root) => pathContains(root, row.path)),
  );
```

Leave everything after it — the `lstat`, the `ENOENT`-only rule, `markMissing` — untouched.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- packages/server/src/scanner/reconcile-scoped.test.ts packages/server/src/scanner`
Expected: PASS, including every existing scanner test.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/media-file-repo.ts packages/server/src/scanner/reconcile.ts packages/server/src/scanner/reconcile-scoped.test.ts
git commit -m "feat(server): let the missing pass consider only rows at or under a scan's scope"
```

---

### Task 4: `scanLibrary` takes a scope

**Files:**
- Modify: `packages/server/src/scanner/scan-library.ts`
- Modify: `packages/server/src/daemon/scan-coordinator.test.ts` (the `summaryOf` literal only)
- Test: `packages/server/src/scanner/scan-library-scoped.test.ts`

**Interfaces:**
- Consumes: `walkScope` (Task 1), `validateScope` / `ScopeError` (Task 2), `ReconcileInput.scope` (Task 3).
- Produces:
  - `ScanLibraryInput.scope?: readonly string[]`
  - `ScanSummary.scopedPaths: number | null`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/scanner/scan-library-scoped.test.ts`:

```ts
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo, type MediaFileRow } from '../db/media-file-repo.js';
import { FAKE_PROBE_DOCUMENT } from '../../test/helpers/fake-ffprobe.js';
import { scanLibrary, type ScanSummary } from './scan-library.js';
import { ScopeError } from './scope.js';

const fixedProbe = (path: string): ProbeData =>
  ({ ...FAKE_PROBE_DOCUMENT, format: { ...FAKE_PROBE_DOCUMENT.format, filename: path } }) as ProbeData;

let base: string;
let root: string;
let db: Db;
let libraryId: string;
let probed: string[];

const scan = (scope?: string[]): Promise<ScanSummary> =>
  scanLibrary({
    db,
    libraryId,
    ffprobePath: 'unused',
    nowMs: () => 1_000,
    scope,
    probeFileImpl: async (input) => {
      probed.push(input.path);
      return fixedProbe(input.path);
    },
  });

const rows = (): MediaFileRow[] => createMediaFileRepo(db).listByLibrary({ libraryId });
const present = (): string[] =>
  rows()
    .filter((row) => row.missing_since_ms === null)
    .map((row) => row.path)
    .sort();
const missing = (): string[] =>
  rows()
    .filter((row) => row.missing_since_ms !== null)
    .map((row) => row.path)
    .sort();

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-scan-scoped-'));
  root = join(base, 'library');
  mkdirSync(join(root, 'Film A'), { recursive: true });
  mkdirSync(join(root, 'Film B'), { recursive: true });
  writeFileSync(join(root, 'Film A', 'a.mkv'), 'film a, the original');
  writeFileSync(join(root, 'Film B', 'b.mkv'), 'film b, the original');
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  libraryId = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv'],
    nowMs: 0,
  }).id;
  probed = [];
  await scan();
  probed = [];
});

afterEach(() => {
  chmodSync(root, 0o755);
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('scanLibrary with a scope', () => {
  it('adds a new file named in scope, and probes nothing else', async () => {
    mkdirSync(join(root, 'Film C'));
    const added = join(root, 'Film C', 'c.mkv');
    writeFileSync(added, 'film c');

    const summary = await scan([added]);

    expect(summary.added).toBe(1);
    expect(summary.seen).toBe(1);
    expect(summary.scopedPaths).toBe(1);
    expect(probed).toEqual([added]);
    expect(present()).toContain(added);
  });

  it('adds every new file under a folder named in scope', async () => {
    mkdirSync(join(root, 'Show', 'Season 1'), { recursive: true });
    writeFileSync(join(root, 'Show', 'Season 1', 'e1.mkv'), 'e1');
    writeFileSync(join(root, 'Show', 'Season 1', 'e2.mkv'), 'e2');

    const summary = await scan([join(root, 'Show')]);

    expect(summary.added).toBe(2);
  });

  // A rename keeps the inode. The new path is observed first, the identity
  // matches the existing row, and the row follows the file — so nothing is
  // left at the old path for the missing pass to find.
  it('follows a renamed file to its new path, keeping one row', async () => {
    const before = rows().find((row) => row.path === join(root, 'Film A', 'a.mkv'))!;
    const renamed = join(root, 'Film A', 'a (2001).mkv');
    renameSync(join(root, 'Film A', 'a.mkv'), renamed);

    const summary = await scan([join(root, 'Film A', 'a.mkv'), renamed]);

    expect(summary.missing).toBe(0);
    expect(summary.added).toBe(0);
    expect(rows().find((row) => row.id === before.id)!.path).toBe(renamed);
    expect(missing()).toEqual([]);
  });

  it('handles an upgrade: the new file gets a row and the deleted one is marked missing', async () => {
    const old = join(root, 'Film A', 'a.mkv');
    const upgraded = join(root, 'Film A', 'a WEBDL.mkv');
    unlinkSync(old);
    writeFileSync(upgraded, 'film a, a better release with different bytes');

    const summary = await scan([join(root, 'Film A')]);

    expect(summary.added).toBe(1);
    expect(summary.missing).toBe(1);
    expect(missing()).toEqual([old]);
    expect(present()).toContain(upgraded);
  });

  it('marks a deleted folder in scope missing, and nothing outside it', async () => {
    rmSync(join(root, 'Film A'), { recursive: true });
    unlinkSync(join(root, 'Film B', 'b.mkv'));

    const summary = await scan([join(root, 'Film A')]);

    expect(summary.missing).toBe(1);
    expect(missing()).toEqual([join(root, 'Film A', 'a.mkv')]);
  });

  // Review Focus 4. A root that cannot be read is what an unmounted share
  // looks like, and a delete notification for a folder under it must not be
  // taken at its word.
  it('marks nothing missing when the root cannot be shown to be present', async () => {
    chmodSync(root, 0o000);

    const summary = await scan([join(root, 'Film A')]);

    expect(summary.missing).toBe(0);
    expect(summary.rootsUnavailable).toBe(1);
    chmodSync(root, 0o755);
    expect(missing()).toEqual([]);
  });

  it('does not sweep orphaned working files', async () => {
    const orphan = join(root, 'Film A', '.trawlarr-replace-0000.mkv');
    writeFileSync(orphan, 'left by a dead worker');

    const summary = await scan([join(root, 'Film A')]);

    expect(summary.workingFilesRemoved).toBe(0);
  });

  it('refuses a scope outside the library, and scans nothing', async () => {
    await expect(scan([join(base, 'elsewhere', 'x.mkv')])).rejects.toBeInstanceOf(ScopeError);
    expect(probed).toEqual([]);
  });

  it('reports scopedPaths as null for a full scan', async () => {
    expect((await scan()).scopedPaths).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- packages/server/src/scanner/scan-library-scoped.test.ts`
Expected: FAIL — the scoped cases report `seen: 2` (a full walk ran) and `scopedPaths` is `undefined`.

- [ ] **Step 3: Add the input and the summary field**

In `packages/server/src/scanner/scan-library.ts`:

Add the imports:

```ts
import { walkScope } from './scoped-walk.js';
import { validateScope } from './scope.js';
```

Add to `ScanSummary`, after `workingFilesRemoved`:

```ts
  /**
   * How many paths this scan was scoped to, or `null` for a scan of the whole
   * library. A scoped scan's other counters describe only what it walked.
   */
  scopedPaths: number | null;
```

Add to `ScanLibraryInput`, after `libraryId`:

```ts
  /**
   * Absolute paths inside this library's roots, files or folders: scan only
   * these. Absent means the whole library.
   *
   * Everything a scan does PER FILE is identical either way. What a scope
   * changes is which files the loop is handed, which rows the missing pass
   * may consider, and that the working-file sweep is left to full scans.
   */
  scope?: readonly string[];
```

- [ ] **Step 4: Resolve the scope and switch the iteration**

Find the line where the function has loaded `library` (the `LibraryRecord` for `libraryId`). Directly after it, add:

```ts
  // Checked before anything is walked or written, and all-or-nothing: see
  // `validateScope`. `null` is a scan of the whole library.
  const scope = input.scope === undefined ? null : validateScope({ library, paths: input.scope });
```

Add `scopedPaths: scope === null ? null : scope.length,` to the `summary` literal (near line 308), after `workingFilesRemoved: 0,`. If `summary` is declared before `library` is loaded, move the `scope` line above it rather than reordering `summary`.

Replace the head of the walk loop:

```ts
  const workingFiles: string[] = [];
  const files =
    scope === null
      ? walkFiles({
          roots: library.roots,
          extensions: library.extensions,
          exclude: reservedDirsForLibrary(library),
          onWorkingFile: (path) => workingFiles.push(path),
        })
      : walkScope({
          scope,
          libraryRoots: library.roots,
          extensions: library.extensions,
          exclude: reservedDirsForLibrary(library),
        });
  for await (const entry of files) {
```

The loop body is not touched.

- [ ] **Step 5: Scope the missing pass and skip the sweep**

Change the `reconcileMissing` call to pass the scope:

```ts
  const reconciled = await reconcileMissing({
    library,
    mediaFileRepo,
    seenFileIds,
    nowMs: nowMs(),
    allowEmptyRoots: input.allowEmptyRoots,
    scope: scope ?? undefined,
  });
```

Change the sweep's condition, extending its comment:

```ts
  // ... A failure here costs one pass of tidying, never the scan that
  // already succeeded. Full scans only: a scoped scan collected no working
  // files to judge, and the sweep is hourly tidying, not something a single
  // imported file needs done.
  if (scope === null && reconciled.rootsUnavailable === 0) {
```

- [ ] **Step 6: Fix the one other summary literal**

In `packages/server/src/daemon/scan-coordinator.test.ts`, add `scopedPaths: null,` to `summaryOf`, after `workingFilesRemoved: 0,`.

- [ ] **Step 7: Run the tests and the type-check**

Run:
```bash
pnpm test -- packages/server/src/scanner packages/server/src/daemon/scan-coordinator.test.ts
pnpm build && pnpm typecheck
```
Expected: PASS; typecheck exits 0. If typecheck reports another `ScanSummary` literal missing `scopedPaths`, add `scopedPaths: null` to it.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/scanner/scan-library.ts packages/server/src/scanner/scan-library-scoped.test.ts packages/server/src/daemon/scan-coordinator.test.ts
git commit -m "feat(server): scan only the paths a scan is scoped to, leaving every per-file rule as it was"
```

---

### Task 5: The coordinator carries paths

**Files:**
- Modify: `packages/server/src/daemon/scan-coordinator.ts`
- Modify: `packages/server/src/daemon/scan-coordinator.test.ts`

**Interfaces:**
- Consumes: `ScanLibraryInput.scope` (Task 4).
- Produces:
  - `export type ScanReason = 'manual' | 'watch' | 'interval' | 'startup' | 'notify'`
  - `export const SCOPED_PATH_LIMIT = 200`
  - `ScanCoordinator.request(libraryId: string, reason: ScanReason, paths?: readonly string[]): void`

- [ ] **Step 1: Extend the test harness**

In `packages/server/src/daemon/scan-coordinator.test.ts`:

Change `ScanCall` to record the scope:

```ts
interface ScanCall {
  libraryId: string;
  reason: ScanReason;
  /** `null` for a scan of the whole library. */
  scope: string[] | null;
}
```

and the fake `scanFn`'s first line to:

```ts
    scans.push({
      libraryId: input.libraryId,
      reason: input.reason,
      scope: input.scope === undefined ? null : [...input.scope].sort(),
    });
```

Add `SCOPED_PATH_LIMIT` to the import from `./scan-coordinator.js`.

- [ ] **Step 2: Write the failing tests**

Append to the same file:

```ts
describe('scan coordinator: scoped scans', () => {
  it('scans only the paths a watch burst named, once the tree settles', () => {
    const { coordinator, scans, timers, watched } = harness();
    coordinator.start();

    watched[0]!.onChange('/lib/Film/a.mkv');
    watched[0]!.onChange('/lib/Film/b.mkv');
    watched[0]!.onChange('/lib/Film/a.mkv');
    expect(scans).toEqual([]);
    timers.advance(SETTLE_MS);

    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ reason: 'watch', scope: ['/lib/Film/a.mkv', '/lib/Film/b.mkv'] });
  });

  it('runs a notified scan at once, with no settle delay', () => {
    const { coordinator, scans, libraryIds } = harness();
    coordinator.start();

    coordinator.request(libraryIds[0]!, 'notify', ['/lib/Film']);

    expect(scans).toEqual([{ libraryId: libraryIds[0], reason: 'notify', scope: ['/lib/Film'] }]);
  });

  it('collects paths reported during a scan into one catch-up scan', async () => {
    const { coordinator, scans, libraryIds, release } = harness({ blocking: true });
    coordinator.start();

    coordinator.request(libraryIds[0]!, 'notify', ['/lib/A']);
    coordinator.request(libraryIds[0]!, 'notify', ['/lib/B']);
    coordinator.request(libraryIds[0]!, 'notify', ['/lib/C']);
    await release();
    await coordinator.idle();

    expect(scans.map((call) => call.scope)).toEqual([['/lib/A'], ['/lib/B', '/lib/C']]);
  });

  it('lets a full request during a scan supersede the paths collected so far', async () => {
    const { coordinator, scans, libraryIds, release } = harness({ blocking: true });
    coordinator.start();

    coordinator.request(libraryIds[0]!, 'notify', ['/lib/A']);
    coordinator.request(libraryIds[0]!, 'notify', ['/lib/B']);
    coordinator.request(libraryIds[0]!, 'manual');
    coordinator.request(libraryIds[0]!, 'notify', ['/lib/C']);
    await release();
    await coordinator.idle();

    expect(scans.map((call) => call.scope)).toEqual([['/lib/A'], null]);
  });

  // A season pack, or a library moved wholesale: past the limit a list of
  // paths is no cheaper than the walk, and unbounded it is a memory leak.
  it('turns more than the limit of pending paths into one full scan', () => {
    const { coordinator, scans, timers, watched } = harness();
    coordinator.start();

    for (let index = 0; index <= SCOPED_PATH_LIMIT; index += 1) {
      watched[0]!.onChange(`/lib/Show/e${String(index)}.mkv`);
    }
    timers.advance(SETTLE_MS);

    expect(scans).toHaveLength(1);
    expect(scans[0]!.scope).toBeNull();
  });

  it('keeps exactly the limit of paths scoped', () => {
    const { coordinator, scans, timers, watched } = harness();
    coordinator.start();

    for (let index = 0; index < SCOPED_PATH_LIMIT; index += 1) {
      watched[0]!.onChange(`/lib/Show/e${String(index)}.mkv`);
    }
    timers.advance(SETTLE_MS);

    expect(scans[0]!.scope).toHaveLength(SCOPED_PATH_LIMIT);
  });

  it('does not let a notified scan discard a watch burst that is still settling', async () => {
    const { coordinator, scans, timers, libraryIds, watched } = harness();
    coordinator.start();

    watched[0]!.onChange('/lib/Film/a.mkv');
    coordinator.request(libraryIds[0]!, 'notify', ['/lib/Other']);
    await coordinator.idle();
    timers.advance(SETTLE_MS);
    await coordinator.idle();

    expect(scans.map((call) => call.scope)).toEqual([['/lib/Other'], ['/lib/Film/a.mkv']]);
  });

  it('still lets a full manual scan supersede a settling watch burst', async () => {
    const { coordinator, scans, timers, libraryIds, watched } = harness();
    coordinator.start();

    watched[0]!.onChange('/lib/Film/a.mkv');
    coordinator.request(libraryIds[0]!, 'manual');
    await coordinator.idle();
    timers.advance(SETTLE_MS);
    await coordinator.idle();

    expect(scans.map((call) => call.scope)).toEqual([null]);
  });

  it('keeps the interval scan full', () => {
    const { coordinator, scans, timers } = harness();
    coordinator.start();

    timers.advance(RESCAN_MS);

    expect(scans[0]).toMatchObject({ reason: 'interval', scope: null });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- packages/server/src/daemon/scan-coordinator.test.ts`
Expected: the new `describe` FAILS (every scan has `scope: null`; `SCOPED_PATH_LIMIT` is not exported). Existing tests still pass.

- [ ] **Step 4: Add the types**

In `packages/server/src/daemon/scan-coordinator.ts`:

```ts
export type ScanReason = 'manual' | 'watch' | 'interval' | 'startup' | 'notify';

/**
 * How many distinct pending paths one library may collect before they are
 * replaced by a single full scan. Past this a list of paths is no cheaper
 * than the walk it was avoiding — a season pack, a library moved wholesale —
 * and with no bound at all it is memory that grows with every event until
 * the scan in flight ends.
 */
export const SCOPED_PATH_LIMIT = 200;

/** One scan to run: of the whole library (`paths` null), or of these paths. */
interface PlannedScan {
  reason: ScanReason;
  paths: Set<string> | null;
}
```

Change the interface method and its comment:

```ts
  /**
   * Scan now if this library is not already scanning; otherwise remember the
   * request and scan when the current one ends. With `paths`, only those
   * files and folders are scanned; without, the whole library.
   */
  request(libraryId: string, reason: ScanReason, paths?: readonly string[]): void;
```

Change `LibraryScanState`:

```ts
interface LibraryScanState {
  /** A scan (and its at-most-one catch-up) is in flight for this library. */
  running: boolean;
  /** What arrived while a scan was running: one catch-up, whatever the count. */
  pending: PlannedScan | null;
  /** Armed settle timer, i.e. a burst of watch events still settling. */
  settle: unknown | null;
  /** What that burst has named so far. */
  settling: PlannedScan | null;
}
```

and `stateFor`'s literal to `{ running: false, pending: null, settle: null, settling: null }`.

- [ ] **Step 5: Add the merge rule**

Above `createScanCoordinator`:

```ts
/**
 * Fold one more request into what is already planned.
 *
 * FULL ABSORBS SCOPED, in either order: a scan of the whole library covers
 * every path anyone named, so once one is planned the paths are dropped
 * rather than scanned twice. The reason kept is the latest, as it always was.
 */
const planWith = (
  current: PlannedScan | null,
  reason: ScanReason,
  paths: readonly string[] | undefined,
): PlannedScan => {
  if (paths === undefined || (current !== null && current.paths === null)) {
    return { reason, paths: null };
  }
  const merged = new Set(current?.paths ?? []);
  for (const path of paths) merged.add(path);
  return { reason, paths: merged.size > SCOPED_PATH_LIMIT ? null : merged };
};

const scopeOf = (plan: PlannedScan): string[] | undefined =>
  plan.paths === null ? undefined : [...plan.paths];
```

- [ ] **Step 6: Thread the plan through `executeScan`, `runScan`, `armSettle` and `request`**

`executeScan` takes the plan: change its signature to `(libraryId: string, plan: PlannedScan)`, use `reason: plan.reason`, and add `scope: scopeOf(plan),` to the `scanFn` input, after `reason`.

`runScan` takes the plan: signature `(libraryId: string, plan: PlannedScan)`, and inside:

```ts
        let current: PlannedScan | null = plan;
        while (current !== null) {
          try {
            await executeScan(libraryId, current);
          } catch (error) {
            onError(error, { libraryId, phase: 'scan' });
          }
          // Read-and-clear: however many triggers landed during the scan,
          // they produce exactly one more pass.
          current = stopped ? null : state.pending;
          state.pending = null;
        }
```

`armSettle` — replace its timer callback, and take the burst's paths:

```ts
  const armSettle = (libraryId: string, paths: readonly string[] | undefined): void => {
    const state = stateFor(libraryId);
    state.settling = planWith(state.settling, 'watch', paths);
    if (state.settle !== null) clearTimer(state.settle);
    state.settle = setTimer(() => {
      state.settle = null;
      const burst = state.settling ?? { reason: 'watch', paths: null };
      state.settling = null;
      if (stopped) return;
      if (state.running) {
        state.pending = planWith(state.pending, 'watch', scopeOf(burst));
        return;
      }
      runScan(libraryId, burst);
    }, settings.getScan().settleMs);
  };
```

`request`:

```ts
  const request = (libraryId: string, reason: ScanReason, paths?: readonly string[]): void => {
    if (stopped) return;
    const state = stateFor(libraryId);

    // A trigger during a scan can never start a second one. It is folded
    // into the one catch-up instead, and the running scan picks that up when
    // it ends — including a watch trigger, which needs no separate settle
    // timer here: the scan already in flight IS a delay at least as long as
    // one, and the catch-up starts only once it finishes.
    if (state.running) {
      state.pending = planWith(state.pending, reason, paths);
      return;
    }

    if (reason === 'watch') {
      armSettle(libraryId, paths);
      return;
    }

    // An explicit trigger — a human, startup, the interval, a notification —
    // is not debounced: it is not evidence that anything is being written
    // (an *arr sends its webhook after the import is finished), and making an
    // operator wait 30 seconds for "scan now" would be a bug of its own.
    //
    // A FULL one supersedes a settling burst, since the scan it is about to
    // run covers everything that burst would have. A SCOPED one does not: it
    // covers only its own paths, so the burst keeps settling and runs after.
    if (paths === undefined && state.settle !== null) {
      clearTimer(state.settle);
      state.settle = null;
      state.settling = null;
    }
    runScan(libraryId, planWith(null, reason, paths));
  };
```

Update the three other callers: the interval's `request(library.id, 'interval')` is unchanged; in `stop()` add `state.settling = null;` beside `state.pending = null;`.

- [ ] **Step 7: Pass the watcher's path**

In `syncWatchers`, change the watch's handler:

```ts
            // The path is a hint of WHERE something changed, never a record
            // of what: it narrows the scan, and the scan establishes facts.
            onChange: (path) => {
              request(library.id, 'watch', [path]);
            },
```

- [ ] **Step 8: Run the tests and the type-check**

Run:
```bash
pnpm test -- packages/server/src/daemon/scan-coordinator.test.ts packages/server/src/daemon
pnpm build && pnpm typecheck
```
Expected: PASS. `packages/server/src/api/api.test.ts`'s `fakeScans.request` still type-checks (a function with fewer parameters is assignable).

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/daemon/scan-coordinator.ts packages/server/src/daemon/scan-coordinator.test.ts
git commit -m "feat(daemon): scan only the paths the watcher reported, collecting them into one scan per library"
```

---

### Task 6: Paths on the scan endpoint

**Files:**
- Modify: `packages/server/src/api/routes/libraries.ts` (the `POST /libraries/:id/scan` route, near line 394)
- Modify: `packages/server/src/api/api.test.ts`

**Interfaces:**
- Consumes: `validateScope`, `ScopeError` (Task 2); `ScanCoordinator.request` with paths (Task 5).
- Produces: `POST /libraries/:id/scan` accepts `{ "paths": string[] }` and returns `mode: 'full' | 'scoped'`.

- [ ] **Step 1: Let the fake coordinator record paths**

In `packages/server/src/api/api.test.ts`, change both `requests` declarations (in `FakeScans` and in `fakeScans`) to:

```ts
  requests: { libraryId: string; reason: ScanReason; paths?: readonly string[] }[];
```

and the fake's `request` to:

```ts
    request: (libraryId: string, reason: ScanReason, paths?: readonly string[]) => {
      requests.push(paths === undefined ? { libraryId, reason } : { libraryId, reason, paths });
    },
```

- [ ] **Step 2: Write the failing tests**

Add to `api.test.ts`, beside the existing scan-endpoint tests (search for `/scan`). `createLibraryRepo` is already imported; create the library with a real temp root as the neighbouring tests do, binding its id to `id` and its root to `root`:

```ts
  it('queues a full scan when no paths are sent, exactly as before', async () => {
    const result = await api('POST', `/libraries/${id}/scan`);

    expect(result.status).toBe(202);
    expect(result.body.mode).toBe('full');
    expect(scans.requests).toEqual([{ libraryId: id, reason: 'manual' }]);
  });

  it('queues a scoped scan for the paths sent', async () => {
    const result = await api('POST', `/libraries/${id}/scan`, {
      paths: [join(root, 'Film'), join(root, 'Film', 'film.mkv')],
    });

    expect(result.status).toBe(202);
    expect(result.body.mode).toBe('scoped');
    expect(scans.requests).toEqual([
      {
        libraryId: id,
        reason: 'notify',
        paths: [join(root, 'Film'), join(root, 'Film', 'film.mkv')],
      },
    ]);
  });

  it('refuses a path outside the library, naming it, and queues nothing', async () => {
    const result = await api('POST', `/libraries/${id}/scan`, {
      paths: [join(root, 'Film'), '/somewhere/else.mkv'],
    });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('invalid-scope');
    expect(result.body.error.message).toContain('/somewhere/else.mkv');
    expect(scans.requests).toEqual([]);
  });

  it('refuses "paths" that is not a list of strings', async () => {
    const result = await api('POST', `/libraries/${id}/scan`, { paths: 'not-a-list' });

    expect(result.status).toBe(400);
    expect(scans.requests).toEqual([]);
  });

  it('treats an empty list of paths as nothing to scan, not as a full scan', async () => {
    const result = await api('POST', `/libraries/${id}/scan`, { paths: [] });

    expect(result.status).toBe(400);
    expect(scans.requests).toEqual([]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- packages/server/src/api/api.test.ts -t 'scan'`
Expected: the four tests that send or inspect `paths`/`mode` FAIL.

- [ ] **Step 4: Implement**

In `packages/server/src/api/routes/libraries.ts`, add the import:

```ts
import { ScopeError, validateScope } from '../../scanner/scope.js';
```

and replace the route's handler:

```ts
    handler: ({ params, body, ctx }) => {
      const library = requireLibrary(ctx, params.id!);
      const requested = optionalStringArray(body, 'paths');

      // 202, not 200: a scan of a real library takes minutes, and holding an
      // HTTP connection open for it times out every proxy in the path. The
      // scan's progress arrives on the websocket; its result is in the
      // library's stats afterwards.
      const note =
        `The scan was queued, not performed. Watch "scan.progress"/"scan.finished" on the ` +
        `websocket, or poll GET /api/v1/libraries/${library.id}/stats.`;

      if (requested === undefined) {
        ctx.scans.request(library.id, 'manual');
        return accepted({ accepted: true, libraryId: library.id, mode: 'full' as const, note });
      }

      // An empty list is refused rather than read as "everything": a caller
      // that built its list from nothing would otherwise trigger the full
      // walk it was written to avoid.
      if (requested.length === 0) {
        throw new ApiError(
          400,
          'invalid-scope',
          `"paths" is empty. Omit it to scan the whole library, or name at least one path.`,
        );
      }
      let paths: string[];
      try {
        paths = validateScope({ library, paths: requested });
      } catch (error) {
        if (error instanceof ScopeError) throw new ApiError(400, 'invalid-scope', error.message);
        throw error;
      }
      ctx.scans.request(library.id, 'notify', paths);
      return accepted({ accepted: true, libraryId: library.id, mode: 'scoped' as const, paths, note });
    },
```

`optionalStringArray` and `ApiError` come from `../router.js`; add them to that import if they are not already there.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- packages/server/src/api/api.test.ts -t 'scan'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/api/routes/libraries.ts packages/server/src/api/api.test.ts
git commit -m "feat(api): accept paths on a library scan, so a caller can scan one file without the whole library"
```

---

### Task 7: The \*arr endpoint

**Files:**
- Modify: `packages/server/src/db/settings-repo.ts`
- Create: `packages/server/src/notify/arr-payload.ts`
- Create: `packages/server/src/api/routes/notify.ts`
- Modify: `packages/server/src/api/server.ts` (route registry, near line 46)
- Test: `packages/server/src/notify/arr-payload.test.ts`
- Test: `packages/server/src/api/api.test.ts`

**Interfaces:**
- Consumes: `PathMapping`, `validatePathMap`, `mapPath`, `PathMapError` from `@trawlarr/core`; `validateScope` (Task 2); `ScanCoordinator.request` (Task 5).
- Produces:
  - `ScanSettings.notifyPathMap: PathMapping[]`
  - `readArrFolder(body: unknown): { kind: 'ignore'; why: string } | { kind: 'folder'; path: string } | { kind: 'invalid'; why: string }`
  - `POST /notify/arr`
  - `notifyRoutes: Route[]`

- [ ] **Step 1: Write the failing payload tests**

Create `packages/server/src/notify/arr-payload.test.ts`. The bodies are written by hand from the fields the \*arrs document; no captured payloads.

```ts
import { describe, expect, it } from 'vitest';
import { readArrFolder } from './arr-payload.js';

describe('readArrFolder', () => {
  it('reads the series folder from a Sonarr import', () => {
    expect(
      readArrFolder({
        eventType: 'Download',
        series: { id: 1, title: 'Show', path: '/data/shows/Show' },
        episodeFile: { relativePath: 'Season 1/e1.mkv' },
        isUpgrade: false,
      }),
    ).toEqual({ kind: 'folder', path: '/data/shows/Show' });
  });

  it('reads the movie folder from a Radarr import', () => {
    expect(
      readArrFolder({
        eventType: 'Download',
        movie: { id: 1, title: 'Film', folderPath: '/data/movies/Film (2001)' },
        movieFile: { relativePath: 'Film (2001).mkv' },
      }),
    ).toEqual({ kind: 'folder', path: '/data/movies/Film (2001)' });
  });

  it('reads the artist folder from a Lidarr import', () => {
    expect(
      readArrFolder({ eventType: 'Download', artist: { id: 1, path: '/data/music/Artist' } }),
    ).toEqual({ kind: 'folder', path: '/data/music/Artist' });
  });

  it.each(['Rename', 'EpisodeFileDelete', 'SeriesDelete', 'MovieFileDelete', 'MovieDelete'])(
    'scans the folder for %s, like any other event that names one',
    (eventType) => {
      expect(
        readArrFolder({ eventType, series: { path: '/data/shows/Show' } }),
      ).toEqual({ kind: 'folder', path: '/data/shows/Show' });
    },
  );

  // A future *arr release adds an event. Refusing what is not recognised
  // would turn that upgrade into files nobody scans.
  it('scans the folder for an event type it has never heard of', () => {
    expect(
      readArrFolder({ eventType: 'SomethingNew', movie: { folderPath: '/data/movies/Film' } }),
    ).toEqual({ kind: 'folder', path: '/data/movies/Film' });
  });

  it('ignores the Test event, so the Test button in the *arr passes', () => {
    expect(readArrFolder({ eventType: 'Test', series: { path: 'C:\\testpath' } }).kind).toBe(
      'ignore',
    );
  });

  it('ignores Grab: nothing has been imported yet', () => {
    expect(readArrFolder({ eventType: 'Grab', series: { path: '/data/shows/Show' } }).kind).toBe(
      'ignore',
    );
  });

  it('ignores an event that names no folder', () => {
    expect(readArrFolder({ eventType: 'Health', message: 'indexer down' }).kind).toBe('ignore');
  });

  // Review Focus 5.
  it.each([null, undefined, 'a string', 42, ['a', 'list']])(
    'reports a body that is not an object as invalid: %j',
    (body) => {
      expect(readArrFolder(body).kind).toBe('invalid');
    },
  );

  it('reports a folder that is not a string as invalid', () => {
    expect(readArrFolder({ eventType: 'Download', series: { path: 42 } }).kind).toBe('invalid');
  });

  it('reports a Windows path as invalid, naming it', () => {
    const result = readArrFolder({ eventType: 'Download', movie: { folderPath: 'C:\\Movies\\Film' } });
    expect(result).toMatchObject({ kind: 'invalid' });
    expect((result as { why: string }).why).toContain('C:\\Movies\\Film');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- packages/server/src/notify/arr-payload.test.ts`
Expected: FAIL — cannot resolve `./arr-payload.js`.

- [ ] **Step 3: Write the payload reader**

Create `packages/server/src/notify/arr-payload.ts`:

```ts
/**
 * What a Sonarr, Radarr or Lidarr webhook says to scan.
 *
 * ONE VALUE IS READ: the folder of the series, movie or artist. The payloads
 * name FILES in different fields for import, upgrade, rename and delete, and
 * differently per application, but every one of them carries that folder —
 * so a scan scoped to it covers every event with one rule, and re-checking a
 * folder that did not change changes nothing.
 *
 * Unknown event types are scanned, not refused. The list of events is the
 * *arrs' to grow, and refusing a new one would turn an upgrade of Sonarr
 * into imports nobody scans.
 */
export type ArrFolder =
  | { kind: 'folder'; path: string }
  /** Understood, and nothing to scan. Answered with success. */
  | { kind: 'ignore'; why: string }
  /** Not something this endpoint can act on. Answered with a client error. */
  | { kind: 'invalid'; why: string };

/** Events that name a folder nothing has happened in yet, or a placeholder one. */
const IGNORED_EVENTS: ReadonlySet<string> = new Set(['Test', 'Grab']);

const fieldOf = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

export const readArrFolder = (body: unknown): ArrFolder => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'invalid', why: 'The body is not a JSON object.' };
  }

  const eventType = fieldOf(body, 'eventType');
  if (typeof eventType === 'string' && IGNORED_EVENTS.has(eventType)) {
    return { kind: 'ignore', why: `"${eventType}" events name nothing to scan.` };
  }

  const folder =
    fieldOf(fieldOf(body, 'series'), 'path') ??
    fieldOf(fieldOf(body, 'movie'), 'folderPath') ??
    fieldOf(fieldOf(body, 'artist'), 'path');
  if (folder === undefined || folder === null) {
    return { kind: 'ignore', why: 'The event names no series, movie or artist folder.' };
  }
  if (typeof folder !== 'string') {
    return { kind: 'invalid', why: `The folder is not a string: ${JSON.stringify(folder)}.` };
  }
  if (!folder.startsWith('/')) {
    return {
      kind: 'invalid',
      why:
        `The folder "${folder}" is not an absolute POSIX path. trawlarr reads the path as the ` +
        `sending application reports it; map it with the "Notification paths" setting.`,
    };
  }
  return { kind: 'folder', path: folder };
};
```

- [ ] **Step 4: Run the payload tests to verify they pass**

Run: `pnpm test -- packages/server/src/notify/arr-payload.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing setting and endpoint tests**

Add to `packages/server/src/api/api.test.ts`. Bind `id` and `root` to a library with a real temp root, as in Task 6:

```ts
describe('POST /notify/arr', () => {
  it('scans the mapped folder in the library that contains it', async () => {
    settings.setScan({ notifyPathMap: [{ serverPath: root, nodePath: '/data/movies' }] });

    const result = await api('POST', '/notify/arr', {
      eventType: 'Download',
      movie: { folderPath: '/data/movies/Film (2001)' },
    });

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ libraryId: id, path: join(root, 'Film (2001)') });
    expect(scans.requests).toEqual([
      { libraryId: id, reason: 'notify', paths: [join(root, 'Film (2001)')] },
    ]);
  });

  it('takes the path as received when no mapping is configured', async () => {
    const result = await api('POST', '/notify/arr', {
      eventType: 'Download',
      series: { path: join(root, 'Show') },
    });

    expect(result.status).toBe(202);
    expect(scans.requests).toEqual([{ libraryId: id, reason: 'notify', paths: [join(root, 'Show')] }]);
  });

  it('answers the Test event with success and scans nothing', async () => {
    const result = await api('POST', '/notify/arr', { eventType: 'Test', series: { path: 'C:\\testpath' } });

    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
    expect(scans.requests).toEqual([]);
  });

  it('refuses a folder that maps to no library, saying what it tried', async () => {
    const result = await api('POST', '/notify/arr', {
      eventType: 'Download',
      movie: { folderPath: '/data/movies/Film' },
    });

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('no-library-for-path');
    expect(result.body.error.message).toContain('/data/movies/Film');
    expect(result.body.error.message).toContain(root);
    expect(scans.requests).toEqual([]);
  });

  it('refuses a body that is not an object', async () => {
    const result = await api('POST', '/notify/arr', ['not', 'an', 'object']);

    expect(result.status).toBe(400);
    expect(scans.requests).toEqual([]);
  });

  it('refuses a folder inside a reserved directory', async () => {
    const result = await api('POST', '/notify/arr', {
      eventType: 'Download',
      movie: { folderPath: join(root, '.trawlarr', 'trash') },
    });

    expect(result.status).toBe(422);
    expect(scans.requests).toEqual([]);
  });

  it('needs the API key, like every other endpoint', async () => {
    const result = await api('POST', '/notify/arr', { eventType: 'Test' }, { apiKey: null });

    expect(result.status).toBe(401);
  });
});

describe('scan.notifyPathMap', () => {
  it('is empty by default and round-trips through the settings endpoint', async () => {
    expect((await api('GET', '/system/settings')).body.scan.notifyPathMap).toEqual([]);

    const saved = await api('PATCH', '/system/settings', {
      scan: { notifyPathMap: [{ serverPath: '/library', nodePath: '/data' }] },
    });

    expect(saved.status).toBe(200);
    expect(saved.body.scan.notifyPathMap).toEqual([{ serverPath: '/library', nodePath: '/data' }]);
  });

  it('refuses a mapping that is not absolute, as a named setting error', async () => {
    const result = await api('PATCH', '/system/settings', {
      scan: { notifyPathMap: [{ serverPath: 'library', nodePath: '/data' }] },
    });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('invalid-setting');
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `pnpm test -- packages/server/src/api/api.test.ts -t 'notify'`
Expected: FAIL — `notifyPathMap` is not a known scan setting; `/notify/arr` is a 404.

- [ ] **Step 7: Add the setting**

In `packages/server/src/db/settings-repo.ts`:

Import from core: `import { PathMapError, validatePathMap, type PathMapping } from '@trawlarr/core';` (merge with the existing core import if there is one).

Add to `ScanSettings`, after `probeConcurrency`:

```ts
  /**
   * How a path reported by another application translates to a path here,
   * for notifications (`POST /notify/arr`). In each pair `nodePath` is the
   * prefix as the sender reports it and `serverPath` the prefix as trawlarr
   * sees it: the sender stands where a remote node does. Empty means paths
   * are taken as received.
   */
  notifyPathMap: PathMapping[];
```

Add `notifyPathMap: [],` to `DEFAULT_SCAN`.

In `validateScan`, add `notifyPathMap: unknown;` to the parameter type and this field to the result:

```ts
  notifyPathMap: ((): PathMapping[] => {
    try {
      return validatePathMap(value.notifyPathMap);
    } catch (error) {
      // The API turns a SettingValidationError into a 400 naming the field;
      // anything else would surface as a 500 for what is a typing mistake.
      if (error instanceof PathMapError) {
        throw new SettingValidationError(`scan.notifyPathMap: ${error.message}`);
      }
      throw error;
    }
  })(),
```

In `getScan`, add:

```ts
      notifyPathMap: readField(SETTING_KEYS.scan, 'notifyPathMap') ?? DEFAULT_SCAN.notifyPathMap,
```

In `setScan`, add:

```ts
    writeField(SETTING_KEYS.scan, 'notifyPathMap', next.notifyPathMap);
```

- [ ] **Step 8: Add the route**

Create `packages/server/src/api/routes/notify.ts`:

```ts
import { mapPath } from '@trawlarr/core';
import { createLibraryRepo } from '../../db/library-repo.js';
import { createSubtreeMatcher } from '../../fs/path-contains.js';
import { readArrFolder } from '../../notify/arr-payload.js';
import { ScopeError, validateScope } from '../../scanner/scope.js';
import { accepted, ApiError, type Route } from '../router.js';

export const notifyRoutes: Route[] = [
  {
    /**
     * Where Sonarr, Radarr and Lidarr post their own webhook, unmodified.
     *
     * A notification is a hint that a folder changed and nothing more: it
     * queues a scan scoped to that folder, and the scan establishes every
     * fact. Nothing durable depends on one arriving — the interval scan
     * finds whatever a lost webhook would have reported.
     */
    method: 'POST',
    path: '/notify/arr',
    handler: ({ body, ctx }) => {
      const read = readArrFolder(body);
      if (read.kind === 'invalid') throw new ApiError(400, 'invalid-body', read.why);
      // Success, not an error: the *arr marks a connection unhealthy on a
      // failed call, and its own Test button sends an event with nothing in
      // it to scan.
      if (read.kind === 'ignore') return { ignored: true, reason: read.why };

      const map = ctx.settings.getScan().notifyPathMap;
      const mapped = map.length === 0 ? read.path : (mapPath(map, read.path, 'toServer') ?? read.path);

      const libraries = createLibraryRepo(ctx.db).list();
      const library = libraries.find((candidate) =>
        createSubtreeMatcher({ roots: candidate.roots, subtrees: candidate.roots })(mapped),
      );
      if (library === undefined) {
        throw new ApiError(
          422,
          'no-library-for-path',
          `No library contains "${mapped}"` +
            (mapped === read.path ? '' : ` (received as "${read.path}")`) +
            `. Library roots: ${libraries.flatMap((candidate) => candidate.roots).join(', ') || 'none'}. ` +
            `If the sending application sees the library at a different path, set "Notification paths".`,
        );
      }

      let paths: string[];
      try {
        paths = validateScope({ library, paths: [mapped] });
      } catch (error) {
        if (error instanceof ScopeError) throw new ApiError(422, 'invalid-scope', error.message);
        throw error;
      }
      ctx.scans.request(library.id, 'notify', paths);
      return accepted({ accepted: true, libraryId: library.id, path: paths[0] });
    },
  },
];
```

Register it in `packages/server/src/api/server.ts`: add `import { notifyRoutes } from './routes/notify.js';` beside the other route imports, and `...notifyRoutes,` to the route list directly after `...libraryRoutes,`.

- [ ] **Step 9: Run the tests and the type-check**

Run:
```bash
pnpm test -- packages/server/src/notify packages/server/src/api/api.test.ts -t 'notify'
pnpm test -- packages/server/src/db
pnpm build && pnpm typecheck
```
Expected: PASS; typecheck exits 0. If another test builds a full `ScanSettings` literal, add `notifyPathMap: []` to it.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/db/settings-repo.ts packages/server/src/notify packages/server/src/api/routes/notify.ts packages/server/src/api/server.ts packages/server/src/api/api.test.ts
git commit -m "feat(api): take Sonarr, Radarr and Lidarr webhooks directly and scan the folder they name"
```

---

### Task 8: "Notification paths" in the web UI

**Files:**
- Create: `packages/web/src/screens/config/notification-paths-model.ts`
- Create: `packages/web/src/screens/config/NotificationPaths.tsx`
- Modify: `packages/web/src/screens/config/Config.tsx` (`SystemTab`, near line 1417)
- Test: `packages/web/src/screens/config/notification-paths-model.test.ts`

**Interfaces:**
- Consumes: `GET`/`PATCH /system/settings` with `scan.notifyPathMap` (Task 7).
- Produces:
  - `rowsFromMap(map: { serverPath: string; nodePath: string }[]): NotificationPathRow[]`
  - `mapFromRows(rows: NotificationPathRow[]): { serverPath: string; nodePath: string }[]`
  - `interface NotificationPathRow { key: string; theirs: string; ours: string }`
  - `NotificationPathsSection(props: { client: ApiClient }): JSX.Element`

Validation is the server's: its `invalid-setting` message is shown verbatim. That message is worded for remote nodes ("the node"); accepted for now and noted in the PR description.

- [ ] **Step 1: Write the failing model tests**

Create `packages/web/src/screens/config/notification-paths-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapFromRows, rowsFromMap } from './notification-paths-model.js';

describe('notification paths model', () => {
  it('shows the sender path first and trawlarr path second', () => {
    expect(rowsFromMap([{ serverPath: '/library', nodePath: '/data' }])).toEqual([
      { key: '/data\u0000/library', theirs: '/data', ours: '/library' },
    ]);
  });

  it('round-trips a map through rows', () => {
    const map = [
      { serverPath: '/library/movies', nodePath: '/data/movies' },
      { serverPath: '/library/shows', nodePath: '/data/shows' },
    ];
    expect(mapFromRows(rowsFromMap(map))).toEqual(map);
  });

  it('drops a row left entirely blank, so an unused "Add row" does not fail the save', () => {
    expect(
      mapFromRows([
        { key: 'a', theirs: '/data', ours: '/library' },
        { key: 'b', theirs: '  ', ours: '' },
      ]),
    ).toEqual([{ serverPath: '/library', nodePath: '/data' }]);
  });

  it('keeps a half-filled row, so the server can say what is wrong with it', () => {
    expect(mapFromRows([{ key: 'a', theirs: '/data', ours: '' }])).toEqual([
      { serverPath: '', nodePath: '/data' },
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(mapFromRows([{ key: 'a', theirs: ' /data ', ours: ' /library ' }])).toEqual([
      { serverPath: '/library', nodePath: '/data' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- packages/web/src/screens/config/notification-paths-model.test.ts`
Expected: FAIL — cannot resolve `./notification-paths-model.js`.

- [ ] **Step 3: Write the model**

Create `packages/web/src/screens/config/notification-paths-model.ts`:

```ts
/**
 * The "Notification paths" setting as the rows a person edits.
 *
 * The stored shape is the one remote nodes use (`serverPath`/`nodePath`),
 * where the sending application stands in the node's place. Those names mean
 * nothing on this screen, so the rows are named for what they are: the path
 * as the other application reports it, and the path as trawlarr sees it.
 */
export interface NotificationPathRow {
  key: string;
  theirs: string;
  ours: string;
}

export const rowsFromMap = (
  map: { serverPath: string; nodePath: string }[],
): NotificationPathRow[] =>
  map.map((entry) => ({
    key: `${entry.nodePath}\u0000${entry.serverPath}`,
    theirs: entry.nodePath,
    ours: entry.serverPath,
  }));

export const mapFromRows = (
  rows: NotificationPathRow[],
): { serverPath: string; nodePath: string }[] =>
  rows
    .map((row) => ({ serverPath: row.ours.trim(), nodePath: row.theirs.trim() }))
    .filter((entry) => entry.serverPath !== '' || entry.nodePath !== '');
```

- [ ] **Step 4: Run the model tests to verify they pass**

Run: `pnpm test -- packages/web/src/screens/config/notification-paths-model.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the section**

Create `packages/web/src/screens/config/NotificationPaths.tsx`. Import `ApiClient` and `describeFailure` from the same modules `Config.tsx` imports them from (see the top of that file), and follow `MetadataSection` in `Config.tsx` for loading, saving and failure display — this section has the same shape with a table in place of one input.

```tsx
import { useEffect, useState } from 'react';
import {
  mapFromRows,
  rowsFromMap,
  type NotificationPathRow,
} from './notification-paths-model.js';

interface ScanSettingsResponse {
  scan: { notifyPathMap: { serverPath: string; nodePath: string }[] };
}

let nextRowKey = 0;
const newRowKey = (): string => {
  nextRowKey += 1;
  return `new-${String(nextRowKey)}`;
};

export const NotificationPathsSection = (props: { client: ApiClient }): JSX.Element => {
  const { client } = props;
  const [rows, setRows] = useState<NotificationPathRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await client.get<ScanSettingsResponse>('/system/settings');
        if (!cancelled) setRows(rowsFromMap(settings.scan.notifyPathMap));
      } catch (error) {
        if (!cancelled) setFailure(describeFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const save = async (): Promise<void> => {
    if (rows === null) return;
    setSaving(true);
    setFailure(null);
    try {
      const saved = await client.patch<ScanSettingsResponse>('/system/settings', {
        scan: { notifyPathMap: mapFromRows(rows) },
      });
      setRows(rowsFromMap(saved.scan.notifyPathMap));
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setSaving(false);
    }
  };

  const edit = (key: string, patch: Partial<NotificationPathRow>): void => {
    setRows((current) =>
      current === null
        ? current
        : current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  return (
    <div className="setting-section">
      <h3>Notification paths</h3>
      {rows !== null && (
        <table>
          <thead>
            <tr>
              <th>Reported as</th>
              <th>Path here</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <input
                    aria-label="Reported as"
                    value={row.theirs}
                    onChange={(event) => {
                      edit(row.key, { theirs: event.target.value });
                    }}
                  />
                </td>
                <td>
                  <input
                    aria-label="Path here"
                    value={row.ours}
                    onChange={(event) => {
                      edit(row.key, { ours: event.target.value });
                    }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setRows((current) =>
                        current === null ? current : current.filter((r) => r.key !== row.key),
                      );
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row-actions">
        <button
          type="button"
          onClick={() => {
            setRows((current) => [...(current ?? []), { key: newRowKey(), theirs: '', ours: '' }]);
          }}
        >
          Add row
        </button>
        <button type="button" disabled={saving || rows === null} onClick={() => void save()}>
          Save
        </button>
      </div>
      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
        </div>
      )}
    </div>
  );
};
```

Match the wrapper element and class names to what `MetadataSection` actually renders if they differ from `setting-section`/`h3` — the goal is that this section looks like its neighbours, with no new CSS.

- [ ] **Step 6: Mount it**

In `packages/web/src/screens/config/Config.tsx`, import `NotificationPathsSection` and add it to `SystemTab` after `<MetadataSection client={props.client} />`:

```tsx
    <NotificationPathsSection client={props.client} />
```

- [ ] **Step 7: Build, type-check and run the web tests for this screen**

Run:
```bash
pnpm build && pnpm typecheck
pnpm test -- packages/web/src/screens/config
pnpm exec eslint packages/web/src/screens/config
```
Expected: PASS, exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/screens/config/notification-paths-model.ts packages/web/src/screens/config/notification-paths-model.test.ts packages/web/src/screens/config/NotificationPaths.tsx packages/web/src/screens/config/Config.tsx
git commit -m "feat(web): edit the path mapping notifications are translated through"
```

---

### Task 9: End to end, the \*arr check, and the docs

**Files:**
- Test: `packages/server/src/daemon/scan-coordinator-scoped.test.ts`
- Modify: `README.md` (the section describing what triggers a scan)
- Modify: `docs/deployment.md`
- Modify: `docs/superpowers/specs/2026-10-10-targeted-scan-design.md` (§8 only, with what was found)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the end-to-end test**

Create `packages/server/src/daemon/scan-coordinator-scoped.test.ts`. A real coordinator, the real `scanLibrary`, a real directory; only the watcher and the probe are faked.

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { openDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLibraryRepo } from '../db/library-repo.js';
import { createMediaFileRepo } from '../db/media-file-repo.js';
import { createSettingsRepo } from '../db/settings-repo.js';
import { scanLibrary } from '../scanner/scan-library.js';
import { FAKE_PROBE_DOCUMENT } from '../../test/helpers/fake-ffprobe.js';
import { createEventBus } from './events.js';
import { createScanCoordinator, type ScanCoordinator } from './scan-coordinator.js';
import type { WatchInput } from './watcher.js';

const fixedProbe = (path: string): ProbeData =>
  ({ ...FAKE_PROBE_DOCUMENT, format: { ...FAKE_PROBE_DOCUMENT.format, filename: path } }) as ProbeData;

let base: string;
let root: string;
let db: Db;
let libraryId: string;
let coordinator: ScanCoordinator;
let watched: WatchInput[];
let probed: string[];
let scopes: (readonly string[] | undefined)[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trawlarr-coord-scoped-'));
  root = join(base, 'library');
  for (let index = 0; index < 20; index += 1) {
    mkdirSync(join(root, `Film ${String(index)}`), { recursive: true });
    writeFileSync(join(root, `Film ${String(index)}`, 'film.mkv'), `film ${String(index)}`);
  }
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  libraryId = createLibraryRepo(db).create({
    name: 'Movies',
    roots: [root],
    extensions: ['mkv'],
    nowMs: 0,
  }).id;
  const settings = createSettingsRepo({ db });
  settings.setScan({ settleMs: 0 });
  watched = [];
  probed = [];
  scopes = [];
  coordinator = createScanCoordinator({
    db,
    bus: createEventBus(),
    settings,
    nowMs: () => 1_000,
    watchPort: {
      watch: (input) => {
        watched.push(input);
        return { close: async () => {} };
      },
    },
    scanFn: (input) => {
      scopes.push(input.scope);
      return scanLibrary({
        ...input,
        probeFileImpl: async (probe) => {
          probed.push(probe.path);
          return fixedProbe(probe.path);
        },
      });
    },
    onError: (error) => {
      throw error;
    },
  });
});

afterEach(async () => {
  await coordinator.stop();
  db.close();
  rmSync(base, { recursive: true, force: true });
});

it('adds a file the watcher reported without walking the rest of the library', async () => {
  coordinator.start();
  coordinator.request(libraryId, 'startup');
  await coordinator.idle();
  expect(probed).toHaveLength(20);
  probed = [];
  scopes = [];

  const added = join(root, 'Film 3', 'film (extended).mkv');
  writeFileSync(added, 'the extended cut');
  watched[0]!.onChange(added);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await coordinator.idle();

  expect(scopes).toEqual([[added]]);
  expect(probed).toEqual([added]);
  expect(
    createMediaFileRepo(db)
      .listByLibrary({ libraryId })
      .some((row) => row.path === added),
  ).toBe(true);
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test -- packages/server/src/daemon/scan-coordinator-scoped.test.ts`
Expected: PASS. (Every piece exists by now; this test is the proof that they compose. If it fails, the failing layer is the one to fix — do not adjust the test.)

- [ ] **Step 3: Check the \*arrs' webhook settings (§8 of the spec)**

This is read-only against the production host. For each of `sonarr`, `radarr`, `lidarr`:

```bash
ssh media-server.lan 'docker exec sonarr sh -c "wget -qO- --header=\"X-Api-Key: \$(sed -n \"s:.*<ApiKey>\\(.*\\)</ApiKey>.*:\\1:p\" /config/config.xml)\" http://localhost:8989/api/v3/notification/schema"' \
  | python3 -c 'import json,sys; s=[n for n in json.load(sys.stdin) if n["implementation"]=="Webhook"][0]; print([f["name"] for f in s["fields"]])'
```

(Radarr: port 7878, `/api/v3`. Lidarr: port 8686, `/api/v1`.) The key is read and used inside the container and never printed.

Expected: each list contains `headers`. Record the result in §8 of the spec, replacing the "to verify" wording with what was found. If one application has no `headers` field, record that it needs a custom script calling `POST /libraries/:id/scan` instead, and say so in `docs/deployment.md`.

For Lidarr's folder field, trigger its webhook Test in the UI is not enough (the Test event is ignored). Instead confirm from Lidarr's API that an artist resource has `path`: `GET /api/v1/artist` → first item has a `path` key. Record it in §8.

- [ ] **Step 4: Document it**

In `README.md`, in the section that says when a library is scanned, state: a watcher event or a notification scans only the files or folders it names; startup, the interval and "Scan" in the UI scan the whole library; the interval scan is what finds anything nobody reported.

In `docs/deployment.md`, add a section "Notifying trawlarr from Sonarr, Radarr and Lidarr" containing exactly:

- Settings → Connect → add **Webhook**.
- URL: `http://<trawlarr host>:8265/api/v1/notify/arr`, method `POST`.
- Under Advanced, Headers: `X-Api-Key` = the daemon's API key.
- Triggers: On Import, On Upgrade, On Rename, and every On Delete.
- If the application sees the library at a different path than trawlarr does, set Config → System → Notification paths (for example reported as `/data`, path here `/library`).
- The application's Test button should succeed; it scans nothing.
- A notification missed while trawlarr is restarting is not retried; the hourly scan finds the file.

- [ ] **Step 5: Final verification for the branch**

Run:
```bash
pnpm build && pnpm typecheck
pnpm exec eslint packages/server/src packages/web/src/screens/config
pnpm exec prettier --check README.md docs packages/server/src packages/web/src/screens/config
pnpm test -- packages/server/src/scanner packages/server/src/fs packages/server/src/daemon packages/server/src/notify packages/server/src/db packages/server/src/api/api.test.ts packages/web/src/screens/config
```
Expected: all exit 0. Do not run the bare `pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/daemon/scan-coordinator-scoped.test.ts README.md docs/deployment.md docs/superpowers/specs/2026-10-10-targeted-scan-design.md
git commit -m "docs: say what triggers a scoped scan and how to point Sonarr, Radarr and Lidarr at trawlarr"
```
