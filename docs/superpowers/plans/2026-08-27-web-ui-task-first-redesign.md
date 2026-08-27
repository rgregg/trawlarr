# Web UI Task-First Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-screen web UI with a task-first UI — Watch, Diagnose, Files, Configure — that answers "why is this file in this state" without dropping to `curl`.

**Architecture:** Four mode routes plus shared object views (file, job, flow), all addressed by real URLs over a hand-rolled History-API router. Every screen is correct from REST alone; the WebSocket only overlays in-flight liveness. All logic lives in pure `*-model.ts` modules that vitest tests directly; React components stay thin enough to need no tests.

**Tech Stack:** TypeScript ESM, React 18, Vite 5, vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-web-ui-task-first-redesign-design.md`

## Global Constraints

- **Node 22.** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` — do **not** redirect nvm's output, it breaks the shell function.
- **Gate for every task:** `pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`. Licence audit must report exactly **291 packages**, MIT-only.
- **No new runtime or dev dependencies.** `packages/web/package.json` depends on `react`, `react-dom`, `@trawlarr/plugin-api` and nothing else. Adding a router, table, virtualisation, or DOM-testing library is a plan violation.
- **No DOM testing library.** Tests import pure functions from `*-model.ts` and assert on their return values. Never write a test that renders a component.
- **Logic lives in `*-model.ts`.** Follow `screens/activity-model.ts`, `screens/overview-model.ts`, `screens/library-form-model.ts`. A component may hold fetch/effect wiring and JSX; anything with a branch belongs in a model.
- **REST is truth; the socket is liveness.** Per `packages/server/src/worker/protocol.ts:44`, `progress` and `log` are LIVENESS ONLY. No screen may be *wrong* when the socket is down — only less lively. Never store a durable fact from a live event.
- **Filter state lives in the URL.** `/files?library=shows&state=failed&q=foundation` must reproduce a view exactly.
- **Desktop and phone are both first-class.** Tables collapse to cards below `48rem`; no horizontal scrolling of primary content; no hover-only affordances.
- **API base path is `/api/v1`**, prefixed automatically by `ApiClient`. Pass paths like `/files`, never `/api/v1/files`.
- All new files carry the file-level doc-comment style used in `packages/web/src` — say *why*, not *what*.

### API surface this plan consumes (all existing unless marked)

| Method | Path | Use |
| --- | --- | --- |
| GET | `/files?libraryId=&state=&q=&missing=&limit=&offset=` | Files table. Returns `{ total, limit, offset, items }` |
| GET | `/files/:id` | File detail; includes `probeJson` |
| POST | `/files/:id/requeue` | Requeue |
| POST | `/files/:id/hold` | Hold |
| POST | `/files/:id/priority` | **NEW — Task 2** |
| GET | `/jobs?fileId=&state=&limit=&offset=` | Job history |
| GET | `/jobs/:id` | Job detail with steps |
| GET | `/jobs/:id/log` | Full job log |
| GET | `/libraries` | Library list |
| GET | `/libraries/:id/stats` | Convergence counts |
| GET | `/workers` | Worker counts and active |
| PUT | `/workers/counts` | Set worker counts |
| GET | `/system/schedule`, PUT same | Schedule window |
| GET | `/system/settings`, PUT same | Trash retention |
| POST | `/system/maintenance/trash-purge` | Purge trash |
| GET | `/flows/:id` | Flow definition |
| POST | `/flows/:id/dry-run` | Dry-run a file |

There is **no bulk requeue endpoint**. "Requeue all N" issues N calls to `POST /files/:id/requeue` and reports partial failure.

## File structure

```
packages/web/src/
  shell/
    route.ts             NEW  pure: parse/format URLs  <-> Route
    route.test.ts        NEW
    useRoute.ts          NEW  History API hook (thin)
    Link.tsx             NEW  internal <a> that pushes instead of navigating
    virtual.ts           NEW  pure: visibleRange(scrollTop, height, rowHeight, count)
    virtual.test.ts      NEW
    useApi.ts            unchanged
    useLive.ts           unchanged
    KeyGate.tsx          unchanged
  screens/
    watch/Watch.tsx              NEW   absorbs Activity + Overview
    watch/watch-model.ts         NEW   running rows, idle reason, 24h counters
    watch/watch-model.test.ts    NEW
    diagnose/Diagnose.tsx        NEW
    diagnose/diagnose-model.ts   NEW   group failures by cause
    diagnose/diagnose-model.test.ts NEW
    files/Files.tsx              NEW
    files/files-model.ts         NEW   filter/sort/format rows
    files/files-model.test.ts    NEW
    files/FileDetail.tsx         NEW
    files/file-detail-model.ts   NEW   streams, "why this state"
    files/file-detail-model.test.ts NEW
    jobs/JobDetail.tsx           NEW
    jobs/job-detail-model.ts     NEW   step rows + reason extraction
    jobs/job-detail-model.test.ts NEW
    flows/FlowDetail.tsx         NEW
    flows/flow-graph-model.ts    NEW   definition -> drawable rows
    flows/flow-graph-model.test.ts NEW
    config/Config.tsx            NEW   tabs: workers, libraries, plugins, system
    config/config-model.ts       NEW   worker/schedule/trash form state
    config/config-model.test.ts  NEW
    Libraries.tsx / LibrarySetup.tsx / FlowPicker.tsx   moved under config/
    Activity.tsx / Overview.tsx + models                deleted in Task 10
```

---

### Task 1: Router foundation

The app has no router: `App.tsx` holds `useState<Screen>`. Everything else depends on this, so it lands first and keeps the existing screens working at temporary routes.

**Files:**
- Create: `packages/web/src/shell/route.ts`
- Create: `packages/web/src/shell/route.test.ts`
- Create: `packages/web/src/shell/useRoute.ts`
- Create: `packages/web/src/shell/Link.tsx`
- Modify: `packages/web/src/App.tsx` (replace `useState<Screen>` nav)

**Interfaces:**
- Produces:
  - `type Route = { name: 'watch' } | { name: 'diagnose' } | { name: 'files'; filters: FileFilters } | { name: 'file'; id: string } | { name: 'job'; id: string } | { name: 'flow'; id: string } | { name: 'config'; tab: ConfigTab } | { name: 'notFound'; path: string }`
  - `interface FileFilters { library: string | null; state: string | null; q: string | null }`
  - `type ConfigTab = 'workers' | 'libraries' | 'plugins' | 'system'`
  - `parseRoute(pathname: string, search: string): Route`
  - `formatRoute(route: Route): string`
  - `useRoute(): { route: Route; navigate: (to: string) => void }`
  - `Link(props: { to: string; children: ReactNode; className?: string }): JSX.Element`

- [ ] **Step 1: Write the failing test**

`packages/web/src/shell/route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from './route.js';

describe('parseRoute', () => {
  it('reads the four modes', () => {
    expect(parseRoute('/', '')).toEqual({ name: 'watch' });
    expect(parseRoute('/diagnose', '')).toEqual({ name: 'diagnose' });
    expect(parseRoute('/config', '')).toEqual({ name: 'config', tab: 'workers' });
    expect(parseRoute('/files', '')).toEqual({
      name: 'files',
      filters: { library: null, state: null, q: null },
    });
  });

  it('carries file filters in the query string, not in component state', () => {
    expect(parseRoute('/files', '?library=lib-1&state=failed&q=foundation')).toEqual({
      name: 'files',
      filters: { library: 'lib-1', state: 'failed', q: 'foundation' },
    });
  });

  it('reads object routes', () => {
    expect(parseRoute('/files/abc-123', '')).toEqual({ name: 'file', id: 'abc-123' });
    expect(parseRoute('/jobs/job-9', '')).toEqual({ name: 'job', id: 'job-9' });
    expect(parseRoute('/flows/flow-7', '')).toEqual({ name: 'flow', id: 'flow-7' });
  });

  it('names an unknown path rather than silently showing the default screen', () => {
    expect(parseRoute('/nope', '')).toEqual({ name: 'notFound', path: '/nope' });
  });

  it('round-trips every route through formatRoute', () => {
    const routes = [
      { name: 'watch' } as const,
      { name: 'diagnose' } as const,
      { name: 'file', id: 'abc-123' } as const,
      { name: 'job', id: 'job-9' } as const,
      { name: 'flow', id: 'flow-7' } as const,
      { name: 'config', tab: 'libraries' } as const,
      { name: 'files', filters: { library: 'lib-1', state: 'failed', q: 'x' } } as const,
    ];
    for (const route of routes) {
      const url = new URL(formatRoute(route), 'http://x');
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
  });

  it('omits empty filters from the formatted URL', () => {
    expect(formatRoute({ name: 'files', filters: { library: null, state: null, q: null } })).toBe(
      '/files',
    );
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run packages/web/src/shell/route.test.ts`
Expected: FAIL — `Cannot find module './route.js'`.

