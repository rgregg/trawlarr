# Trawlarr P0–P1 (Foundations + Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trawlarr monorepo foundations and a flow engine that runs unmodified Tdarr community flow plugins against real media files from a CLI, with no UI.

**Architecture:** A pnpm/TypeScript monorepo. `@trawlarr/plugin-api` declares the interoperability contract as types. `@trawlarr/core` holds pure domain logic (file identity, probe facts, signature, ledger) with zero IO. `@trawlarr/engine` hosts third-party CommonJS plugins in a controlled module sandbox, builds and compiles an ffmpeg command cooperatively across plugins, and walks the flow graph. `@trawlarr/server` contributes only its SQLite layer in this phase.

**Tech Stack:** Node 22 LTS, pnpm 9, TypeScript 5.x (ESM, `module: nodenext`), vitest, better-sqlite3, eslint + typescript-eslint + prettier, ffmpeg/ffprobe on PATH.

**Source spec:** `docs/superpowers/specs/2026-08-10-trawlarr-design.md`. Where this plan and the spec disagree, the spec wins — report the discrepancy rather than silently diverging.

## Global Constraints

Every task's requirements implicitly include this section.

- **License: MIT.** Every package's `package.json` sets `"license": "MIT"`. A root `LICENSE` file contains the MIT text with copyright `Ryan Gregg`.
- **No code, comment, or type file is copied from Tdarr, `Tdarr_Plugins`, or Unmanic.** Type declarations are written independently from the field names and signatures required for interoperability. If you find yourself pasting, stop.
- **No third-party plugin source is committed.** Plugin corpora are fetched into `cache/` (gitignored) at test time only.
- **`@trawlarr/core` performs no IO.** No `node:fs`, no `node:child_process`, no network, no clock reads except via an injected `nowMs` parameter. This is what makes it testable and is enforced by a lint rule in Task 1.
- **Upstream misspellings are preserved verbatim** in contract-facing types: `overallOuputArguments` (not `overallOutputArguments`) and `lastSuccesfulPlugin` (not `lastSuccessfulPlugin`). These are part of the wire contract. Add a comment saying so at each site.
- **Classic plugins are unsupported.** `installClassicPluginDeps` exists on the args object and always rejects.
- **TDD, always.** Write the failing test, watch it fail for the right reason, implement minimally, watch it pass, commit. A test that has never failed has never been verified.
- **Node version floor: 22.** `engines.node` is `">=22"` in every package.
- **All timestamps are integer milliseconds since epoch (`nowMs`)**, passed in explicitly. Never call `Date.now()` inside `core`.

---

## File Structure

### `packages/plugin-api` — the contract, types only

| File | Responsibility |
| --- | --- |
| `src/details.ts` | `PluginDetails`, `PluginInput`, `PluginInputUi`, output descriptors |
| `src/file-object.ts` | `PluginFileObject`, `ProbeData`, `ProbeStream`, `ProbeFormat`, legacy status enums |
| `src/ffmpeg.ts` | `FfmpegCommand`, `FfmpegCommandStream` |
| `src/args.ts` | `PluginInputArgs`, `PluginOutputArgs`, `RunVariables`, `PluginDeps`, `ConfigVars` |
| `src/module.ts` | `PluginModule` — the shape of a loaded plugin |
| `src/index.ts` | Re-exports |

### `packages/core` — pure domain

| File | Responsibility |
| --- | --- |
| `src/canonical-json.ts` | Deterministic JSON serialisation + `sha256Hex` |
| `src/identity.ts` | File identity keys and match resolution |
| `src/facts.ts` | Probe fact extraction, equivalence, hashing |
| `src/signature.ts` | Flow definition hash, ledger signature |
| `src/ledger.ts` | Ledger state machine: known-good, run outcomes, backoff, requeue |
| `src/flow.ts` | `FlowDefinition` graph types and structural validation |
| `src/ffmpeg-command.ts` | `ffmpegCommand` lifecycle and guards (pure) |
| `src/ffmpeg-compile.ts` | `FfmpegCommand` → argv (pure) |
| `src/index.ts` | Re-exports |

### `packages/server` — SQLite layer only in this phase

| File | Responsibility |
| --- | --- |
| `src/db/connection.ts` | Open database, WAL, pragmas |
| `src/db/migrate.ts` | Forward-only numbered migrations, version guard |
| `src/db/migrations/001_initial.sql` | Initial schema |
| `src/db/chunked.ts` | Bounded-transaction batch helper |
| `src/db/media-file-repo.ts` | Identity lookup, upsert, atomic claim |
| `src/db/plugin-document-repo.ts` | Backing store for `crudTransDBN` |

### `packages/engine` — plugin host and executor

| File | Responsibility |
| --- | --- |
| `src/host/require-from-string.ts` | Compile CommonJS text with a controlled `require` |
| `src/host/loader.ts` | Load a plugin file, read `details()`, cache by path+mtime |
| `src/host/file-object.ts` | Project a trawlarr file record to/from `PluginFileObject` |
| `src/host/deps.ts` | Build the injected `deps` object |
| `src/host/crud-trans-dbn.ts` | Document store + host-settings allowlist |
| `src/host/axios-middleware.ts` | Endpoint allowlist, loud rejection |
| `src/host/args.ts` | Assemble `PluginInputArgs` for one node invocation |
| `src/ffmpeg/run.ts` | Spawn ffmpeg, parse progress, cancel |
| `src/ffmpeg/progress.ts` | Parse ffmpeg's `-progress` stream |
| `src/executor/run-flow.ts` | Graph walk, routing, cycles, `onFlowError`, step trace |
| `src/executor/vouchable.ts` | Which nodes the engine can render inert |
| `src/executor/dry-run.ts` | Dry-run execution mode |
| `src/cli.ts` | `trawlarr-engine run` |

### `packages/plugins-core` — first-party MIT nodes

`src/input/start/`, `src/video/checkVideoCodec/`, `src/ffmpegCommand/beginCommand/`, `src/ffmpegCommand/setVideoEncoder/`, `src/ffmpegCommand/execute/` — each a directory with `index.ts` exporting `details` and `plugin`.

### Repository root

`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `LICENSE`, `README.md`, `.github/workflows/ci.yml`, `.github/workflows/compat-nightly.yml`, `scripts/audit-licenses.mjs`, `scripts/fetch-plugin-corpus.mjs`.

---

## Task 1: Repository, monorepo scaffold, CI, license audit

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `LICENSE`, `README.md`
- Create: `.github/workflows/ci.yml`, `scripts/audit-licenses.mjs`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Test: `packages/core/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm audit:licenses` at the repo root. The `@trawlarr/core` package name and its `src/index.ts` barrel. Path alias `@trawlarr/*` resolving to `packages/*/src` for tests.

> **Before starting:** creating the GitHub repository is outward-facing. Confirm with Ryan, then create it empty and push the spec as the first commit (spec §12.1). Everything below happens in that new repository. Do not copy any file from the old GPL-3.0 tree except `docs/superpowers/specs/2026-08-10-trawlarr-design.md` and `docs/superpowers/plans/2026-08-10-trawlarr-p0-p1-engine.md`.

- [ ] **Step 1: Initialise the workspace root**

`package.json`:

```json
{
  "name": "trawlarr",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write .",
    "audit:licenses": "node scripts/audit-licenses.mjs"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "@vitest/coverage-v8": "^2.1.0",
    "eslint": "^9.12.0",
    "prettier": "^3.3.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.8.0",
    "vitest": "^2.1.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
```

`.gitignore`:

```
node_modules/
dist/
coverage/
cache/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 2: Add the MIT license and TypeScript config**

`LICENSE` — the standard MIT text, `Copyright (c) 2026 Ryan Gregg`.

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

`exactOptionalPropertyTypes` is deliberately off: the contract's file object is full of optional fields that plugins set to `undefined` explicitly, and turning this on fights the contract rather than the code.

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@trawlarr/plugin-api': pkg('plugin-api'),
      '@trawlarr/core': pkg('core'),
      '@trawlarr/engine': pkg('engine'),
      '@trawlarr/server': pkg('server'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Add lint config, including the no-IO rule for `core`**

`eslint.config.js`:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'cache/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'fs', 'node:fs', 'node:fs/promises',
            'child_process', 'node:child_process',
            'http', 'node:http', 'https', 'node:https',
            'node:net', 'node:dgram',
          ],
          patterns: ['node:fs/*'],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '@trawlarr/core must not perform IO.' },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'core must receive nowMs as a parameter, not read the clock.',
        },
      ],
    },
  },
);
```

`.prettierrc`:

```json
{ "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```

- [ ] **Step 4: Create the `core` package with a smoke test**

`packages/core/package.json`:

```json
{
  "name": "@trawlarr/core",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"]
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/core/src/index.ts`:

```ts
export const CORE_PACKAGE = '@trawlarr/core';
```

`packages/core/src/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from './index.js';

describe('toolchain', () => {
  it('resolves the core package barrel', () => {
    expect(CORE_PACKAGE).toBe('@trawlarr/core');
  });
});
```

- [ ] **Step 5: Verify the toolchain runs**

Run: `pnpm install && pnpm build && pnpm test && pnpm lint`
Expected: build succeeds, one passing test, lint clean.

- [ ] **Step 6: Write the license audit script**

`scripts/audit-licenses.mjs`. It walks `node_modules` for every package reachable from the workspace, reads each `package.json`'s `license`, and fails on anything not in the allowlist. This satisfies spec §12.3 and must cover *all* runtime dependencies, not just plugin `deps`.

```js
#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD',
  'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0',
]);

const normalise = (l) => {
  if (!l) return null;
  const s = typeof l === 'string' ? l : l.type;
  if (!s) return null;
  return s.replace(/^\(|\)$/g, '').split(/\s+OR\s+/i).map((x) => x.trim());
};

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.name.startsWith('@')) {
      yield* walk(p);
    } else {
      yield p;
      yield* walk(join(p, 'node_modules'));
    }
  }
}

const problems = [];
const seen = new Set();
for (const root of ['node_modules', 'packages']) {
  for await (const dir of walk(root)) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name || seen.has(`${pkg.name}@${pkg.version}`)) continue;
    seen.add(`${pkg.name}@${pkg.version}`);
    if (pkg.name.startsWith('@trawlarr/')) continue;
    const licenses = normalise(pkg.license) ?? normalise(pkg.licenses?.[0]);
    if (!licenses || !licenses.some((l) => ALLOWED.has(l))) {
      problems.push(`${pkg.name}@${pkg.version}: ${JSON.stringify(pkg.license ?? null)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Disallowed or unknown licenses (${problems.length}):`);
  for (const p of problems.sort()) console.error(`  ${p}`);
  console.error('\nAdd to ALLOWED only after confirming compatibility with MIT distribution.');
  process.exit(1);
}
console.log(`License audit passed: ${seen.size} packages checked.`);
```

- [ ] **Step 7: Run the audit and resolve findings**

Run: `pnpm audit:licenses`
Expected: PASS. If a dev dependency reports an unknown license, confirm it manually and either add the SPDX id to `ALLOWED` with a one-line comment, or replace the dependency. Do not silence a finding you have not read.

- [ ] **Step 8: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm audit:licenses
      - run: pnpm test -- --coverage
```

- [ ] **Step 9: Write the README**

Cover: what trawlarr is, MIT license, that it contains no Unmanic code and credits Josh.5 for the prior fork's lineage, that Tdarr compatibility is interoperability with the plugin contract rather than derivation, and — plainly — that installing a plugin executes that author's code as the service user (spec §4.7). Do not imply a sandbox.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold, MIT license, CI, license audit"
```

---

## Task 2: `@trawlarr/plugin-api` contract types

**Files:**
- Create: `packages/plugin-api/package.json`, `packages/plugin-api/tsconfig.json`
- Create: `packages/plugin-api/src/{details,file-object,ffmpeg,args,module,index}.ts`
- Test: `packages/plugin-api/src/contract.test.ts`

**Interfaces:**
- Consumes: Task 1's toolchain.
- Produces: all contract types. Later tasks import from `@trawlarr/plugin-api`:
  `PluginDetails`, `PluginInput`, `PluginInputUi`, `ProbeStream`, `ProbeFormat`, `ProbeData`,
  `PluginFileObject`, `HealthCheckStatus`, `TranscodeDecision`, `FfmpegCommand`,
  `FfmpegCommandStream`, `RunVariables`, `PluginDeps`, `ConfigVars`, `PluginInputArgs`,
  `PluginOutputArgs`, `PluginModule`, `JobDescriptor`.

- [ ] **Step 1: Write the failing test**

Types alone can't be unit-tested, so the test asserts the *structural* facts later code depends on — the misspelled keys and the enum members — by constructing values. If someone "fixes" a misspelling, this fails.

`packages/plugin-api/src/contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FfmpegCommand, PluginFileObject, PluginOutputArgs } from './index.js';

describe('contract shape', () => {
  it('preserves the upstream misspelling on the ffmpeg command', () => {
    const cmd: FfmpegCommand = {
      init: true,
      inputFiles: ['/in.mkv'],
      streams: [],
      container: 'mkv',
      hardwareDecoding: false,
      shouldProcess: false,
      overallInputArguments: [],
      overallOuputArguments: ['-max_muxing_queue_size', '9999'],
    };
    expect(Object.keys(cmd)).toContain('overallOuputArguments');
    expect(Object.keys(cmd)).not.toContain('overallOutputArguments');
  });

  it('models the legacy status enums as the contract spells them', () => {
    const file = {
      _id: '/library/movie.mkv',
      HealthCheck: 'Success',
      TranscodeDecisionMaker: 'Transcode success',
    } as PluginFileObject;
    expect(file.HealthCheck).toBe('Success');
    expect(file.TranscodeDecisionMaker).toBe('Transcode success');
  });

  it('routes by output number', () => {
    const out: PluginOutputArgs = {
      outputNumber: 2,
      outputFileObj: { _id: '/library/movie.mkv' },
      variables: {
        ffmpegCommand: {
          init: false,
          inputFiles: [],
          streams: [],
          container: '',
          hardwareDecoding: false,
          shouldProcess: false,
          overallInputArguments: [],
          overallOuputArguments: [],
        },
        flowFailed: false,
        user: {},
      },
    };
    expect(out.outputNumber).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/plugin-api`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Create the package manifest**

`packages/plugin-api/package.json` — same shape as `core`'s in Task 1 Step 4, with `"name": "@trawlarr/plugin-api"`. `packages/plugin-api/tsconfig.json` — identical to `core`'s.

- [ ] **Step 4: Write `src/details.ts`**

```ts
/** Conditional-visibility comparison operators supported by plugin input UIs. */
export type InputCondition =
  | '===' | '!==' | '>' | '>=' | '<' | '<=' | 'includes' | 'notIncludes';

export interface InputDisplayCondition {
  name: string;
  value: string;
  condition: InputCondition;
}

export interface InputDisplayConditionSet {
  logic: 'AND' | 'OR';
  inputs: InputDisplayCondition[];
}

export interface PluginInputUi {
  type: 'dropdown' | 'text' | 'textarea' | 'directory' | 'slider' | 'switch' | 'codeEditor';
  options?: string[];
  sliderOptions?: { min: number; max: number };
  style?: Record<string, unknown>;
  /** Choosing a value may rewrite sibling input values: value -> { inputName: newValue }. */
  onSelect?: Record<string, Record<string, string>>;
  displayConditions?: { logic: 'AND' | 'OR'; sets: InputDisplayConditionSet[] };
}

export interface PluginInput {
  label: string;
  name: string;
  type: 'string' | 'boolean' | 'number';
  defaultValue: string;
  tooltip: string;
  inputUI: PluginInputUi;
}

export interface PluginOutputDescriptor {
  number: number;
  tooltip: string;
}

export interface PluginDetails {
  name: string;
  nameUI?: { type: 'text' | 'textarea'; style?: Record<string, unknown> };
  description: string;
  style: {
    borderColor: string;
    opacity?: number;
    borderRadius?: number | string;
    width?: number | string;
    height?: number | string;
    backgroundColor?: string;
  };
  tags: string;
  isStartPlugin: boolean;
  pType: 'start' | 'onFlowError' | '';
  sidebarPosition: number;
  icon: string;
  inputs: PluginInput[];
  outputs: PluginOutputDescriptor[];
  requiresVersion: string;
}
```

- [ ] **Step 5: Write `src/file-object.ts`**

```ts
export interface ProbeStreamTags {
  language?: string;
  title?: string;
  [key: string]: string | undefined;
}

/**
 * A raw ffprobe stream. The open index signature is deliberate: community
 * plugins read arbitrary ffprobe fields, so narrowing this would break them.
 */
export interface ProbeStream {
  codec_name: string;
  codec_type: string;
  bit_rate?: number;
  channels?: number;
  tags?: ProbeStreamTags;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface ProbeFormat {
  filename?: string;
  nb_streams?: number;
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  [key: string]: string | number | undefined;
}

export interface ProbeData {
  streams?: ProbeStream[];
  format?: ProbeFormat;
}

export type HealthCheckStatus =
  | '' | 'Hold' | 'Queued' | 'Success' | 'Error' | 'Cancelled';

export type TranscodeDecision =
  | '' | 'Hold' | 'Queued'
  | 'Transcode success' | 'Transcode error' | 'Transcode cancelled'
  | 'Not required';

export interface StatSyncLike {
  mtimeMs: number;
  ctimeMs: number;
}

export interface ScannerReads {
  ffProbeRead: string;
  exiftoolRead: string;
  mediaInfoRead: string;
  closedCaptionRead: string;
}

/**
 * The per-job view of a file handed to plugins. `_id` is the file's PATH,
 * not a stable identifier — trawlarr's stable identity is projected into
 * `footprintId`. The open index signature is required: plugins read fields
 * we do not enumerate.
 */
export interface PluginFileObject {
  _id: string;
  file: string;
  DB: string;
  footprintId: string;
  container: string;
  createdAt: number;
  file_size: number;
  bit_rate: number;
  statSync: StatSyncLike;
  scannerReads: ScannerReads;
  ffProbeData: ProbeData;
  meta?: Record<string, unknown>;
  mediaInfo?: Record<string, unknown>;
  hasClosedCaptions: boolean;
  bumped: boolean;
  HealthCheck: HealthCheckStatus;
  TranscodeDecisionMaker: TranscodeDecision;
  holdUntil: number;
  fileMedium: string;
  video_codec_name: string;
  audio_codec_name: string;
  video_resolution: string;
  videoStreamIndex: number;
  lastHealthCheckDate: number;
  lastTranscodeDate: number;
  history: string;
  oldSize: number;
  newSize: number;
  lastPluginDetails: string;
  [key: string]: unknown;
}
```

- [ ] **Step 6: Write `src/ffmpeg.ts`**

```ts
import type { ProbeStream } from './file-object.js';

/** An ffprobe stream plus the four fields plugins mutate to shape the command. */
export interface FfmpegCommandStream extends ProbeStream {
  removed: boolean;
  forceEncoding: boolean;
  inputArgs: string[];
  outputArgs: string[];
}

export interface FfmpegCommand {
  init: boolean;
  inputFiles: string[];
  streams: FfmpegCommandStream[];
  container: string;
  hardwareDecoding: boolean;
  shouldProcess: boolean;
  overallInputArguments: string[];
  /**
   * Spelled `Ouput` deliberately: this is the upstream contract key and
   * community plugins write to it. Do not "correct" it.
   */
  overallOuputArguments: string[];
}
```

- [ ] **Step 7: Write `src/args.ts`**

```ts
import type { PluginFileObject, ProbeData } from './file-object.js';
import type { FfmpegCommand } from './ffmpeg.js';

export interface LiveSizeCompare {
  enabled: boolean;
  compareMethod: string;
  thresholdPerc: number;
  lowerThresholdPerc: number;
  checkDelaySeconds: number;
  error: boolean;
  errorType: '' | 'upperThreshold' | 'lowerThreshold';
}

export interface RunVariables {
  ffmpegCommand: FfmpegCommand;
  flowFailed: boolean;
  user: Record<string, string>;
  healthCheck?: 'Success';
  queueTags?: string;
  liveSizeCompare?: LiveSizeCompare;
  removeFromTdarr?: boolean;
  automation?: Record<string, unknown>;
}

export interface JobDescriptor {
  version: string;
  footprintId: string;
  jobId: string;
  start: number;
  type: string;
  fileId: string;
}

export interface PathTranslator {
  server: string;
  node: string;
}

export interface ConfigVars {
  config: {
    nodeID: string;
    nodeName: string;
    serverURL: string;
    serverIP: string;
    serverPort: string;
    handbrakePath: string;
    ffmpegPath: string;
    mkvpropeditPath: string;
    pathTranslators: PathTranslator[];
    platform_arch_isdocker: string;
    logLevel: string;
    processPid: number;
    priority: number;
    apiKey: string;
    maxLogSizeMB: number;
    pollInterval: number;
    /**
     * Upstream vocabulary, exposed only here. Trawlarr's UI and docs say
     * "Direct access" and "File transfer" instead (spec §4.8).
     */
    nodeType: 'mapped' | 'unmapped';
    unmappedNodeCache: string;
    startPaused: boolean;
  };
}

export type CrudMode = 'getById' | 'insert' | 'update' | 'removeOne';

export interface PluginDeps {
  fsextra: unknown;
  gracefulfs: unknown;
  upath: unknown;
  axios: unknown;
  ncp: unknown;
  mvdir: unknown;
  parseArgsStringToArgv: (input: string) => string[];
  importFresh: (path: string) => unknown;
  requireFromString: (pluginText: string, relativePath: string) => Record<string, unknown>;
  axiosMiddleware: (endpoint: string, data: Record<string, unknown>) => Promise<unknown>;
  crudTransDBN: (
    collection: string,
    mode: CrudMode,
    docID: string,
    obj: Record<string, unknown>,
  ) => Promise<unknown>;
  configVars: ConfigVars;
}

export interface ScanTypes {
  scanIndividualFile?: boolean;
  [key: string]: unknown;
}

export interface PluginInputArgs {
  inputFileObj: PluginFileObject;
  originalLibraryFile: PluginFileObject;
  librarySettings: Record<string, unknown>;
  inputs: Record<string, unknown>;
  userVariables: { global: Record<string, string>; library: Record<string, string> };
  variables: RunVariables;
  config: Record<string, unknown>;
  configVars: ConfigVars;

  workDir: string;
  platform: string;
  arch: string;
  platform_arch_isdocker: string;
  ffmpegPath: string;
  handbrakePath: string;
  mkvpropeditPath: string;
  nodeHardwareType: string;
  workerType: string;
  nodeTags?: string;
  job: JobDescriptor;
  isAutomation: boolean;
  logFullCliOutput: boolean;

  jobLog: (text: string) => void;
  updateWorker: (obj: Record<string, unknown>) => void;
  logOutcome: (outcome: string) => void;
  updateStat: (db: string, key: string, inc: number) => Promise<void>;
  scanIndividualFile?: (
    file: { _id: string; file: string; DB: string; footprintId: string },
    scanTypes: ScanTypes,
  ) => Promise<PluginFileObject>;
  /** Always rejects: classic plugins are out of scope (spec §2.8). */
  installClassicPluginDeps: (deps: string[]) => Promise<never>;

  /** Upstream spelling preserved: plugins read `lastSuccesfulPlugin`. */
  lastSuccesfulPlugin: unknown;
  lastSuccessfulRun: unknown;
  thisPlugin: unknown;

  deps: PluginDeps;
}

export interface PluginOutputArgs {
  outputNumber: number;
  outputFileObj: { _id: string };
  variables: RunVariables;
}

export type { ProbeData };
```

- [ ] **Step 8: Write `src/module.ts` and `src/index.ts`**

```ts
// src/module.ts
import type { PluginDetails } from './details.js';
import type { PluginInputArgs, PluginOutputArgs } from './args.js';

export interface PluginModule {
  details: () => PluginDetails;
  plugin: (args: PluginInputArgs) => PluginOutputArgs | Promise<PluginOutputArgs>;
}
```

```ts
// src/index.ts
export * from './details.js';
export * from './file-object.js';
export * from './ffmpeg.js';
export * from './args.js';
export * from './module.js';
```

- [ ] **Step 9: Run the test**

Run: `pnpm test -- packages/plugin-api`
Expected: PASS, 3 tests.

- [ ] **Step 10: Commit**

```bash
git add packages/plugin-api
git commit -m "feat(plugin-api): declare the Tdarr flow plugin interoperability contract"
```

---

## Task 3: Canonical JSON and hashing

**Files:**
- Create: `packages/core/src/canonical-json.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/canonical-json.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `canonicalJson(value: unknown): string`, `sha256Hex(input: string): string`. Tasks 5, 6 depend on both.

Key sizing (`node:crypto` is allowed in `core` — it is computation, not IO; the lint rule in Task 1 does not restrict it).

- [ ] **Step 1: Write the failing test**

`packages/core/src/canonical-json.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from './canonical-json.js';

describe('canonicalJson', () => {
  it('orders object keys so equal content hashes equally', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('orders keys recursively', () => {
    expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined object values but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('renders undefined array entries as null to preserve positions', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('rejects values that cannot hash deterministically', () => {
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(/not serialisable/i);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/not serialisable/i);
  });
});

describe('sha256Hex', () => {
  it('produces a stable 64-character digest', () => {
    const digest = sha256Hex('trawlarr');
    expect(digest).toHaveLength(64);
    expect(digest).toBe(sha256Hex('trawlarr'));
    expect(digest).not.toBe(sha256Hex('trawlarrr'));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/core/src/canonical-json.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/canonical-json.ts`:

```ts
import { createHash } from 'node:crypto';

const notSerialisable = (value: unknown): never => {
  throw new Error(`canonicalJson: value is not serialisable deterministically: ${String(value)}`);
};

/**
 * Deterministic JSON: object keys sorted, arrays left in order, undefined
 * dropped from objects and nulled in arrays. Two structurally equal values
 * always produce byte-identical output, which is what makes hashing stable
 * across processes and Node versions.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : notSerialisable(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return notSerialisable(value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    const parts = value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry)));
    return `[${parts.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return `{${parts.join(',')}}`;
};

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');
```

- [ ] **Step 4: Export from the barrel**

`packages/core/src/index.ts`:

```ts
export const CORE_PACKAGE = '@trawlarr/core';
export * from './canonical-json.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- packages/core`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): deterministic canonical JSON and sha256 helper"
```

---

## Task 4: File identity

Spec §4.2. This is the fix for the failure where a Radarr rename discards the ledger and re-transcodes a converged file, so the tests are written around renames rather than around happy-path lookups.

**Files:**
- Create: `packages/core/src/identity.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/identity.test.ts`

**Interfaces:**
- Consumes: Task 3 (`sha256Hex`).
- Produces:
  - `type IdentityKind = 'inode' | 'content'`
  - `interface IdentityCandidate { inodeKey: string | null; contentKey: string }`
  - `interface PartialHashParts { sizeBytes: number; headHex: string; tailHex: string }`
  - `buildIdentityCandidate(input: { deviceId: number | bigint | null; inode: number | bigint | null; hash: PartialHashParts }): IdentityCandidate`
  - `interface IdentityLookup { byInodeKey(key: string): string | null; byContentKey(key: string): string | null }`
  - `interface IdentityMatch { fileId: string | null; matchedBy: IdentityKind | null }`
  - `matchIdentity(candidate: IdentityCandidate, lookup: IdentityLookup): IdentityMatch`
  - `contentKeyOf(parts: PartialHashParts): string`
  - `inodeKeyOf(deviceId: number | bigint, inode: number | bigint): string`

  Task 9 implements `IdentityLookup` against SQLite. The partial-hash *reader* is IO and belongs to the P2 scanner; `core` only defines the key format.

- [ ] **Step 1: Write the failing test**

`packages/core/src/identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildIdentityCandidate,
  contentKeyOf,
  inodeKeyOf,
  matchIdentity,
  type IdentityLookup,
} from './identity.js';

const hash = { sizeBytes: 4096, headHex: 'aa11', tailHex: 'bb22' };

const lookup = (
  inodes: Record<string, string> = {},
  contents: Record<string, string> = {},
): IdentityLookup => ({
  byInodeKey: (k) => inodes[k] ?? null,
  byContentKey: (k) => contents[k] ?? null,
});

describe('identity keys', () => {
  it('builds a stable inode key from device and inode', () => {
    expect(inodeKeyOf(2049, 8675309)).toBe('2049:8675309');
  });

  it('accepts bigint stat values without precision loss', () => {
    expect(inodeKeyOf(2049n, 12345678901234567n)).toBe('2049:12345678901234567');
  });

  it('derives the content key from size, head and tail', () => {
    expect(contentKeyOf(hash)).toBe(contentKeyOf({ ...hash }));
    expect(contentKeyOf(hash)).not.toBe(contentKeyOf({ ...hash, sizeBytes: 4097 }));
  });

  it('omits the inode key when the filesystem reports none', () => {
    const candidate = buildIdentityCandidate({ deviceId: null, inode: null, hash });
    expect(candidate.inodeKey).toBeNull();
    expect(candidate.contentKey).toBe(contentKeyOf(hash));
  });
});

describe('matchIdentity', () => {
  it('prefers the inode match, which is the cheap common case', () => {
    const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
    const result = matchIdentity(candidate, lookup({ '2049:42': 'file-1' }, {}));
    expect(result).toEqual({ fileId: 'file-1', matchedBy: 'inode' });
  });

  it('survives a rename: same inode, different path, still the same file', () => {
    // A Radarr quality upgrade renames the file; the inode is unchanged.
    const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
    expect(matchIdentity(candidate, lookup({ '2049:42': 'file-1' })).fileId).toBe('file-1');
  });

  it('falls back to content when the inode has changed', () => {
    // A copy to a new device renumbers the inode but the bytes are identical.
    const candidate = buildIdentityCandidate({ deviceId: 3000, inode: 99, hash });
    const result = matchIdentity(candidate, lookup({}, { [contentKeyOf(hash)]: 'file-1' }));
    expect(result).toEqual({ fileId: 'file-1', matchedBy: 'content' });
  });

  it('treats a genuinely new file as new', () => {
    const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 7, hash });
    expect(matchIdentity(candidate, lookup())).toEqual({ fileId: null, matchedBy: null });
  });

  it('does not consult content when the inode already matched', () => {
    let contentCalls = 0;
    const spy: IdentityLookup = {
      byInodeKey: () => 'file-1',
      byContentKey: () => {
        contentCalls += 1;
        return 'file-2';
      },
    };
    const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
    expect(matchIdentity(candidate, spy).fileId).toBe('file-1');
    expect(contentCalls).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/core/src/identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/identity.ts`:

```ts
import { sha256Hex } from './canonical-json.js';

export type IdentityKind = 'inode' | 'content';

export interface PartialHashParts {
  sizeBytes: number;
  /** Hex digest of the file's leading bytes. */
  headHex: string;
  /** Hex digest of the file's trailing bytes. */
  tailHex: string;
}

export interface IdentityCandidate {
  inodeKey: string | null;
  contentKey: string;
}

export interface IdentityLookup {
  byInodeKey(key: string): string | null;
  byContentKey(key: string): string | null;
}

export interface IdentityMatch {
  fileId: string | null;
  matchedBy: IdentityKind | null;
}

export const inodeKeyOf = (deviceId: number | bigint, inode: number | bigint): string =>
  `${deviceId.toString()}:${inode.toString()}`;

export const contentKeyOf = (parts: PartialHashParts): string =>
  sha256Hex(`${parts.sizeBytes}:${parts.headHex}:${parts.tailHex}`);

export const buildIdentityCandidate = (input: {
  deviceId: number | bigint | null;
  inode: number | bigint | null;
  hash: PartialHashParts;
}): IdentityCandidate => ({
  inodeKey:
    input.deviceId === null || input.inode === null
      ? null
      : inodeKeyOf(input.deviceId, input.inode),
  contentKey: contentKeyOf(input.hash),
});

/**
 * Resolve a scanned file to an existing record. Inode first because it is
 * cheap and stable across renames — the case that matters, since media
 * managers rename constantly. Content hash second, so a file that moved
 * across devices keeps its ledger instead of being reprocessed.
 */
export const matchIdentity = (
  candidate: IdentityCandidate,
  lookup: IdentityLookup,
): IdentityMatch => {
  if (candidate.inodeKey !== null) {
    const byInode = lookup.byInodeKey(candidate.inodeKey);
    if (byInode !== null) return { fileId: byInode, matchedBy: 'inode' };
  }

  const byContent = lookup.byContentKey(candidate.contentKey);
  if (byContent !== null) return { fileId: byContent, matchedBy: 'content' };

  return { fileId: null, matchedBy: null };
};
```

- [ ] **Step 4: Export from the barrel**

Add `export * from './identity.js';` to `packages/core/src/index.ts`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- packages/core`
Expected: PASS, 18 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): file identity by inode with content-hash fallback"
```

---

## Task 5: Probe facts — extraction, equivalence, hashing

Spec §5.2. A *fact set* is the subset of probed state that convergence reasoning uses. Both the signature (Task 6) and convergence detection (Task 7) depend on it, so it is its own unit.

**Files:**
- Create: `packages/core/src/facts.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/facts.test.ts`

**Interfaces:**
- Consumes: Task 3 (`canonicalJson`, `sha256Hex`), `ProbeData`/`ProbeStream` from `@trawlarr/plugin-api`.
- Produces:
  - `interface StreamFact { index: number; codecType: string; codecName: string; language: string | null; disposition: string | null }`
  - `interface FactSet { container: string; sizeBytes: number; durationMs: number | null; width: number | null; height: number | null; streams: StreamFact[] }`
  - `interface FactTolerance { durationMs: number; sizeRatio: number }`
  - `const DEFAULT_FACT_TOLERANCE: FactTolerance`
  - `extractFacts(input: { probe: ProbeData; container: string; sizeBytes: number }): FactSet`
  - `factsEquivalent(a: FactSet, b: FactSet, tolerance?: FactTolerance): boolean`
  - `factsHash(facts: FactSet): string`

- [ ] **Step 1: Write the failing test**

`packages/core/src/facts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import {
  DEFAULT_FACT_TOLERANCE,
  extractFacts,
  factsEquivalent,
  factsHash,
  type FactSet,
} from './facts.js';

const probe: ProbeData = {
  format: { duration: '1440.5', nb_streams: 3 },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'eac3', tags: { language: 'eng' } },
    {
      codec_type: 'subtitle',
      codec_name: 'subrip',
      tags: { language: 'eng', title: 'Commentary' },
      disposition: { comment: 1 },
    },
  ],
};

const facts = (over: Partial<FactSet> = {}): FactSet => ({
  ...extractFacts({ probe, container: 'mkv', sizeBytes: 40_000_000_000 }),
  ...over,
});

describe('extractFacts', () => {
  it('captures container, size, duration and dimensions', () => {
    const f = extractFacts({ probe, container: 'mkv', sizeBytes: 1234 });
    expect(f.container).toBe('mkv');
    expect(f.sizeBytes).toBe(1234);
    expect(f.durationMs).toBe(1_440_500);
    expect(f.width).toBe(1920);
    expect(f.height).toBe(1080);
  });

  it('records one fact per stream, in stream order, with index', () => {
    const f = extractFacts({ probe, container: 'mkv', sizeBytes: 1 });
    expect(f.streams).toHaveLength(3);
    expect(f.streams[0]).toEqual({
      index: 0, codecType: 'video', codecName: 'h264', language: null, disposition: null,
    });
    expect(f.streams[1]?.language).toBe('eng');
    expect(f.streams[2]?.disposition).toBe('comment');
  });

  it('tolerates a probe with no streams or format', () => {
    const f = extractFacts({ probe: {}, container: 'mp4', sizeBytes: 0 });
    expect(f.streams).toEqual([]);
    expect(f.durationMs).toBeNull();
    expect(f.width).toBeNull();
  });

  it('ignores an unparseable duration rather than producing NaN', () => {
    const f = extractFacts({
      probe: { format: { duration: 'N/A' } }, container: 'mkv', sizeBytes: 1,
    });
    expect(f.durationMs).toBeNull();
  });
});

describe('factsEquivalent', () => {
  it('is true for identical fact sets', () => {
    expect(factsEquivalent(facts(), facts())).toBe(true);
  });

  it('tolerates small duration drift from re-muxing', () => {
    const a = facts({ durationMs: 1_440_500 });
    const b = facts({ durationMs: 1_440_500 + DEFAULT_FACT_TOLERANCE.durationMs - 1 });
    expect(factsEquivalent(a, b)).toBe(true);
  });

  it('rejects duration drift beyond tolerance', () => {
    const a = facts({ durationMs: 1_440_500 });
    const b = facts({ durationMs: 1_440_500 + DEFAULT_FACT_TOLERANCE.durationMs + 1 });
    expect(factsEquivalent(a, b)).toBe(false);
  });

  it('tolerates small size drift but not a real re-encode', () => {
    const a = facts({ sizeBytes: 40_000_000_000 });
    expect(factsEquivalent(a, facts({ sizeBytes: 40_020_000_000 }))).toBe(true);
    expect(factsEquivalent(a, facts({ sizeBytes: 12_000_000_000 }))).toBe(false);
  });

  it('detects a codec change — the signal that work actually happened', () => {
    const before = facts();
    const after = facts({
      streams: before.streams.map((s, i) => (i === 0 ? { ...s, codecName: 'hevc' } : s)),
    });
    expect(factsEquivalent(before, after)).toBe(false);
  });

  it('detects a dropped stream', () => {
    const before = facts();
    expect(factsEquivalent(before, facts({ streams: before.streams.slice(0, 2) }))).toBe(false);
  });

  it('detects a container change', () => {
    expect(factsEquivalent(facts(), facts({ container: 'mp4' }))).toBe(false);
  });

  it('treats one null duration and one known duration as different', () => {
    expect(factsEquivalent(facts({ durationMs: null }), facts())).toBe(false);
  });

  it('treats two unknown durations as equivalent', () => {
    expect(factsEquivalent(facts({ durationMs: null }), facts({ durationMs: null }))).toBe(true);
  });
});

describe('factsHash', () => {
  it('is stable and order-independent for equal content', () => {
    expect(factsHash(facts())).toBe(factsHash(facts()));
  });

  it('changes when any fact changes', () => {
    expect(factsHash(facts())).not.toBe(factsHash(facts({ container: 'mp4' })));
  });

  it('is exact, not tolerant — size drift changes the hash', () => {
    // factsHash decides "should we re-evaluate"; factsEquivalent decides
    // "did work accomplish anything". They intentionally differ.
    expect(factsHash(facts({ sizeBytes: 1 }))).not.toBe(factsHash(facts({ sizeBytes: 2 })));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/core/src/facts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/facts.ts`:

```ts
import type { ProbeData, ProbeStream } from '@trawlarr/plugin-api';
import { canonicalJson, sha256Hex } from './canonical-json.js';

export interface StreamFact {
  index: number;
  codecType: string;
  codecName: string;
  language: string | null;
  disposition: string | null;
}

export interface FactSet {
  container: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  streams: StreamFact[];
}

export interface FactTolerance {
  /** Absolute duration drift, in milliseconds, treated as no change. */
  durationMs: number;
  /** Fractional size drift treated as no change. */
  sizeRatio: number;
}

export const DEFAULT_FACT_TOLERANCE: FactTolerance = {
  durationMs: 1_000,
  sizeRatio: 0.01,
};

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Collapse ffprobe's disposition map to the flags that are set, sorted. */
const dispositionOf = (stream: ProbeStream): string | null => {
  const raw = stream.disposition;
  if (raw === null || typeof raw !== 'object') return null;
  const flags = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => v === 1 || v === true)
    .map(([k]) => k)
    .sort();
  return flags.length > 0 ? flags.join(',') : null;
};

const firstVideoStream = (streams: ProbeStream[]): ProbeStream | undefined =>
  streams.find((s) => s.codec_type === 'video');

export const extractFacts = (input: {
  probe: ProbeData;
  container: string;
  sizeBytes: number;
}): FactSet => {
  const streams = input.probe.streams ?? [];
  const video = firstVideoStream(streams);
  const durationSeconds = numberOrNull(input.probe.format?.duration);

  return {
    container: input.container,
    sizeBytes: input.sizeBytes,
    durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
    width: numberOrNull(video?.width),
    height: numberOrNull(video?.height),
    streams: streams.map((stream, index) => ({
      index,
      codecType: stream.codec_type ?? '',
      codecName: stream.codec_name ?? '',
      language: stream.tags?.language ?? null,
      disposition: dispositionOf(stream),
    })),
  };
};

const streamsEquivalent = (a: StreamFact[], b: StreamFact[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i];
    return (
      right !== undefined &&
      left.index === right.index &&
      left.codecType === right.codecType &&
      left.codecName === right.codecName &&
      left.language === right.language &&
      left.disposition === right.disposition
    );
  });
};

/**
 * Did anything meaningful change between two runs? Used by convergence
 * detection, so it is deliberately tolerant of the incidental drift a
 * lossless remux produces while remaining strict about codecs, streams
 * and container.
 */
export const factsEquivalent = (
  a: FactSet,
  b: FactSet,
  tolerance: FactTolerance = DEFAULT_FACT_TOLERANCE,
): boolean => {
  if (a.container !== b.container) return false;
  if (a.width !== b.width || a.height !== b.height) return false;

  if ((a.durationMs === null) !== (b.durationMs === null)) return false;
  if (
    a.durationMs !== null &&
    b.durationMs !== null &&
    Math.abs(a.durationMs - b.durationMs) >= tolerance.durationMs
  ) {
    return false;
  }

  const largest = Math.max(a.sizeBytes, b.sizeBytes);
  if (largest > 0) {
    const drift = Math.abs(a.sizeBytes - b.sizeBytes) / largest;
    if (drift > tolerance.sizeRatio) return false;
  }

  return streamsEquivalent(a.streams, b.streams);
};

/** Exact hash of the fact set, used by the ledger signature. */
export const factsHash = (facts: FactSet): string => sha256Hex(canonicalJson(facts));
```

- [ ] **Step 4: Export from the barrel**

Add `export * from './facts.js';` to `packages/core/src/index.ts`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- packages/core`
Expected: PASS, 34 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): probe fact extraction, tolerance-aware equivalence, exact hashing"
```

---

## Task 6: Flow definition hash and ledger signature

Spec §5.3. The signature is hashed over the **whole flow definition**, never the executed subset — a signature over executed plugins is circular and cannot be computed before the run it is meant to make unnecessary. The tests below pin that property so nobody "optimises" it back into a bug.

**Files:**
- Create: `packages/core/src/flow.ts`, `packages/core/src/signature.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/signature.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 5.
- Produces:
  - `interface FlowNode { id: string; pluginId: string; pluginVersion: string; inputs: Record<string, unknown> }`
  - `interface FlowEdge { fromNodeId: string; outputNumber: number; toNodeId: string }`
  - `interface FlowDefinition { nodes: FlowNode[]; edges: FlowEdge[] }`
  - `flowDefinitionHash(flow: FlowDefinition): string`
  - `computeSignature(input: { flowDefinitionHash: string; facts: FactSet }): string`

  Task 15's executor consumes `FlowDefinition`, `FlowNode`, `FlowEdge`.

> **On naming vs spec §2.7.** The spec asks that flows be stored structurally compatible
> with Tdarr's `{flowPlugins[], flowEdges[]}` so v1.1 import is a translation rather than a
> redesign. This plan uses `{nodes[], edges[]}` internally, which is the same structure with
> clearer names: a node carries `pluginId` plus `inputs`, and an edge carries
> `fromNodeId`/`outputNumber`/`toNodeId`. The compatibility requirement is satisfied by the
> shape, and the v1.1 importer owns the field renaming — one small adapter rather than
> Tdarr's vocabulary spread through the whole codebase. If you find a structural (not
> cosmetic) difference while building the importer, that is a spec discrepancy worth
> reporting.

- [ ] **Step 1: Write the failing test**

`packages/core/src/signature.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractFacts } from './facts.js';
import { computeSignature, flowDefinitionHash } from './signature.js';
import type { FlowDefinition } from './flow.js';

const flow = (over: Partial<FlowDefinition> = {}): FlowDefinition => ({
  nodes: [
    { id: 'n1', pluginId: 'start', pluginVersion: '1.0.0', inputs: {} },
    {
      id: 'n2',
      pluginId: 'setVideoEncoder',
      pluginVersion: '1.0.0',
      inputs: { encoder: 'hevc_nvenc', cq: '24' },
    },
  ],
  edges: [{ fromNodeId: 'n1', outputNumber: 1, toNodeId: 'n2' }],
  ...over,
});

const facts = extractFacts({
  probe: { format: { duration: '60' }, streams: [{ codec_type: 'video', codec_name: 'h264' }] },
  container: 'mkv',
  sizeBytes: 1000,
});

describe('flowDefinitionHash', () => {
  it('is stable for the same definition', () => {
    expect(flowDefinitionHash(flow())).toBe(flowDefinitionHash(flow()));
  });

  it('ignores node and edge ordering, which carries no meaning', () => {
    const reordered = flow({
      nodes: [...flow().nodes].reverse(),
    });
    expect(flowDefinitionHash(reordered)).toBe(flowDefinitionHash(flow()));
  });

  it('changes when a node input changes', () => {
    const edited = flow({
      nodes: [
        flow().nodes[0]!,
        { ...flow().nodes[1]!, inputs: { encoder: 'hevc_nvenc', cq: '20' } },
      ],
    });
    expect(flowDefinitionHash(edited)).not.toBe(flowDefinitionHash(flow()));
  });

  it('changes when a referenced plugin version changes', () => {
    const bumped = flow({
      nodes: [flow().nodes[0]!, { ...flow().nodes[1]!, pluginVersion: '1.1.0' }],
    });
    expect(flowDefinitionHash(bumped)).not.toBe(flowDefinitionHash(flow()));
  });

  it('changes when the graph is rewired', () => {
    const rewired = flow({ edges: [{ fromNodeId: 'n1', outputNumber: 2, toNodeId: 'n2' }] });
    expect(flowDefinitionHash(rewired)).not.toBe(flowDefinitionHash(flow()));
  });

  it('hashes every node, including ones no run would reach', () => {
    // This is the anti-regression test for the circular-signature bug:
    // an unreachable branch still contributes, because reachability is
    // per-file and cannot be known before running.
    const withOrphan = flow({
      nodes: [...flow().nodes, { id: 'n9', pluginId: 'x', pluginVersion: '1.0.0', inputs: {} }],
    });
    expect(flowDefinitionHash(withOrphan)).not.toBe(flowDefinitionHash(flow()));
  });
});

describe('computeSignature', () => {
  it('combines the flow hash and the file facts', () => {
    const h = flowDefinitionHash(flow());
    expect(computeSignature({ flowDefinitionHash: h, facts })).toBe(
      computeSignature({ flowDefinitionHash: h, facts }),
    );
  });

  it('changes when the flow changes, so a flow edit invalidates the file', () => {
    const a = computeSignature({ flowDefinitionHash: flowDefinitionHash(flow()), facts });
    const edited = flow({ edges: [] });
    const b = computeSignature({ flowDefinitionHash: flowDefinitionHash(edited), facts });
    expect(a).not.toBe(b);
  });

  it('changes when the file changes', () => {
    const h = flowDefinitionHash(flow());
    const other = extractFacts({ probe: {}, container: 'mp4', sizeBytes: 5 });
    expect(computeSignature({ flowDefinitionHash: h, facts })).not.toBe(
      computeSignature({ flowDefinitionHash: h, facts: other }),
    );
  });

  it('is computable with no run history, before anything executes', () => {
    expect(typeof computeSignature({ flowDefinitionHash: 'abc', facts })).toBe('string');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/core/src/signature.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the flow types**

`packages/core/src/flow.ts`:

```ts
export interface FlowNode {
  id: string;
  pluginId: string;
  pluginVersion: string;
  inputs: Record<string, unknown>;
}

export interface FlowEdge {
  fromNodeId: string;
  outputNumber: number;
  toNodeId: string;
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}
```

- [ ] **Step 4: Implement the signature**

`packages/core/src/signature.ts`:

```ts
import { canonicalJson, sha256Hex } from './canonical-json.js';
import { factsHash, type FactSet } from './facts.js';
import type { FlowDefinition, FlowEdge, FlowNode } from './flow.js';

const nodeKey = (node: FlowNode): string => node.id;
const edgeKey = (edge: FlowEdge): string =>
  `${edge.fromNodeId}|${edge.outputNumber}|${edge.toNodeId}`;

/**
 * Hash of the entire flow definition: structure, every node's configuration,
 * and every referenced plugin version.
 *
 * Deliberately not the set of plugins a run executed. Which plugins execute
 * depends on running the flow, so a signature defined that way could not be
 * computed before the run it is supposed to make unnecessary. Hashing the
 * whole definition is computable up front; the cost is that editing an
 * unreachable branch invalidates files that would never have reached it,
 * which only ever causes a cheap re-evaluation.
 *
 * This value also serves as the flow's version — there is no separate counter.
 */
export const flowDefinitionHash = (flow: FlowDefinition): string => {
  const nodes = [...flow.nodes].sort((a, b) => (nodeKey(a) < nodeKey(b) ? -1 : 1));
  const edges = [...flow.edges].sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1));

  return sha256Hex(
    canonicalJson({
      nodes: nodes.map((node) => ({
        id: node.id,
        pluginId: node.pluginId,
        pluginVersion: node.pluginVersion,
        inputs: node.inputs,
      })),
      edges: edges.map((edge) => ({
        fromNodeId: edge.fromNodeId,
        outputNumber: edge.outputNumber,
        toNodeId: edge.toNodeId,
      })),
    }),
  );
};

/** A file is known-good when this matches the value stored at its last success. */
export const computeSignature = (input: {
  flowDefinitionHash: string;
  facts: FactSet;
}): string => sha256Hex(canonicalJson([input.flowDefinitionHash, factsHash(input.facts)]));
```

- [ ] **Step 5: Export from the barrel**

Add to `packages/core/src/index.ts`:

```ts
export * from './flow.js';
export * from './signature.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test -- packages/core`
Expected: PASS, 44 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): flow definition hash and a priori computable ledger signature"
```

---

## Task 7: Ledger state machine

Spec §5.3 and §5.4. Convergence detection is **retrospective** — comparing pre- and post-run fact sets — because a flow cannot be asked hypothetically: asking means running, and running transcodes the file again.

**Files:**
- Create: `packages/core/src/ledger.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/ledger.test.ts`

**Interfaces:**
- Consumes: Task 5 (`FactSet`, `factsEquivalent`).
- Produces:
  - `type FileState = 'unknown' | 'queued' | 'running' | 'good' | 'failed' | 'not_converging' | 'held'`
  - `interface LedgerRecord { state: FileState; signature: string | null; attemptCount: number; consecutiveNoopCount: number; holdUntilMs: number | null }`
  - `interface RunOutcome { success: boolean; claimedModified: boolean; preFacts: FactSet; postFacts: FactSet | null }`
  - `const MAX_ATTEMPTS: 3`, `const BACKOFF_MINUTES: readonly [5, 25, 125]`, `const NOOP_LIMIT: 2`
  - `newLedgerRecord(): LedgerRecord`
  - `isKnownGood(record: LedgerRecord, currentSignature: string): boolean`
  - `applyRunOutcome(input: { record: LedgerRecord; outcome: RunOutcome; currentSignature: string; nowMs: number }): LedgerRecord`
  - `applyStall(input: { record: LedgerRecord; nowMs: number }): LedgerRecord`
  - `applyRequeue(record: LedgerRecord): LedgerRecord`
  - `isEligible(record: LedgerRecord, nowMs: number): boolean`

- [ ] **Step 1: Write the failing test**

`packages/core/src/ledger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractFacts, type FactSet } from './facts.js';
import {
  BACKOFF_MINUTES,
  MAX_ATTEMPTS,
  NOOP_LIMIT,
  applyRequeue,
  applyRunOutcome,
  applyStall,
  isEligible,
  isKnownGood,
  newLedgerRecord,
  type LedgerRecord,
} from './ledger.js';