- [ ] **Step 3: Implement `route.ts`**

```ts
/**
 * URLs are the app's state, not a `useState` in the shell.
 *
 * Everything an operator wants to send to themselves later — a failing file,
 * one job's reasons, a filtered list — has to survive a reload and paste into
 * a message. That is why filters live in the query string and why every
 * object has its own path: the previous shell held the current screen in
 * component state, so nothing in this UI was linkable at all.
 */
export interface FileFilters {
  library: string | null;
  state: string | null;
  q: string | null;
}

export type ConfigTab = 'workers' | 'libraries' | 'plugins' | 'system';

export type Route =
  | { name: 'watch' }
  | { name: 'diagnose' }
  | { name: 'files'; filters: FileFilters }
  | { name: 'file'; id: string }
  | { name: 'job'; id: string }
  | { name: 'flow'; id: string }
  | { name: 'config'; tab: ConfigTab }
  | { name: 'notFound'; path: string };

const CONFIG_TABS: ConfigTab[] = ['workers', 'libraries', 'plugins', 'system'];

const isConfigTab = (raw: string | null): raw is ConfigTab =>
  raw !== null && (CONFIG_TABS as string[]).includes(raw);

export const parseRoute = (pathname: string, search: string): Route => {
  const params = new URLSearchParams(search);
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const segments = path.split('/').filter((part) => part.length > 0);

  if (segments.length === 0) return { name: 'watch' };
  if (segments.length === 1 && segments[0] === 'diagnose') return { name: 'diagnose' };

  if (segments[0] === 'config' && segments.length === 1) {
    const tab = params.get('tab');
    return { name: 'config', tab: isConfigTab(tab) ? tab : 'workers' };
  }

  if (segments[0] === 'files') {
    if (segments.length === 1) {
      return {
        name: 'files',
        filters: {
          library: params.get('library'),
          state: params.get('state'),
          q: params.get('q'),
        },
      };
    }
    if (segments.length === 2) return { name: 'file', id: segments[1] };
  }

  if (segments[0] === 'jobs' && segments.length === 2) return { name: 'job', id: segments[1] };
  if (segments[0] === 'flows' && segments.length === 2) return { name: 'flow', id: segments[1] };

  return { name: 'notFound', path };
};

export const formatRoute = (route: Route): string => {
  switch (route.name) {
    case 'watch':
      return '/';
    case 'diagnose':
      return '/diagnose';
    case 'file':
      return `/files/${route.id}`;
    case 'job':
      return `/jobs/${route.id}`;
    case 'flow':
      return `/flows/${route.id}`;
    case 'config':
      return route.tab === 'workers' ? '/config' : `/config?tab=${route.tab}`;
    case 'notFound':
      return route.path;
    case 'files': {
      const params = new URLSearchParams();
      if (route.filters.library !== null) params.set('library', route.filters.library);
      if (route.filters.state !== null) params.set('state', route.filters.state);
      if (route.filters.q !== null) params.set('q', route.filters.q);
      const query = params.toString();
      return query.length === 0 ? '/files' : `/files?${query}`;
    }
  }
};
```

Note the `config` default: `formatRoute({name:'config',tab:'workers'})` is `/config`, and `parseRoute('/config','')` returns tab `workers`, so the round-trip holds.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run packages/web/src/shell/route.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Implement `useRoute.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';
import { parseRoute, type Route } from './route.js';

/**
 * The History API, read the same way on every render.
 *
 * No routing library: the whole route table is seven patterns, and a library
 * would be more code than `route.ts`. `popstate` covers the back button;
 * `navigate` covers everything else.
 */
export const useRoute = (): { route: Route; navigate: (to: string) => void } => {
  const read = (): Route => parseRoute(window.location.pathname, window.location.search);
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const onPop = (): void => {
      setRoute(read());
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const navigate = useCallback((to: string): void => {
    window.history.pushState(null, '', to);
    setRoute(parseRoute(window.location.pathname, window.location.search));
  }, []);

  return { route, navigate };
};
```

- [ ] **Step 6: Implement `Link.tsx`**

```tsx
import type { ReactNode } from 'react';

/**
 * A real `<a href>` that pushes instead of reloading.
 *
 * It stays an anchor so middle-click, ctrl-click and "copy link address" all
 * behave — a button styled as a link silently loses those, and this UI's whole
 * point is that things are linkable.
 */
export const Link = (props: {
  to: string;
  children: ReactNode;
  className?: string;
  navigate: (to: string) => void;
}): JSX.Element => (
  <a
    href={props.to}
    className={props.className}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      props.navigate(props.to);
    }}
  >
    {props.children}
  </a>
);
```

- [ ] **Step 7: Switch `App.tsx` to routes**

Replace the `Screen` type, `SCREENS` array, and `useState<Screen>` with `useRoute()`. Nav entries become `<Link>`s to `/`, `/diagnose`, `/files`, `/config`, each with `aria-current="page"` when `route.name` matches. Render existing screens temporarily so the app keeps working:

```tsx
const { route, navigate } = useRoute();
// ...
<main>
  {route.name === 'watch' && <Overview client={props.client} live={live} onOverall={setOverall} />}
  {route.name === 'diagnose' && <Activity client={props.client} live={live} />}
  {route.name === 'files' && <Activity client={props.client} live={live} />}
  {route.name === 'config' && <Libraries client={props.client} live={live} />}
  {route.name === 'notFound' && <p>No screen for {route.path}.</p>}
</main>
```

Later tasks replace these one at a time.

- [ ] **Step 8: Add the SPA fallback so a deep link survives a reload**

The daemon serves the built bundle. A request for `/files/abc-123` must return `index.html`, not 404. Find the static handler in `packages/server/src/api/` and make any non-`/api/v1` GET that does not match a built asset return `index.html`. Add a server test asserting `GET /files/abc-123` returns HTML with status 200 and `GET /api/v1/nope` still returns a JSON 404.

- [ ] **Step 9: Run the full gate**

Run: `pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`
Expected: all green; licences 291.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/shell packages/web/src/App.tsx packages/server/src/api
git commit -m "feat(web): give the UI real URLs"
```

---

### Task 2: File priority endpoint

The UI needs to raise a file's priority; no endpoint exists. `/files/:id` has `requeue` and `hold` only, and there is no `PATCH /files/:id`.

**Files:**
- Modify: `packages/server/src/api/routes/files.ts`
- Modify: `packages/server/src/db/media-file-repo.ts` (add `setPriority`)
- Test: `packages/server/src/api/api.test.ts`

**Interfaces:**
- Produces: `POST /files/:id/priority` with body `{ priority: number }`, returning the updated file resource. Repo method `setPriority(id: string, priority: number): boolean` — returns false when no row matched.

- [ ] **Step 1: Write the failing test**

In `packages/server/src/api/api.test.ts`, beside the existing file-route tests:

```ts
it('raises a file priority so it is claimed next', async () => {
  const { app, db } = await harness();
  const fileId = seedFile(db, { path: '/library/shows/a.mkv', state: 'queued' });

  const response = await request(app, 'POST', `/api/v1/files/${fileId}/priority`, {
    priority: 10,
  });

  expect(response.status).toBe(200);
  expect((response.body as { priority: number }).priority).toBe(10);
  expect(readFileRow(db, fileId).priority).toBe(10);
});

it('refuses a priority that is not a finite number', async () => {
  const { app, db } = await harness();
  const fileId = seedFile(db, { path: '/library/shows/a.mkv', state: 'queued' });

  const response = await request(app, 'POST', `/api/v1/files/${fileId}/priority`, {
    priority: 'high',
  });

  expect(response.status).toBe(400);
  expect(readFileRow(db, fileId).priority).toBe(0);
});

it('answers 404 for a file that does not exist', async () => {
  const { app } = await harness();
  const response = await request(app, 'POST', '/api/v1/files/missing/priority', { priority: 1 });
  expect(response.status).toBe(404);
});
```

Use whatever harness/seed helpers the surrounding tests already use; match their names exactly rather than inventing new ones.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/server/src/api/api.test.ts -t priority`
Expected: FAIL with 404 on the first test (no such route).

- [ ] **Step 3: Add `setPriority` to the repo**

In `media-file-repo.ts`, beside the existing update statements:

```ts
const updatePriority = db.prepare('UPDATE media_file SET priority = ?, updated_at = ? WHERE id = ?');
```

and on the returned object:

```ts
  setPriority: (id: string, priority: number, nowMs: number): boolean =>
    updatePriority.run(priority, nowMs, id).changes > 0,
```

Add `setPriority` to the repo's exported interface.

- [ ] **Step 4: Add the route**

In `files.ts`, following the shape of the existing `requeue` route:

```ts
  {
    method: 'POST',
    path: '/files/:id/priority',
    handler: ({ params, body, ctx }) => {
      const raw = (body as { priority?: unknown } | null)?.priority;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new ApiError(400, 'invalid_priority', 'priority must be a finite number.');
      }
      const repo = createMediaFileRepo(ctx.db);
      if (!repo.setPriority(params.id, raw, Date.now())) {
        throw new ApiError(404, 'not_found', `No file with id ${params.id}.`);
      }
      const row = repo.byId(params.id);
      if (row === undefined) throw new ApiError(404, 'not_found', `No file with id ${params.id}.`);
      return toFileResource(row);
    },
  },
```

Match the surrounding code's error-construction style; if `ApiError` takes an object there, use that form.

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm vitest run packages/server/src/api/api.test.ts -t priority`
Expected: PASS, 3 tests.

- [ ] **Step 6: Full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src
git commit -m "feat(api): raise a file's priority over the API"
```

---

### Task 3: Files table

**Files:**
- Create: `packages/web/src/shell/virtual.ts`, `virtual.test.ts`
- Create: `packages/web/src/screens/files/files-model.ts`, `files-model.test.ts`
- Create: `packages/web/src/screens/files/Files.tsx`
- Modify: `packages/web/src/App.tsx` (route `files` → `<Files>`)

**Interfaces:**
- Consumes: `FileFilters`, `Route`, `Link`, `useRoute` from Task 1.
- Produces:
  - `interface FileRow { id: string; path: string; name: string; state: string; video: string; audio: string; sizeBytes: number; updatedAt: number }`
  - `toFileRows(items: ApiFile[]): FileRow[]`
  - `sortRows(rows: FileRow[], column: SortColumn, direction: 'asc' | 'desc'): FileRow[]`
  - `type SortColumn = 'name' | 'state' | 'size' | 'updated'`
  - `formatBytes(bytes: number): string`
  - `filtersToQuery(filters: FileFilters, limit: number, offset: number): string`
  - `visibleRange(input: { scrollTop: number; viewportHeight: number; rowHeight: number; count: number; overscan?: number }): { start: number; end: number }`

- [ ] **Step 1: Write the failing tests**

`packages/web/src/shell/virtual.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { visibleRange } from './virtual.js';

describe('visibleRange', () => {
  it('shows only the rows the viewport can hold, plus overscan', () => {
    expect(
      visibleRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2 }),
    ).toEqual({ start: 0, end: 7 });
  });

  it('moves the window as the list scrolls', () => {
    expect(
      visibleRange({ scrollTop: 400, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2 }),
    ).toEqual({ start: 18, end: 27 });
  });

  it('never runs past the end of the list', () => {
    expect(
      visibleRange({ scrollTop: 19_800, viewportHeight: 100, rowHeight: 20, count: 1000, overscan: 2 }),
    ).toEqual({ start: 988, end: 1000 });
  });

  it('handles an empty list without producing a negative range', () => {
    expect(visibleRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 20, count: 0 })).toEqual({
      start: 0,
      end: 0,
    });
  });
});
```

`packages/web/src/screens/files/files-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filtersToQuery, formatBytes, sortRows, toFileRows } from './files-model.js';

const apiFile = {
  id: 'f1',
  libraryId: 'lib-1',
  path: '/library/shows/Foundation (2021)/Season 2/S02E02.mkv',
  state: 'good',
  videoCodec: 'hevc',
  audioCodec: 'aac,eac3',
  sizeBytes: 1_900_000_000,
  updatedAt: 1_000,
};

describe('toFileRows', () => {
  it('shows the file name, keeping the full path for the title', () => {
    const [row] = toFileRows([apiFile]);
    expect(row.name).toBe('S02E02.mkv');
    expect(row.path).toBe(apiFile.path);
  });

  it('renders a missing codec as a dash rather than "null"', () => {
    const [row] = toFileRows([{ ...apiFile, videoCodec: null, audioCodec: null }]);
    expect(row.video).toBe('—');
    expect(row.audio).toBe('—');
  });
});

describe('sortRows', () => {
  const rows = toFileRows([
    { ...apiFile, id: 'b', path: '/x/b.mkv', sizeBytes: 300, updatedAt: 2 },
    { ...apiFile, id: 'a', path: '/x/a.mkv', sizeBytes: 100, updatedAt: 3 },
    { ...apiFile, id: 'c', path: '/x/c.mkv', sizeBytes: 200, updatedAt: 1 },
  ]);

  it('sorts by name ascending', () => {
    expect(sortRows(rows, 'name', 'asc').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by size descending', () => {
    expect(sortRows(rows, 'size', 'desc').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the array it was given', () => {
    const before = rows.map((r) => r.id);
    sortRows(rows, 'size', 'desc');
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1_900_000_000)).toBe('1.9 GB');
    expect(formatBytes(8_400_000_000_000)).toBe('8.4 TB');
  });
});

describe('filtersToQuery', () => {
  it('omits absent filters and always carries paging', () => {
    expect(filtersToQuery({ library: null, state: null, q: null }, 200, 0)).toBe(
      '?limit=200&offset=0',
    );
  });

  it('maps the UI filter names onto the API parameter names', () => {
    expect(filtersToQuery({ library: 'lib-1', state: 'failed', q: 'found' }, 200, 400)).toBe(
      '?libraryId=lib-1&state=failed&q=found&limit=200&offset=400',
    );
  });
});
```

Note the mapping the last test pins: the URL says `library`, the API says `libraryId`.

- [ ] **Step 2: Run and watch both fail**

Run: `pnpm vitest run packages/web/src/shell/virtual.test.ts packages/web/src/screens/files/files-model.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `virtual.ts`**

```ts
/**
 * Which slice of a long list is worth rendering.
 *
 * A library is 4,625 rows today and nothing says the next one is smaller, so
 * the table renders a window and pads it with two spacer rows. Pure, because
 * the arithmetic — not the scrolling — is what breaks.
 */