const NOW = 1_700_000_000_000;
const SIG = 'sig-current';

const factsFor = (codec: string, size = 1000): FactSet =>
  extractFacts({
    probe: { format: { duration: '60' }, streams: [{ codec_type: 'video', codec_name: codec }] },
    container: 'mkv',
    sizeBytes: size,
  });

const h264 = factsFor('h264');
const hevc = factsFor('hevc', 400);

const record = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  ...newLedgerRecord(),
  ...over,
});

describe('isKnownGood', () => {
  it('is false for a file that has never run', () => {
    expect(isKnownGood(newLedgerRecord(), SIG)).toBe(false);
  });

  it('is true when the stored signature matches and the state is good', () => {
    expect(isKnownGood(record({ state: 'good', signature: SIG }), SIG)).toBe(true);
  });

  it('is false when the signature differs — a flow edit invalidates it', () => {
    expect(isKnownGood(record({ state: 'good', signature: 'sig-old' }), SIG)).toBe(false);
  });

  it('is false when a matching signature is attached to a non-good state', () => {
    expect(isKnownGood(record({ state: 'failed', signature: SIG }), SIG)).toBe(false);
  });
});

describe('applyRunOutcome — success', () => {
  it('marks a file good and stores the signature', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: true, claimedModified: true, preFacts: h264, postFacts: hevc },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.state).toBe('good');
    expect(next.signature).toBe(SIG);
    expect(next.attemptCount).toBe(0);
    expect(next.consecutiveNoopCount).toBe(0);
  });

  it('is good with no noop counted when the flow decided no work was needed', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: true, claimedModified: false, preFacts: h264, postFacts: null },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.state).toBe('good');
    expect(next.consecutiveNoopCount).toBe(0);
  });
});

describe('applyRunOutcome — convergence detection', () => {
  const noopRun = {
    success: true, claimedModified: true, preFacts: h264, postFacts: factsFor('h264'),
  };

  it('counts a run that claimed to modify the file but changed nothing', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: noopRun,
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.consecutiveNoopCount).toBe(1);
    expect(next.state).toBe('good');
  });

  it(`gives up after ${NOOP_LIMIT} consecutive no-op runs`, () => {
    const once = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: noopRun,
      currentSignature: SIG,
      nowMs: NOW,
    });
    const twice = applyRunOutcome({
      record: { ...once, state: 'running' },
      outcome: noopRun,
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(twice.consecutiveNoopCount).toBe(NOOP_LIMIT);
    expect(twice.state).toBe('not_converging');
  });

  it('resets the no-op streak when a run actually changes the file', () => {
    const stuck = record({ state: 'running', consecutiveNoopCount: 1 });
    const next = applyRunOutcome({
      record: stuck,
      outcome: { success: true, claimedModified: true, preFacts: h264, postFacts: hevc },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.consecutiveNoopCount).toBe(0);
    expect(next.state).toBe('good');
  });

  it('counts a missing post-run probe as a no-op when work was claimed', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: true, claimedModified: true, preFacts: h264, postFacts: null },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.consecutiveNoopCount).toBe(1);
  });
});

describe('applyRunOutcome — failure and backoff', () => {
  it('holds with backoff on the first failure', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: false, claimedModified: false, preFacts: h264, postFacts: null },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.state).toBe('held');
    expect(next.attemptCount).toBe(1);
    expect(next.holdUntilMs).toBe(NOW + BACKOFF_MINUTES[0] * 60_000);
  });

  it('uses escalating backoff per attempt', () => {
    let current = record({ state: 'running' });
    const seen: Array<number | null> = [];
    for (let i = 0; i < 3; i += 1) {
      current = applyRunOutcome({
        record: { ...current, state: 'running' },
        outcome: { success: false, claimedModified: false, preFacts: h264, postFacts: null },
        currentSignature: SIG,
        nowMs: NOW,
      });
      seen.push(current.holdUntilMs);
    }
    expect(seen[0]).toBe(NOW + 5 * 60_000);
    expect(seen[1]).toBe(NOW + 25 * 60_000);
    expect(current.state).toBe('failed');
    expect(current.attemptCount).toBe(MAX_ATTEMPTS);
  });

  it('does not store a signature for a failed run', () => {
    const next = applyRunOutcome({
      record: record({ state: 'running' }),
      outcome: { success: false, claimedModified: false, preFacts: h264, postFacts: null },
      currentSignature: SIG,
      nowMs: NOW,
    });
    expect(next.signature).toBeNull();
  });
});

describe('applyStall', () => {
  it('treats a stall exactly like a failed attempt', () => {
    const next = applyStall({ record: record({ state: 'running' }), nowMs: NOW });
    expect(next.state).toBe('held');
    expect(next.attemptCount).toBe(1);
    expect(next.holdUntilMs).toBe(NOW + BACKOFF_MINUTES[0] * 60_000);
  });

  it('fails the file once attempts are exhausted', () => {
    const next = applyStall({
      record: record({ state: 'running', attemptCount: MAX_ATTEMPTS - 1 }),
      nowMs: NOW,
    });
    expect(next.state).toBe('failed');
  });
});

describe('applyRequeue', () => {
  it('clears both counters and returns the file to the queue', () => {
    const next = applyRequeue(
      record({ state: 'not_converging', attemptCount: 3, consecutiveNoopCount: 2, holdUntilMs: NOW }),
    );
    expect(next).toMatchObject({
      state: 'queued', attemptCount: 0, consecutiveNoopCount: 0, holdUntilMs: null,
    });
  });

  it('recovers a failed file too', () => {
    expect(applyRequeue(record({ state: 'failed', attemptCount: 3 })).state).toBe('queued');
  });
});