export const visibleRange = (input: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan?: number;
}): { start: number; end: number } => {
  const overscan = input.overscan ?? 6;
  if (input.count <= 0 || input.rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(input.scrollTop / input.rowHeight) - overscan;
  const visible = Math.ceil(input.viewportHeight / input.rowHeight) + overscan * 2;
  const start = Math.max(0, first);
  return { start, end: Math.min(input.count, start + visible) };
};
```

- [ ] **Step 4: Implement `files-model.ts`**

```ts
import type { FileFilters } from '../../shell/route.js';

export interface ApiFile {
  id: string;
  libraryId: string;
  path: string;
  state: string;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number;
  updatedAt: number;
}

export interface FileRow {
  id: string;
  path: string;
  name: string;
  state: string;
  video: string;
  audio: string;
  sizeBytes: number;
  updatedAt: number;
}

export type SortColumn = 'name' | 'state' | 'size' | 'updated';

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const toFileRows = (items: ApiFile[]): FileRow[] =>
  items.map((item) => ({
    id: item.id,
    path: item.path,
    name: basename(item.path),
    state: item.state,
    video: item.videoCodec ?? '—',
    audio: item.audioCodec ?? '—',
    sizeBytes: item.sizeBytes,
    updatedAt: item.updatedAt,
  }));

export const sortRows = (
  rows: FileRow[],
  column: SortColumn,
  direction: 'asc' | 'desc',
): FileRow[] => {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    switch (column) {
      case 'name':
        return sign * left.name.localeCompare(right.name);
      case 'state':
        return sign * left.state.localeCompare(right.state);
      case 'size':
        return sign * (left.sizeBytes - right.sizeBytes);
      case 'updated':
        return sign * (left.updatedAt - right.updatedAt);
    }
  });
};

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${UNITS[unit]}`;
};

/** The URL says `library`; the API says `libraryId`. This is the only place that knows. */
export const filtersToQuery = (filters: FileFilters, limit: number, offset: number): string => {
  const params = new URLSearchParams();
  if (filters.library !== null) params.set('libraryId', filters.library);
  if (filters.state !== null) params.set('state', filters.state);
  if (filters.q !== null) params.set('q', filters.q);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `?${params.toString()}`;
};
```

- [ ] **Step 5: Run and watch them pass**

Run: `pnpm vitest run packages/web/src/shell/virtual.test.ts packages/web/src/screens/files/files-model.test.ts`
Expected: PASS.

- [ ] **Step 6: Build `Files.tsx`**

A component that: reads `route.filters`; fetches `GET /files${filtersToQuery(filters, 200, offset)}`; holds `sort` in component state (a view preference, not a shareable fact — filters go in the URL, sort does not); renders a scroll container of fixed `2.25rem` rows using `visibleRange`, with a leading and trailing spacer `<div>` sized `start * rowHeight` and `(count - end) * rowHeight`; renders each row as a `<Link to={`/files/${row.id}`}>`. Filter controls call `navigate(formatRoute({ name: 'files', filters: next }))`.

Footer states `{total} files · {formatBytes(sum)} · {percent}% converged`.

Below `48rem`, rows become stacked cards (name on its own line, then state/codecs/size) via CSS in `styles.css`; no horizontal scroll.

Empty, loading, and error are three distinct renders: "No files match these filters" with a clear-filters link; a skeleton; and the error message with a Retry button.

- [ ] **Step 7: Route it and gate**

In `App.tsx`, `route.name === 'files'` renders `<Files client={props.client} filters={route.filters} navigate={navigate} />`.

Run: `pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`

- [ ] **Step 8: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): a files table that can hold a real library"
```

---

### Task 4: File detail — including "why is it in this state"

**Files:**
- Create: `packages/web/src/screens/files/file-detail-model.ts`, `file-detail-model.test.ts`
- Create: `packages/web/src/screens/files/FileDetail.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `formatBytes` from `files-model.ts`.
- Produces:
  - `interface StreamRow { index: number; kind: string; codec: string; detail: string; language: string; duration: string }`
  - `toStreamRows(probe: unknown): StreamRow[]`
  - `explainState(input: { state: string; signature: string | null; flowHash: string | null; attemptCount: number; lastJobReason: string | null; holdUntilMs: number | null; nowMs: number }): string`

- [ ] **Step 1: Write the failing test**

`packages/web/src/screens/files/file-detail-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { explainState, toStreamRows } from './file-detail-model.js';

describe('toStreamRows', () => {
  const probe = {
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'hevc',
        width: 1920,
        height: 1080,
        tags: { DURATION: '00:53:51.457000000' },
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
        channels: 2,
        tags: { language: 'eng', DURATION: '00:53:51.509000000' },
      },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'ita' } },
    ],
  };

  it('reads the duration from the DURATION tag, which is where mkv keeps it', () => {
    const rows = toStreamRows(probe);
    expect(rows[0].duration).toBe('00:53:51');
    expect(rows[0].detail).toBe('1080p');
  });

  it('describes audio by channel count and language', () => {
    const rows = toStreamRows(probe);
    expect(rows[1].detail).toBe('2ch');
    expect(rows[1].language).toBe('eng');
  });

  it('says und for a stream with no language rather than leaving it blank', () => {
    expect(toStreamRows(probe)[0].language).toBe('und');
  });

  it('returns nothing for a probe that could not be parsed', () => {
    expect(toStreamRows(null)).toEqual([]);
    expect(toStreamRows({ streams: 'nonsense' })).toEqual([]);
  });
});

describe('explainState', () => {
  const base = {
    signature: 'abc',
    flowHash: 'flow-1',
    attemptCount: 0,
    lastJobReason: null,
    holdUntilMs: null,
    nowMs: 1_000,
  };

  it('explains a converged file by its signature, not by silence', () => {
    expect(explainState({ ...base, state: 'good' })).toBe(
      'Converged. Its signature matches the flow this library uses, so there is nothing to do.',
    );
  });

  it('says why a queued file is queued when the flow moved underneath it', () => {
    expect(explainState({ ...base, state: 'queued', signature: null })).toBe(
      'Queued. It has no signature for the current flow — it has never run, or the flow changed.',
    );
  });

  it('leads with the failure reason, because that is the whole question', () => {
    expect(
      explainState({
        ...base,
        state: 'failed',
        attemptCount: 3,
        lastJobReason: 'the output ran 1.2s shorter than the original',
      }),
    ).toBe(
      'Failed after 3 attempts: the output ran 1.2s shorter than the original. It will not retry on its own.',
    );
  });

  it('says when a held file will come back', () => {
    expect(
      explainState({ ...base, state: 'held', holdUntilMs: 61_000, nowMs: 1_000 }),
    ).toBe('Held after a failed attempt. It will be retried in 1m.');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/screens/files/file-detail-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `file-detail-model.ts`**

```ts
/**
 * What a probe and a row actually mean, in words.
 *
 * "Why is this file like this" was the question every single time this week,
 * and it was answered with ffprobe and SQL because nothing in the product
 * would say it. The answer exists in the row; it just needed writing down.
 */
export interface StreamRow {
  index: number;
  kind: string;
  codec: string;
  detail: string;
  language: string;
  duration: string;
}

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  tags?: Record<string, string>;
}

/** mkv leaves `duration` unset on every stream and puts the real length in a tag. */
const streamDuration = (stream: ProbeStream): string => {
  const tag = stream.tags?.DURATION ?? stream.tags?.duration;
  if (tag === undefined) return '—';
  const [clock] = tag.split('.');
  return clock ?? '—';
};

const streamDetail = (stream: ProbeStream): string => {
  if (stream.codec_type === 'video') {
    return stream.height === undefined ? '—' : `${String(stream.height)}p`;
  }
  if (stream.codec_type === 'audio') {
    return stream.channels === undefined ? '—' : `${String(stream.channels)}ch`;
  }
  return '—';
};

export const toStreamRows = (probe: unknown): StreamRow[] => {
  const streams = (probe as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(streams)) return [];
  return (streams as ProbeStream[]).map((stream, position) => ({
    index: stream.index ?? position,
    kind: stream.codec_type ?? 'unknown',
    codec: stream.codec_name ?? 'unknown',
    detail: streamDetail(stream),
    language: stream.tags?.language ?? 'und',
    duration: streamDuration(stream),
  }));
};

const humanDelay = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m`;
  return `${String(Math.round(minutes / 60))}h`;
};

export const explainState = (input: {
  state: string;
  signature: string | null;
  flowHash: string | null;
  attemptCount: number;
  lastJobReason: string | null;
  holdUntilMs: number | null;
  nowMs: number;
}): string => {
  switch (input.state) {
    case 'good':
      return 'Converged. Its signature matches the flow this library uses, so there is nothing to do.';
    case 'queued':
      return input.signature === null
        ? 'Queued. It has no signature for the current flow — it has never run, or the flow changed.'
        : 'Queued. Its signature no longer matches the flow this library uses.';
    case 'failed':
      return `Failed after ${String(input.attemptCount)} attempts${
        input.lastJobReason === null ? '' : `: ${input.lastJobReason}`
      }. It will not retry on its own.`;
    case 'held':
      return input.holdUntilMs === null
        ? 'Held after a failed attempt. It will be retried.'
        : `Held after a failed attempt. It will be retried in ${humanDelay(
            input.holdUntilMs - input.nowMs,
          )}.`;
    case 'not_converging':
      return 'Not converging. The flow ran without changing it enough to converge, so it has been set aside.';
    default:
      return `State ${input.state}.`;
  }
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/web/src/screens/files/file-detail-model.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Build `FileDetail.tsx`**

Fetches `GET /files/:id` and `GET /jobs?fileId=:id&limit=20`. Renders path, state chip, `explainState(...)` prominently near the top, `formatBytes(sizeBytes)`, mtime; the stream table from `toStreamRows(probeJson)`; job history as `<Link to={`/jobs/${id}`}>` rows with outcome and one-line reason.

Actions: **Requeue** (`POST /files/:id/requeue`), **Raise priority** (`POST /files/:id/priority` with `{ priority: 10 }`), **Dry-run** (`POST /flows/:flowId/dry-run` with the file id, rendering the returned reasons). Each disables while in flight and reports failure inline without navigating away.

On desktop this renders beside the Files table; on mobile it is a full screen. Same URL either way.

- [ ] **Step 6: Route it, gate, commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): a file view that says why the file is that way"
```

---

### Task 5: Job detail

**Files:**
- Create: `packages/web/src/screens/jobs/job-detail-model.ts`, `job-detail-model.test.ts`
- Create: `packages/web/src/screens/jobs/JobDetail.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Produces:
  - `interface StepRow { seq: number; label: string; outcome: 'ok' | 'failed' | 'running'; durationMs: number; reason: string | null }`
  - `toStepRows(steps: ApiStep[]): StepRow[]`
  - `pluginLabel(pluginId: string): string`

- [ ] **Step 1: Write the failing test**

`packages/web/src/screens/jobs/job-detail-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pluginLabel, toStepRows } from './job-detail-model.js';

describe('pluginLabel', () => {
  it('reads a plugin id as words', () => {
    expect(pluginLabel('trawlarr:verifyOutput')).toBe('Verify Output');
    expect(pluginLabel('tdarr:ffmpegCommandSetContainer')).toBe('Ffmpeg Command Set Container');
  });

  it('leaves an id it cannot parse alone', () => {
    expect(pluginLabel('weird')).toBe('weird');
  });
});