describe('isEligible', () => {
  it('allows a queued file with no hold', () => {
    expect(isEligible(record({ state: 'queued' }), NOW)).toBe(true);
  });

  it('blocks a held file until its hold expires', () => {
    const held = record({ state: 'held', holdUntilMs: NOW + 1000 });
    expect(isEligible(held, NOW)).toBe(false);
    expect(isEligible(held, NOW + 1001)).toBe(true);
  });

  it('never re-runs a terminal file automatically', () => {
    expect(isEligible(record({ state: 'failed' }), NOW)).toBe(false);
    expect(isEligible(record({ state: 'not_converging' }), NOW)).toBe(false);
    expect(isEligible(record({ state: 'good', signature: SIG }), NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/core/src/ledger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/ledger.ts`:

```ts
import { factsEquivalent, type FactSet } from './facts.js';

export type FileState =
  | 'unknown' | 'queued' | 'running' | 'good' | 'failed' | 'not_converging' | 'held';

export interface LedgerRecord {
  state: FileState;
  /** Signature recorded at the last successful run; null if never succeeded. */
  signature: string | null;
  attemptCount: number;
  consecutiveNoopCount: number;
  holdUntilMs: number | null;
}

export interface RunOutcome {
  success: boolean;
  /** Whether the flow reports having modified the file. */
  claimedModified: boolean;
  preFacts: FactSet;
  /** Facts after the run; null when the file was not re-probed. */
  postFacts: FactSet | null;
}

export const MAX_ATTEMPTS = 3 as const;
export const BACKOFF_MINUTES = [5, 25, 125] as const;
export const NOOP_LIMIT = 2 as const;

const MINUTE_MS = 60_000;

export const newLedgerRecord = (): LedgerRecord => ({
  state: 'unknown',
  signature: null,
  attemptCount: 0,
  consecutiveNoopCount: 0,
  holdUntilMs: null,
});

export const isKnownGood = (record: LedgerRecord, currentSignature: string): boolean =>
  record.state === 'good' && record.signature === currentSignature;

const backoffFor = (attemptCount: number): number => {
  const index = Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1);
  return (BACKOFF_MINUTES[index] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]!) * MINUTE_MS;
};

const recordFailedAttempt = (record: LedgerRecord, nowMs: number): LedgerRecord => {
  const attemptCount = record.attemptCount + 1;
  if (attemptCount >= MAX_ATTEMPTS) {
    return { ...record, state: 'failed', attemptCount, holdUntilMs: null };
  }
  return {
    ...record,
    state: 'held',
    attemptCount,
    holdUntilMs: nowMs + backoffFor(attemptCount),
  };
};

/**
 * Fold a completed run into the ledger.
 *
 * Convergence is judged retrospectively: if the run claimed to modify the
 * file but the post-run facts are equivalent to the pre-run facts, the run
 * accomplished nothing. Two of those in a row and we stop, because the flow
 * and the file disagree in a way that repeating will not resolve.
 *
 * A missing post-run probe alongside a modification claim counts as a no-op:
 * we cannot verify progress, and assuming progress is how infinite loops start.
 */
export const applyRunOutcome = (input: {
  record: LedgerRecord;
  outcome: RunOutcome;
  currentSignature: string;
  nowMs: number;
}): LedgerRecord => {
  const { record, outcome, currentSignature, nowMs } = input;

  if (!outcome.success) return recordFailedAttempt(record, nowMs);

  const wasNoop =
    outcome.claimedModified &&
    (outcome.postFacts === null || factsEquivalent(outcome.preFacts, outcome.postFacts));

  const consecutiveNoopCount = wasNoop ? record.consecutiveNoopCount + 1 : 0;

  return {
    state: consecutiveNoopCount >= NOOP_LIMIT ? 'not_converging' : 'good',
    signature: currentSignature,
    attemptCount: 0,
    consecutiveNoopCount,
    holdUntilMs: null,
  };
};

/** A stalled job is a failed attempt: same counter, same backoff. */
export const applyStall = (input: { record: LedgerRecord; nowMs: number }): LedgerRecord =>
  recordFailedAttempt(input.record, input.nowMs);

/** Manual recovery. Nothing else clears a terminal state. */
export const applyRequeue = (record: LedgerRecord): LedgerRecord => ({
  ...record,
  state: 'queued',
  attemptCount: 0,
  consecutiveNoopCount: 0,
  holdUntilMs: null,
});

export const isEligible = (record: LedgerRecord, nowMs: number): boolean => {
  if (record.state === 'queued') return record.holdUntilMs === null || nowMs > record.holdUntilMs;
  if (record.state === 'held') return record.holdUntilMs === null || nowMs > record.holdUntilMs;
  return false;
};
```

- [ ] **Step 4: Export from the barrel**

Add `export * from './ledger.js';` to `packages/core/src/index.ts`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- packages/core`
Expected: PASS, 66 tests.

- [ ] **Step 6: Verify `core` really has no IO**

Run: `pnpm lint`
Expected: PASS. The `no-restricted-imports` and `Date.now` rules from Task 1 are the enforcement; if either trips, pass the value in as a parameter rather than relaxing the rule.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): ledger state machine with retrospective convergence detection"
```

---

## Task 8: SQLite connection, migrations, chunked transactions

Spec §3.3. `better-sqlite3` is synchronous, so bulk writes must be chunked or they freeze the API and WebSocket. The chunking helper is built here, before anything can write in bulk badly.

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`
- Create: `packages/server/src/db/connection.ts`, `packages/server/src/db/migrate.ts`, `packages/server/src/db/chunked.ts`
- Create: `packages/server/src/db/migrations/001_initial.sql` (schema written in Task 9; created empty-but-valid here)
- Test: `packages/server/src/db/migrate.test.ts`, `packages/server/src/db/chunked.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `openDatabase(input: { file: string }): Database` — `Database` is `better-sqlite3`'s type, re-exported as `type Db`
  - `migrate(db: Db): { from: number; to: number }`
  - `SCHEMA_VERSION: number`
  - `runChunked<T>(input: { db: Db; items: readonly T[]; chunkSize?: number; apply: (item: T) => void }): Promise<{ chunks: number; items: number }>`
  - `DEFAULT_CHUNK_SIZE: 500`

- [ ] **Step 1: Create the package manifest**

`packages/server/package.json`:

```json
{
  "name": "@trawlarr/server",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "dependencies": {
    "@trawlarr/core": "workspace:*",
    "@trawlarr/plugin-api": "workspace:*",
    "better-sqlite3": "^11.3.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11"
  }
}
```

`packages/server/tsconfig.json` — same shape as `core`'s, plus references:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../core" }, { "path": "../plugin-api" }],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing migration test**

`packages/server/src/db/migrate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { SCHEMA_VERSION, migrate } from './migrate.js';

const memoryDb = () => openDatabase({ file: ':memory:' });

describe('openDatabase', () => {
  it('enables WAL and foreign keys', () => {
    const db = openDatabase({ file: ':memory:' });
    // An in-memory database reports "memory" for journal_mode; foreign_keys is
    // the setting that must hold everywhere.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

describe('migrate', () => {
  it('applies every migration to a fresh database', () => {
    const db = memoryDb();
    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('records the schema version so restarts are cheap', () => {
    const db = memoryDb();
    migrate(db);
    const row = db
      .prepare(`SELECT value FROM setting WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it('is idempotent', () => {
    const db = memoryDb();
    migrate(db);
    const second = migrate(db);
    expect(second).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
  });

  it('refuses to start on a database from a newer build', () => {
    const db = memoryDb();
    migrate(db);
    db.prepare(`UPDATE setting SET value = ? WHERE key = 'schema_version'`).run(
      String(SCHEMA_VERSION + 5),
    );
    expect(() => migrate(db)).toThrow(/newer schema/i);
    db.close();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm test -- packages/server`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the connection**

`packages/server/src/db/connection.ts`:

```ts
import SqliteDatabase from 'better-sqlite3';

export type Db = SqliteDatabase.Database;

/**
 * Open the single database the server owns. Nothing else ever opens it:
 * worker processes and remote nodes receive job payloads over the wire,
 * which is what keeps one-writer SQLite viable permanently.
 */
export const openDatabase = (input: { file: string }): Db => {
  const db = new SqliteDatabase(input.file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
};
```

- [ ] **Step 5: Implement migrations**

`packages/server/src/db/migrate.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const loadMigrations = (): Migration[] =>
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (match?.[1] === undefined) {
        throw new Error(`Migration filename must start with a number: ${name}`);
      }
      return {
        version: Number.parseInt(match[1], 10),
        name,
        sql: readFileSync(join(migrationsDir, name), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);

const MIGRATIONS = loadMigrations();

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

const readVersion = (db: Db): number => {
  db.exec(`CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM setting WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row === undefined ? 0 : Number.parseInt(row.value, 10);
};

const writeVersion = (db: Db, version: number): void => {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(version));
};

/**
 * Forward-only migrations. A database stamped with a version this build does
 * not know about means someone downgraded; refusing to start is the only safe
 * response, because applying old migrations over a new schema corrupts it.
 */
export const migrate = (db: Db): { from: number; to: number } => {
  const from = readVersion(db);

  if (from > SCHEMA_VERSION) {
    throw new Error(
      `Database has a newer schema (version ${from}) than this build supports ` +
        `(version ${SCHEMA_VERSION}). Upgrade trawlarr or restore an older backup.`,
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (pending.length > 0) {
    db.transaction(() => {
      for (const migration of pending) db.exec(migration.sql);
      writeVersion(db, SCHEMA_VERSION);
    })();
  } else {
    writeVersion(db, SCHEMA_VERSION);
  }

  return { from, to: SCHEMA_VERSION };
};
```

- [ ] **Step 6: Create a valid placeholder migration**

`packages/server/src/db/migrations/001_initial.sql` — Task 9 fills in the real schema. For now, enough to make migration tests meaningful:

```sql
-- Schema is completed in Task 9.
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

- [ ] **Step 7: Ensure migrations are shipped, not just compiled**

`.sql` files are not emitted by `tsc`. Add a copy step to `packages/server/package.json` scripts:

```json
"scripts": {
  "build:sql": "node -e \"const{cpSync,mkdirSync}=require('node:fs');mkdirSync('dist/db/migrations',{recursive:true});cpSync('src/db/migrations','dist/db/migrations',{recursive:true})\""
}
```

Root `package.json` `build` becomes: `"build": "tsc --build && pnpm -r --if-present run build:sql"`.

- [ ] **Step 8: Run the migration tests**

Run: `pnpm test -- packages/server/src/db/migrate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Write the failing chunked-transaction test**

`packages/server/src/db/chunked.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { DEFAULT_CHUNK_SIZE, runChunked } from './chunked.js';

const setup = () => {
  const db = openDatabase({ file: ':memory:' });
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)`);
  return db;
};

describe('runChunked', () => {
  it('writes every item', async () => {
    const db = setup();
    const insert = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);
    const items = Array.from({ length: 1200 }, (_, i) => i);

    const result = await runChunked({
      db,
      items,
      chunkSize: 500,
      apply: (i) => insert.run(i, `v${i}`),
    });

    expect(result).toEqual({ chunks: 3, items: 1200 });
    const count = db.prepare(`SELECT COUNT(*) AS c FROM t`).get() as { c: number };
    expect(count.c).toBe(1200);
    db.close();
  });

  it('yields to the event loop between chunks so the API stays responsive', async () => {
    const db = setup();
    const insert = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);
    let ticksDuringWrite = 0;
    const timer = setInterval(() => {
      ticksDuringWrite += 1;
    }, 1);

    await runChunked({
      db,
      items: Array.from({ length: 50 }, (_, i) => i),
      chunkSize: 5,
      apply: (i) => insert.run(i, `v${i}`),
    });
    clearInterval(timer);

    // 10 chunks means at least a few macrotask boundaries were reached.
    expect(ticksDuringWrite).toBeGreaterThan(0);
    db.close();
  });

  it('commits completed chunks and surfaces the failure of the bad one', async () => {
    const db = setup();
    const insert = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);

    await expect(
      runChunked({
        db,
        items: [1, 2, 3, 4, 5, 6],
        chunkSize: 2,
        apply: (i) => {
          if (i === 5) throw new Error('boom');
          insert.run(i, `v${i}`);
        },
      }),
    ).rejects.toThrow('boom');

    // Chunks [1,2] and [3,4] committed; [5,6] rolled back entirely.
    const count = db.prepare(`SELECT COUNT(*) AS c FROM t`).get() as { c: number };
    expect(count.c).toBe(4);
    db.close();
  });

  it('handles an empty list without opening a transaction', async () => {
    const db = setup();
    expect(await runChunked({ db, items: [], apply: () => {} })).toEqual({ chunks: 0, items: 0 });
    db.close();
  });

  it('exposes a sane default chunk size', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(500);
  });
});
```

- [ ] **Step 10: Run it to confirm it fails**

Run: `pnpm test -- packages/server/src/db/chunked.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 11: Implement**

`packages/server/src/db/chunked.ts`:

```ts
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Db } from './connection.js';

export const DEFAULT_CHUNK_SIZE = 500;

/**
 * Apply a large batch of writes in bounded transactions, yielding between
 * chunks.
 *
 * better-sqlite3 is synchronous: one transaction wrapping 100,000 inserts
 * blocks the event loop for its whole duration, which freezes the HTTP API
 * and the WebSocket. Chunking keeps any single blocking span short. Each
 * chunk commits independently, so a mid-batch failure leaves earlier chunks
 * durable — scans are resumable, so partial progress is a feature.
 */
export const runChunked = async <T>(input: {
  db: Db;
  items: readonly T[];
  chunkSize?: number;
  apply: (item: T) => void;
}): Promise<{ chunks: number; items: number }> => {
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize < 1) throw new Error('chunkSize must be at least 1');

  let chunks = 0;

  for (let offset = 0; offset < input.items.length; offset += chunkSize) {
    const chunk = input.items.slice(offset, offset + chunkSize);
    const commit = input.db.transaction((batch: readonly T[]) => {
      for (const item of batch) input.apply(item);
    });
    commit(chunk);
    chunks += 1;
    await yieldToEventLoop();
  }

  return { chunks, items: input.items.length };
};
```

- [ ] **Step 12: Run the tests**

Run: `pnpm test -- packages/server`
Expected: PASS, 10 tests.

- [ ] **Step 13: Commit**

```bash
git add packages/server package.json
git commit -m "feat(server): sqlite connection, forward-only migrations, chunked transactions"
```

---

## Task 9: Schema, identity lookup, atomic claim, plugin document store

Spec §5.1, §4.3, §2.9. The claim test is written for contention specifically — a read-then-assign queue lets two workers transcode the same file into each other's output.

**Files:**
- Modify: `packages/server/src/db/migrations/001_initial.sql`
- Create: `packages/server/src/db/media-file-repo.ts`, `packages/server/src/db/plugin-document-repo.ts`
- Create: `packages/server/src/index.ts`
- Test: `packages/server/src/db/media-file-repo.test.ts`, `packages/server/src/db/plugin-document-repo.test.ts`

**Interfaces:**
- Consumes: Task 4 (`IdentityLookup`, `matchIdentity`), Task 7 (`FileState`), Task 8 (`Db`, `migrate`).
- Produces:
  - `createMediaFileRepo(db: Db): MediaFileRepo` with:
    - `identityLookup(libraryId: string): IdentityLookup`
    - `upsertScanned(input: UpsertScannedInput): string` (returns file id)
    - `claimNext(input: { workerClass: string; nowMs: number; libraryIds?: string[] }): ClaimedFile | null`
    - `setState(input: { fileId: string; state: FileState; signature?: string | null; attemptCount?: number; consecutiveNoopCount?: number; holdUntilMs?: number | null }): void`
    - `getById(fileId: string): MediaFileRow | null`
  - `createPluginDocumentRepo(db: Db): PluginDocumentRepo` with `get`, `insert`, `update`, `removeOne`
  - Types `MediaFileRow`, `UpsertScannedInput`, `ClaimedFile`

- [ ] **Step 1: Write the real schema**

Replace `packages/server/src/db/migrations/001_initial.sql`:

```sql
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE library (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  roots_json            TEXT NOT NULL DEFAULT '[]',
  extensions_json       TEXT NOT NULL DEFAULT '[]',
  companion_extensions_json TEXT NOT NULL DEFAULT '[]',
  staging_dir           TEXT,
  trash_dir             TEXT,
  flow_id               TEXT REFERENCES flow(id) ON DELETE SET NULL,
  allow_hardlinked      INTEGER NOT NULL DEFAULT 0,
  enabled               INTEGER NOT NULL DEFAULT 1,
  paused_reason         TEXT,
  user_variables_json   TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL
);

CREATE TABLE flow (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE plugin_source (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_synced_at INTEGER
);

CREATE TABLE plugin (
  id           TEXT PRIMARY KEY,
  source_id    TEXT REFERENCES plugin_source(id) ON DELETE CASCADE,
  rel_path     TEXT NOT NULL,
  abs_path     TEXT NOT NULL,
  version      TEXT NOT NULL,
  details_json TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source_id, rel_path)
);

CREATE TABLE media_file (
  id                     TEXT PRIMARY KEY,
  library_id             TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,

  -- Identity. Path is an attribute, never the key (spec 4.2).
  inode_key              TEXT,
  content_key            TEXT NOT NULL,
  path                   TEXT NOT NULL,
  nlink                  INTEGER NOT NULL DEFAULT 1,

  size_bytes             INTEGER NOT NULL,
  mtime_ms               INTEGER NOT NULL,
  ctime_ms               INTEGER NOT NULL,
  container              TEXT NOT NULL DEFAULT '',

  probe_json             TEXT,
  exiftool_json          TEXT,
  mediainfo_json         TEXT,

  -- Denormalised for fast filtering without parsing probe_json.
  video_codec            TEXT,
  audio_codec            TEXT,
  resolution             TEXT,
  duration_ms            INTEGER,
  bitrate                INTEGER,

  -- Ledger (spec 5.3).
  state                  TEXT NOT NULL DEFAULT 'unknown',
  signature              TEXT,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  consecutive_noop_count INTEGER NOT NULL DEFAULT 0,
  hold_until_ms          INTEGER,
  pre_facts_json         TEXT,
  post_facts_json        TEXT,
  original_size_bytes    INTEGER,
  last_run_id            TEXT,

  priority               INTEGER NOT NULL DEFAULT 0,
  discovered_at          INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,

  UNIQUE (library_id, content_key)
);

CREATE INDEX media_file_inode_idx   ON media_file (library_id, inode_key);
CREATE INDEX media_file_path_idx    ON media_file (library_id, path);
CREATE INDEX media_file_queue_idx   ON media_file (state, hold_until_ms, priority, discovered_at);
CREATE INDEX media_file_codec_idx   ON media_file (library_id, video_codec);

CREATE TABLE node (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  access_mode    TEXT NOT NULL DEFAULT 'direct',
  path_map_json  TEXT NOT NULL DEFAULT '[]',
  hardware_type  TEXT NOT NULL DEFAULT 'cpu',
  tags           TEXT NOT NULL DEFAULT '',
  last_seen_at   INTEGER
);

CREATE TABLE job (
  id            TEXT PRIMARY KEY,
  file_id       TEXT NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,
  flow_id       TEXT NOT NULL,
  flow_hash     TEXT NOT NULL,
  node_id       TEXT REFERENCES node(id) ON DELETE SET NULL,
  worker_class  TEXT NOT NULL DEFAULT 'transcode',
  state         TEXT NOT NULL,
  outcome       TEXT,
  log_path      TEXT,
  started_at    INTEGER NOT NULL,
  heartbeat_at  INTEGER,
  ended_at      INTEGER
);

CREATE INDEX job_file_idx ON job (file_id, started_at DESC);

CREATE TABLE job_step (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  node_id        TEXT NOT NULL,
  plugin_id      TEXT NOT NULL,
  output_number  INTEGER,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  log_excerpt    TEXT NOT NULL DEFAULT '',
  UNIQUE (job_id, seq)
);

-- Backs deps.crudTransDBN for plugin-owned collections (spec 2.9).
CREATE TABLE plugin_document (
  collection TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, doc_id)
);
```

> `library.flow_id` references `flow(id)`, which is declared after it. SQLite resolves foreign keys at write time, not parse time, so declaration order is fine.

- [ ] **Step 2: Write the failing media-file repo test**

`packages/server/src/db/media-file-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { buildIdentityCandidate, matchIdentity } from '@trawlarr/core';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createMediaFileRepo, type MediaFileRepo } from './media-file-repo.js';

const NOW = 1_700_000_000_000;
const LIB = 'lib-movies';
const hash = { sizeBytes: 4096, headHex: 'aa', tailHex: 'bb' };

let db: Db;
let repo: MediaFileRepo;

const seedLibrary = () => {
  db.prepare(`INSERT INTO library (id, name, created_at) VALUES (?, ?, ?)`).run(
    LIB, 'Movies', NOW,
  );
};

const scan = (over: Partial<Parameters<MediaFileRepo['upsertScanned']>[0]> = {}) => {
  const candidate = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
  return repo.upsertScanned({
    libraryId: LIB,
    identity: candidate,
    path: '/media/movies/Arrival.mkv',
    nlink: 1,
    sizeBytes: hash.sizeBytes,
    mtimeMs: NOW,
    ctimeMs: NOW,
    container: 'mkv',
    nowMs: NOW,
    ...over,
  });
};

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  seedLibrary();
  repo = createMediaFileRepo(db);
});

describe('upsertScanned and identity', () => {
  it('inserts a new file', () => {
    const id = scan();
    expect(repo.getById(id)?.path).toBe('/media/movies/Arrival.mkv');
  });

  it('keeps the same record when a file is renamed — the whole point of identity', () => {
    const first = scan();
    const second = scan({ path: '/media/movies/Arrival (2016) [Bluray-1080p].mkv' });
    expect(second).toBe(first);
    expect(repo.getById(first)?.path).toBe('/media/movies/Arrival (2016) [Bluray-1080p].mkv');
    const count = db.prepare(`SELECT COUNT(*) AS c FROM media_file`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('preserves ledger state across a rename', () => {
    const id = scan();
    repo.setState({ fileId: id, state: 'good', signature: 'sig-1' });
    scan({ path: '/media/movies/renamed.mkv' });
    expect(repo.getById(id)).toMatchObject({ state: 'good', signature: 'sig-1' });
  });

  it('matches by content when the inode changed', () => {
    const id = scan();
    const moved = buildIdentityCandidate({ deviceId: 3000, inode: 999, hash });
    expect(scan({ identity: moved })).toBe(id);
  });

  it('resolves identity through the shared core matcher', () => {
    scan();
    const lookup = repo.identityLookup(LIB);
    const same = buildIdentityCandidate({ deviceId: 2049, inode: 42, hash });
    expect(matchIdentity(same, lookup).matchedBy).toBe('inode');

    const different = buildIdentityCandidate({
      deviceId: 2049, inode: 43, hash: { ...hash, headHex: 'ff' },
    });
    expect(matchIdentity(different, lookup).fileId).toBeNull();
  });

  it('records hardlink count so seeding files can be skipped', () => {
    const id = scan({ nlink: 2 });
    expect(repo.getById(id)?.nlink).toBe(2);
  });
});

describe('claimNext', () => {
  const queueOne = () => {
    const id = scan();
    repo.setState({ fileId: id, state: 'queued' });
    return id;
  };

  it('returns null when nothing is queued', () => {
    scan();
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();
  });

  it('claims a queued file and marks it running', () => {
    const id = queueOne();
    const claim = repo.claimNext({ workerClass: 'transcode', nowMs: NOW });
    expect(claim?.fileId).toBe(id);
    expect(repo.getById(id)?.state).toBe('running');
  });

  it('never hands the same file to two workers', () => {
    queueOne();
    const first = repo.claimNext({ workerClass: 'transcode', nowMs: NOW });
    const second = repo.claimNext({ workerClass: 'transcode', nowMs: NOW });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('hands out each file exactly once under repeated contention', () => {
    for (let i = 0; i < 25; i += 1) {
      const id = scan({
        identity: buildIdentityCandidate({
          deviceId: 2049, inode: 100 + i, hash: { ...hash, headHex: `h${i}` },
        }),
        path: `/media/movies/film-${i}.mkv`,
      });
      repo.setState({ fileId: id, state: 'queued' });
    }
    const claimed = new Set<string>();
    for (;;) {
      const claim = repo.claimNext({ workerClass: 'transcode', nowMs: NOW });
      if (claim === null) break;
      expect(claimed.has(claim.fileId)).toBe(false);
      claimed.add(claim.fileId);
    }
    expect(claimed.size).toBe(25);
  });

  it('skips a held file until its hold expires', () => {
    const id = scan();
    repo.setState({ fileId: id, state: 'held', holdUntilMs: NOW + 1000 });
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW + 2000 })?.fileId).toBe(id);
  });

  it('never claims terminal files', () => {
    for (const state of ['good', 'failed', 'not_converging'] as const) {
      const id = scan({
        identity: buildIdentityCandidate({
          deviceId: 2049, inode: 500, hash: { ...hash, headHex: state },
        }),
        path: `/media/movies/${state}.mkv`,
      });
      repo.setState({ fileId: id, state });
    }
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW })).toBeNull();
  });

  it('orders by priority then discovery time', () => {
    const older = scan({
      identity: buildIdentityCandidate({
        deviceId: 2049, inode: 1, hash: { ...hash, headHex: '01' },
      }),
      path: '/a.mkv',
      nowMs: NOW,
    });
    const urgent = scan({
      identity: buildIdentityCandidate({
        deviceId: 2049, inode: 2, hash: { ...hash, headHex: '02' },
      }),
      path: '/b.mkv',
      nowMs: NOW + 5000,
    });
    repo.setState({ fileId: older, state: 'queued' });
    repo.setState({ fileId: urgent, state: 'queued' });
    db.prepare(`UPDATE media_file SET priority = 10 WHERE id = ?`).run(urgent);

    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW + 9000 })?.fileId).toBe(urgent);
    expect(repo.claimNext({ workerClass: 'transcode', nowMs: NOW + 9000 })?.fileId).toBe(older);
  });

  it('honours a library filter', () => {
    db.prepare(`INSERT INTO library (id, name, created_at) VALUES (?, ?, ?)`).run(
      'lib-tv', 'TV', NOW,
    );
    queueOne();
    expect(
      repo.claimNext({ workerClass: 'transcode', nowMs: NOW, libraryIds: ['lib-tv'] }),
    ).toBeNull();
    expect(
      repo.claimNext({ workerClass: 'transcode', nowMs: NOW, libraryIds: [LIB] }),
    ).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm test -- packages/server/src/db/media-file-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the media-file repo**

`packages/server/src/db/media-file-repo.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { FileState, IdentityCandidate, IdentityLookup } from '@trawlarr/core';
import type { Db } from './connection.js';

export interface MediaFileRow {
  id: string;
  library_id: string;
  inode_key: string | null;
  content_key: string;
  path: string;
  nlink: number;
  size_bytes: number;
  mtime_ms: number;
  ctime_ms: number;
  container: string;
  state: FileState;
  signature: string | null;
  attempt_count: number;
  consecutive_noop_count: number;
  hold_until_ms: number | null;
  priority: number;
  discovered_at: number;
}

export interface UpsertScannedInput {
  libraryId: string;
  identity: IdentityCandidate;
  path: string;
  nlink: number;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  container: string;
  nowMs: number;
}

export interface ClaimedFile {
  fileId: string;
  libraryId: string;
  path: string;
}

export interface MediaFileRepo {
  identityLookup(libraryId: string): IdentityLookup;
  upsertScanned(input: UpsertScannedInput): string;
  claimNext(input: {
    workerClass: string;
    nowMs: number;
    libraryIds?: string[];
  }): ClaimedFile | null;
  setState(input: {
    fileId: string;
    state: FileState;
    signature?: string | null;
    attemptCount?: number;
    consecutiveNoopCount?: number;
    holdUntilMs?: number | null;
  }): void;
  getById(fileId: string): MediaFileRow | null;
}

export const createMediaFileRepo = (db: Db): MediaFileRepo => {
  const byInode = db.prepare(
    `SELECT id FROM media_file WHERE library_id = ? AND inode_key = ?`,
  );
  const byContent = db.prepare(
    `SELECT id FROM media_file WHERE library_id = ? AND content_key = ?`,
  );
  const selectById = db.prepare(`SELECT * FROM media_file WHERE id = ?`);

  const insertFile = db.prepare(
    `INSERT INTO media_file (
       id, library_id, inode_key, content_key, path, nlink,
       size_bytes, mtime_ms, ctime_ms, container,
       state, original_size_bytes, discovered_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)`,
  );

  const updateScanned = db.prepare(
    `UPDATE media_file
        SET inode_key = ?, content_key = ?, path = ?, nlink = ?,
            size_bytes = ?, mtime_ms = ?, ctime_ms = ?, container = ?, updated_at = ?
      WHERE id = ?`,
  );

  /**
   * Claim in one statement. A read-then-write queue lets two workers select
   * the same row and transcode it twice into each other's output, so the
   * SELECT that picks the row and the UPDATE that takes it must be atomic.
   */
  const claimStatement = db.prepare(
    `UPDATE media_file
        SET state = 'running', updated_at = :nowMs
      WHERE id = (
        SELECT id FROM media_file
         WHERE state IN ('queued', 'held')
           AND (hold_until_ms IS NULL OR hold_until_ms < :nowMs)
           AND (:filterLibraries = 0 OR library_id IN (SELECT value FROM json_each(:libraryIds)))
         ORDER BY priority DESC, discovered_at ASC
         LIMIT 1
      )
      RETURNING id AS fileId, library_id AS libraryId, path`,
  );

  const identityLookup = (libraryId: string): IdentityLookup => ({
    byInodeKey: (key) =>
      (byInode.get(libraryId, key) as { id: string } | undefined)?.id ?? null,
    byContentKey: (key) =>
      (byContent.get(libraryId, key) as { id: string } | undefined)?.id ?? null,
  });

  return {
    identityLookup,

    upsertScanned(input) {
      const lookup = identityLookup(input.libraryId);
      const existing =
        (input.identity.inodeKey !== null ? lookup.byInodeKey(input.identity.inodeKey) : null) ??
        lookup.byContentKey(input.identity.contentKey);

      if (existing !== null) {
        updateScanned.run(
          input.identity.inodeKey,
          input.identity.contentKey,
          input.path,
          input.nlink,
          input.sizeBytes,
          input.mtimeMs,
          input.ctimeMs,
          input.container,
          input.nowMs,
          existing,
        );
        return existing;
      }

      const id = randomUUID();
      insertFile.run(
        id,
        input.libraryId,
        input.identity.inodeKey,
        input.identity.contentKey,
        input.path,
        input.nlink,
        input.sizeBytes,
        input.mtimeMs,
        input.ctimeMs,
        input.container,
        input.sizeBytes,
        input.nowMs,
        input.nowMs,
      );
      return id;
    },

    claimNext(input) {
      const filterLibraries = input.libraryIds === undefined ? 0 : 1;
      const row = claimStatement.get({
        nowMs: input.nowMs,
        filterLibraries,
        libraryIds: JSON.stringify(input.libraryIds ?? []),
      }) as ClaimedFile | undefined;
      return row ?? null;
    },

    setState(input) {
      const current = selectById.get(input.fileId) as MediaFileRow | undefined;
      if (current === undefined) throw new Error(`Unknown media file: ${input.fileId}`);

      db.prepare(
        `UPDATE media_file
            SET state = ?, signature = ?, attempt_count = ?,
                consecutive_noop_count = ?, hold_until_ms = ?
          WHERE id = ?`,
      ).run(
        input.state,
        input.signature === undefined ? current.signature : input.signature,
        input.attemptCount ?? current.attempt_count,
        input.consecutiveNoopCount ?? current.consecutive_noop_count,
        input.holdUntilMs === undefined ? current.hold_until_ms : input.holdUntilMs,
        input.fileId,
      );
    },

    getById(fileId) {
      return (selectById.get(fileId) as MediaFileRow | undefined) ?? null;
    },
  };
};
```

> `workerClass` is accepted but not yet used for filtering: worker classes gain their own eligibility rules with the supervisor in P2. Taking the parameter now keeps the call sites stable.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- packages/server/src/db/media-file-repo.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Write the failing plugin-document test**

`packages/server/src/db/plugin-document-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { migrate } from './migrate.js';
import { createPluginDocumentRepo, type PluginDocumentRepo } from './plugin-document-repo.js';

const NOW = 1_700_000_000_000;
let db: Db;
let repo: PluginDocumentRepo;

beforeEach(() => {
  db = openDatabase({ file: ':memory:' });
  migrate(db);
  repo = createPluginDocumentRepo(db);
});

describe('plugin document store', () => {
  it('returns undefined for a document that does not exist', () => {
    // processedCheck relies on this: absence must be distinguishable, not an error.
    expect(repo.get('F2FOutputJSONDB', '/media/movie.mkv')).toBeUndefined();
  });

  it('round-trips an inserted document', () => {
    repo.insert('F2FOutputJSONDB', '/media/movie.mkv', { _id: '/media/movie.mkv', DB: 'db1' }, NOW);
    expect(repo.get('F2FOutputJSONDB', '/media/movie.mkv')).toEqual({
      _id: '/media/movie.mkv',
      DB: 'db1',
    });
  });

  it('replaces on insert of the same id, matching the observed remove-then-insert pattern', () => {
    repo.insert('F2FOutputJSONDB', 'k', { v: 1 }, NOW);
    repo.insert('F2FOutputJSONDB', 'k', { v: 2 }, NOW + 1);
    expect(repo.get('F2FOutputJSONDB', 'k')).toEqual({ v: 2 });
  });

  it('merges on update rather than overwriting', () => {
    repo.insert('SettingsGlobalJSONDB', 'globalsettings', { a: 1, b: 2 }, NOW);
    repo.update('SettingsGlobalJSONDB', 'globalsettings', { b: 3 }, NOW + 1);
    expect(repo.get('SettingsGlobalJSONDB', 'globalsettings')).toEqual({ a: 1, b: 3 });
  });

  it('creates the document when updating one that does not exist', () => {
    repo.update('C', 'k', { a: 1 }, NOW);
    expect(repo.get('C', 'k')).toEqual({ a: 1 });
  });

  it('removes a document', () => {
    repo.insert('C', 'k', { a: 1 }, NOW);
    repo.removeOne('C', 'k');
    expect(repo.get('C', 'k')).toBeUndefined();
  });

  it('tolerates removing something absent', () => {
    expect(() => repo.removeOne('C', 'missing')).not.toThrow();
  });

  it('keeps collections isolated', () => {
    repo.insert('A', 'k', { from: 'A' }, NOW);
    repo.insert('B', 'k', { from: 'B' }, NOW);
    expect(repo.get('A', 'k')).toEqual({ from: 'A' });
    expect(repo.get('B', 'k')).toEqual({ from: 'B' });
  });
});
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `pnpm test -- packages/server/src/db/plugin-document-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement**

`packages/server/src/db/plugin-document-repo.ts`:

```ts
import type { Db } from './connection.js';

export type PluginDocument = Record<string, unknown>;

export interface PluginDocumentRepo {
  get(collection: string, docId: string): PluginDocument | undefined;
  insert(collection: string, docId: string, data: PluginDocument, nowMs: number): void;
  update(collection: string, docId: string, patch: PluginDocument, nowMs: number): void;
  removeOne(collection: string, docId: string): void;
}

/**
 * Generic document storage backing deps.crudTransDBN. Plugins invent their
 * own collection names (F2FOutputJSONDB is one such), so this must accept
 * anything rather than validating against a known set.
 */
export const createPluginDocumentRepo = (db: Db): PluginDocumentRepo => {
  const selectOne = db.prepare(
    `SELECT data_json FROM plugin_document WHERE collection = ? AND doc_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO plugin_document (collection, doc_id, data_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(collection, doc_id)
       DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
  );
  const deleteOne = db.prepare(
    `DELETE FROM plugin_document WHERE collection = ? AND doc_id = ?`,
  );

  const read = (collection: string, docId: string): PluginDocument | undefined => {
    const row = selectOne.get(collection, docId) as { data_json: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.data_json) as PluginDocument);
  };

  return {
    get: read,

    insert(collection, docId, data, nowMs) {
      upsert.run(collection, docId, JSON.stringify(data), nowMs);
    },

    update(collection, docId, patch, nowMs) {
      const merged = { ...(read(collection, docId) ?? {}), ...patch };
      upsert.run(collection, docId, JSON.stringify(merged), nowMs);
    },

    removeOne(collection, docId) {
      deleteOne.run(collection, docId);
    },
  };
};
```

- [ ] **Step 9: Create the server barrel**

`packages/server/src/index.ts`:

```ts
export * from './db/connection.js';
export * from './db/migrate.js';
export * from './db/chunked.js';
export * from './db/media-file-repo.js';
export * from './db/plugin-document-repo.js';
```

- [ ] **Step 10: Run everything**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: PASS. P0 is complete: 89 tests.

- [ ] **Step 11: Commit**

```bash
git add packages/server
git commit -m "feat(server): schema, identity-preserving upsert, atomic claim, plugin document store"
```

---

# Phase P1 — the engine

P1 is the risk-retiring phase. It ends with real Tdarr community plugins running against real media from a CLI. If that does not work, the project premise is wrong, so nothing user-visible is built until it does.

---

## Task 10: CommonJS plugin sandbox and loader

Spec §2.1. Plugins are compiled CommonJS and some of them `require` Node builtins directly, so the host needs a real module environment rather than an `eval` wrapper.

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`
- Create: `packages/engine/src/host/require-from-string.ts`, `packages/engine/src/host/loader.ts`
- Test: `packages/engine/test/fixtures/make-plugin.ts`, `packages/engine/src/host/require-from-string.test.ts`, `packages/engine/src/host/loader.test.ts`

**Interfaces:**
- Consumes: Task 2 (`PluginModule`, `PluginDetails`).
- Produces:
  - `requireFromString(input: { code: string; filename: string }): Record<string, unknown>`
  - `interface LoadedPlugin { id: string; absPath: string; version: string; details: PluginDetails; module: PluginModule }`
  - `createPluginLoader(): PluginLoader` with `load(absPath: string, options?: { version?: string; fresh?: boolean }): LoadedPlugin` and `clear(): void`
  - `class PluginLoadError extends Error` carrying `absPath`

- [ ] **Step 1: Create the package manifest**

`packages/engine/package.json`:

```json
{
  "name": "@trawlarr/engine",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "trawlarr-engine": "./dist/cli.js" },
  "files": ["dist"],
  "dependencies": {
    "@trawlarr/core": "workspace:*",
    "@trawlarr/plugin-api": "workspace:*",
    "axios": "^1.7.7",
    "fs-extra": "^11.2.0",
    "graceful-fs": "^4.2.11",
    "import-fresh": "^3.3.0",
    "mvdir": "^1.0.21",
    "ncp": "^2.0.0",
    "string-argv": "^0.3.2",
    "upath": "^2.0.1"
  },
  "devDependencies": {
    "@types/fs-extra": "^11.0.4",
    "@types/graceful-fs": "^4.1.9",
    "@types/ncp": "^2.0.7"
  }
}
```

These are the modules the contract injects into plugin scope (spec §2.3). Run `pnpm install`, then `pnpm audit:licenses` — confirm each is permissive before proceeding. If any is not, stop and report rather than proceeding.

`packages/engine/tsconfig.json` — same shape as `server`'s, referencing `../core` and `../plugin-api`.

- [ ] **Step 2: Write the plugin fixture helper**

`packages/engine/test/fixtures/make-plugin.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Write a CommonJS plugin to a throwaway directory and return its path. */
export const writePluginFile = (code: string, filename = 'index.js'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'trawlarr-plugin-'));
  const abs = join(dir, filename);
  writeFileSync(abs, code, 'utf8');
  return abs;
};

/** A minimal plugin that routes to a fixed output number. */
export const simplePluginCode = (outputNumber = 1): string => `
const details = () => ({
  name: 'Test Plugin',
  description: 'fixture',
  style: { borderColor: '#000000' },
  tags: 'test',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'out 1' }, { number: 2, tooltip: 'out 2' }],
  requiresVersion: '2.11.01',
});

const plugin = (args) => ({
  outputNumber: ${outputNumber},
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});

module.exports = { details, plugin };
`;
```

- [ ] **Step 3: Write the failing sandbox test**

`packages/engine/src/host/require-from-string.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { requireFromString } from './require-from-string.js';
import { writePluginFile } from '../../test/fixtures/make-plugin.js';

describe('requireFromString', () => {
  it('returns module.exports from CommonJS source', () => {
    const exports = requireFromString({
      code: `module.exports = { answer: 42 };`,
      filename: '/virtual/plugin.js',
    });
    expect(exports.answer).toBe(42);
  });

  it('supports the exports shorthand', () => {
    const exports = requireFromString({
      code: `exports.details = () => 'd';`,
      filename: '/virtual/plugin.js',
    });
    expect(typeof exports.details).toBe('function');
  });

  it('lets a plugin require Node builtins, which real plugins do', () => {
    const exports = requireFromString({
      code: `
        const path = require('node:path');
        const cp = require('child_process');
        module.exports = { joined: path.join('a', 'b'), hasSpawn: typeof cp.spawn };
      `,
      filename: '/virtual/plugin.js',
    });
    expect(exports.joined).toBe(join('a', 'b'));
    expect(exports.hasSpawn).toBe('function');
  });

  it('resolves relative requires against the plugin file', () => {
    const abs = writePluginFile(`module.exports = require('./helper.js').value;`);
    writeFileSync(abs.replace('index.js', 'helper.js'), `module.exports = { value: 7 };`, 'utf8');
    expect(requireFromString({ code: `module.exports = require('./helper.js').value;`, filename: abs }))
      .toBe(7);
  });

  it('exposes __filename and __dirname', () => {
    const exports = requireFromString({
      code: `module.exports = { f: __filename, d: __dirname };`,
      filename: '/virtual/nested/plugin.js',
    });
    expect(exports.f).toBe('/virtual/nested/plugin.js');
    expect(exports.d).toBe('/virtual/nested');
  });

  it('compiles fresh each time, so two loads do not share state', () => {
    const code = `let calls = 0; module.exports = { bump: () => ++calls };`;
    const a = requireFromString({ code, filename: '/virtual/p.js' }) as {
      bump: () => number;
    };
    const b = requireFromString({ code, filename: '/virtual/p.js' }) as {
      bump: () => number;
    };
    expect(a.bump()).toBe(1);
    expect(b.bump()).toBe(1);
  });

  it('propagates a syntax error with the filename attached', () => {
    expect(() =>
      requireFromString({ code: `module.exports = {`, filename: '/virtual/broken.js' }),
    ).toThrow();
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/host/require-from-string.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the sandbox**

`packages/engine/src/host/require-from-string.ts`:

```ts
import Module from 'node:module';
import { dirname } from 'node:path';

/**
 * Internal-but-stable Node module internals. `require-from-string` on npm
 * uses exactly these; they are how you get a real CommonJS environment
 * (working `require`, `__dirname`, correct resolution paths) rather than a
 * bare `eval`. Plugins genuinely require builtins, so this matters.
 */
interface ModuleInternals {
  _compile(code: string, filename: string): void;
  _nodeModulePaths(dir: string): string[];
  paths: string[];
  filename: string;
  exports: Record<string, unknown>;
}

const ModuleCtor = Module as unknown as {
  new (id: string, parent?: Module): ModuleInternals;
  _nodeModulePaths(dir: string): string[];
};

/**
 * Compile CommonJS source into a fresh module instance.
 *
 * Deliberately does not populate require.cache: every call yields a clean
 * module, which is what the contract's `importFresh` semantics require and
 * what stops one job's plugin state leaking into the next.
 */
export const requireFromString = (input: {
  code: string;
  filename: string;
}): Record<string, unknown> => {
  const mod = new ModuleCtor(input.filename);
  mod.filename = input.filename;
  mod.paths = ModuleCtor._nodeModulePaths(dirname(input.filename));
  mod._compile(input.code, input.filename);
  return mod.exports;
};
```

- [ ] **Step 6: Run the sandbox tests**

Run: `pnpm test -- packages/engine/src/host/require-from-string.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Write the failing loader test**

`packages/engine/src/host/loader.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { utimesSync, writeFileSync } from 'node:fs';
import { PluginLoadError, createPluginLoader } from './loader.js';
import { simplePluginCode, writePluginFile } from '../../test/fixtures/make-plugin.js';

describe('createPluginLoader', () => {
  it('loads a plugin and reads its details', () => {
    const abs = writePluginFile(simplePluginCode());
    const loaded = createPluginLoader().load(abs);
    expect(loaded.details.name).toBe('Test Plugin');
    expect(loaded.details.outputs).toHaveLength(2);
    expect(typeof loaded.module.plugin).toBe('function');
    expect(loaded.absPath).toBe(abs);
  });

  it('derives a stable id from the path when none is given', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    expect(loader.load(abs).id).toBe(loader.load(abs).id);
  });

  it('defaults the version to requiresVersion when not supplied', () => {
    const abs = writePluginFile(simplePluginCode());
    expect(createPluginLoader().load(abs).version).toBe('2.11.01');
  });

  it('prefers an explicitly supplied version', () => {
    const abs = writePluginFile(simplePluginCode());
    expect(createPluginLoader().load(abs, { version: '3.0.0' }).version).toBe('3.0.0');
  });

  it('caches by path and mtime', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    expect(loader.load(abs).module).toBe(loader.load(abs).module);
  });

  it('reloads when the file changes on disk', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    const first = loader.load(abs);
    writeFileSync(abs, simplePluginCode(2), 'utf8');
    const later = new Date(Date.now() + 5000);
    utimesSync(abs, later, later);
    expect(loader.load(abs).module).not.toBe(first.module);
  });

  it('bypasses the cache when asked for a fresh load', () => {
    const abs = writePluginFile(simplePluginCode());
    const loader = createPluginLoader();
    expect(loader.load(abs, { fresh: true }).module).not.toBe(loader.load(abs).module);
  });

  it('rejects a file that is not a plugin', () => {
    const abs = writePluginFile(`module.exports = { nope: true };`);
    expect(() => createPluginLoader().load(abs)).toThrow(PluginLoadError);
    expect(() => createPluginLoader().load(abs)).toThrow(/must export.*details.*plugin/i);
  });

  it('rejects details() that omits outputs, which the editor cannot render', () => {
    const abs = writePluginFile(`
      module.exports = {
        details: () => ({ name: 'x', description: '', style: {}, tags: '', inputs: [] }),
        plugin: () => ({}),
      };
    `);
    expect(() => createPluginLoader().load(abs)).toThrow(/outputs/i);
  });

  it('names the file in the error when details() throws', () => {
    const abs = writePluginFile(`
      module.exports = { details: () => { throw new Error('bad details'); }, plugin: () => ({}) };
    `);
    try {
      createPluginLoader().load(abs);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginLoadError);
      expect((error as PluginLoadError).absPath).toBe(abs);
      expect((error as Error).message).toMatch(/bad details/);
    }
  });

  it('reports a missing file clearly', () => {
    expect(() => createPluginLoader().load('/nope/missing.js')).toThrow(PluginLoadError);
  });
});
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/host/loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 9: Implement the loader**

`packages/engine/src/host/loader.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { PluginDetails, PluginModule } from '@trawlarr/plugin-api';
import { requireFromString } from './require-from-string.js';

export class PluginLoadError extends Error {
  readonly absPath: string;

  constructor(absPath: string, message: string, options?: { cause?: unknown }) {
    super(`Failed to load plugin ${absPath}: ${message}`, options);
    this.name = 'PluginLoadError';
    this.absPath = absPath;
  }
}

export interface LoadedPlugin {
  id: string;
  absPath: string;
  version: string;
  details: PluginDetails;
  module: PluginModule;
}

export interface PluginLoader {
  load(absPath: string, options?: { version?: string; fresh?: boolean }): LoadedPlugin;
  clear(): void;
}

const idFor = (absPath: string): string =>
  createHash('sha256').update(absPath).digest('hex').slice(0, 16);

const assertPluginModule = (absPath: string, exports: Record<string, unknown>): PluginModule => {
  if (typeof exports.details !== 'function' || typeof exports.plugin !== 'function') {
    throw new PluginLoadError(
      absPath,
      'a plugin must export both a details() and a plugin() function',
    );
  }
  return exports as unknown as PluginModule;
};

const readDetails = (absPath: string, module: PluginModule): PluginDetails => {
  let details: PluginDetails;
  try {
    details = module.details();
  } catch (cause) {
    throw new PluginLoadError(absPath, `details() threw: ${(cause as Error).message}`, { cause });
  }

  if (details === null || typeof details !== 'object') {
    throw new PluginLoadError(absPath, 'details() must return an object');
  }
  if (!Array.isArray(details.outputs)) {
    throw new PluginLoadError(absPath, 'details() must return an outputs array');
  }
  if (!Array.isArray(details.inputs)) {
    throw new PluginLoadError(absPath, 'details() must return an inputs array');
  }
  return details;
};

export const createPluginLoader = (): PluginLoader => {
  const cache = new Map<string, { mtimeMs: number; loaded: LoadedPlugin }>();

  return {
    load(absPath, options) {
      let mtimeMs: number;
      let code: string;
      try {
        mtimeMs = statSync(absPath).mtimeMs;
        code = readFileSync(absPath, 'utf8');
      } catch (cause) {
        throw new PluginLoadError(absPath, (cause as Error).message, { cause });
      }

      const fresh = options?.fresh === true;
      const cached = cache.get(absPath);
      if (!fresh && cached !== undefined && cached.mtimeMs === mtimeMs) {
        return cached.loaded;
      }

      let exports: Record<string, unknown>;
      try {
        exports = requireFromString({ code, filename: absPath });
      } catch (cause) {
        throw new PluginLoadError(absPath, (cause as Error).message, { cause });
      }

      const module = assertPluginModule(absPath, exports);
      const details = readDetails(absPath, module);

      const loaded: LoadedPlugin = {
        id: idFor(absPath),
        absPath,
        version: options?.version ?? details.requiresVersion ?? '0.0.0',
        details,
        module,
      };

      if (!fresh) cache.set(absPath, { mtimeMs, loaded });
      return loaded;
    },

    clear() {
      cache.clear();
    },
  };
};
```

- [ ] **Step 10: Run the tests**

Run: `pnpm test -- packages/engine`
Expected: PASS, 18 tests.

- [ ] **Step 11: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): CommonJS plugin sandbox and validating loader"
```

---

## Task 11: File-object projection

Spec §2.4. The projection is a wide surface with an open index signature, and the legacy status enums are read *and written* by plugins — omitting them silently breaks any plugin that branches on them.

**Files:**
- Create: `packages/engine/src/host/file-object.ts`
- Test: `packages/engine/src/host/file-object.test.ts`

**Interfaces:**
- Consumes: Task 2 (`PluginFileObject`, `ProbeData`, `HealthCheckStatus`, `TranscodeDecision`), Task 7 (`FileState`).
- Produces:
  - `interface ProjectionSource { fileId: string; libraryId: string; footprintId: string; path: string; container: string; sizeBytes: number; originalSizeBytes: number; mtimeMs: number; ctimeMs: number; probe: ProbeData; exiftool?: Record<string, unknown>; mediainfo?: Record<string, unknown>; state: FileState; lastRunModified: boolean; healthStatus?: HealthCheckStatus; holdUntilMs: number | null; lastTranscodeMs: number | null; lastHealthCheckMs: number | null; history: string; discoveredAtMs: number }`
  - `toPluginFileObject(source: ProjectionSource): PluginFileObject`
  - `interface AbsorbedChanges { path: string; healthStatus: HealthCheckStatus; transcodeDecision: TranscodeDecision; holdUntilMs: number | null; bumped: boolean; newSizeBytes: number | null }`
  - `absorbPluginFileObject(fileObject: PluginFileObject): AbsorbedChanges`
  - `projectTranscodeDecision(state: FileState, lastRunModified: boolean): TranscodeDecision`

- [ ] **Step 1: Write the failing test**

`packages/engine/src/host/file-object.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import {
  absorbPluginFileObject,
  projectTranscodeDecision,
  toPluginFileObject,
  type ProjectionSource,
} from './file-object.js';

const probe: ProbeData = {
  format: { duration: '5400.0', bit_rate: '8000000', nb_streams: 2 },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'eac3', tags: { language: 'eng' } },
  ],
};

const source = (over: Partial<ProjectionSource> = {}): ProjectionSource => ({
  fileId: 'file-1',
  libraryId: 'lib-movies',
  footprintId: '2049:42',
  path: '/media/movies/Arrival.mkv',
  container: 'mkv',
  sizeBytes: 8_000_000_000,
  originalSizeBytes: 12_000_000_000,
  mtimeMs: 1_700_000_000_000,
  ctimeMs: 1_699_000_000_000,
  probe,
  state: 'good',
  lastRunModified: true,
  holdUntilMs: null,
  lastTranscodeMs: 1_700_000_500_000,
  lastHealthCheckMs: null,
  history: '',
  discoveredAtMs: 1_690_000_000_000,
  ...over,
});

describe('toPluginFileObject', () => {
  it('puts the PATH in _id, because that is what the contract means', () => {
    const file = toPluginFileObject(source());
    expect(file._id).toBe('/media/movies/Arrival.mkv');
    expect(file.file).toBe('/media/movies/Arrival.mkv');
  });

  it('projects trawlarr identity into footprintId, keeping it separate from _id', () => {
    const file = toPluginFileObject(source());
    expect(file.footprintId).toBe('2049:42');
    expect(file.footprintId).not.toBe(file._id);
  });

  it('carries the probe payload through untouched', () => {
    expect(toPluginFileObject(source()).ffProbeData).toEqual(probe);
  });

  it('denormalises the fields plugins commonly read', () => {
    const file = toPluginFileObject(source());
    expect(file.video_codec_name).toBe('h264');
    expect(file.audio_codec_name).toBe('eac3');
    expect(file.video_resolution).toBe('1080p');
    expect(file.videoStreamIndex).toBe(0);
    expect(file.container).toBe('mkv');
    expect(file.file_size).toBe(8_000_000_000);
    expect(file.bit_rate).toBe(8_000_000);
  });

  it('classifies common resolutions', () => {
    const at = (width: number, height: number) =>
      toPluginFileObject(
        source({
          probe: { streams: [{ codec_type: 'video', codec_name: 'h264', width, height }] },
        }),
      ).video_resolution;
    expect(at(3840, 2160)).toBe('4KUHD');
    expect(at(1920, 1080)).toBe('1080p');
    expect(at(1280, 720)).toBe('720p');
    expect(at(720, 480)).toBe('480p');
  });

  it('reports which scanner reads have happened', () => {
    const bare = toPluginFileObject(source());
    expect(bare.scannerReads.ffProbeRead).toBe('true');
    expect(bare.scannerReads.exiftoolRead).toBe('false');

    const enriched = toPluginFileObject(source({ exiftool: { FileType: 'MKV' } }));
    expect(enriched.scannerReads.exiftoolRead).toBe('true');
    expect(enriched.meta).toEqual({ FileType: 'MKV' });
  });

  it('omits meta and mediaInfo when those probes have not run', () => {
    const file = toPluginFileObject(source());
    expect(file.meta).toBeUndefined();
    expect(file.mediaInfo).toBeUndefined();
  });

  it('reports size history so size-comparison plugins work', () => {
    const file = toPluginFileObject(source());
    expect(file.oldSize).toBe(12_000_000_000);
    expect(file.newSize).toBe(8_000_000_000);
  });

  it('survives a probe with no streams', () => {
    const file = toPluginFileObject(source({ probe: {} }));
    expect(file.video_codec_name).toBe('');
    expect(file.video_resolution).toBe('');
    expect(file.videoStreamIndex).toBe(0);
  });
});

describe('projectTranscodeDecision', () => {
  it('maps ledger state onto the legacy enum plugins branch on', () => {
    expect(projectTranscodeDecision('good', true)).toBe('Transcode success');
    expect(projectTranscodeDecision('good', false)).toBe('Not required');
    expect(projectTranscodeDecision('queued', false)).toBe('Queued');
    expect(projectTranscodeDecision('held', false)).toBe('Hold');
    expect(projectTranscodeDecision('failed', false)).toBe('Transcode error');
    expect(projectTranscodeDecision('not_converging', true)).toBe('Transcode error');
    expect(projectTranscodeDecision('running', false)).toBe('');
    expect(projectTranscodeDecision('unknown', false)).toBe('');
  });
});

describe('absorbPluginFileObject', () => {
  it('picks up a path change a plugin made', () => {
    const file = toPluginFileObject(source());
    file._id = '/media/movies/Arrival.mp4';
    expect(absorbPluginFileObject(file).path).toBe('/media/movies/Arrival.mp4');
  });

  it('picks up status writes, which plugins really do perform', () => {
    const file = toPluginFileObject(source());
    file.HealthCheck = 'Error';
    file.TranscodeDecisionMaker = 'Transcode error';
    const absorbed = absorbPluginFileObject(file);
    expect(absorbed.healthStatus).toBe('Error');
    expect(absorbed.transcodeDecision).toBe('Transcode error');
  });

  it('picks up holdUntil and bumped, mapping onto scheduling', () => {
    const file = toPluginFileObject(source());
    file.holdUntil = 1_800_000_000_000;
    file.bumped = true;
    const absorbed = absorbPluginFileObject(file);
    expect(absorbed.holdUntilMs).toBe(1_800_000_000_000);
    expect(absorbed.bumped).toBe(true);
  });

  it('treats a zero holdUntil as no hold', () => {
    const file = toPluginFileObject(source());
    file.holdUntil = 0;
    expect(absorbPluginFileObject(file).holdUntilMs).toBeNull();
  });

  it('ignores nonsense values rather than corrupting state', () => {
    const file = toPluginFileObject(source());
    (file as Record<string, unknown>).HealthCheck = 'Bananas';
    (file as Record<string, unknown>).holdUntil = 'soon';
    const absorbed = absorbPluginFileObject(file);
    expect(absorbed.healthStatus).toBe('');
    expect(absorbed.holdUntilMs).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/host/file-object.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/engine/src/host/file-object.ts`:

```ts
import type {
  HealthCheckStatus,
  PluginFileObject,
  ProbeData,
  ProbeStream,
  TranscodeDecision,
} from '@trawlarr/plugin-api';
import type { FileState } from '@trawlarr/core';

export interface ProjectionSource {
  fileId: string;
  libraryId: string;
  /** Trawlarr's stable identity — deliberately not the path. */
  footprintId: string;
  path: string;
  container: string;
  sizeBytes: number;
  originalSizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  probe: ProbeData;
  exiftool?: Record<string, unknown>;
  mediainfo?: Record<string, unknown>;
  state: FileState;
  /** Whether the most recent successful run modified the file. */
  lastRunModified: boolean;
  healthStatus?: HealthCheckStatus;
  holdUntilMs: number | null;
  lastTranscodeMs: number | null;
  lastHealthCheckMs: number | null;
  history: string;
  discoveredAtMs: number;
}

export interface AbsorbedChanges {
  path: string;
  healthStatus: HealthCheckStatus;
  transcodeDecision: TranscodeDecision;
  holdUntilMs: number | null;
  bumped: boolean;
  newSizeBytes: number | null;
}

const HEALTH_VALUES = new Set<HealthCheckStatus>([
  '', 'Hold', 'Queued', 'Success', 'Error', 'Cancelled',
]);

const DECISION_VALUES = new Set<TranscodeDecision>([
  '', 'Hold', 'Queued',
  'Transcode success', 'Transcode error', 'Transcode cancelled', 'Not required',
]);

/**
 * Trawlarr's ledger is the source of truth, but plugins branch on these two
 * legacy strings, so the ledger is projected into them on the way out and
 * their writes are absorbed on the way back in.
 */
export const projectTranscodeDecision = (
  state: FileState,
  lastRunModified: boolean,
): TranscodeDecision => {
  switch (state) {
    case 'good':
      return lastRunModified ? 'Transcode success' : 'Not required';
    case 'queued':
      return 'Queued';
    case 'held':
      return 'Hold';
    case 'failed':
    case 'not_converging':
      return 'Transcode error';
    default:
      return '';
  }
};

const videoStreamIndexOf = (streams: ProbeStream[]): number => {
  const index = streams.findIndex((s) => s.codec_type === 'video');
  return index === -1 ? 0 : index;
};

/** Resolution labels follow the vocabulary community plugins already compare against. */
const resolutionLabel = (width: number | undefined, height: number | undefined): string => {
  if (typeof width !== 'number' || typeof height !== 'number') return '';
  if (width >= 7000) return '8KUHD';
  if (width >= 3000) return '4KUHD';
  if (width >= 1800) return '1080p';
  if (width >= 1200) return '720p';
  if (width >= 1000) return '576p';
  if (width >= 700) return '480p';
  return 'other';
};

const numeric = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const toPluginFileObject = (source: ProjectionSource): PluginFileObject => {
  const streams = source.probe.streams ?? [];
  const videoIndex = videoStreamIndexOf(streams);
  const video = streams[videoIndex];
  const audio = streams.find((s) => s.codec_type === 'audio');

  const file: PluginFileObject = {
    _id: source.path,
    file: source.path,
    DB: source.libraryId,
    footprintId: source.footprintId,
    container: source.container,
    createdAt: source.discoveredAtMs,
    file_size: source.sizeBytes,
    bit_rate: numeric(source.probe.format?.bit_rate),
    statSync: { mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs },
    scannerReads: {
      ffProbeRead: source.probe.streams === undefined ? 'false' : 'true',
      exiftoolRead: source.exiftool === undefined ? 'false' : 'true',
      mediaInfoRead: source.mediainfo === undefined ? 'false' : 'true',
      closedCaptionRead: 'false',
    },
    ffProbeData: source.probe,
    hasClosedCaptions: false,
    bumped: false,
    HealthCheck: source.healthStatus ?? '',
    TranscodeDecisionMaker: projectTranscodeDecision(source.state, source.lastRunModified),
    holdUntil: source.holdUntilMs ?? 0,
    fileMedium: video === undefined ? 'audio' : 'video',
    video_codec_name: video?.codec_name ?? '',
    audio_codec_name: audio?.codec_name ?? '',
    video_resolution: resolutionLabel(video?.width, video?.height),
    videoStreamIndex: videoIndex,
    lastHealthCheckDate: source.lastHealthCheckMs ?? 0,
    lastTranscodeDate: source.lastTranscodeMs ?? 0,
    history: source.history,
    oldSize: source.originalSizeBytes,
    newSize: source.sizeBytes,
    lastPluginDetails: '',
  };

  if (source.exiftool !== undefined) file.meta = source.exiftool;
  if (source.mediainfo !== undefined) file.mediaInfo = source.mediainfo;

  return file;
};

export const absorbPluginFileObject = (fileObject: PluginFileObject): AbsorbedChanges => {
  const health = fileObject.HealthCheck as unknown;
  const decision = fileObject.TranscodeDecisionMaker as unknown;
  const hold = fileObject.holdUntil as unknown;
  const newSize = fileObject.newSize as unknown;

  return {
    path: typeof fileObject._id === 'string' ? fileObject._id : '',
    healthStatus:
      typeof health === 'string' && HEALTH_VALUES.has(health as HealthCheckStatus)
        ? (health as HealthCheckStatus)
        : '',
    transcodeDecision:
      typeof decision === 'string' && DECISION_VALUES.has(decision as TranscodeDecision)
        ? (decision as TranscodeDecision)
        : '',
    holdUntilMs: typeof hold === 'number' && Number.isFinite(hold) && hold > 0 ? hold : null,
    bumped: fileObject.bumped === true,
    newSizeBytes: typeof newSize === 'number' && Number.isFinite(newSize) ? newSize : null,
  };
};
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- packages/engine`
Expected: PASS, 35 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): file-object projection with legacy status round-tripping"
```

---

## Task 12: Host services — `crudTransDBN`, `axiosMiddleware`, deps assembly

Spec §2.9. Both host services are confirmed in community plugin use, so a silent stub makes popular plugins produce wrong answers rather than errors. `processedCheck` in particular reports "not processed" for everything if `crudTransDBN` returns nothing.

**Files:**
- Create: `packages/engine/src/host/crud-trans-dbn.ts`, `packages/engine/src/host/axios-middleware.ts`, `packages/engine/src/host/deps.ts`
- Test: `packages/engine/src/host/crud-trans-dbn.test.ts`, `packages/engine/src/host/axios-middleware.test.ts`

**Interfaces:**
- Consumes: Task 2 (`PluginDeps`, `ConfigVars`, `CrudMode`), Task 9 (`PluginDocumentRepo`).
- Produces:
  - `interface HostSettingsPort { setPauseAllNodes(paused: boolean): void; getPauseAllNodes(): boolean }`
  - `interface DocumentPort { get(collection, docId): Record<string, unknown> | undefined; insert(collection, docId, data, nowMs): void; update(collection, docId, patch, nowMs): void; removeOne(collection, docId): void }` — satisfied directly by `PluginDocumentRepo` from Task 9
  - `HOST_COLLECTIONS: Set<string>`
  - `createCrudTransDbn(input: { documents: DocumentPort; hostSettings: HostSettingsPort; log: (text: string) => void; nowMs: () => number }): PluginDeps['crudTransDBN']`
  - `SUPPORTED_ENDPOINTS: Set<string>`
  - `createAxiosMiddleware(input: { probeFile: (path: string) => Promise<unknown>; log: (text: string) => void }): PluginDeps['axiosMiddleware']`
  - `class UnsupportedHostEndpointError extends Error`
  - `buildPluginDeps(input: { configVars: ConfigVars; crudTransDBN: PluginDeps['crudTransDBN']; axiosMiddleware: PluginDeps['axiosMiddleware'] }): PluginDeps`

- [ ] **Step 1: Write the failing `crudTransDBN` test**

`packages/engine/src/host/crud-trans-dbn.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_COLLECTIONS, createCrudTransDbn, type DocumentPort } from './crud-trans-dbn.js';

const NOW = 1_700_000_000_000;

const makeDocuments = (): DocumentPort & { store: Map<string, Record<string, unknown>> } => {
  const store = new Map<string, Record<string, unknown>>();
  const key = (c: string, d: string) => `${c}::${d}`;
  return {
    store,
    get: (c, d) => store.get(key(c, d)),
    insert: (c, d, data) => void store.set(key(c, d), data),
    update: (c, d, patch) =>
      void store.set(key(c, d), { ...(store.get(key(c, d)) ?? {}), ...patch }),
    removeOne: (c, d) => void store.delete(key(c, d)),
  };
};

let documents: ReturnType<typeof makeDocuments>;
let setPauseAllNodes: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.fn>;
let crud: ReturnType<typeof createCrudTransDbn>;
let paused = false;

beforeEach(() => {
  documents = makeDocuments();
  paused = false;
  setPauseAllNodes = vi.fn((value: boolean) => {
    paused = value;
  });
  log = vi.fn();
  crud = createCrudTransDbn({
    documents,
    hostSettings: { setPauseAllNodes, getPauseAllNodes: () => paused },
    log,
    nowMs: () => NOW,
  });
});

describe('plugin-owned collections', () => {
  it('returns undefined for an unknown document, as processedCheck expects', async () => {
    await expect(crud('F2FOutputJSONDB', 'getById', '/media/movie.mkv', {})).resolves.toBeUndefined();
  });

  it('round-trips the processedAdd then processedCheck sequence', async () => {
    // This is the exact pattern the community plugins use.
    await crud('F2FOutputJSONDB', 'removeOne', '/media/movie.mkv', {});
    await crud('F2FOutputJSONDB', 'insert', '/media/movie.mkv', {
      _id: '/media/movie.mkv',
      DB: 'lib-movies',
    });
    await expect(crud('F2FOutputJSONDB', 'getById', '/media/movie.mkv', {})).resolves.toEqual({
      _id: '/media/movie.mkv',
      DB: 'lib-movies',
    });
  });

  it('merges on update', async () => {
    await crud('MyDB', 'insert', 'k', { a: 1, b: 2 });
    await crud('MyDB', 'update', 'k', { b: 3 });
    await expect(crud('MyDB', 'getById', 'k', {})).resolves.toEqual({ a: 1, b: 3 });
  });

  it('accepts collections nobody predicted', async () => {
    await crud('SomeoneElsesDB', 'insert', 'k', { v: 1 });
    await expect(crud('SomeoneElsesDB', 'getById', 'k', {})).resolves.toEqual({ v: 1 });
  });

  it('rejects an unknown mode loudly rather than silently doing nothing', async () => {
    await expect(
      crud('MyDB', 'frobnicate' as never, 'k', {}),
    ).rejects.toThrow(/unsupported crudTransDBN mode/i);
  });
});

describe('host collections', () => {
  it('recognises the global settings collection', () => {
    expect(HOST_COLLECTIONS.has('SettingsGlobalJSONDB')).toBe(true);
  });

  it('really pauses the workers when a plugin asks', async () => {
    await crud('SettingsGlobalJSONDB', 'update', 'globalsettings', { pauseAllNodes: true });
    expect(setPauseAllNodes).toHaveBeenCalledWith(true);
  });

  it('unpauses too', async () => {
    await crud('SettingsGlobalJSONDB', 'update', 'globalsettings', { pauseAllNodes: false });
    expect(setPauseAllNodes).toHaveBeenCalledWith(false);
  });

  it('warns and ignores host settings keys it does not map', async () => {
    await crud('SettingsGlobalJSONDB', 'update', 'globalsettings', { someFutureSetting: 1 });
    expect(setPauseAllNodes).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/someFutureSetting/));
  });

  it('does not write host collections into plugin document storage', async () => {
    await crud('SettingsGlobalJSONDB', 'update', 'globalsettings', { pauseAllNodes: true });
    expect(documents.store.size).toBe(0);
  });

  it('reads back the host settings it understands', async () => {
    const value = await crud('SettingsGlobalJSONDB', 'getById', 'globalsettings', {});
    expect(value).toMatchObject({ pauseAllNodes: expect.any(Boolean) });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/host/crud-trans-dbn.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `crudTransDBN`**

`packages/engine/src/host/crud-trans-dbn.ts`:

```ts
import type { CrudMode, PluginDeps } from '@trawlarr/plugin-api';

export interface DocumentPort {
  get(collection: string, docId: string): Record<string, unknown> | undefined;
  insert(collection: string, docId: string, data: Record<string, unknown>, nowMs: number): void;
  update(collection: string, docId: string, patch: Record<string, unknown>, nowMs: number): void;
  removeOne(collection: string, docId: string): void;
}

export interface HostSettingsPort {
  setPauseAllNodes(paused: boolean): void;
  getPauseAllNodes(): boolean;
}

/** Collections that mean host state, not plugin-owned documents. */
export const HOST_COLLECTIONS = new Set(['SettingsGlobalJSONDB']);

/** Host settings keys trawlarr honours. Anything else warns rather than silently vanishing. */
const HOST_SETTING_KEYS = new Set(['pauseAllNodes']);

/**
 * Backs deps.crudTransDBN.
 *
 * Two behaviours matter. Plugin-owned collections get generic document
 * storage, because plugins invent their own names. Host collections are
 * mapped onto real trawlarr settings through a narrow allowlist — a plugin
 * asking to pause the workers genuinely pauses them, and a key we do not
 * understand produces a warning in the job log rather than a silent no-op,
 * because a silent no-op is how a plugin ends up quietly not working.
 */
export const createCrudTransDbn = (input: {
  documents: DocumentPort;
  hostSettings: HostSettingsPort;
  log: (text: string) => void;
  nowMs: () => number;
}): PluginDeps['crudTransDBN'] => {
  const handleHostSettings = (
    mode: CrudMode,
    docId: string,
    obj: Record<string, unknown>,
  ): unknown => {
    if (mode === 'getById') {
      return { _id: docId, pauseAllNodes: input.hostSettings.getPauseAllNodes() };
    }

    if (mode === 'insert' || mode === 'update') {
      for (const [key, value] of Object.entries(obj)) {
        if (!HOST_SETTING_KEYS.has(key)) {
          input.log(
            `Plugin wrote unsupported host setting "${key}" to ${docId}; ignoring. ` +
              `Supported keys: ${[...HOST_SETTING_KEYS].join(', ')}.`,
          );
          continue;
        }
        if (key === 'pauseAllNodes') input.hostSettings.setPauseAllNodes(value === true);
      }
      return undefined;
    }

    input.log(`Plugin attempted "${mode}" on host settings ${docId}; ignoring.`);
    return undefined;
  };

  return async (collection, mode, docID, obj) => {
    if (HOST_COLLECTIONS.has(collection)) {
      return handleHostSettings(mode, docID, obj);
    }

    switch (mode) {
      case 'getById':
        return input.documents.get(collection, docID);
      case 'insert':
        input.documents.insert(collection, docID, obj, input.nowMs());
        return undefined;
      case 'update':
        input.documents.update(collection, docID, obj, input.nowMs());
        return undefined;
      case 'removeOne':
        input.documents.removeOne(collection, docID);
        return undefined;
      default:
        throw new Error(
          `Unsupported crudTransDBN mode "${String(mode)}" on collection "${collection}". ` +
            `Supported modes: getById, insert, update, removeOne.`,
        );
    }
  };
};
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- packages/engine/src/host/crud-trans-dbn.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the failing `axiosMiddleware` test**

`packages/engine/src/host/axios-middleware.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORTED_ENDPOINTS,
  UnsupportedHostEndpointError,
  createAxiosMiddleware,
} from './axios-middleware.js';

const make = (probeFile = vi.fn().mockResolvedValue({ streams: [] })) => {
  const log = vi.fn();
  return { call: createAxiosMiddleware({ probeFile, log }), probeFile, log };
};

describe('createAxiosMiddleware', () => {
  it('supports scan-individual-file, the one endpoint plugins reach for', async () => {
    expect(SUPPORTED_ENDPOINTS.has('api/v2/scan-individual-file')).toBe(true);
    const { call, probeFile } = make();
    await call('api/v2/scan-individual-file', { file: { _id: '/media/movie.mkv' } });
    expect(probeFile).toHaveBeenCalledWith('/media/movie.mkv');
  });

  it('tolerates a leading slash on the endpoint', async () => {
    const { call, probeFile } = make();
    await call('/api/v2/scan-individual-file', { file: { _id: '/media/a.mkv' } });
    expect(probeFile).toHaveBeenCalledWith('/media/a.mkv');
  });

  it('rejects an unsupported endpoint by name, so the fix is obvious', async () => {
    const { call, log } = make();
    await expect(call('api/v2/read-plugin', {})).rejects.toThrow(UnsupportedHostEndpointError);
    await expect(call('api/v2/read-plugin', {})).rejects.toThrow(/api\/v2\/read-plugin/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/read-plugin/));
  });

  it('mentions that classic plugins are unsupported when the bridge endpoint is called', async () => {
    const { call } = make();
    await expect(call('api/v2/read-plugin', {})).rejects.toThrow(/classic plugins/i);
  });

  it('rejects a malformed scan request rather than probing nothing', async () => {
    const { call } = make();
    await expect(call('api/v2/scan-individual-file', {})).rejects.toThrow(/file\._id/);
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/host/axios-middleware.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `axiosMiddleware`**

`packages/engine/src/host/axios-middleware.ts`:

```ts
import type { PluginDeps } from '@trawlarr/plugin-api';

export class UnsupportedHostEndpointError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, detail: string) {
    super(`Unsupported host endpoint "${endpoint}". ${detail}`);
    this.name = 'UnsupportedHostEndpointError';
    this.endpoint = endpoint;
  }
}

export const SUPPORTED_ENDPOINTS = new Set(['api/v2/scan-individual-file']);

/** Endpoints we know about and deliberately do not implement, with the reason. */
const KNOWN_UNSUPPORTED = new Map([
  [
    'api/v2/read-plugin',
    'Trawlarr does not support Tdarr classic plugins, and this endpoint exists only ' +
      'to serve the classic-plugin bridge.',
  ],
]);

const normalise = (endpoint: string): string => endpoint.replace(/^\/+/, '');

/**
 * Backs deps.axiosMiddleware.
 *
 * Trawlarr is not a reimplementation of Tdarr's server API, so this is an
 * allowlist rather than a proxy. Anything outside it fails with the endpoint
 * named, in both the thrown error and the job log — a named incompatibility
 * is a five-minute fix, an empty response is a bug hunt.
 */
export const createAxiosMiddleware = (input: {
  probeFile: (path: string) => Promise<unknown>;
  log: (text: string) => void;
}): PluginDeps['axiosMiddleware'] => async (endpoint, data) => {
  const name = normalise(endpoint);

  if (!SUPPORTED_ENDPOINTS.has(name)) {
    const detail =
      KNOWN_UNSUPPORTED.get(name) ??
      `Supported endpoints: ${[...SUPPORTED_ENDPOINTS].join(', ')}.`;
    input.log(`Plugin called unsupported host endpoint "${name}". ${detail}`);
    throw new UnsupportedHostEndpointError(name, detail);
  }

  const file = data.file as { _id?: unknown } | undefined;
  if (typeof file?._id !== 'string') {
    throw new Error(`${name} requires data.file._id to be a file path.`);
  }
  return input.probeFile(file._id);
};
```

- [ ] **Step 8: Implement the deps assembly**

`packages/engine/src/host/deps.ts`:

```ts
import fsextra from 'fs-extra';
import gracefulfs from 'graceful-fs';
import importFresh from 'import-fresh';
import mvdir from 'mvdir';
import ncp from 'ncp';
import upath from 'upath';
import axios from 'axios';
import { parseArgsStringToArgv } from 'string-argv';
import type { ConfigVars, PluginDeps } from '@trawlarr/plugin-api';
import { requireFromString } from './require-from-string.js';

/**
 * The modules the contract injects into plugin scope. These are real npm
 * packages and their behaviour is part of the contract, so they are passed
 * through rather than wrapped.
 */
export const buildPluginDeps = (input: {
  configVars: ConfigVars;
  crudTransDBN: PluginDeps['crudTransDBN'];
  axiosMiddleware: PluginDeps['axiosMiddleware'];
}): PluginDeps => ({
  fsextra,
  gracefulfs,
  upath,
  axios,
  ncp,
  mvdir,
  parseArgsStringToArgv,
  importFresh: (path: string) => importFresh(path),
  requireFromString: (pluginText: string, relativePath: string) =>
    requireFromString({ code: pluginText, filename: relativePath }),
  axiosMiddleware: input.axiosMiddleware,
  crudTransDBN: input.crudTransDBN,
  configVars: input.configVars,
});

/** Classic plugins are out of scope; this rejects rather than pretending. */
export const rejectClassicPluginDeps = async (deps: string[]): Promise<never> => {
  throw new Error(
    `This plugin requires classic-plugin dependencies (${deps.join(', ')}), but trawlarr ` +
      `does not support Tdarr classic plugins. Use a flow plugin instead.`,
  );
};
```

- [ ] **Step 9: Run the tests**

Run: `pnpm test -- packages/engine`
Expected: PASS, 51 tests.

- [ ] **Step 10: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): host services for crudTransDBN and an allowlisted axiosMiddleware"
```

---

## Task 13: ffmpeg command lifecycle and argv compiler

Spec §2.5. Two separate concerns: the Begin/Execute state machine the engine enforces, and the mechanical compilation of the cooperative structure into argv. Compilation is trawlarr's job, not the plugins'.

**Files:**
- Create: `packages/core/src/ffmpeg-command.ts`, `packages/core/src/ffmpeg-compile.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/ffmpeg-command.test.ts`, `packages/core/src/ffmpeg-compile.test.ts`

These live in `core`, not `engine`: they are pure functions over data, they perform no IO, and putting them here is what lets `plugins-core` use them without depending on `engine` — which would otherwise be circular, since `engine`'s CLI imports `plugins-core`.

**Interfaces:**
- Consumes: Task 2 (`FfmpegCommand`, `FfmpegCommandStream`, `ProbeData`). Note this is the one
  place `core` imports from `plugin-api` for contract types; it remains IO-free.
- Produces:
  - `emptyFfmpegCommand(): FfmpegCommand`
  - `beginFfmpegCommand(input: { probe: ProbeData; container: string; inputPath: string }): FfmpegCommand`
  - `assertCommandInitialised(command: FfmpegCommand): void` — throws `FfmpegCommandStateError`
  - `closeFfmpegCommand(command: FfmpegCommand): FfmpegCommand`
  - `class FfmpegCommandStateError extends Error`
  - `compileFfmpegArgs(input: { command: FfmpegCommand; outputPath: string }): string[]`

- [ ] **Step 1: Write the failing lifecycle test**

`packages/core/src/ffmpeg-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import {
  FfmpegCommandStateError,
  assertCommandInitialised,
  beginFfmpegCommand,
  closeFfmpegCommand,
  emptyFfmpegCommand,
} from './ffmpeg-command.js';

const probe: ProbeData = {
  streams: [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'eac3' },
  ],
};

describe('emptyFfmpegCommand', () => {
  it('starts uninitialised with the contract-spelled keys present', () => {
    const cmd = emptyFfmpegCommand();
    expect(cmd.init).toBe(false);
    expect(cmd.shouldProcess).toBe(false);
    expect(cmd.overallOuputArguments).toEqual([]);
  });
});

describe('beginFfmpegCommand', () => {
  it('initialises from the probe and the input path', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    expect(cmd.init).toBe(true);
    expect(cmd.container).toBe('mkv');
    expect(cmd.inputFiles).toEqual(['/in.mkv']);
  });

  it('seeds one mutable stream per probe stream, all kept by default', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    expect(cmd.streams).toHaveLength(2);
    expect(cmd.streams[0]).toMatchObject({
      codec_name: 'h264', removed: false, forceEncoding: false, inputArgs: [], outputArgs: [],
    });
  });

  it('preserves the raw ffprobe fields plugins read', () => {
    const cmd = beginFfmpegCommand({
      probe: { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, index: 0 }] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(cmd.streams[0]?.width).toBe(1920);
  });

  it('gives each stream its own arg arrays', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    cmd.streams[0]?.outputArgs.push('-c:v', 'hevc');
    expect(cmd.streams[1]?.outputArgs).toEqual([]);
  });

  it('handles a probe with no streams', () => {
    const cmd = beginFfmpegCommand({ probe: {}, container: 'mp4', inputPath: '/in.mp4' });
    expect(cmd.streams).toEqual([]);
    expect(cmd.init).toBe(true);
  });
});

describe('assertCommandInitialised', () => {
  it('passes for an initialised command', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    expect(() => assertCommandInitialised(cmd)).not.toThrow();
  });

  it('explains how to fix an uninitialised command', () => {
    expect(() => assertCommandInitialised(emptyFfmpegCommand())).toThrow(FfmpegCommandStateError);
    expect(() => assertCommandInitialised(emptyFfmpegCommand())).toThrow(/Begin Command/i);
    expect(() => assertCommandInitialised(emptyFfmpegCommand())).toThrow(/Execute/i);
  });
});

describe('closeFfmpegCommand', () => {
  it('clears init so a second command needs a fresh Begin', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    const closed = closeFfmpegCommand(cmd);
    expect(closed.init).toBe(false);
    expect(() => assertCommandInitialised(closed)).toThrow(FfmpegCommandStateError);
  });

  it('also clears shouldProcess, so a stale flag cannot re-trigger work', () => {
    const cmd = beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
    cmd.shouldProcess = true;
    expect(closeFfmpegCommand(cmd).shouldProcess).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/core/src/ffmpeg-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the lifecycle**

`packages/core/src/ffmpeg-command.ts`:

```ts
import type { FfmpegCommand, FfmpegCommandStream, ProbeData } from '@trawlarr/plugin-api';

export class FfmpegCommandStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegCommandStateError';
  }
}

export const emptyFfmpegCommand = (): FfmpegCommand => ({
  init: false,
  inputFiles: [],
  streams: [],
  container: '',
  hardwareDecoding: false,
  shouldProcess: false,
  overallInputArguments: [],
  overallOuputArguments: [],
});

/**
 * Seed a command from a probe. Each ffprobe stream becomes a mutable stream
 * carrying its original fields plus the four the contract adds, because
 * plugins read arbitrary ffprobe properties while deciding what to do.
 */
export const beginFfmpegCommand = (input: {
  probe: ProbeData;
  container: string;
  inputPath: string;
}): FfmpegCommand => ({
  init: true,
  inputFiles: [input.inputPath],
  streams: (input.probe.streams ?? []).map(
    (stream): FfmpegCommandStream => ({
      ...stream,
      removed: false,
      forceEncoding: false,
      inputArgs: [],
      outputArgs: [],
    }),
  ),
  container: input.container,
  hardwareDecoding: false,
  shouldProcess: false,
  overallInputArguments: [],
  overallOuputArguments: [],
});

/**
 * Command-building plugins call this and throw if a Begin Command node was
 * skipped. The message names both nodes because that is the actual fix.
 */
export const assertCommandInitialised = (command: FfmpegCommand): void => {
  if (command.init !== true) {
    throw new FfmpegCommandStateError(
      'FFmpeg command plugins were used out of order. Add a "Begin Command" node before ' +
        'any command-building node, and an "Execute" node afterwards to run the command. ' +
        'Starting a second command requires another "Begin Command".',
    );
  }
};

/** Close the command after Execute; a further command needs a fresh Begin. */
export const closeFfmpegCommand = (command: FfmpegCommand): FfmpegCommand => ({
  ...command,
  init: false,
  shouldProcess: false,
});
```

- [ ] **Step 4: Write the failing compiler test**

`packages/core/src/ffmpeg-compile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from './ffmpeg-command.js';
import { compileFfmpegArgs } from './ffmpeg-compile.js';

const probe: ProbeData = {
  streams: [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'eac3' },
    { codec_type: 'subtitle', codec_name: 'subrip' },
  ],
};

const command = () => beginFfmpegCommand({ probe, container: 'mkv', inputPath: '/in.mkv' });
const compile = (cmd = command(), outputPath = '/out.mkv') =>
  compileFfmpegArgs({ command: cmd, outputPath });

describe('compileFfmpegArgs', () => {
  it('maps every stream and copies by default', () => {
    expect(compile()).toEqual([
      '-i', '/in.mkv',
      '-map', '0:0', '-map', '0:1', '-map', '0:2',
      '-c', 'copy',
      '/out.mkv',
    ]);
  });

  it('omits removed streams', () => {
    const cmd = command();
    cmd.streams[2]!.removed = true;
    expect(compile(cmd)).toEqual([
      '-i', '/in.mkv',
      '-map', '0:0', '-map', '0:1',
      '-c', 'copy',
      '/out.mkv',
    ]);
  });

  it('places per-stream outputArgs immediately after that stream map', () => {
    const cmd = command();
    cmd.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc', '-cq', '24');
    expect(compile(cmd)).toEqual([
      '-i', '/in.mkv',
      '-map', '0:0', '-c:v', 'hevc_nvenc', '-cq', '24',
      '-map', '0:1',
      '-map', '0:2',
      '/out.mkv',
    ]);
  });

  it('drops the blanket copy once any stream specifies its own encoding', () => {
    const cmd = command();
    cmd.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc');
    expect(compile(cmd)).not.toContain('copy');
  });

  it('hoists stream inputArgs ahead of the input', () => {
    const cmd = command();
    cmd.streams[0]!.inputArgs.push('-hwaccel', 'cuda');
    expect(compile(cmd)).toEqual([
      '-hwaccel', 'cuda',
      '-i', '/in.mkv',
      '-map', '0:0', '-map', '0:1', '-map', '0:2',
      '-c', 'copy',
      '/out.mkv',
    ]);
  });

  it('wraps with overall input and output arguments, honouring the misspelled key', () => {
    const cmd = command();
    cmd.overallInputArguments.push('-fflags', '+genpts');
    cmd.overallOuputArguments.push('-max_muxing_queue_size', '9999');
    const args = compile(cmd);
    expect(args.slice(0, 2)).toEqual(['-fflags', '+genpts']);
    expect(args.slice(-3)).toEqual(['-max_muxing_queue_size', '9999', '/out.mkv']);
  });

  it('supports multiple inputs with correct file indices', () => {
    const cmd = command();
    cmd.inputFiles.push('/second.mkv');
    const args = compile(cmd);
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(args).toContain('/second.mkv');
  });

  it('puts the output path last', () => {
    expect(compile().at(-1)).toBe('/out.mkv');
  });

  it('refuses to compile an uninitialised command', () => {
    const cmd = command();
    cmd.init = false;
    expect(() => compile(cmd)).toThrow(/Begin Command/i);
  });

  it('refuses to compile with no inputs', () => {
    const cmd = command();
    cmd.inputFiles = [];
    expect(() => compile(cmd)).toThrow(/input file/i);
  });

  it('refuses to compile when every stream was removed', () => {
    const cmd = command();
    for (const stream of cmd.streams) stream.removed = true;
    expect(() => compile(cmd)).toThrow(/every stream/i);
  });
});
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `pnpm test -- packages/core/src/ffmpeg-compile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the compiler**

`packages/core/src/ffmpeg-compile.ts`:

```ts
import type { FfmpegCommand } from '@trawlarr/plugin-api';
import { assertCommandInitialised } from './ffmpeg-command.js';

/**
 * Compile the cooperatively-built command into argv.
 *
 * Order is fixed by ffmpeg's grammar: overall input args, then per-stream
 * input args (hoisted, since things like -hwaccel must precede -i), then
 * inputs, then the map/output-args pairs for surviving streams, then overall
 * output args, then the output path.
 *
 * The blanket `-c copy` is emitted only when no stream asked for its own
 * codec; otherwise it would override the encoders plugins just configured.
 */
export const compileFfmpegArgs = (input: {
  command: FfmpegCommand;
  outputPath: string;
}): string[] => {
  const { command, outputPath } = input;

  assertCommandInitialised(command);

  if (command.inputFiles.length === 0) {
    throw new Error('Cannot compile an ffmpeg command with no input file.');
  }

  const kept = command.streams.filter((stream) => stream.removed !== true);
  if (command.streams.length > 0 && kept.length === 0) {
    throw new Error(
      'Cannot compile an ffmpeg command in which every stream was removed — ' +
        'the output would contain nothing.',
    );
  }

  const args: string[] = [...command.overallInputArguments];

  for (const stream of command.streams) {
    if (stream.removed === true) continue;
    args.push(...stream.inputArgs);
  }

  for (const file of command.inputFiles) {
    args.push('-i', file);
  }

  const anyStreamEncodes = kept.some(
    (stream) => stream.outputArgs.length > 0 || stream.forceEncoding === true,
  );

  for (const stream of kept) {
    const index = command.streams.indexOf(stream);
    args.push('-map', `0:${index}`);
    args.push(...stream.outputArgs);
  }

  if (!anyStreamEncodes) {
    args.push('-c', 'copy');
  }

  args.push(...command.overallOuputArguments);
  args.push(outputPath);

  return args;
};
```

- [ ] **Step 7: Export from the barrel**

Add to `packages/core/src/index.ts`:

```ts
export * from './ffmpeg-command.js';
export * from './ffmpeg-compile.js';
```

- [ ] **Step 8: Run the tests**

Run: `pnpm test -- packages/core packages/engine`
Expected: PASS — 89 core tests, 90 engine tests.

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "feat(core): ffmpeg command lifecycle guards and argv compiler"
```

---

## Task 14: ffmpeg runner with progress and cancellation

Spec §4.6. Progress reporting is the stall heartbeat, and cancellation must kill the whole process tree, so both are built here rather than bolted on. The parser is pure and tested directly; the spawn is injected so the runner is testable without ffmpeg. Real ffmpeg arrives in Task 18.

**Files:**
- Create: `packages/engine/src/ffmpeg/progress.ts`, `packages/engine/src/ffmpeg/run.ts`
- Test: `packages/engine/src/ffmpeg/progress.test.ts`, `packages/engine/src/ffmpeg/run.test.ts`

**Interfaces:**
- Consumes: nothing beyond Node builtins.
- Produces:
  - `interface FfmpegProgress { outTimeMs: number | null; frame: number | null; fps: number | null; speed: number | null; done: boolean }`
  - `createProgressParser(): { push(chunk: string): FfmpegProgress[] }`
  - `PROGRESS_ARGS: readonly string[]` — `['-progress', 'pipe:1', '-nostats', '-hide_banner', '-y']`
  - `interface FfmpegRunResult { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; cancelled: boolean }`
  - `runFfmpeg(input: RunFfmpegInput): Promise<FfmpegRunResult>` where
    `RunFfmpegInput = { ffmpegPath: string; args: string[]; durationMs?: number | null; onProgress?: (p: FfmpegProgress & { percent: number | null }) => void; signal?: AbortSignal; stderrTailLines?: number; spawnFn?: SpawnFn }`
  - `type SpawnFn = (command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcessLike`

- [ ] **Step 1: Write the failing progress-parser test**

`packages/engine/src/ffmpeg/progress.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PROGRESS_ARGS, createProgressParser } from './progress.js';

describe('PROGRESS_ARGS', () => {
  it('asks ffmpeg for machine-readable progress on stdout', () => {
    expect(PROGRESS_ARGS).toContain('-progress');
    expect(PROGRESS_ARGS).toContain('pipe:1');
    expect(PROGRESS_ARGS).toContain('-nostats');
  });
});

describe('createProgressParser', () => {
  it('emits one update per progress block', () => {
    const parser = createProgressParser();
    const updates = parser.push(
      ['frame=120', 'fps=48.5', 'out_time_ms=5000000', 'speed=2.1x', 'progress=continue', ''].join('\n'),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      frame: 120, fps: 48.5, outTimeMs: 5000, speed: 2.1, done: false,
    });
  });

  it('converts out_time_ms, which ffmpeg reports in microseconds', () => {
    const parser = createProgressParser();
    const [update] = parser.push('out_time_ms=90000000\nprogress=continue\n');
    expect(update?.outTimeMs).toBe(90_000);
  });

  it('marks the final block done', () => {
    const parser = createProgressParser();
    const [update] = parser.push('out_time_ms=1000000\nprogress=end\n');
    expect(update?.done).toBe(true);
  });

  it('handles a block split across chunk boundaries', () => {
    const parser = createProgressParser();
    expect(parser.push('frame=10\nout_time')).toHaveLength(0);
    const updates = parser.push('_ms=2000000\nprogress=continue\n');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.outTimeMs).toBe(2000);
    expect(updates[0]?.frame).toBe(10);
  });

  it('emits several updates from one busy chunk', () => {
    const parser = createProgressParser();
    const updates = parser.push(
      'out_time_ms=1000000\nprogress=continue\nout_time_ms=2000000\nprogress=continue\n',
    );
    expect(updates.map((u) => u.outTimeMs)).toEqual([1000, 2000]);
  });

  it('reports nulls for fields ffmpeg omits rather than guessing', () => {
    const parser = createProgressParser();
    const [update] = parser.push('progress=continue\n');
    expect(update).toEqual({ frame: null, fps: null, outTimeMs: null, speed: null, done: false });
  });

  it('ignores N/A values, which ffmpeg emits early in a run', () => {
    const parser = createProgressParser();
    const [update] = parser.push('fps=N/A\nout_time_ms=N/A\nprogress=continue\n');
    expect(update?.fps).toBeNull();
    expect(update?.outTimeMs).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/ffmpeg/progress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

`packages/engine/src/ffmpeg/progress.ts`:

```ts
export interface FfmpegProgress {
  outTimeMs: number | null;
  frame: number | null;
  fps: number | null;
  speed: number | null;
  done: boolean;
}

/** `-y` overwrites the staged output, which is ours and always safe to replace. */
export const PROGRESS_ARGS = ['-progress', 'pipe:1', '-nostats', '-hide_banner', '-y'] as const;

const numberOf = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === 'N/A') return null;
  const parsed = Number.parseFloat(raw.replace(/x$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Parse ffmpeg's `-progress` stream. It emits `key=value` lines terminated by
 * a `progress=` line, and chunk boundaries fall anywhere, so partial lines
 * are buffered until complete.
 */
export const createProgressParser = (): { push(chunk: string): FfmpegProgress[] } => {
  let buffer = '';
  let fields: Record<string, string> = {};

  return {
    push(chunk) {
      buffer += chunk;
      const updates: FfmpegProgress[] = [];

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        if (line === '') continue;
        const separator = line.indexOf('=');
        if (separator === -1) continue;

        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        fields[key] = value;

        if (key === 'progress') {
          const microseconds = numberOf(fields.out_time_ms);
          updates.push({
            frame: numberOf(fields.frame),
            fps: numberOf(fields.fps),
            outTimeMs: microseconds === null ? null : Math.round(microseconds / 1000),
            speed: numberOf(fields.speed),
            done: value === 'end',
          });
          fields = {};
        }
      }

      return updates;
    },
  };
};
```

- [ ] **Step 4: Write the failing runner test**

`packages/engine/src/ffmpeg/run.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runFfmpeg, type SpawnFn } from './run.js';

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  pid = 4242;
  killed = false;
  killSignals: string[] = [];

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignals.push(signal ?? 'SIGTERM');
    return true;
  }
}

const harness = () => {
  const child = new FakeChild();
  const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
  return { child, spawnFn };
};

describe('runFfmpeg', () => {
  it('spawns with progress arguments ahead of the caller arguments', async () => {
    const { child, spawnFn } = harness();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: ['-i', '/in.mkv', '/out.mkv'], spawnFn });
    setImmediate(() => child.emit('close', 0, null));
    await run;

    const [command, args] = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(command).toBe('ffmpeg');
    expect(args.slice(0, 2)).toEqual(['-progress', 'pipe:1']);
    expect(args.slice(-3)).toEqual(['-i', '/in.mkv', '/out.mkv']);
  });

  it('resolves with the exit code', async () => {
    const { child, spawnFn } = harness();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], spawnFn });
    setImmediate(() => child.emit('close', 0, null));
    await expect(run).resolves.toMatchObject({ code: 0, cancelled: false });
  });

  it('reports progress with a percentage when the duration is known', async () => {
    const { child, spawnFn } = harness();
    const seen: Array<number | null> = [];
    const run = runFfmpeg({
      ffmpegPath: 'ffmpeg',
      args: [],
      durationMs: 10_000,
      onProgress: (p) => seen.push(p.percent),
      spawnFn,
    });
    setImmediate(() => {
      child.stdout.emit('data', 'out_time_ms=5000000\nprogress=continue\n');
      child.emit('close', 0, null);
    });
    await run;
    expect(seen).toEqual([50]);
  });

  it('reports a null percentage when the duration is unknown', async () => {
    const { child, spawnFn } = harness();
    const seen: Array<number | null> = [];
    const run = runFfmpeg({
      ffmpegPath: 'ffmpeg', args: [], onProgress: (p) => seen.push(p.percent), spawnFn,
    });
    setImmediate(() => {
      child.stdout.emit('data', 'out_time_ms=5000000\nprogress=continue\n');
      child.emit('close', 0, null);
    });
    await run;
    expect(seen).toEqual([null]);
  });

  it('clamps the percentage to 100 when ffmpeg overshoots the probed duration', async () => {
    const { child, spawnFn } = harness();
    const seen: Array<number | null> = [];
    const run = runFfmpeg({
      ffmpegPath: 'ffmpeg',
      args: [],
      durationMs: 1000,
      onProgress: (p) => seen.push(p.percent),
      spawnFn,
    });
    setImmediate(() => {
      child.stdout.emit('data', 'out_time_ms=9000000\nprogress=continue\n');
      child.emit('close', 0, null);
    });
    await run;
    expect(seen).toEqual([100]);
  });

  it('keeps only the tail of stderr, so a chatty run cannot exhaust memory', async () => {
    const { child, spawnFn } = harness();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], stderrTailLines: 3, spawnFn });
    setImmediate(() => {
      for (let i = 1; i <= 50; i += 1) child.stderr.emit('data', `line ${i}\n`);
      child.emit('close', 1, null);
    });
    const result = await run;
    expect(result.stderrTail.split('\n')).toHaveLength(3);
    expect(result.stderrTail).toContain('line 50');
    expect(result.stderrTail).not.toContain('line 1\n');
  });

  it('kills the process when the signal aborts, and reports cancellation', async () => {
    const { child, spawnFn } = harness();
    const controller = new AbortController();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], signal: controller.signal, spawnFn });
    setImmediate(() => {
      controller.abort();
      child.emit('close', null, 'SIGKILL');
    });
    const result = await run;
    expect(child.killed).toBe(true);
    expect(result.cancelled).toBe(true);
  });

  it('rejects when the binary cannot be spawned at all', async () => {
    const { child, spawnFn } = harness();
    const run = runFfmpeg({ ffmpegPath: 'nope', args: [], spawnFn });
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    await expect(run).rejects.toThrow(/ENOENT/);
  });

  it('does not kill an already-finished process when aborted afterwards', async () => {
    const { child, spawnFn } = harness();
    const controller = new AbortController();
    const run = runFfmpeg({ ffmpegPath: 'ffmpeg', args: [], signal: controller.signal, spawnFn });
    setImmediate(() => child.emit('close', 0, null));
    await run;
    controller.abort();
    expect(child.killed).toBe(false);
  });
});
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/ffmpeg/run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the runner**

`packages/engine/src/ffmpeg/run.ts`:

```ts
import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { PROGRESS_ARGS, createProgressParser, type FfmpegProgress } from './progress.js';

interface ReadableLike extends EventEmitter {
  setEncoding(encoding: string): unknown;
}

export interface ChildProcessLike extends EventEmitter {
  stdout: ReadableLike | null;
  stderr: ReadableLike | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcessLike;

export interface FfmpegRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  cancelled: boolean;
}

export interface RunFfmpegInput {
  ffmpegPath: string;
  args: string[];
  /** Probed duration, used to turn out_time into a percentage. */
  durationMs?: number | null;
  onProgress?: (progress: FfmpegProgress & { percent: number | null }) => void;
  signal?: AbortSignal;
  stderrTailLines?: number;
  spawnFn?: SpawnFn;
}

const DEFAULT_STDERR_TAIL_LINES = 40;

/**
 * Run ffmpeg.
 *
 * Progress is forwarded as it arrives because it doubles as the job's stall
 * heartbeat — a job that reports nothing for long enough is indistinguishable
 * from a hung one and gets killed. stderr is kept as a bounded tail so that a
 * pathological run cannot exhaust memory while still leaving a diagnosable
 * message when ffmpeg fails.
 */
export const runFfmpeg = (input: RunFfmpegInput): Promise<FfmpegRunResult> =>
  new Promise((resolve, reject) => {
    const spawnFn = input.spawnFn ?? (spawn as unknown as SpawnFn);
    const tailLimit = input.stderrTailLines ?? DEFAULT_STDERR_TAIL_LINES;

    const child = spawnFn(input.ffmpegPath, [...PROGRESS_ARGS, ...input.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parser = createProgressParser();
    const stderrTail: string[] = [];
    let cancelled = false;
    let finished = false;

    const onAbort = (): void => {
      if (finished) return;
      cancelled = true;
      // SIGKILL rather than SIGTERM: ffmpeg can ignore a polite request while
      // finalising, and a cancelled job must actually stop.
      child.kill('SIGKILL');
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = (): void => {
      finished = true;
      input.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (input.onProgress === undefined) return;
      for (const progress of parser.push(chunk)) {
        const duration = input.durationMs ?? null;
        const percent =
          duration === null || duration <= 0 || progress.outTimeMs === null
            ? null
            : Math.min(100, Math.round((progress.outTimeMs / duration) * 100));
        input.onProgress({ ...progress, percent });
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line === '') continue;
        stderrTail.push(line);
        if (stderrTail.length > tailLimit) stderrTail.shift();
      }
    });

    child.on('error', (error: Error) => {
      cleanup();
      reject(error);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal, stderrTail: stderrTail.join('\n'), cancelled });
    });
  });
```

- [ ] **Step 7: Run the tests**

Run: `pnpm test -- packages/engine`
Expected: PASS, 90 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): ffmpeg runner with progress heartbeat and hard cancellation"
```

---

## Task 15: Flow executor

Spec §2.2, §4.6, §6.5. Routing is by `outputNumber`. Cycles are legal — community flows contain them — so termination comes from a step budget, not from cycle rejection.

**Files:**
- Create: `packages/engine/src/executor/run-flow.ts`
- Test: `packages/engine/src/executor/run-flow.test.ts`

**Interfaces:**
- Consumes: Task 6 (`FlowDefinition`, `FlowNode`), Task 10 (`LoadedPlugin`), Task 2 (`PluginInputArgs`, `RunVariables`), Task 13 (`emptyFfmpegCommand`).
- Produces:
  - `interface StepRecord { seq: number; nodeId: string; pluginId: string; pluginName: string; outputNumber: number | null; durationMs: number; logExcerpt: string; error: string | null }`
  - `type StopReason = 'end-of-flow' | 'plugin-error' | 'step-budget' | 'missing-node' | 'no-start-node'`
  - `interface FlowRunResult { steps: StepRecord[]; variables: RunVariables; currentPath: string; failed: boolean; stopReason: StopReason; error: string | null }`
  - `interface NodeInvocation { node: FlowNode; plugin: LoadedPlugin; currentPath: string; variables: RunVariables; seq: number }`
  - `interface RunFlowOptions { flow: FlowDefinition; initialPath: string; loadPlugin: (node: FlowNode) => LoadedPlugin; buildArgs: (invocation: NodeInvocation) => PluginInputArgs; startNodeId?: string; maxSteps?: number; onStep?: (step: StepRecord) => void; nowMs?: () => number }`
  - `runFlow(options: RunFlowOptions): Promise<FlowRunResult>`
  - `DEFAULT_MAX_STEPS: 500`

- [ ] **Step 1: Write the failing test**

`packages/engine/src/executor/run-flow.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { FlowDefinition, FlowNode } from '@trawlarr/core';
import type { PluginDetails, PluginInputArgs, PluginModule, RunVariables } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';
import { emptyFfmpegCommand } from '@trawlarr/core';
import { DEFAULT_MAX_STEPS, runFlow } from './run-flow.js';

const details = (over: Partial<PluginDetails> = {}): PluginDetails => ({
  name: 'Node',
  description: '',
  style: { borderColor: '#000' },
  tags: '',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: '' }, { number: 2, tooltip: '' }],
  requiresVersion: '2.11.01',
  ...over,
});

/** Build a loader over a map of node id -> plugin behaviour. */
const loaderFor = (
  behaviours: Record<string, { module: PluginModule; details?: PluginDetails }>,
) => (node: FlowNode): LoadedPlugin => {
  const entry = behaviours[node.pluginId];
  if (entry === undefined) throw new Error(`no fixture for plugin ${node.pluginId}`);
  return {
    id: node.pluginId,
    absPath: `/fixtures/${node.pluginId}.js`,
    version: node.pluginVersion,
    details: entry.details ?? details(),
    module: entry.module,
  };
};

const routeTo = (outputNumber: number): PluginModule => ({
  details: () => details(),
  plugin: (args) => ({
    outputNumber,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  }),
});

const variables = (): RunVariables => ({
  ffmpegCommand: emptyFfmpegCommand(),
  flowFailed: false,
  user: {},
});

const buildArgs = (invocation: {
  currentPath: string;
  variables: RunVariables;
}): PluginInputArgs =>
  ({
    inputFileObj: { _id: invocation.currentPath },
    variables: invocation.variables,
    inputs: {},
    jobLog: () => {},
  }) as unknown as PluginInputArgs;

const flow = (nodes: FlowNode[], edges: FlowDefinition['edges']): FlowDefinition => ({
  nodes,
  edges,
});

const node = (id: string, pluginId = id, isStart = false): FlowNode => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs: isStart ? { __start: true } : {},
});

describe('runFlow — routing', () => {
  it('walks a linear flow and records a step per node', async () => {
    const result = await runFlow({
      flow: flow([node('a'), node('b')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) }, b: { module: routeTo(1) } }),
      buildArgs,
    });

    expect(result.failed).toBe(false);
    expect(result.stopReason).toBe('end-of-flow');
    expect(result.steps.map((s) => s.nodeId)).toEqual(['a', 'b']);
    expect(result.steps.map((s) => s.seq)).toEqual([1, 2]);
  });

  it('follows the edge matching the returned output number', async () => {
    const result = await runFlow({
      flow: flow(
        [node('a'), node('yes'), node('no')],
        [
          { fromNodeId: 'a', outputNumber: 1, toNodeId: 'yes' },
          { fromNodeId: 'a', outputNumber: 2, toNodeId: 'no' },
        ],
      ),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({
        a: { module: routeTo(2) },
        yes: { module: routeTo(1) },
        no: { module: routeTo(1) },
      }),
      buildArgs,
    });

    expect(result.steps.map((s) => s.nodeId)).toEqual(['a', 'no']);
  });

  it('ends cleanly when the chosen output has no edge', async () => {
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
    });
    expect(result.stopReason).toBe('end-of-flow');
    expect(result.failed).toBe(false);
  });

  it('finds the start node from details().isStartPlugin when none is named', async () => {
    const result = await runFlow({
      flow: flow([node('a'), node('start')], [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'a' }]),
      initialPath: '/in.mkv',
      loadPlugin: loaderFor({
        a: { module: routeTo(1) },
        start: { module: routeTo(1), details: details({ isStartPlugin: true }) },
      }),
      buildArgs,
    });
    expect(result.steps[0]?.nodeId).toBe('start');
  });

  it('fails clearly when there is no start node at all', async () => {
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
    });
    expect(result.stopReason).toBe('no-start-node');
    expect(result.failed).toBe(true);
    expect(result.error).toMatch(/start/i);
  });

  it('fails when an edge points at a node that is not in the flow', async () => {
    const result = await runFlow({
      flow: flow([node('a')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'ghost' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
    });
    expect(result.stopReason).toBe('missing-node');
    expect(result.error).toMatch(/ghost/);
  });
});

describe('runFlow — cycles', () => {
  it('permits a cycle, because real community flows contain them', async () => {
    let visits = 0;
    const loop: PluginModule = {
      details: () => details(),
      plugin: (args) => {
        visits += 1;
        return {
          outputNumber: visits < 3 ? 1 : 2,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: args.variables,
        };
      },
    };

    const result = await runFlow({
      flow: flow(
        [node('a'), node('done')],
        [
          { fromNodeId: 'a', outputNumber: 1, toNodeId: 'a' },
          { fromNodeId: 'a', outputNumber: 2, toNodeId: 'done' },
        ],
      ),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: loop }, done: { module: routeTo(1) } }),
      buildArgs,
    });

    expect(visits).toBe(3);
    expect(result.steps).toHaveLength(4);
    expect(result.failed).toBe(false);
  });

  it('stops an endless cycle at the step budget instead of hanging', async () => {
    const result = await runFlow({
      flow: flow([node('a')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'a' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
      maxSteps: 10,
    });
    expect(result.stopReason).toBe('step-budget');
    expect(result.failed).toBe(true);
    expect(result.steps).toHaveLength(10);
    expect(result.error).toMatch(/10/);
  });

  it('has a default budget', () => {
    expect(DEFAULT_MAX_STEPS).toBe(500);
  });
});

describe('runFlow — errors', () => {
  const boom: PluginModule = {
    details: () => details(),
    plugin: () => {
      throw new Error('plugin exploded');
    },
  };

  it('fails the run and records the error on the step', async () => {
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: boom } }),
      buildArgs,
    });
    expect(result.failed).toBe(true);
    expect(result.stopReason).toBe('plugin-error');
    expect(result.steps[0]?.error).toMatch(/plugin exploded/);
    expect(result.variables.flowFailed).toBe(true);
  });

  it('routes to an onFlowError node when the flow has one', async () => {
    const result = await runFlow({
      flow: flow([node('a'), node('handler')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({
        a: { module: boom },
        handler: { module: routeTo(1), details: details({ pType: 'onFlowError' }) },
      }),
      buildArgs,
    });
    expect(result.steps.map((s) => s.nodeId)).toEqual(['a', 'handler']);
    expect(result.variables.flowFailed).toBe(true);
  });

  it('does not loop when the error handler itself throws', async () => {
    const result = await runFlow({
      flow: flow([node('a'), node('handler')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({
        a: { module: boom },
        handler: { module: boom, details: details({ pType: 'onFlowError' }) },
      }),
      buildArgs,
    });
    expect(result.steps).toHaveLength(2);
    expect(result.failed).toBe(true);
  });

  it('fails the run when a plugin returns nothing usable', async () => {
    const bad: PluginModule = {
      details: () => details(),
      plugin: () => undefined as never,
    };
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: bad } }),
      buildArgs,
    });
    expect(result.failed).toBe(true);
    expect(result.steps[0]?.error).toMatch(/outputNumber/i);
  });

  it('fails the run when a plugin cannot be loaded', async () => {
    const result = await runFlow({
      flow: flow([node('a', 'missing-plugin')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({}),
      buildArgs,
    });
    expect(result.failed).toBe(true);
    expect(result.error).toMatch(/missing-plugin/);
  });
});

describe('runFlow — state threading', () => {
  it('threads a path change from one node into the next', async () => {
    const rename: PluginModule = {
      details: () => details(),
      plugin: (args) => ({
        outputNumber: 1,
        outputFileObj: { _id: '/out.mp4' },
        variables: args.variables,
      }),
    };
    const seen: string[] = [];

    const result = await runFlow({
      flow: flow([node('a'), node('b')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: rename }, b: { module: routeTo(1) } }),
      buildArgs: (invocation) => {
        seen.push(invocation.currentPath);
        return buildArgs(invocation);
      },
    });

    expect(seen).toEqual(['/in.mkv', '/out.mp4']);
    expect(result.currentPath).toBe('/out.mp4');
  });

  it('threads mutated variables forward, which is how ffmpegCommand cooperation works', async () => {
    const setter: PluginModule = {
      details: () => details(),
      plugin: (args) => {
        args.variables.ffmpegCommand.init = true;
        args.variables.ffmpegCommand.container = 'mkv';
        return {
          outputNumber: 1,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: args.variables,
        };
      },
    };

    const result = await runFlow({
      flow: flow([node('a'), node('b')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: setter }, b: { module: routeTo(1) } }),
      buildArgs,
    });

    expect(result.variables.ffmpegCommand.init).toBe(true);
    expect(result.variables.ffmpegCommand.container).toBe('mkv');
  });

  it('awaits async plugins', async () => {
    const slow: PluginModule = {
      details: () => details(),
      plugin: async (args) => {
        await Promise.resolve();
        return {
          outputNumber: 1,
          outputFileObj: { _id: '/async.mkv' },
          variables: args.variables,
        };
      },
    };
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: slow } }),
      buildArgs,
    });
    expect(result.currentPath).toBe('/async.mkv');
  });

  it('emits steps as they happen for live progress', async () => {
    const onStep = vi.fn();
    await runFlow({
      flow: flow([node('a'), node('b')], [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }]),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) }, b: { module: routeTo(1) } }),
      buildArgs,
      onStep,
    });
    expect(onStep).toHaveBeenCalledTimes(2);
    expect(onStep.mock.calls[0]![0]).toMatchObject({ seq: 1, nodeId: 'a' });
  });

  it('records step durations from the injected clock', async () => {
    let clock = 1000;
    const result = await runFlow({
      flow: flow([node('a')], []),
      initialPath: '/in.mkv',
      startNodeId: 'a',
      loadPlugin: loaderFor({ a: { module: routeTo(1) } }),
      buildArgs,
      nowMs: () => {
        clock += 250;
        return clock;
      },
    });
    expect(result.steps[0]?.durationMs).toBe(250);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/executor/run-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the executor**

`packages/engine/src/executor/run-flow.ts`:

```ts
import type { FlowDefinition, FlowNode } from '@trawlarr/core';
import type { PluginInputArgs, RunVariables } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';

export interface StepRecord {
  seq: number;
  nodeId: string;
  pluginId: string;
  pluginName: string;
  outputNumber: number | null;
  durationMs: number;
  logExcerpt: string;
  error: string | null;
}

export type StopReason =
  | 'end-of-flow' | 'plugin-error' | 'step-budget' | 'missing-node' | 'no-start-node';

export interface FlowRunResult {
  steps: StepRecord[];
  variables: RunVariables;
  currentPath: string;
  failed: boolean;
  stopReason: StopReason;
  error: string | null;
}

export interface NodeInvocation {
  node: FlowNode;
  plugin: LoadedPlugin;
  currentPath: string;
  variables: RunVariables;
  seq: number;
}

export interface RunFlowOptions {
  flow: FlowDefinition;
  initialPath: string;
  loadPlugin: (node: FlowNode) => LoadedPlugin;
  buildArgs: (invocation: NodeInvocation) => PluginInputArgs;
  startNodeId?: string;
  maxSteps?: number;
  onStep?: (step: StepRecord) => void;
  nowMs?: () => number;
}

/**
 * Cycles are legal, so termination cannot come from cycle detection. A step
 * budget bounds any flow, including intentional loops, without forbidding them.
 */
export const DEFAULT_MAX_STEPS = 500;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const runFlow = async (options: RunFlowOptions): Promise<FlowRunResult> => {
  const nowMs = options.nowMs ?? (() => Date.now());
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  const nodesById = new Map(options.flow.nodes.map((node) => [node.id, node]));
  const steps: StepRecord[] = [];

  let variables: RunVariables = {
    ffmpegCommand: {
      init: false,
      inputFiles: [],
      streams: [],
      container: '',
      hardwareDecoding: false,
      shouldProcess: false,
      overallInputArguments: [],
      overallOuputArguments: [],
    },
    flowFailed: false,
    user: {},
  };
  let currentPath = options.initialPath;

  const finish = (stopReason: StopReason, error: string | null): FlowRunResult => ({
    steps,
    variables,
    currentPath,
    failed: stopReason !== 'end-of-flow',
    stopReason,
    error,
  });

  const findStartNode = (): FlowNode | undefined => {
    if (options.startNodeId !== undefined) return nodesById.get(options.startNodeId);
    return options.flow.nodes.find((node) => {
      try {
        return options.loadPlugin(node).details.isStartPlugin === true;
      } catch {
        return false;
      }
    });
  };

  const findErrorHandler = (): FlowNode | undefined =>
    options.flow.nodes.find((node) => {
      try {
        return options.loadPlugin(node).details.pType === 'onFlowError';
      } catch {
        return false;
      }
    });

  let current = findStartNode();
  if (current === undefined) {
    return finish(
      'no-start-node',
      'This flow has no start node. Mark a node as the start, or pass an explicit start node id.',
    );
  }

  let errorHandlerUsed = false;

  for (;;) {
    if (steps.length >= maxSteps) {
      return finish(
        'step-budget',
        `Flow exceeded its budget of ${maxSteps} steps, which usually means a loop that ` +
          `never reaches an exit condition.`,
      );
    }

    const node: FlowNode = current;
    const seq = steps.length + 1;
    const startedAt = nowMs();

    let plugin: LoadedPlugin;
    try {
      plugin = options.loadPlugin(node);
    } catch (error) {
      const step: StepRecord = {
        seq,
        nodeId: node.id,
        pluginId: node.pluginId,
        pluginName: node.pluginId,
        outputNumber: null,
        durationMs: nowMs() - startedAt,
        logExcerpt: '',
        error: messageOf(error),
      };
      steps.push(step);
      options.onStep?.(step);
      variables = { ...variables, flowFailed: true };
      return finish('plugin-error', messageOf(error));
    }

    const logLines: string[] = [];
    const invocation: NodeInvocation = { node, plugin, currentPath, variables, seq };
    const args = options.buildArgs(invocation);
    const originalJobLog = args.jobLog;
    args.jobLog = (text: string) => {
      logLines.push(text);
      originalJobLog?.(text);
    };

    let outputNumber: number | null = null;
    let stepError: string | null = null;

    try {
      const output = await plugin.module.plugin(args);
      if (output === null || output === undefined || typeof output.outputNumber !== 'number') {
        throw new Error(
          `Plugin "${plugin.details.name}" did not return an outputNumber. A flow plugin ` +
            `must return { outputNumber, outputFileObj, variables }.`,
        );
      }
      outputNumber = output.outputNumber;
      if (typeof output.outputFileObj?._id === 'string') currentPath = output.outputFileObj._id;
      if (output.variables !== undefined) variables = output.variables;
    } catch (error) {
      stepError = messageOf(error);
    }

    const step: StepRecord = {
      seq,
      nodeId: node.id,
      pluginId: node.pluginId,
      pluginName: plugin.details.name,
      outputNumber,
      durationMs: nowMs() - startedAt,
      logExcerpt: logLines.join('\n'),
      error: stepError,
    };
    steps.push(step);
    options.onStep?.(step);

    if (stepError !== null) {
      variables = { ...variables, flowFailed: true };

      // One attempt at the error handler. If it throws too, stop — retrying a
      // failing handler is how a failure becomes an infinite loop.
      if (!errorHandlerUsed) {
        const handler = findErrorHandler();
        if (handler !== undefined && handler.id !== node.id) {
          errorHandlerUsed = true;
          current = handler;
          continue;
        }
      }
      return finish('plugin-error', stepError);
    }

    const edge = options.flow.edges.find(
      (candidate) => candidate.fromNodeId === node.id && candidate.outputNumber === outputNumber,
    );
    if (edge === undefined) return finish('end-of-flow', null);

    const next = nodesById.get(edge.toNodeId);
    if (next === undefined) {
      return finish(
        'missing-node',
        `Flow edge from "${node.id}" points at "${edge.toNodeId}", which is not in this flow.`,
      );
    }
    current = next;
  }
};
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- packages/engine`
Expected: PASS, 110 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): flow executor with output routing, cycles, and error handling"
```

---

## Task 16: Dry run

Spec §6.4. A preview cannot be assumed side-effect-free: the engine controls its own nodes, but a third-party node can spawn a subprocess directly and no engine cleverness intercepts that. So the dry run reports where it stopped instead of pretending to full coverage.

**Files:**
- Create: `packages/engine/src/executor/vouchable.ts`, `packages/engine/src/executor/dry-run.ts`
- Test: `packages/engine/src/executor/dry-run.test.ts`

**Interfaces:**
- Consumes: Task 15 (`runFlow`, `RunFlowOptions`, `FlowRunResult`), Task 10 (`LoadedPlugin`).
- Produces:
  - `type SideEffectClass = 'inert' | 'engine-controlled' | 'unknown'`
  - `FIRST_PARTY_INERT: Set<string>`, `FIRST_PARTY_ENGINE_CONTROLLED: Set<string>`
  - `classifySideEffects(plugin: LoadedPlugin): SideEffectClass`
  - `interface DryRunResult extends FlowRunResult { complete: boolean; stoppedAtNodeId: string | null; stoppedBecause: string | null; plannedCommands: string[][] }`
  - `runDryFlow(options: RunFlowOptions & { outputPathFor: (path: string, container: string) => string }): Promise<DryRunResult>`

- [ ] **Step 1: Write the failing test**

`packages/engine/src/executor/dry-run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FlowDefinition, FlowNode } from '@trawlarr/core';
import type { PluginDetails, PluginInputArgs, PluginModule } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';
import { beginFfmpegCommand } from '@trawlarr/core';
import { classifySideEffects } from './vouchable.js';
import { runDryFlow } from './dry-run.js';

const details = (over: Partial<PluginDetails> = {}): PluginDetails => ({
  name: 'Node',
  description: '',
  style: { borderColor: '#000' },
  tags: '',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: '' }],
  requiresVersion: '2.11.01',
  ...over,
});

const loaded = (id: string, module: PluginModule): LoadedPlugin => ({
  id,
  absPath: `/plugins/${id}.js`,
  version: '1.0.0',
  details: details({ name: id }),
  module,
});

const pass: PluginModule = {
  details: () => details(),
  plugin: (args) => ({
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  }),
};

const beginAndEncode: PluginModule = {
  details: () => details(),
  plugin: (args) => {
    const command = beginFfmpegCommand({
      probe: { streams: [{ codec_type: 'video', codec_name: 'h264' }] },
      container: 'mkv',
      inputPath: args.inputFileObj._id,
    });
    command.streams[0]!.outputArgs.push('-c:v', 'hevc_nvenc');
    command.shouldProcess = true;
    return {
      outputNumber: 1,
      outputFileObj: { _id: args.inputFileObj._id },
      variables: { ...args.variables, ffmpegCommand: command },
    };
  },
};

const node = (id: string, pluginId: string): FlowNode => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs: {},
});

const flow = (nodes: FlowNode[], edges: FlowDefinition['edges']): FlowDefinition => ({ nodes, edges });

const buildArgs = (invocation: { currentPath: string; variables: unknown }) =>
  ({
    inputFileObj: { _id: invocation.currentPath },
    variables: invocation.variables,
    inputs: {},
    jobLog: () => {},
  }) as unknown as PluginInputArgs;

const base = {
  initialPath: '/in.mkv',
  startNodeId: 'a',
  buildArgs,
  outputPathFor: (path: string, container: string) => `/staging/out.${container}`,
};

describe('classifySideEffects', () => {
  it('knows first-party filters are inert', () => {
    expect(classifySideEffects(loaded('trawlarr:checkVideoCodec', pass))).toBe('inert');
  });

  it('knows the Execute node is engine-controlled', () => {
    expect(classifySideEffects(loaded('trawlarr:execute', pass))).toBe('engine-controlled');
  });

  it('treats anything unrecognised as unknown, which is the safe default', () => {
    expect(classifySideEffects(loaded('community:mysteryNode', pass))).toBe('unknown');
  });
});

describe('runDryFlow', () => {
  it('completes a flow built only from first-party nodes', async () => {
    const result = await runDryFlow({
      ...base,
      flow: flow(
        [node('a', 'trawlarr:checkVideoCodec'), node('b', 'trawlarr:setVideoEncoder')],
        [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
      ),
      loadPlugin: (n) => loaded(n.pluginId, pass),
    });

    expect(result.complete).toBe(true);
    expect(result.stoppedAtNodeId).toBeNull();
    expect(result.steps).toHaveLength(2);
  });

  it('records the ffmpeg command Execute would have run, without running it', async () => {
    const result = await runDryFlow({
      ...base,
      flow: flow(
        [node('a', 'trawlarr:beginCommand'), node('b', 'trawlarr:execute')],
        [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
      ),
      loadPlugin: (n) =>
        loaded(n.pluginId, n.pluginId === 'trawlarr:beginCommand' ? beginAndEncode : pass),
    });

    expect(result.complete).toBe(true);
    expect(result.plannedCommands).toHaveLength(1);
    expect(result.plannedCommands[0]).toEqual([
      '-i', '/in.mkv', '-map', '0:0', '-c:v', 'hevc_nvenc', '/staging/out.mkv',
    ]);
  });

  it('stops at an unrecognised node and says which one and why', async () => {
    const result = await runDryFlow({
      ...base,
      flow: flow(
        [node('a', 'trawlarr:checkVideoCodec'), node('b', 'community:mysteryNode')],
        [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
      ),
      loadPlugin: (n) => loaded(n.pluginId, pass),
    });

    expect(result.complete).toBe(false);
    expect(result.stoppedAtNodeId).toBe('b');
    expect(result.stoppedBecause).toMatch(/community:mysteryNode/);
    expect(result.stoppedBecause).toMatch(/side effects/i);
  });

  it('does not invoke the unrecognised plugin at all', async () => {
    let invoked = false;
    const spy: PluginModule = {
      details: () => details(),
      plugin: (args) => {
        invoked = true;
        return {
          outputNumber: 1,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: args.variables,
        };
      },
    };
    await runDryFlow({
      ...base,
      flow: flow([node('a', 'community:mysteryNode')], []),
      loadPlugin: (n) => loaded(n.pluginId, spy),
    });
    expect(invoked).toBe(false);
  });

  it('reports stopping early as incomplete rather than as a failure', async () => {
    const result = await runDryFlow({
      ...base,
      flow: flow([node('a', 'community:mysteryNode')], []),
      loadPlugin: (n) => loaded(n.pluginId, pass),
    });
    // The flow did not fail; we declined to continue. The distinction matters
    // because a dry run stopping early is normal, not an error to fix.
    expect(result.failed).toBe(false);
    expect(result.complete).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- packages/engine/src/executor/dry-run.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the classifier**

`packages/engine/src/executor/vouchable.ts`:

```ts
import type { LoadedPlugin } from '../host/loader.js';

export type SideEffectClass = 'inert' | 'engine-controlled' | 'unknown';

/** First-party nodes that only read and decide. */
export const FIRST_PARTY_INERT = new Set([
  'trawlarr:start',
  'trawlarr:checkVideoCodec',
  'trawlarr:checkResolution',
  'trawlarr:checkFileSize',
  'trawlarr:beginCommand',
  'trawlarr:setVideoEncoder',
  'trawlarr:setAudioCodec',
]);

/** First-party nodes whose effects the engine performs, so it can withhold them. */
export const FIRST_PARTY_ENGINE_CONTROLLED = new Set([
  'trawlarr:execute',
  'trawlarr:verifyOutput',
  'trawlarr:replaceOriginal',
  'trawlarr:moveFile',
]);

/**
 * Can the engine guarantee this node performs no side effect during a dry run?
 *
 * Only for nodes we wrote. A third-party plugin can require('child_process')
 * directly, so "unknown" is the honest answer for everything else — and it is
 * where a dry run stops.
 */
export const classifySideEffects = (plugin: LoadedPlugin): SideEffectClass => {
  if (FIRST_PARTY_INERT.has(plugin.id)) return 'inert';
  if (FIRST_PARTY_ENGINE_CONTROLLED.has(plugin.id)) return 'engine-controlled';
  return 'unknown';
};
```

- [ ] **Step 4: Implement the dry run**

`packages/engine/src/executor/dry-run.ts`:

```ts
import type { PluginModule } from '@trawlarr/plugin-api';
import { closeFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import type { LoadedPlugin } from '../host/loader.js';
import { runFlow, type FlowRunResult, type RunFlowOptions } from './run-flow.js';
import { classifySideEffects } from './vouchable.js';

export interface DryRunResult extends FlowRunResult {
  complete: boolean;
  stoppedAtNodeId: string | null;
  stoppedBecause: string | null;
  plannedCommands: string[][];
}

class DryRunStop extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, pluginId: string) {
    super(
      `Dry run stopped before node "${nodeId}": trawlarr cannot vouch for the side effects ` +
        `of plugin "${pluginId}", because a third-party plugin may run subprocesses or write ` +
        `files directly. Use a trial run to execute this flow against throwaway copies.`,
    );
    this.name = 'DryRunStop';
    this.nodeId = nodeId;
  }
}

/**
 * Walk the flow without performing side effects.
 *
 * Engine-controlled nodes are replaced by inert stand-ins: the Execute
 * substitute compiles the command that would have run and records it, then
 * routes onward as success. Any node we cannot vouch for halts the walk
 * before it is invoked.
 */
export const runDryFlow = async (
  options: RunFlowOptions & {
    outputPathFor: (path: string, container: string) => string;
  },
): Promise<DryRunResult> => {
  const plannedCommands: string[][] = [];
  let stoppedAtNodeId: string | null = null;
  let stoppedBecause: string | null = null;

  const inertStandIn = (plugin: LoadedPlugin): PluginModule => ({
    details: () => plugin.details,
    plugin: (args) => {
      if (plugin.id === 'trawlarr:execute' && args.variables.ffmpegCommand.init) {
        plannedCommands.push(
          compileFfmpegArgs({
            command: args.variables.ffmpegCommand,
            outputPath: options.outputPathFor(
              args.inputFileObj._id,
              args.variables.ffmpegCommand.container,
            ),
          }),
        );
        return {
          outputNumber: 1,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: {
            ...args.variables,
            ffmpegCommand: closeFfmpegCommand(args.variables.ffmpegCommand),
          },
        };
      }

      return {
        outputNumber: 1,
        outputFileObj: { _id: args.inputFileObj._id },
        variables: args.variables,
      };
    },
  });

  const result = await runFlow({
    ...options,
    loadPlugin: (node) => {
      const plugin = options.loadPlugin(node);
      const classification = classifySideEffects(plugin);

      if (classification === 'unknown') {
        const stop = new DryRunStop(node.id, plugin.id);
        stoppedAtNodeId = node.id;
        stoppedBecause = stop.message;
        throw stop;
      }

      if (classification === 'engine-controlled') {
        return { ...plugin, module: inertStandIn(plugin) };
      }

      return plugin;
    },
  });

  const stoppedEarly = stoppedAtNodeId !== null;

  return {
    ...result,
    // Declining to continue is not a failure — it is the documented limit of
    // what a dry run can promise.
    failed: stoppedEarly ? false : result.failed,
    error: stoppedEarly ? null : result.error,
    complete: !stoppedEarly && !result.failed,
    stoppedAtNodeId,
    stoppedBecause,
    plannedCommands,
  };
};
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- packages/engine`
Expected: PASS, 118 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): dry run that reports where it cannot vouch for side effects"
```

---

## Task 17: First-party plugin set

Spec §7. Five nodes — enough to build a working transcode flow with nothing downloaded. Each is a real plugin conforming to the contract, so they double as the reference implementation for plugin authors.

**Files:**
- Create: `packages/plugins-core/package.json`, `packages/plugins-core/tsconfig.json`
- Create: `packages/plugins-core/src/{start,checkVideoCodec,beginCommand,setVideoEncoder,execute}/index.ts`
- Create: `packages/plugins-core/src/index.ts`
- Test: `packages/plugins-core/src/plugins.test.ts`

**Interfaces:**
- Consumes: Task 2, Task 13.
- Produces: `FIRST_PARTY_PLUGINS: Record<string, { id: string; module: PluginModule }>` keyed by plugin id (`trawlarr:start` and so on), consumed by Task 18's CLI.

- [ ] **Step 1: Create the package**

`packages/plugins-core/package.json` — `"name": "@trawlarr/plugins-core"`, dependencies on `@trawlarr/plugin-api` and `@trawlarr/core` (both `workspace:*`), same shape as earlier manifests. `tsconfig.json` references `../plugin-api` and `../core`.

It must **not** depend on `@trawlarr/engine`: `engine` imports this package, so the reverse edge would be a cycle. That is why the ffmpeg command helpers live in `core`.

- [ ] **Step 2: Write the failing test**

`packages/plugins-core/src/plugins.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PluginInputArgs } from '@trawlarr/plugin-api';
import { emptyFfmpegCommand } from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from './index.js';

const argsFor = (over: Partial<PluginInputArgs> = {}): PluginInputArgs =>
  ({
    inputFileObj: {
      _id: '/media/movie.mkv',
      container: 'mkv',
      video_codec_name: 'h264',
      ffProbeData: {
        format: { duration: '60' },
        streams: [
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'eac3' },
        ],
      },
    },
    variables: { ffmpegCommand: emptyFfmpegCommand(), flowFailed: false, user: {} },
    inputs: {},
    jobLog: () => {},
    ...over,
  }) as unknown as PluginInputArgs;

describe('every first-party plugin', () => {
  it('conforms to the contract', () => {
    for (const [id, entry] of Object.entries(FIRST_PARTY_PLUGINS)) {
      const details = entry.module.details();
      expect(typeof entry.module.plugin, id).toBe('function');
      expect(Array.isArray(details.inputs), id).toBe(true);
      expect(details.outputs.length, id).toBeGreaterThan(0);
      expect(details.name, id).toBeTruthy();
    }
  });
});

describe('trawlarr:start', () => {
  it('is a start node that passes the file through', async () => {
    const plugin = FIRST_PARTY_PLUGINS['trawlarr:start']!.module;
    expect(plugin.details().isStartPlugin).toBe(true);
    const out = await plugin.plugin(argsFor());
    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe('/media/movie.mkv');
  });
});

describe('trawlarr:checkVideoCodec', () => {
  const plugin = () => FIRST_PARTY_PLUGINS['trawlarr:checkVideoCodec']!.module;

  it('routes to output 1 when the codec matches', async () => {
    const out = await plugin().plugin(argsFor({ inputs: { codec: 'h264' } }));
    expect(out.outputNumber).toBe(1);
  });

  it('routes to output 2 when it does not', async () => {
    const out = await plugin().plugin(argsFor({ inputs: { codec: 'hevc' } }));
    expect(out.outputNumber).toBe(2);
  });

  it('compares case-insensitively', async () => {
    const out = await plugin().plugin(argsFor({ inputs: { codec: 'H264' } }));
    expect(out.outputNumber).toBe(1);
  });
});

describe('trawlarr:beginCommand', () => {
  it('initialises the command from the probe', async () => {
    const out = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
    expect(out.variables.ffmpegCommand.init).toBe(true);
    expect(out.variables.ffmpegCommand.streams).toHaveLength(2);
    expect(out.variables.ffmpegCommand.inputFiles).toEqual(['/media/movie.mkv']);
  });
});

describe('trawlarr:setVideoEncoder', () => {
  it('sets encoder args on the video stream and marks the command for processing', async () => {
    const begun = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
    const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
      argsFor({
        variables: begun.variables,
        inputs: { encoder: 'libx265', quality: '24' },
      }),
    );
    const video = out.variables.ffmpegCommand.streams[0]!;
    expect(video.outputArgs).toEqual(['-c:v', 'libx265', '-crf', '24']);
    expect(out.variables.ffmpegCommand.shouldProcess).toBe(true);
  });

  it('leaves audio streams alone', async () => {
    const begun = await FIRST_PARTY_PLUGINS['trawlarr:beginCommand']!.module.plugin(argsFor());
    const out = await FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
      argsFor({ variables: begun.variables, inputs: { encoder: 'libx265', quality: '24' } }),
    );
    expect(out.variables.ffmpegCommand.streams[1]!.outputArgs).toEqual([]);
  });

  it('refuses to run without a Begin Command node, naming the fix', async () => {
    await expect(
      FIRST_PARTY_PLUGINS['trawlarr:setVideoEncoder']!.module.plugin(
        argsFor({ inputs: { encoder: 'libx265', quality: '24' } }),
      ),
    ).rejects.toThrow(/Begin Command/i);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm test -- packages/plugins-core`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the plugins**

Each file follows the same shape. `packages/plugins-core/src/start/index.ts`:

```ts
import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';

export const details = (): PluginDetails => ({
  name: 'Start',
  description: 'Entry point for the flow. Every file enters here.',
  style: { borderColor: '#33aa33' },
  tags: 'start',
  isStartPlugin: true,
  pType: 'start',
  sidebarPosition: -1,
  icon: 'faPlay',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'Continue' }],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});
```

`packages/plugins-core/src/checkVideoCodec/index.ts`:

```ts
import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';

export const details = (): PluginDetails => ({
  name: 'Check Video Codec',
  description: 'Branch on whether the video stream already uses a given codec.',
  style: { borderColor: '#3399cc' },
  tags: 'video,filter',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: 'faQuestion',
  inputs: [
    {
      label: 'Codec',
      name: 'codec',
      type: 'string',
      defaultValue: 'hevc',
      tooltip: 'The codec to test for, as ffprobe names it — for example hevc, h264, av1.',
      inputUI: { type: 'dropdown', options: ['hevc', 'h264', 'av1', 'vp9', 'mpeg4'] },
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Video already uses this codec' },
    { number: 2, tooltip: 'Video uses a different codec' },
  ],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  const wanted = String(args.inputs.codec ?? '').toLowerCase();
  const actual = String(args.inputFileObj.video_codec_name ?? '').toLowerCase();
  const matches = wanted !== '' && wanted === actual;

  args.jobLog(`Video codec is "${actual}"; wanted "${wanted}" — ${matches ? 'match' : 'differs'}.`);

  return {
    outputNumber: matches ? 1 : 2,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
```

`packages/plugins-core/src/beginCommand/index.ts`:

```ts
import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { beginFfmpegCommand } from '@trawlarr/core';

export const details = (): PluginDetails => ({
  name: 'Begin Command',
  description:
    'Start building an ffmpeg command. Command-building nodes must come after this, ' +
    'and an Execute node must follow them.',
  style: { borderColor: '#cc9933' },
  tags: 'ffmpeg',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 2,
  icon: 'faPlay',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'Command started' }],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: {
    ...args.variables,
    ffmpegCommand: beginFfmpegCommand({
      probe: args.inputFileObj.ffProbeData,
      container: args.inputFileObj.container,
      inputPath: args.inputFileObj._id,
    }),
  },
});
```

`packages/plugins-core/src/setVideoEncoder/index.ts`:

```ts
import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { assertCommandInitialised } from '@trawlarr/core';

/** Encoders that take -crf; the hardware ones take -cq instead. */
const CRF_ENCODERS = new Set(['libx264', 'libx265', 'libsvtav1', 'libvpx-vp9']);

export const details = (): PluginDetails => ({
  name: 'Set Video Encoder',
  description: 'Choose the encoder and quality for the video stream.',
  style: { borderColor: '#cc9933' },
  tags: 'ffmpeg,video',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 3,
  icon: 'faFilm',
  inputs: [
    {
      label: 'Encoder',
      name: 'encoder',
      type: 'string',
      defaultValue: 'libx265',
      tooltip: 'The ffmpeg encoder to use. Hardware encoders require matching hardware.',
      inputUI: {
        type: 'dropdown',
        options: ['libx265', 'libx264', 'hevc_nvenc', 'h264_nvenc', 'hevc_qsv', 'hevc_vaapi'],
      },
    },
    {
      label: 'Quality',
      name: 'quality',
      type: 'string',
      defaultValue: '24',
      tooltip: 'Lower is better quality and larger files. 20–24 is usually visually lossless.',
      inputUI: { type: 'slider', sliderOptions: { min: 0, max: 51 } },
    },
  ],
  outputs: [{ number: 1, tooltip: 'Encoder set' }],
  requiresVersion: '1.0.0',
});

export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  assertCommandInitialised(args.variables.ffmpegCommand);

  const encoder = String(args.inputs.encoder ?? 'libx265');
  const quality = String(args.inputs.quality ?? '24');
  const qualityFlag = CRF_ENCODERS.has(encoder) ? '-crf' : '-cq';

  for (const stream of args.variables.ffmpegCommand.streams) {
    if (stream.codec_type !== 'video' || stream.removed === true) continue;
    stream.outputArgs.push('-c:v', encoder, qualityFlag, quality);
    stream.forceEncoding = true;
  }
  args.variables.ffmpegCommand.shouldProcess = true;
  args.jobLog(`Video encoder set to ${encoder} at ${qualityFlag} ${quality}.`);

  return {
    outputNumber: 1,
    outputFileObj: { _id: args.inputFileObj._id },
    variables: args.variables,
  };
};
```

`packages/plugins-core/src/execute/index.ts`:

```ts
import type { PluginDetails, PluginInputArgs, PluginOutputArgs } from '@trawlarr/plugin-api';
import { assertCommandInitialised } from '@trawlarr/core';

export const details = (): PluginDetails => ({
  name: 'Execute',
  description: 'Run the ffmpeg command built by the preceding nodes.',
  style: { borderColor: '#cc3333' },
  tags: 'ffmpeg',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 4,
  icon: 'faBolt',
  inputs: [],
  outputs: [
    { number: 1, tooltip: 'Command succeeded' },
    { number: 2, tooltip: 'Command failed' },
  ],
  requiresVersion: '1.0.0',
});

/**
 * The engine performs the actual execution and replaces this module's behaviour
 * at runtime, which is what lets a dry run record the planned command without
 * running it. Reaching this body means the node ran outside an engine that
 * understands it.
 */
export const plugin = (args: PluginInputArgs): PluginOutputArgs => {
  assertCommandInitialised(args.variables.ffmpegCommand);
  throw new Error(
    'The Execute node must be run by the trawlarr engine, which performs the ffmpeg ' +
      'invocation itself. This usually means the engine did not register its executor.',
  );
};
```

`packages/plugins-core/src/index.ts`:

```ts
import type { PluginModule } from '@trawlarr/plugin-api';
import * as start from './start/index.js';
import * as checkVideoCodec from './checkVideoCodec/index.js';
import * as beginCommand from './beginCommand/index.js';
import * as setVideoEncoder from './setVideoEncoder/index.js';
import * as execute from './execute/index.js';

const entry = (id: string, module: PluginModule): { id: string; module: PluginModule } => ({
  id,
  module,
});

export const FIRST_PARTY_PLUGINS: Record<string, { id: string; module: PluginModule }> = {
  'trawlarr:start': entry('trawlarr:start', start),
  'trawlarr:checkVideoCodec': entry('trawlarr:checkVideoCodec', checkVideoCodec),
  'trawlarr:beginCommand': entry('trawlarr:beginCommand', beginCommand),
  'trawlarr:setVideoEncoder': entry('trawlarr:setVideoEncoder', setVideoEncoder),
  'trawlarr:execute': entry('trawlarr:execute', execute),
};
```

- [ ] **Step 5: Create the engine barrel**

The plugins import their helpers from `@trawlarr/core`; this barrel is what the CLI and
later phases consume. Create `packages/engine/src/index.ts`:

```ts
export * from './host/require-from-string.js';
export * from './host/loader.js';
export * from './host/file-object.js';
export * from './host/deps.js';
export * from './host/crud-trans-dbn.js';
export * from './host/axios-middleware.js';
export * from './ffmpeg/progress.js';
export * from './ffmpeg/run.js';
export * from './executor/run-flow.js';
export * from './executor/vouchable.js';
export * from './executor/dry-run.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test -- packages/plugins-core`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins-core packages/engine/src/index.ts
git commit -m "feat(plugins-core): first-party MIT node set for a working transcode flow"
```

---

## Task 18: Args assembly, CLI, and a real end-to-end transcode

This is where P1 proves itself: a real flow, real ffmpeg, real output.

**Files:**
- Create: `packages/engine/src/host/args.ts`, `packages/engine/src/executor/execute-node.ts`, `packages/engine/src/cli.ts`
- Test: `packages/engine/test/end-to-end.test.ts`

**Interfaces:**
- Consumes: Tasks 10–17.
- Produces:
  - `buildPluginInputArgs(input: BuildArgsInput): PluginInputArgs`
  - `createExecuteRunner(input: { ffmpegPath: string; outputPathFor: (path: string, container: string) => string; signal?: AbortSignal; onProgress?: (percent: number | null) => void; log?: (text: string) => void }): (plugin: LoadedPlugin) => PluginModule | null` — substitutes the engine's real Execute behaviour
  - CLI: `trawlarr-engine run --flow <flow.json> --file <media> [--dry-run] [--ffmpeg <path>] [--work-dir <dir>]`

- [ ] **Step 1: Write `host/args.ts`**

```ts
import { platform, arch } from 'node:os';
import type {
  ConfigVars, PluginDeps, PluginFileObject, PluginInputArgs, RunVariables,
} from '@trawlarr/plugin-api';
import { rejectClassicPluginDeps } from './deps.js';

export interface BuildArgsInput {
  fileObject: PluginFileObject;
  originalFileObject: PluginFileObject;
  nodeInputs: Record<string, unknown>;
  variables: RunVariables;
  librarySettings: Record<string, unknown>;
  userVariables: { global: Record<string, string>; library: Record<string, string> };
  configVars: ConfigVars;
  deps: PluginDeps;
  workDir: string;
  jobId: string;
  footprintId: string;
  fileId: string;
  jobStartMs: number;
  workerClass: string;
  hardwareType: string;
  log: (text: string) => void;
  onWorkerUpdate?: (obj: Record<string, unknown>) => void;
  probeFile?: (path: string) => Promise<PluginFileObject>;
}

export const buildPluginInputArgs = (input: BuildArgsInput): PluginInputArgs => {
  const config = input.configVars.config;

  return {
    inputFileObj: input.fileObject,
    originalLibraryFile: input.originalFileObject,
    librarySettings: input.librarySettings,
    inputs: input.nodeInputs,
    userVariables: input.userVariables,
    variables: input.variables,
    config: config as unknown as Record<string, unknown>,
    configVars: input.configVars,

    workDir: input.workDir,
    platform: platform(),
    arch: arch(),
    platform_arch_isdocker: config.platform_arch_isdocker,
    ffmpegPath: config.ffmpegPath,
    handbrakePath: config.handbrakePath,
    mkvpropeditPath: config.mkvpropeditPath,
    nodeHardwareType: input.hardwareType,
    workerType: input.workerClass,
    job: {
      version: '1.0.0',
      footprintId: input.footprintId,
      jobId: input.jobId,
      start: input.jobStartMs,
      type: input.workerClass,
      fileId: input.fileId,
    },
    isAutomation: false,
    logFullCliOutput: false,

    jobLog: input.log,
    updateWorker: (obj) => input.onWorkerUpdate?.(obj),
    logOutcome: (outcome) => input.log(`Outcome: ${outcome}`),
    updateStat: async () => {},
    scanIndividualFile: input.probeFile === undefined
      ? undefined
      : async (file) => input.probeFile!(file._id),
    installClassicPluginDeps: rejectClassicPluginDeps,

    lastSuccesfulPlugin: null,
    lastSuccessfulRun: null,
    thisPlugin: null,

    deps: input.deps,
  };
};
```

- [ ] **Step 2: Write `executor/execute-node.ts`**

```ts
import type { PluginModule } from '@trawlarr/plugin-api';
import { closeFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import { runFfmpeg } from '../ffmpeg/run.js';
import type { LoadedPlugin } from '../host/loader.js';

/**
 * The engine owns execution: the Execute node's declared behaviour is replaced
 * by this, which compiles the cooperatively-built command and runs ffmpeg.
 * Keeping it here rather than inside the plugin is what makes dry runs and
 * cancellation possible at all.
 */
export const createExecuteRunner = (input: {
  ffmpegPath: string;
  outputPathFor: (path: string, container: string) => string;
  signal?: AbortSignal;
  onProgress?: (percent: number | null) => void;
  log?: (text: string) => void;
}) => (plugin: LoadedPlugin): PluginModule | null => {
  if (plugin.id !== 'trawlarr:execute') return null;

  return {
    details: () => plugin.details,
    plugin: async (args) => {
      const command = args.variables.ffmpegCommand;
      const outputPath = input.outputPathFor(args.inputFileObj._id, command.container);
      const ffmpegArgs = compileFfmpegArgs({ command, outputPath });

      input.log?.(`Running: ${input.ffmpegPath} ${ffmpegArgs.join(' ')}`);

      const durationMs = Number.parseFloat(
        String(args.inputFileObj.ffProbeData.format?.duration ?? ''),
      );

      const result = await runFfmpeg({
        ffmpegPath: input.ffmpegPath,
        args: ffmpegArgs,
        durationMs: Number.isFinite(durationMs) ? durationMs * 1000 : null,
        signal: input.signal,
        onProgress: (progress) => {
          input.onProgress?.(progress.percent);
          args.updateWorker({ percentage: progress.percent, fps: progress.fps });
        },
      });

      const succeeded = result.code === 0 && !result.cancelled;
      if (!succeeded) {
        input.log?.(`ffmpeg failed (code ${String(result.code)}): ${result.stderrTail}`);
      }

      return {
        outputNumber: succeeded ? 1 : 2,
        outputFileObj: { _id: succeeded ? outputPath : args.inputFileObj._id },
        variables: { ...args.variables, ffmpegCommand: closeFfmpegCommand(command) },
      };
    },
  };
};
```

- [ ] **Step 3: Write the CLI**

`packages/engine/src/cli.ts`. It wires everything: read a flow JSON, probe the file, build the projection, assemble deps with an in-memory document store, run the flow, print the step trace.

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { ConfigVars, ProbeData } from '@trawlarr/plugin-api';
import type { FlowDefinition } from '@trawlarr/core';
import { FIRST_PARTY_PLUGINS } from '@trawlarr/plugins-core';
import { buildPluginDeps } from './host/deps.js';
import { createCrudTransDbn } from './host/crud-trans-dbn.js';
import { createAxiosMiddleware } from './host/axios-middleware.js';
import { buildPluginInputArgs } from './host/args.js';
import { toPluginFileObject } from './host/file-object.js';
import { createPluginLoader, type LoadedPlugin } from './host/loader.js';
import { createExecuteRunner } from './executor/execute-node.js';
import { runFlow } from './executor/run-flow.js';
import { runDryFlow } from './executor/dry-run.js';

const execFileAsync = promisify(execFile);

const probe = async (ffprobePath: string, file: string): Promise<ProbeData> => {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  return JSON.parse(stdout) as ProbeData;
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      flow: { type: 'string' },
      file: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      ffmpeg: { type: 'string', default: 'ffmpeg' },
      ffprobe: { type: 'string', default: 'ffprobe' },
      'work-dir': { type: 'string' },
    },
  });

  if (values.flow === undefined || values.file === undefined) {
    console.error('Usage: trawlarr-engine --flow <flow.json> --file <media> [--dry-run]');
    return 2;
  }

  const flow = JSON.parse(await readFile(values.flow, 'utf8')) as FlowDefinition;
  const workDir = values['work-dir'] ?? mkdtempSync(join(tmpdir(), 'trawlarr-job-'));
  const stat = statSync(values.file);
  const probeData = await probe(values.ffprobe!, values.file);

  const fileObject = toPluginFileObject({
    fileId: 'cli-file',
    libraryId: 'cli-library',
    footprintId: `${stat.dev}:${stat.ino}`,
    path: values.file,
    container: extname(values.file).replace('.', ''),
    sizeBytes: stat.size,
    originalSizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    probe: probeData,
    state: 'unknown',
    lastRunModified: false,
    holdUntilMs: null,
    lastTranscodeMs: null,
    lastHealthCheckMs: null,
    history: '',
    discoveredAtMs: Date.now(),
  });

  const log = (text: string) => console.log(`  ${text}`);
  const documents = new Map<string, Record<string, unknown>>();
  let paused = false;

  const configVars: ConfigVars = {
    config: {
      nodeID: 'cli', nodeName: 'cli', serverURL: '', serverIP: '', serverPort: '',
      handbrakePath: 'HandBrakeCLI', ffmpegPath: values.ffmpeg!, mkvpropeditPath: 'mkvpropedit',
      pathTranslators: [], platform_arch_isdocker: `${process.platform}_${process.arch}_false`,
      logLevel: 'info', processPid: process.pid, priority: 0, apiKey: '',
      maxLogSizeMB: 10, pollInterval: 1000, nodeType: 'mapped',
      unmappedNodeCache: '', startPaused: false,
    },
  };

  const deps = buildPluginDeps({
    configVars,
    crudTransDBN: createCrudTransDbn({
      documents: {
        get: (c, d) => documents.get(`${c}::${d}`),
        insert: (c, d, data) => void documents.set(`${c}::${d}`, data),
        update: (c, d, patch) =>
          void documents.set(`${c}::${d}`, { ...(documents.get(`${c}::${d}`) ?? {}), ...patch }),
        removeOne: (c, d) => void documents.delete(`${c}::${d}`),
      },
      hostSettings: {
        setPauseAllNodes: (value) => {
          paused = value;
          log(`Plugin ${value ? 'paused' : 'unpaused'} all nodes.`);
        },
        getPauseAllNodes: () => paused,
      },
      log,
      nowMs: () => Date.now(),
    }),
    axiosMiddleware: createAxiosMiddleware({
      probeFile: (path) => probe(values.ffprobe!, path),
      log,
    }),
  });

  const outputPathFor = (path: string, container: string) =>
    join(workDir, `${basename(path, extname(path))}.${container || 'mkv'}`);

  const loader = createPluginLoader();
  const executeRunner = createExecuteRunner({
    ffmpegPath: values.ffmpeg!,
    outputPathFor,
    log,
  });

  const loadPlugin = (node: { pluginId: string }): LoadedPlugin => {
    const firstParty = FIRST_PARTY_PLUGINS[node.pluginId];
    if (firstParty !== undefined) {
      const base: LoadedPlugin = {
        id: firstParty.id,
        absPath: `builtin:${firstParty.id}`,
        version: '1.0.0',
        details: firstParty.module.details(),
        module: firstParty.module,
      };
      const substitute = executeRunner(base);
      return substitute === null ? base : { ...base, module: substitute };
    }
    return loader.load(node.pluginId);
  };

  const buildArgs = (invocation: {
    node: { inputs: Record<string, unknown> };
    currentPath: string;
    variables: Parameters<typeof buildPluginInputArgs>[0]['variables'];
  }) =>
    buildPluginInputArgs({
      fileObject: { ...fileObject, _id: invocation.currentPath, file: invocation.currentPath },
      originalFileObject: fileObject,
      nodeInputs: invocation.node.inputs,
      variables: invocation.variables,
      librarySettings: {},
      userVariables: { global: {}, library: {} },
      configVars,
      deps,
      workDir,
      jobId: 'cli-job',
      footprintId: fileObject.footprintId,
      fileId: 'cli-file',
      jobStartMs: Date.now(),
      workerClass: 'transcode',
      hardwareType: 'cpu',
      log,
    });

  const options = { flow, initialPath: values.file, loadPlugin, buildArgs };
  const result = values['dry-run']
    ? await runDryFlow({ ...options, outputPathFor })
    : await runFlow(options);

  console.log('\nStep trace:');
  for (const step of result.steps) {
    const routed = step.outputNumber === null ? 'error' : `output ${step.outputNumber}`;
    console.log(`  ${step.seq}. ${step.pluginName} → ${routed} (${step.durationMs}ms)`);
    if (step.error !== null) console.log(`     error: ${step.error}`);
  }

  if ('plannedCommands' in result) {
    for (const args of result.plannedCommands) {
      console.log(`\nWould run: ${values.ffmpeg} ${args.join(' ')}`);
    }
    if (result.stoppedBecause !== null) console.log(`\n${result.stoppedBecause}`);
  }

  console.log(`\nStopped: ${result.stopReason}`);
  console.log(`Result path: ${result.currentPath}`);
  return result.failed ? 1 : 0;
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
```

- [ ] **Step 4: Write the end-to-end test**

`packages/engine/test/end-to-end.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const hasFfmpeg = async (): Promise<boolean> => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
};

let available = false;
let workDir: string;
let mediaPath: string;

beforeAll(async () => {
  available = await hasFfmpeg();
  if (!available) return;

  workDir = mkdtempSync(join(tmpdir(), 'trawlarr-e2e-'));
  mediaPath = join(workDir, 'sample.mkv');

  // Generate a tiny h264 sample rather than committing a binary fixture.
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    mediaPath,
  ]);
}, 60_000);

const flowPath = () => {
  const path = join(workDir, 'flow.json');
  writeFileSync(
    path,
    JSON.stringify({
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
        {
          id: 'check',
          pluginId: 'trawlarr:checkVideoCodec',
          pluginVersion: '1.0.0',
          inputs: { codec: 'hevc' },
        },
        { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
        {
          id: 'encoder',
          pluginId: 'trawlarr:setVideoEncoder',
          pluginVersion: '1.0.0',
          inputs: { encoder: 'libx265', quality: '30' },
        },
        { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
      ],
      edges: [
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
        { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
        { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'encoder' },
        { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'execute' },
      ],
    }),
    'utf8',
  );
  return path;
};

const runCli = (args: string[]) =>
  execFileAsync('node', [join(process.cwd(), 'packages/engine/dist/cli.js'), ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });

describe.runIf(available)('end to end', () => {
  it('dry-runs the flow and reports the ffmpeg command without producing output', async () => {
    const { stdout } = await runCli([
      '--flow', flowPath(), '--file', mediaPath, '--dry-run', '--work-dir', workDir,
    ]);
    expect(stdout).toContain('Would run:');
    expect(stdout).toContain('-c:v libx265');
    expect(stdout).toContain('Stopped: end-of-flow');
  }, 60_000);

  it('transcodes the sample to hevc for real', async () => {
    const { stdout } = await runCli([
      '--flow', flowPath(), '--file', mediaPath, '--work-dir', workDir,
    ]);
    expect(stdout).toContain('Stopped: end-of-flow');

    const outputPath = join(workDir, 'sample.mkv');
    const match = /Result path: (.+)/.exec(stdout);
    const produced = match?.[1]?.trim() ?? outputPath;
    expect(statSync(produced).size).toBeGreaterThan(0);

    const { stdout: probeOut } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', produced,
    ]);
    expect(probeOut.trim()).toBe('hevc');
  }, 180_000);

  it('routes to the already-correct branch on a second pass, doing no work', async () => {
    // Convergence in miniature: the transcoded file should now match, so the
    // flow ends at the check node instead of transcoding again.
    const converged = join(workDir, 'sample.mkv');
    const { stdout } = await runCli([
      '--flow', flowPath(), '--file', converged, '--work-dir', workDir, '--dry-run',
    ]);
    expect(stdout).toContain('1. Start');
    expect(stdout).not.toContain('Would run:');
  }, 60_000);
});
```

- [ ] **Step 5: Build and run the end-to-end test**

Run: `pnpm build && pnpm test -- packages/engine/test/end-to-end.test.ts`
Expected: PASS. If ffmpeg is absent the suite skips — install ffmpeg and re-run rather than accepting a skip as success. **This is the moment P1 is real:** a flow ran, a plugin decided, and ffmpeg produced an hevc file.

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): args assembly, engine-owned Execute, CLI, end-to-end transcode"
```

---

## Task 19: Compatibility harness against real community plugins

Spec §9. This is the test that decides whether the project's premise holds. Pinned SHA for pull requests so CI is deterministic; a nightly job against `master` as the drift alarm.

**Files:**
- Create: `scripts/fetch-plugin-corpus.mjs`, `packages/engine/test/compat/corpus.ts`
- Create: `packages/engine/test/compat/community-plugins.test.ts`
- Create: `.github/workflows/compat-nightly.yml`
- Modify: root `package.json` (add `compat:fetch`), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Tasks 10–15.
- Produces: `CORPUS_DIR`, `corpusAvailable(): boolean`, `pluginPath(relative: string): string`.

- [ ] **Step 1: Write the fetch script**

`scripts/fetch-plugin-corpus.mjs`. Downloads a tarball at a pinned commit into `cache/` — **never** into the repo tree.

```js
#!/usr/bin/env node
import { mkdirSync, existsSync, rmSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Pinned so pull-request CI is deterministic. The nightly workflow overrides
// this with `master` to detect upstream contract drift.
const PINNED_SHA = process.env.TDARR_PLUGINS_REF ?? 'master';
const REPO = 'HaveAGitGat/Tdarr_Plugins';
const CACHE = join(process.cwd(), 'cache', 'tdarr-plugins');
const marker = join(CACHE, `.ref-${PINNED_SHA}`);

if (existsSync(marker)) {
  console.log(`Plugin corpus already present at ${PINNED_SHA}.`);
  process.exit(0);
}

rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });

const url = `https://codeload.github.com/${REPO}/tar.gz/${PINNED_SHA}`;
console.log(`Fetching ${url}`);

const response = await fetch(url);
if (!response.ok) {
  console.error(`Failed to fetch corpus: HTTP ${response.status}`);
  process.exit(1);
}

const tarball = join(CACHE, 'corpus.tar.gz');
await pipeline(response.body, createWriteStream(tarball));
execFileSync('tar', ['-xzf', tarball, '-C', CACHE, '--strip-components=1'], {
  stdio: 'inherit',
});
rmSync(tarball);
execFileSync('touch', [marker]);

console.log(`Plugin corpus ready at ${CACHE} (${PINNED_SHA}).`);
console.log('These plugins are GPL-3.0 and are never committed to this repository.');
```

Add to root `package.json`:

```json
"compat:fetch": "node scripts/fetch-plugin-corpus.mjs"
```

Replace `PINNED_SHA`'s default `'master'` with an actual commit SHA once you have fetched once and confirmed the suite passes — record the SHA and the date in a comment.

- [ ] **Step 2: Write the corpus helper**

`packages/engine/test/compat/corpus.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const CORPUS_DIR = join(process.cwd(), 'cache', 'tdarr-plugins');

export const corpusAvailable = (): boolean =>
  existsSync(join(CORPUS_DIR, 'FlowPlugins', 'CommunityFlowPlugins'));

export const pluginPath = (relative: string): string =>
  join(CORPUS_DIR, 'FlowPlugins', 'CommunityFlowPlugins', relative);
```

- [ ] **Step 3: Write the compatibility test**

`packages/engine/test/compat/community-plugins.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { createPluginLoader } from '../../src/host/loader.js';
import { buildPluginDeps } from '../../src/host/deps.js';
import { createCrudTransDbn } from '../../src/host/crud-trans-dbn.js';
import { createAxiosMiddleware } from '../../src/host/axios-middleware.js';
import { toPluginFileObject } from '../../src/host/file-object.js';
import { beginFfmpegCommand, compileFfmpegArgs, emptyFfmpegCommand } from '@trawlarr/core';
import { CORPUS_DIR, corpusAvailable, pluginPath } from './corpus.js';

const available = corpusAvailable();

const probe: ProbeData = {
  format: { duration: '1440.0', bit_rate: '8000000', nb_streams: 3, size: '8000000000' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'eng' } },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
  ],
};

const fileObject = () =>
  toPluginFileObject({
    fileId: 'f1',
    libraryId: 'lib1',
    footprintId: '2049:42',
    path: '/media/movies/Sample.mkv',
    container: 'mkv',
    sizeBytes: 8_000_000_000,
    originalSizeBytes: 8_000_000_000,
    mtimeMs: 1_700_000_000_000,
    ctimeMs: 1_700_000_000_000,
    probe,
    state: 'unknown',
    lastRunModified: false,
    holdUntilMs: null,
    lastTranscodeMs: null,
    lastHealthCheckMs: null,
    history: '',
    discoveredAtMs: 1_690_000_000_000,
  });

const documents = new Map<string, Record<string, unknown>>();

const deps = buildPluginDeps({
  configVars: {
    config: {
      nodeID: 'test', nodeName: 'test', serverURL: '', serverIP: '', serverPort: '',
      handbrakePath: 'HandBrakeCLI', ffmpegPath: 'ffmpeg', mkvpropeditPath: 'mkvpropedit',
      pathTranslators: [], platform_arch_isdocker: 'linux_x64_false', logLevel: 'info',
      processPid: 1, priority: 0, apiKey: '', maxLogSizeMB: 10, pollInterval: 1000,
      nodeType: 'mapped', unmappedNodeCache: '', startPaused: false,
    },
  },
  crudTransDBN: createCrudTransDbn({
    documents: {
      get: (c, d) => documents.get(`${c}::${d}`),
      insert: (c, d, data) => void documents.set(`${c}::${d}`, data),
      update: (c, d, patch) =>
        void documents.set(`${c}::${d}`, { ...(documents.get(`${c}::${d}`) ?? {}), ...patch }),
      removeOne: (c, d) => void documents.delete(`${c}::${d}`),
    },
    hostSettings: { setPauseAllNodes: () => {}, getPauseAllNodes: () => false },
    log: () => {},
    nowMs: () => 1_700_000_000_000,
  }),
  axiosMiddleware: createAxiosMiddleware({ probeFile: async () => probe, log: () => {} }),
});

const argsFor = (inputs: Record<string, unknown>, withCommand: boolean): PluginInputArgs => {
  const file = fileObject();
  return {
    inputFileObj: file,
    originalLibraryFile: file,
    librarySettings: {},
    inputs,
    userVariables: { global: {}, library: {} },
    variables: {
      ffmpegCommand: withCommand
        ? beginFfmpegCommand({ probe, container: 'mkv', inputPath: file._id })
        : emptyFfmpegCommand(),
      flowFailed: false,
      user: {},
    },
    config: {},
    configVars: deps.configVars,
    workDir: '/tmp/trawlarr-compat',
    platform: 'linux',
    arch: 'x64',
    platform_arch_isdocker: 'linux_x64_false',
    ffmpegPath: 'ffmpeg',
    handbrakePath: 'HandBrakeCLI',
    mkvpropeditPath: 'mkvpropedit',
    nodeHardwareType: 'cpu',
    workerType: 'transcode',
    job: {
      version: '1.0.0', footprintId: '2049:42', jobId: 'j1',
      start: 1_700_000_000_000, type: 'transcode', fileId: 'f1',
    },
    isAutomation: false,
    logFullCliOutput: false,
    jobLog: () => {},
    updateWorker: () => {},
    logOutcome: () => {},
    updateStat: async () => {},
    installClassicPluginDeps: async () => {
      throw new Error('classic unsupported');
    },
    lastSuccesfulPlugin: null,
    lastSuccessfulRun: null,
    thisPlugin: null,
    deps,
  } as unknown as PluginInputArgs;
};

/**
 * Plugins under test. Chosen to cover the contract's load-bearing surfaces:
 * details() parsing, filter routing, ffmpegCommand mutation, and crudTransDBN.
 * Add to this list whenever a compatibility bug is found — that is how the
 * corpus grows into a regression suite.
 */
const CASES = [
  { rel: 'video/checkVideoCodec/1.0.0/index.js', inputs: { codec: 'hevc' }, command: false },
  { rel: 'file/checkFileSize/1.0.0/index.js', inputs: {}, command: false },
  { rel: 'tools/processedCheck/1.0.0/index.js', inputs: {}, command: false },
];

describe.runIf(available)('Tdarr community flow plugins', () => {
  it('reports where the corpus came from', () => {
    expect(existsSync(CORPUS_DIR)).toBe(true);
  });

  for (const testCase of CASES) {
    const abs = pluginPath(testCase.rel);

    describe(testCase.rel, () => {
      it.runIf(existsSync(abs))('loads and exposes usable details()', () => {
        const loaded = createPluginLoader().load(abs);
        expect(loaded.details.name).toBeTruthy();
        expect(loaded.details.outputs.length).toBeGreaterThan(0);
        expect(Array.isArray(loaded.details.inputs)).toBe(true);
      });

      it.runIf(existsSync(abs))('executes and returns a routable output number', async () => {
        const loaded = createPluginLoader().load(abs);
        const output = await loaded.module.plugin(argsFor(testCase.inputs, testCase.command));
        expect(typeof output.outputNumber).toBe('number');
        expect(output.outputNumber).toBeGreaterThanOrEqual(1);
        const numbers = loaded.details.outputs.map((o) => o.number);
        expect(numbers).toContain(output.outputNumber);
      });
    });
  }
});

describe.runIf(available)('ffmpegCommand cooperation across community plugins', () => {
  const abs = pluginPath('ffmpegCommand/setVideoEncoder/1.0.0/index.js');

  it.runIf(existsSync(abs))('produces a compilable command', async () => {
    const loaded = createPluginLoader().load(abs);
    const args = argsFor({ outputCodec: 'hevc', ffmpegPreset: 'medium' }, true);
    const output = await loaded.module.plugin(args);

    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/staging/out.mkv',
    });

    expect(argv).toContain('-i');
    expect(argv.at(-1)).toBe('/staging/out.mkv');
    expect(argv.filter((a) => a === '-map').length).toBeGreaterThan(0);
  });
});
```

> The three `CASES` paths and the `setVideoEncoder` input names are the starting point. On first run, list what is actually in the corpus (`ls cache/tdarr-plugins/FlowPlugins/CommunityFlowPlugins/*/*`) and correct any path or input name that has moved. A failure here is information — record what changed in the commit message.

- [ ] **Step 4: Fetch the corpus and run the suite**

Run: `pnpm compat:fetch && pnpm build && pnpm test -- packages/engine/test/compat`
Expected: PASS. If a plugin fails, read *why* before changing the test: a genuine host gap is the finding this whole phase exists to produce. Fix the host, not the assertion.

- [ ] **Step 5: Pin the SHA**

Record the commit the corpus was fetched at, and set it as the default in `scripts/fetch-plugin-corpus.mjs` with a dated comment. Pull-request CI must not track a moving target.

- [ ] **Step 6: Wire CI**

Add to `.github/workflows/ci.yml`, before the test step:

```yaml
      - run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - run: pnpm compat:fetch
```

Create `.github/workflows/compat-nightly.yml`:

```yaml
name: Compatibility drift
on:
  schedule: [{ cron: '0 5 * * *' }]
  workflow_dispatch:
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - env: { TDARR_PLUGINS_REF: master }
        run: pnpm compat:fetch
      - env: { TDARR_PLUGINS_REF: master }
        run: pnpm test -- packages/engine/test/compat
      - if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: 'Tdarr plugin contract drift detected',
              body: `The nightly compatibility run against Tdarr_Plugins@master failed.
              Pinned CI still passes, so this is upstream drift rather than a regression here.
              Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
              labels: ['compatibility'],
            });
```

- [ ] **Step 7: Commit**

```bash
git add scripts packages/engine/test/compat .github package.json
git commit -m "test(engine): pinned community plugin compatibility harness and nightly drift alarm"
```

- [ ] **Step 8: Verify the whole phase**

Run: `pnpm build && pnpm lint && pnpm audit:licenses && pnpm test`
Expected: all green. P1 is complete when community plugins load, execute, route, and cooperate on an ffmpeg command that compiles and runs.

---

## Definition of done

- `pnpm build`, `pnpm lint`, `pnpm audit:licenses`, `pnpm test` all pass from a clean clone.
- `@trawlarr/core` contains no IO, enforced by lint.
- A real Tdarr community flow plugin loads, executes, and routes correctly.
- Real community `ffmpegCommand` plugins produce argv that ffmpeg accepts.
- The CLI transcodes a generated sample to hevc, and a second pass on the result does no work.
- A dry run reports the planned ffmpeg command and names any node it cannot vouch for.
- CI runs against a pinned plugin corpus; a nightly job files an issue on upstream drift.

## Not in this plan

Deferred to **P2** (service):

- Scanner, filesystem watcher, cron rescan, and the partial-content-hash reader (spec §4.1–4.2)
- Overlapping-root rejection, hardlink skipping, and companion-file policy enforcement (spec §4.2)
- Supervisor, worker classes with hardware concurrency caps, and schedule windows with an explicit timezone (spec §4.4–4.5)
- Worker child processes and the JSON job protocol; the `FileTransport` interface with its local implementation (spec §3.1, §4.8)
- Per-library staging and trash directories, the data-directory layout, and cross-device staging warnings (spec §3.4)
- `Verify Output`, `Replace Original File`, and `Move File` nodes with their safety checks (spec §6.1)
- Flow validation that pauses a library with a stated reason, and contract-level warnings when a plugin's `requiresVersion` exceeds ours (spec §2.10, §6.5)
- Trial run — executing a flow for real against throwaway copies (spec §6.4)
- Plugin source syncing and the plugin browser's backend (spec §7)
- REST/WebSocket API, Docker image with all six required binaries, and the 100k-file scan benchmark (spec §2.11, §3.5)

Deferred to **P3**: the entire UI, including the flow editor's `inputUI` renderer with `onSelect` and `displayConditions` (spec §2.6), scaffolded new flows (spec §6.2), and the template gallery (spec §6.3).

Deferred to **v1.1/v1.2**: Tdarr flow JSON import, health check nodes, signature read-tracking, and remote nodes with Direct access and File transfer.