describe('toStepRows', () => {
  it('keeps the engine reason whole — it is the reason anyone opened this', () => {
    const reason =
      'Running ffmpeg: 1 stream(s) were removed by the flow; output position 1 would carry input stream 2';
    const rows = toStepRows([
      { seq: 1, pluginId: 'trawlarr:execute', outputNumber: 1, durationMs: 107_000, logExcerpt: reason },
    ]);
    expect(rows[0].reason).toBe(reason);
    expect(rows[0].label).toBe('Execute');
    expect(rows[0].outcome).toBe('ok');
  });

  it('marks output 2 as the failure it is', () => {
    const rows = toStepRows([
      {
        seq: 2,
        pluginId: 'trawlarr:verifyOutput',
        outputNumber: 2,
        durationMs: 31,
        logExcerpt: "the output's container runs 3231.5s against the original's 3232.7s",
      },
    ]);
    expect(rows[0].outcome).toBe('failed');
  });

  it('treats a step with no output number yet as still running', () => {
    const rows = toStepRows([
      { seq: 3, pluginId: 'trawlarr:execute', outputNumber: null, durationMs: 0, logExcerpt: null },
    ]);
    expect(rows[0].outcome).toBe('running');
    expect(rows[0].reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/screens/jobs/job-detail-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `job-detail-model.ts`**

```ts
/**
 * A job's steps, with the engine's own sentences kept intact.
 *
 * `Running ffmpeg: <reasons>` and `Skipping ffmpeg: <reason>` are the most
 * useful strings this system produces — they name the exact argument or
 * stream that made a file worth rewriting. This module's only real job is to
 * carry them to the screen unshortened.
 */
export interface ApiStep {
  seq: number;
  pluginId: string;
  outputNumber: number | null;
  durationMs: number;
  logExcerpt: string | null;
}

export interface StepRow {
  seq: number;
  label: string;
  outcome: 'ok' | 'failed' | 'running';
  durationMs: number;
  reason: string | null;
}

export const pluginLabel = (pluginId: string): string => {
  const name = pluginId.includes(':') ? pluginId.slice(pluginId.indexOf(':') + 1) : pluginId;
  if (!/[a-z][A-Z]/.test(name) && name === name.toLowerCase()) return pluginId.includes(':') ? capitalise(name) : name;
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .map(capitalise)
    .join(' ');
};

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** Output 2 is the failure branch by convention throughout the flow contract. */
export const toStepRows = (steps: ApiStep[]): StepRow[] =>
  steps.map((step) => ({
    seq: step.seq,
    label: pluginLabel(step.pluginId),
    outcome: step.outputNumber === null ? 'running' : step.outputNumber === 2 ? 'failed' : 'ok',
    durationMs: step.durationMs,
    reason: step.logExcerpt,
  }));
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/web/src/screens/jobs/job-detail-model.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Build `JobDetail.tsx`**

Fetches `GET /jobs/:id`. Renders the file (as a `<Link>` back to `/files/:fileId`), the job state and timing, then the step list from `toStepRows`. **Reasons render at full width in a monospace block, never truncated and never behind a disclosure.** A "Full log" button fetches `GET /jobs/:id/log` and shows it in a scrollable `<pre>`.

While the job is running, overlay `live.jobs[jobId]` for percent, stage, and the log tail — and only those. Everything else comes from the fetch.

- [ ] **Step 6: Route it, gate, commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): show a job's steps and the engine's reasons"
```

---

### Task 6: Diagnose — problems grouped by cause

**Files:**
- Create: `packages/web/src/screens/diagnose/diagnose-model.ts`, `diagnose-model.test.ts`
- Create: `packages/web/src/screens/diagnose/Diagnose.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `ApiFile` from `files-model.ts`.
- Produces:
  - `interface ProblemGroup { key: string; title: string; reason: string; files: ApiFile[]; totalBytes: number }`
  - `groupProblems(input: { files: ApiFile[]; reasons: Record<string, string> }): ProblemGroup[]`
  - `normaliseReason(reason: string): string`

- [ ] **Step 1: Write the failing test**

`packages/web/src/screens/diagnose/diagnose-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { groupProblems, normaliseReason } from './diagnose-model.js';

const file = (id: string, state: string, sizeBytes: number) => ({
  id,
  libraryId: 'lib-1',
  path: `/library/shows/${id}.mkv`,
  state,
  videoCodec: 'hevc',
  audioCodec: 'aac',
  sizeBytes,
  updatedAt: 1,
});

describe('normaliseReason', () => {
  it('strips the numbers so one cause does not become three problems', () => {
    expect(
      normaliseReason("the output's container runs 3231.5s against the original's 3232.7s"),
    ).toBe("the output's container runs Ns against the original's Ns");
  });

  it('leaves a reason with no numbers untouched', () => {
    expect(normaliseReason('replacement was larger than the original')).toBe(
      'replacement was larger than the original',
    );
  });
});

describe('groupProblems', () => {
  it('makes three files failing for one reason ONE problem', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200), file('c', 'failed', 300)],
      reasons: {
        a: "the output's container runs 3231.5s against the original's 3232.7s",
        b: "the output's container runs 3263.2s against the original's 3265.2s",
        c: "the output's container runs 3519.6s against the original's 3521.9s",
      },
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(3);
    expect(groups[0].totalBytes).toBe(600);
  });

  it('keeps genuinely different causes apart', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200)],
      reasons: { a: 'replacement was larger', b: 'could not read the file' },
    });
    expect(groups).toHaveLength(2);
  });

  it('puts the biggest problem first', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100), file('b', 'failed', 200), file('c', 'failed', 200)],
      reasons: { a: 'small problem', b: 'big problem', c: 'big problem' },
    });
    expect(groups[0].files).toHaveLength(2);
  });

  it('ignores converged files entirely', () => {
    const groups = groupProblems({
      files: [file('a', 'good', 100), file('b', 'good', 200)],
      reasons: {},
    });
    expect(groups).toEqual([]);
  });

  it('groups files with no recorded reason together rather than dropping them', () => {
    const groups = groupProblems({
      files: [file('a', 'failed', 100)],
      reasons: {},
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('No reason was recorded for this failure.');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/screens/diagnose/diagnose-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `diagnose-model.ts`**

```ts
import type { ApiFile } from '../files/files-model.js';

/**
 * Problems, not rows.
 *
 * Three files failing because a removed audio track was the longest stream is
 * ONE problem with three files. Read as three separate failures it took days
 * to see; read as one it is obvious. The grouping key is the engine's own
 * reason with its numbers removed, because the numbers are what differ
 * between files that share a cause.
 */
export interface ProblemGroup {
  key: string;
  title: string;
  reason: string;
  files: ApiFile[];
  totalBytes: number;
}

const UNTROUBLED = new Set(['good']);
const NO_REASON = 'No reason was recorded for this failure.';

export const normaliseReason = (reason: string): string => reason.replace(/\d+(\.\d+)?/g, 'N');

const titleFor = (state: string): string => {
  switch (state) {
    case 'failed':
      return 'Failed';
    case 'held':
      return 'Held after a failed attempt';
    case 'not_converging':
      return 'Not converging';
    default:
      return 'Needs attention';
  }
};

export const groupProblems = (input: {
  files: ApiFile[];
  reasons: Record<string, string>;
}): ProblemGroup[] => {
  const groups = new Map<string, ProblemGroup>();

  for (const file of input.files) {
    if (UNTROUBLED.has(file.state)) continue;
    const reason = input.reasons[file.id] ?? NO_REASON;
    const key = `${file.state}::${normaliseReason(reason)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        title: titleFor(file.state),
        reason,
        files: [file],
        totalBytes: file.sizeBytes,
      });
    } else {
      existing.files.push(file);
      existing.totalBytes += file.sizeBytes;
    }
  }

  return [...groups.values()].sort((left, right) => right.files.length - left.files.length);
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/web/src/screens/diagnose/diagnose-model.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Build `Diagnose.tsx`**

Fetches non-good files (`GET /files?state=failed`, `held`, `not_converging`), then for each file its most recent job's failure reason (`GET /jobs?fileId=&limit=1`), and passes both to `groupProblems`.

Each group renders: title, the reason verbatim, the file count and `formatBytes(totalBytes)`, up to five file `<Link>`s with "and N more", and two actions — **Inspect** (navigates to `/files?state=<state>`) and **Requeue all N**.

Requeue-all issues N sequential `POST /files/:id/requeue` calls, shows progress, and on partial failure reports which files failed rather than claiming success.

**When there are no groups**, render "Nothing needs you — both libraries are converged" plus a link to `/files`. This is the steady state and must look deliberate, never like a screen that failed to load. A fetch error renders differently again, with the message and a retry.

- [ ] **Step 6: Route it, gate, commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): group failures by cause instead of listing rows"
```

---

### Task 7: Watch

**Files:**
- Create: `packages/web/src/screens/watch/watch-model.ts`, `watch-model.test.ts`
- Create: `packages/web/src/screens/watch/Watch.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `LiveState`, `LiveJob` from `api/events.ts`; `formatBytes` from `files-model.ts`.
- Produces:
  - `interface RunningRow { jobId: string; fileId: string; name: string; percent: number | null; stage: string; workerId: string }`
  - `toRunningRows(live: LiveState): RunningRow[]`
  - `interface IdleReason { headline: string; detail: string; action: { label: string; to: string } | null }`
  - `explainIdle(input: { queued: number; workers: number; converged: boolean; withinWindow: boolean }): IdleReason`
  - `summarise24h(jobs: Job24h[]): { encoded: number; skipped: number; failed: number }`

- [ ] **Step 1: Write the failing test**

`packages/web/src/screens/watch/watch-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { initialLiveState } from '../../api/events.js';
import { explainIdle, summarise24h, toRunningRows } from './watch-model.js';

describe('toRunningRows', () => {
  it('shows the file name and its live progress', () => {
    const rows = toRunningRows({
      ...initialLiveState,
      jobs: {
        j1: {
          jobId: 'j1',
          fileId: 'f1',
          libraryId: 'lib-1',
          path: '/library/shows/Foundation/S02E02.mkv',
          workerId: 'w1',
          pid: 10,
          percent: 61,
          stage: 'Execute',
          steps: [],
          log: [],
        },
      },
    });
    expect(rows).toEqual([
      {
        jobId: 'j1',
        fileId: 'f1',
        name: 'S02E02.mkv',
        percent: 61,
        stage: 'Execute',
        workerId: 'w1',
      },
    ]);
  });

  it('is empty when nothing is running', () => {
    expect(toRunningRows(initialLiveState)).toEqual([]);
  });
});

describe('explainIdle', () => {
  it('distinguishes converged from paused — they must never read alike', () => {
    expect(
      explainIdle({ queued: 0, workers: 0, converged: true, withinWindow: true }).headline,
    ).toBe('Everything is converged');

    const paused = explainIdle({ queued: 4507, workers: 0, converged: false, withinWindow: true });
    expect(paused.headline).toBe('Nothing will start');
    expect(paused.detail).toBe('4507 files are queued, but worker count is 0.');
    expect(paused.action).toEqual({ label: 'Set workers', to: '/config?tab=workers' });
  });

  it('names the schedule window when that is what is holding work back', () => {
    const outside = explainIdle({ queued: 12, workers: 1, converged: false, withinWindow: false });
    expect(outside.headline).toBe('Outside the schedule window');
    expect(outside.action).toEqual({ label: 'Change the window', to: '/config?tab=system' });
  });

  it('says work is starting when there is nothing wrong at all', () => {
    expect(
      explainIdle({ queued: 5, workers: 1, converged: false, withinWindow: true }).headline,
    ).toBe('Waiting for a worker');
  });
});

describe('summarise24h', () => {
  it('separates real encodes from skips, because that is the whole question', () => {
    expect(
      summarise24h([
        { state: 'succeeded', ranFfmpeg: true },
        { state: 'succeeded', ranFfmpeg: false },
        { state: 'succeeded', ranFfmpeg: false },
        { state: 'failed', ranFfmpeg: true },
      ]),
    ).toEqual({ encoded: 1, skipped: 2, failed: 1 });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/screens/watch/watch-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `watch-model.ts`**

```ts
import type { LiveState } from '../../api/events.js';

/**
 * What is happening, and — far more often on a healthy install — why nothing
 * is.
 *
 * The steady state of this system is "converged, workers 0, nothing running".
 * A screen that renders that identically to a stall or a fetch failure is
 * worse than no screen, so idleness is explained rather than left blank.
 */
export interface RunningRow {
  jobId: string;
  fileId: string;
  name: string;
  percent: number | null;
  stage: string;
  workerId: string;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const toRunningRows = (live: LiveState): RunningRow[] =>
  Object.values(live.jobs).map((job) => ({
    jobId: job.jobId,
    fileId: job.fileId,
    name: basename(job.path),
    percent: job.percent,
    stage: job.stage,
    workerId: job.workerId,
  }));

export interface IdleReason {
  headline: string;
  detail: string;
  action: { label: string; to: string } | null;
}

export const explainIdle = (input: {
  queued: number;
  workers: number;
  converged: boolean;
  withinWindow: boolean;
}): IdleReason => {
  if (input.converged && input.queued === 0) {
    return {
      headline: 'Everything is converged',
      detail: 'No file needs work. Nothing will run until a file changes or a flow does.',
      action: null,
    };
  }
  if (input.workers === 0) {
    return {
      headline: 'Nothing will start',
      detail: `${String(input.queued)} files are queued, but worker count is 0.`,
      action: { label: 'Set workers', to: '/config?tab=workers' },
    };
  }
  if (!input.withinWindow) {
    return {
      headline: 'Outside the schedule window',
      detail: `${String(input.queued)} files are queued and will run when the window opens.`,
      action: { label: 'Change the window', to: '/config?tab=system' },
    };
  }
  return {
    headline: 'Waiting for a worker',
    detail: `${String(input.queued)} files are queued.`,
    action: null,
  };
};

export interface Job24h {
  state: string;
  ranFfmpeg: boolean;
}

export const summarise24h = (jobs: Job24h[]): {
  encoded: number;
  skipped: number;
  failed: number;
} => {
  let encoded = 0;
  let skipped = 0;
  let failed = 0;
  for (const job of jobs) {
    if (job.state === 'failed') failed += 1;
    else if (job.ranFfmpeg) encoded += 1;
    else skipped += 1;
  }
  return { encoded, skipped, failed };
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/web/src/screens/watch/watch-model.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Build `Watch.tsx`**

Sections, in order: **Running** (from `toRunningRows`, each with a progress bar, stage, worker, and links to file and job — or `explainIdle(...)` when empty); **Libraries** (from `GET /libraries` and `/libraries/:id/stats`, a convergence bar each); **Last 24 hours** (from `GET /jobs?limit=500`, filtered to the last 24h, through `summarise24h`); **Runtime** (worker counts from `GET /workers`, hardware from `GET /system/health`, window from `GET /system/schedule`).

Re-fetch each section when its `live.staleness` counter changes — `libraries` for library stats, `jobs` for the 24h counters, `workers` for runtime. Do not read durable facts out of live events.

`ranFfmpeg` is derived from the job's steps: a `trawlarr:execute` step whose `logExcerpt` starts with `Running ffmpeg` counts as an encode, one starting `Skipping ffmpeg` counts as a skip. If the job list endpoint does not return steps, fetch them for the 24h window only, and cap at 500 jobs.

- [ ] **Step 6: Route it, gate, commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): a Watch screen that explains being idle"
```

---

### Task 8: Configure

**Files:**
- Create: `packages/web/src/screens/config/config-model.ts`, `config-model.test.ts`
- Create: `packages/web/src/screens/config/Config.tsx`
- Move: `Libraries.tsx`, `LibrarySetup.tsx`, `FlowPicker.tsx`, `library-form-model.ts(+test)` into `screens/config/`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Produces:
  - `parseWorkerCount(raw: string): { ok: true; value: number } | { ok: false; message: string }`
  - `parseWindow(raw: string): { ok: true; minutes: number } | { ok: false; message: string }`
  - `formatWindow(minutes: number): string`

- [ ] **Step 1: Write the failing test**

`packages/web/src/screens/config/config-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatWindow, parseWindow, parseWorkerCount } from './config-model.js';

describe('parseWorkerCount', () => {
  it('accepts zero, which is how work is stopped', () => {
    expect(parseWorkerCount('0')).toEqual({ ok: true, value: 0 });
  });

  it('refuses a negative or fractional count', () => {
    expect(parseWorkerCount('-1').ok).toBe(false);
    expect(parseWorkerCount('1.5').ok).toBe(false);
  });

  it('refuses text', () => {
    expect(parseWorkerCount('lots')).toEqual({
      ok: false,
      message: 'Enter a whole number of workers.',
    });
  });
});

describe('parseWindow', () => {
  it('reads HH:MM as minutes past midnight', () => {
    expect(parseWindow('02:30')).toEqual({ ok: true, minutes: 150 });
    expect(parseWindow('00:00')).toEqual({ ok: true, minutes: 0 });
  });

  it('refuses an impossible clock time', () => {
    expect(parseWindow('25:00').ok).toBe(false);
    expect(parseWindow('02:60').ok).toBe(false);
  });

  it('round-trips through formatWindow', () => {
    expect(formatWindow(150)).toBe('02:30');
    expect(formatWindow(0)).toBe('00:00');
  });
});
```

The schedule API stores minutes, not `HH:MM` — this conversion is the whole reason the model exists.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/screens/config/config-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config-model.ts`**

```ts
/**
 * Form values, parsed once and in one place.
 *
 * The schedule API speaks MINUTES PAST MIDNIGHT and the control speaks
 * `HH:MM`; getting that wrong silently sets a window nobody asked for, which
 * has already happened once by hand.
 */
export const parseWorkerCount = (
  raw: string,
): { ok: true; value: number } | { ok: false; message: string } => {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, message: 'Enter a whole number of workers.' };
  }
  return { ok: true, value };
};

export const parseWindow = (
  raw: string,
): { ok: true; minutes: number } | { ok: false; message: string } => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (match === null) return { ok: false, message: 'Use HH:MM, for example 02:30.' };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return { ok: false, message: 'That is not a time of day.' };
  return { ok: true, minutes: hours * 60 + minutes };
};

export const formatWindow = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/web/src/screens/config/config-model.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Build `Config.tsx` with four tabs**

`?tab=` selects; default `workers`.

- **workers** — transcode and health counts from `GET /workers`, saved with `PUT /workers/counts`. Print beneath the control, as static copy: *"Raising transcode workers from 1 to 3 measurably reduced throughput on this hardware (6 vCPU, one GPU)."*
- **libraries** — the moved `Libraries.tsx`/`LibrarySetup.tsx`, plus **+ Add library**. Each library links to its flow at `/flows/:id`.
- **plugins** — sources from `GET /plugins/sources` with a **Sync** button per source.
- **system** — schedule window (`GET`/`PUT /system/schedule`, via `parseWindow`/`formatWindow`), trash retention (`GET`/`PUT /system/settings`) with current trash size and a **Purge now** button (`POST /system/maintenance/trash-purge`), and a read-only hardware/ffmpeg block from `GET /system/health`.

Every write shows a saving state, reports failure inline, and re-fetches on success.

- [ ] **Step 6: Route it, gate, commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): settings you can change without curl"
```

---

### Task 9: Flow detail, read-only

**Files:**
- Create: `packages/web/src/screens/flows/flow-graph-model.ts`, `flow-graph-model.test.ts`
- Create: `packages/web/src/screens/flows/FlowDetail.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Produces:
  - `interface GraphRow { depth: number; nodeId: string; pluginId: string; branchLabel: string | null; inputs: Array<{ key: string; value: string }> }`
  - `toGraphRows(definition: FlowDefinition): GraphRow[]`
  - `type FlowDefinition = { nodes: Array<{ id: string; pluginId: string; inputs?: Record<string, unknown> }>; edges: Array<{ fromNodeId: string; outputNumber: number; toNodeId: string }> }`

- [ ] **Step 1: Write the failing test**

`packages/web/src/screens/flows/flow-graph-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toGraphRows } from './flow-graph-model.js';

const definition = {
  nodes: [
    { id: 'start', pluginId: 'trawlarr:start' },
    { id: 'check', pluginId: 'tdarr:checkVideoCodec' },
    { id: 'encoder', pluginId: 'tdarr:ffmpegCommandSetVideoEncoder' },
    { id: 'muxqueue', pluginId: 'tdarr:ffmpegCommandCustomArguments' },
    { id: 'audio', pluginId: 'tdarr:ffmpegCommandEnsureAudioStream', inputs: { language: 'eng' } },
  ],
  edges: [
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
    { fromNodeId: 'check', outputNumber: 1, toNodeId: 'audio' },
    { fromNodeId: 'check', outputNumber: 2, toNodeId: 'encoder' },
    { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'muxqueue' },
    { fromNodeId: 'muxqueue', outputNumber: 1, toNodeId: 'audio' },
  ],
};

describe('toGraphRows', () => {
  it('walks from start and indents each branch', () => {
    const rows = toGraphRows(definition);
    expect(rows.map((r) => r.nodeId)).toEqual(['start', 'check', 'audio', 'encoder', 'muxqueue']);
    expect(rows.find((r) => r.nodeId === 'encoder')?.depth).toBe(2);
  });

  it('labels which branch a node hangs off — the muxqueue bug was exactly this', () => {
    const rows = toGraphRows(definition);
    expect(rows.find((r) => r.nodeId === 'encoder')?.branchLabel).toBe('output 2');
    expect(rows.find((r) => r.nodeId === 'audio')?.branchLabel).toBe('output 1');
  });

  it('shows a node visited twice only once', () => {
    expect(toGraphRows(definition).filter((r) => r.nodeId === 'audio')).toHaveLength(1);
  });

  it('renders inputs as readable pairs', () => {
    expect(toGraphRows(definition).find((r) => r.nodeId === 'audio')?.inputs).toEqual([
      { key: 'language', value: 'eng' },
    ]);
  });

  it('survives a definition with no start node rather than throwing', () => {
    expect(toGraphRows({ nodes: [], edges: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/screens/flows/flow-graph-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `flow-graph-model.ts`**

```ts
/**
 * A flow, drawn.
 *
 * "Why did this file get rewritten" is nearly always a question about the
 * graph. The `-max_muxing_queue_size` defect — one node on the wrong branch
 * of a codec check, which queued about 9.2 TB of pointless rewrites — is
 * obvious when the branches are drawn and was invisible in the JSON for days.
 */
export interface FlowDefinition {
  nodes: Array<{ id: string; pluginId: string; inputs?: Record<string, unknown> }>;
  edges: Array<{ fromNodeId: string; outputNumber: number; toNodeId: string }>;
}

export interface GraphRow {
  depth: number;
  nodeId: string;
  pluginId: string;
  branchLabel: string | null;
  inputs: Array<{ key: string; value: string }>;
}

export const toGraphRows = (definition: FlowDefinition): GraphRow[] => {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const targets = new Set(definition.edges.map((edge) => edge.toNodeId));
  const root =
    definition.nodes.find((node) => !targets.has(node.id))?.id ?? definition.nodes[0]?.id;
  if (root === undefined) return [];

  const rows: GraphRow[] = [];
  const seen = new Set<string>();

  const walk = (nodeId: string, depth: number, branchLabel: string | null): void => {
    if (seen.has(nodeId)) return;
    const node = byId.get(nodeId);
    if (node === undefined) return;
    seen.add(nodeId);
    rows.push({
      depth,
      nodeId,
      pluginId: node.pluginId,
      branchLabel,
      inputs: Object.entries(node.inputs ?? {}).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      })),
    });
    const outgoing = definition.edges
      .filter((edge) => edge.fromNodeId === nodeId)
      .sort((left, right) => left.outputNumber - right.outputNumber);
    for (const edge of outgoing) {
      walk(edge.toNodeId, depth + 1, `output ${String(edge.outputNumber)}`);
    }
  };

  walk(root, 0, null);
  return rows;
};
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/web/src/screens/flows/flow-graph-model.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Build `FlowDetail.tsx`**

Fetches `GET /flows/:id`. Renders the name, hash, and the libraries using it; the graph from `toGraphRows` as an indented list with branch labels and inputs; a **Copy JSON** button; and the sentence: *"Changing this flow changes its hash and re-queues every file that uses it. Flows are edited over the API or CLI, deliberately."*

No edit controls. Flow editing is explicitly out of scope for this plan.

- [ ] **Step 6: Route it, gate, commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): draw a flow so a misplaced node is visible"
```

---

### Task 10: Remove the absorbed screens and finish the responsive pass

**Files:**
- Delete: `packages/web/src/screens/Activity.tsx`, `activity-model.ts`, `activity-model.test.ts`, `Overview.tsx`, `overview-model.ts`, `overview-model.test.ts`
- Modify: `packages/web/src/App.tsx`, `packages/web/src/styles.css`

- [ ] **Step 1: Confirm nothing imports the old screens**

Run: `grep -rn "Activity\|Overview" packages/web/src --include=*.tsx --include=*.ts`
Expected: only `App.tsx`, if anything.

- [ ] **Step 2: Delete them and simplify `App.tsx`**

`App.tsx` renders exactly: `watch → <Watch>`, `diagnose → <Diagnose>`, `files → <Files>`, `file → <FileDetail>`, `job → <JobDetail>`, `flow → <FlowDetail>`, `config → <Config>`, `notFound → <NotFound>`.

The overall convergence figure in the header now comes from the libraries fetch rather than an `onOverall` callback from a child; drop the `onOverall` prop and the `overall` state with it.

- [ ] **Step 3: Responsive audit**

In `styles.css`, add a single `@media (max-width: 48rem)` block that turns every table into stacked cards, makes detail views full-screen rather than side panels, and sets a minimum touch target of `2.75rem` on all controls. Verify no primary content scrolls horizontally at 380px wide.

Check every action is reachable without hover: any control that only appears on `:hover` must also appear on `:focus-within` or be permanently visible.

- [ ] **Step 4: Full gate**

Run: `pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`
Expected: all green; licences 291. Test count must have grown by the ~40 model tests this plan adds and lost the Activity/Overview model tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src
git commit -m "refactor(web): retire the three-screen shell"
```

---

## Self-review notes

- **Spec coverage.** Four modes → Tasks 6–9; shared object views → Tasks 4, 5, 9; router and URLs → Task 1; two-layer data → Tasks 5 and 7 (live overlay only); Files table with virtualisation → Task 3; Diagnose grouping → Task 6; idle-state explanation → Task 7; writes (requeue, priority, workers, dry-run) → Tasks 2, 4, 6, 8; responsive → every screen task plus Task 10; migration → Tasks 8 and 10; out-of-scope items are not implemented anywhere.
- **Priority gap.** The spec promises "raise priority" and no endpoint existed. Task 2 adds `POST /files/:id/priority`; it is the only server change in this plan.
- **No bulk requeue.** Task 6 issues N calls and reports partial failure, because the API has no bulk route and inventing one is out of scope.
- **Type consistency.** `ApiFile` is defined once in `files-model.ts` and imported by `diagnose-model.ts`. `formatBytes` is defined once in `files-model.ts` and imported by Tasks 4, 6, 7. `FileFilters` and `Route` come from `shell/route.ts` throughout. `LiveState`/`LiveJob` are imported from the existing `api/events.ts` and never redefined.
