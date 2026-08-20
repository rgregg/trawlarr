# P2c — Deployment and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Docker image, a minimum web UI, and a documented Unmanic migration path, so the project owner can point trawlarr at his real media library in a container and watch it converge.

**Architecture:** Trawlarr is a pnpm/TypeScript monorepo whose `@trawlarr/server` package already contains a working daemon: a SQLite store it is the sole writer of, a scanner, a forked-worker supervisor, a REST API at `/api/v1` and a WebSocket at `/api/v1/events`. This phase adds three layers *on top of that surface and nothing beneath it*: (1) an environment-variable seeding layer plus a container image and compose files matching the linuxserver.io conventions the target audience already runs; (2) a new `@trawlarr/web` package — a Vite/React bundle the daemon serves as static files from its own port, authenticating with the same API key a shell script would use, so the spec's rule that the UI has no privileged path stays literally true; (3) per-job log files, a flow template equivalent to a typical Unmanic transcode stack, a migration guide, and a scan benchmark at 100,000 files.

**Tech Stack:** Node 22, TypeScript 5.6, pnpm 9.12 workspaces, better-sqlite3, `node:http` (hand-rolled router), `ws`, chokidar, vitest 2.1, Docker + docker compose, Vite 5 + React 18 (new), Debian bookworm `ffmpeg`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22.** Run `nvm use 22` before anything. `.nvmrc` says `22`; `package.json` declares `"engines": {"node": ">=22"}`.
- **The gate is `pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`.** All four, every task, before the commit. Entering this phase it is green at **1911 tests, 0 skipped, 281 packages audited**. A task may only raise the test count; it may never raise the skip count above 0.
- **Touching any `package.json` means committing `pnpm-lock.yaml` in the same commit.** Run `pnpm install` after the edit and `git add pnpm-lock.yaml` alongside.
- **MIT only.** `pnpm audit:licenses` enforces the allow-list (`scripts/audit-licenses.mjs`). Nothing in this repository may be derived from Tdarr, Tdarr_Plugins or Unmanic. Unmanic is GPL-3.0: **environment-variable names and deployment conventions are interface and may be matched; source code, comments, Dockerfiles, entrypoint scripts and type declarations may not be copied, consulted line-by-line, or paraphrased.** Write every file in this plan from the plan, not from an upstream file.
- **TDD, and tests assert observable state** — database rows, bytes on disk, HTTP status codes and response bodies, process liveness (`process.kill(pid, 0)`), file ownership. **Never assert log text. Never assert elapsed time.** This repository has shipped a green concurrency test against a broken lock and a `toContain('0% converged')` that passed against `100% converged`; assertions here are held to a higher standard than usual.
- **`packages/server/src/worker/run-job.test.ts` must stay byte-for-byte unmodified.** Verify with `git diff --stat -- packages/server/src/worker/run-job.test.ts` before every commit; it must print nothing.
- **After editing any file under `packages/server/src` — including a test file there — run `tsc --build --force` before running the suites.** `rm -rf packages/*/dist && pnpm build` emits **nothing**, because `.tsbuildinfo` lives outside `dist` and tells `tsc` the output is current. The server end-to-end suites drive `packages/server/dist/cli.js`; against a stale `dist` they validate an old build and report green.
- **Every new suite must be unable to skip silently.** Conditions gating a `describe.runIf` are computed **synchronously at module scope** (`describe.runIf` is evaluated at collection time, before any async `beforeAll`). A missing tool answers `false` only for a genuine `ENOENT` and **throws** for every other failure — see `test-support/tool-availability.ts` and reuse it.
- **New runtime dependencies must be MIT/ISC/BSD/Apache-2.0/0BSD** and are added to exactly one package, never to the root.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `packages/server/src/config/env-settings.ts` | The env-var binding table, and applying it as a *seed* over `SettingsRepo`. |
| `packages/server/src/config/env-settings.test.ts` | Its tests. |
| `docker/entrypoint.sh` | PUID/PGID/TZ, directory preparation, drop privileges, exec the daemon. |
| `docker/entrypoint.test.ts` | Runs the script under `bash` with stubbed `usermod`/`gosu`, asserting files and recorded argv. |
| `Dockerfile` | Multi-stage build: pnpm build → runtime image with ffmpeg. |
| `.dockerignore` | Keeps `node_modules`, `dist`, `cache` out of the build context. |
| `docker/compose.yml` | CPU deployment, linuxserver.io conventions. |
| `docker/compose.nvidia.yml` | The same image with the NVIDIA runtime and NVENC declared. |
| `docker/compose-contract.test.ts` | Asserts every env var named in the compose files is one the code actually reads. |
| `docs/deployment.md` | How to run the image; the staging-filesystem trap; env var reference. |
| `docs/migrating-from-unmanic.md` | Concept mapping, plugin-stack mapping table, step-by-step. |
| `packages/server/src/job-log/job-log-writer.ts` | Append-with-cap writer used **inside the worker agent process**. |
| `packages/server/src/job-log/job-log-store.ts` | Path allocation and the retention sweep, used by the daemon. |
| `packages/server/src/flow/templates.ts` | Built-in flow templates, including the Unmanic-equivalent transcode stack. |
| `packages/server/src/api/static-files.ts` | Serves the built web bundle from the daemon's own port. |
| `packages/web/*` | The React UI: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `index.html`, `src/`. |
| `packages/web/src/api/client.ts` | DOM-free typed API client. |
| `packages/web/src/api/events.ts` | DOM-free reducer folding `TrawlarrEvent`s into view state. |
| `scripts/bench-scan.mjs` | The 100,000-file scan benchmark, opt-in. |
| `packages/server/test/scan-bounded.test.ts` | The structural invariants the benchmark's numbers depend on. |

**Modified**

| File | Change |
| --- | --- |
| `packages/server/src/db/settings-repo.ts` | Add `isSet(key)`, add `scan.scanOnStart`. |
| `packages/server/src/daemon/daemon.ts` | Apply env seeds; honour `scanOnStart`; job-log retention timer; NVENC preflight. |
| `packages/server/src/api/routes/system.ts` | Report env provenance on `GET /system/settings`. |
| `packages/server/src/api/routes/jobs.ts` | `GET /jobs/:id/log` stops being a 501. |
| `packages/server/src/api/routes/flows.ts` | `GET /flows/templates`, `POST /flows` from a template. |
| `packages/server/src/api/server.ts` | Mount the static handler beneath the API. |
| `packages/server/src/daemon/events.ts` | `job.started` gains `pid`. |
| `packages/server/src/worker/job-payload.ts` | `JobPayload` gains `logPath`. |
| `packages/server/src/worker/run-payload.ts` | Write the job log file. |
| `packages/server/src/cli.ts` | `--data-dir` honours `TRAWLARR_DATA_DIR`. |
| `package.json`, `vitest.config.ts`, `tsconfig.typecheck.json`, `eslint.config.js`, `.prettierignore` | Admit `packages/web` on the terms described in Task 10. |
| `README.md` | Point at `docs/deployment.md` and the UI. |
| `docs/engineering-notes/p2-prerequisites.md` | Record this phase's findings (final task of each area that produces one). |

---

## Task 1: Environment-variable seeding, with provenance

An operator's compose file must not be a lie, and a setting he changes in the UI must not silently revert on restart. Both are satisfied by one rule: **an env var seeds a setting only when that setting has never been written; the API then reports, per env var, whether it was applied or ignored and whether the live value still matches it.** Port, bind and data directory are the exception — they are per-run overrides, because `trawlarr daemon --port/--bind/--data-dir` already has exactly those semantics and a second, contradictory one would be worse than either.

**Files:**
- Create: `packages/server/src/config/env-settings.ts`
- Create: `packages/server/src/config/env-settings.test.ts`
- Modify: `packages/server/src/db/settings-repo.ts`
- Modify: `packages/server/src/daemon/daemon.ts`
- Modify: `packages/server/src/api/routes/system.ts`
- Modify: `packages/server/src/cli.ts`

**Interfaces:**
- Consumes: `SettingsRepo` from `packages/server/src/db/settings-repo.ts`; `ScheduleConfig` and `HARDWARE_TYPES` from `@trawlarr/core`.
- Produces:
  - `SettingsRepo.isSet(key: string): boolean` — true when the `setting` row for that dotted key exists.
  - `SettingsRepo.getScan(): ScanSettings` gains `scanOnStart: boolean` (default `true`).
  - `export interface EnvBinding { name: string; target: string; describe: string }`
  - `export const ENV_BINDINGS: readonly EnvBinding[]`
  - `export interface EnvApplication { name: string; target: string; envValue: string; applied: 'seeded' | 'ignored-already-set' | 'invalid'; problem: string | null }`
  - `export const applyEnvSettings(input: { settings: SettingsRepo; env: NodeJS.ProcessEnv }): EnvApplication[]`
  - `export const envProvenance(input: { settings: SettingsRepo; env: NodeJS.ProcessEnv; applications: EnvApplication[] }): Array<EnvApplication & { currentValue: string; matchesEnv: boolean }>`

The binding table, exactly:

| Env var | Target | Semantics |
| --- | --- | --- |
| `PUID` | — | entrypoint only, never a setting (Task 3) |
| `PGID` | — | entrypoint only, never a setting (Task 3) |
| `TZ` | `schedule.timezone` | seed-once |
| `NUMBER_OF_WORKERS` | `schedule.baseCounts.transcode` | seed-once |
| `SCHEDULE_FULL_SCAN_MINUTES` | `scan.rescanIntervalMs` (× 60000) | seed-once |
| `RUN_FULL_SCAN_ON_START` | `scan.scanOnStart` | seed-once |
| `TRAWLARR_API_KEY` | `daemon.apiKey` | seed-once |
| `TRAWLARR_HARDWARE` | `hardware.available` (comma-separated) | seed-once |
| `TRAWLARR_HARDWARE_CAPS` | `hardware.caps` (`nvenc=2,qsv=1`) | seed-once |
| `TRAWLARR_PORT` | `daemon.port` | per-run override |
| `TRAWLARR_BIND` | `daemon.bind` | per-run override |
| `TRAWLARR_DATA_DIR` | `--data-dir` default | per-run override |

There is deliberately **no** env var for a staging or cache directory. Staging is per-library and defaults to `<root>/.trawlarr/staging` so that replacement is an atomic `rename(2)`; a global env var pointing at a separate mount would silently degrade every replacement to a cross-device copy. Task 4's documentation states this instead.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/config/env-settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createSettingsRepo } from '../db/settings-repo.js';
import { applyEnvSettings, envProvenance } from './env-settings.js';

const repo = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  return createSettingsRepo({ db });
};

describe('applyEnvSettings', () => {
  it('seeds a setting that has never been written', () => {
    const settings = repo();
    const applications = applyEnvSettings({
      settings,
      env: { NUMBER_OF_WORKERS: '4', SCHEDULE_FULL_SCAN_MINUTES: '30', TZ: 'America/Los_Angeles' },
    });

    expect(settings.getSchedule().baseCounts.transcode).toBe(4);
    expect(settings.getSchedule().timezone).toBe('America/Los_Angeles');
    expect(settings.getScan().rescanIntervalMs).toBe(1_800_000);
    expect(applications.map((a) => a.applied)).toEqual(['seeded', 'seeded', 'seeded']);
  });

  it('does NOT overwrite a setting an operator has already changed', () => {
    const settings = repo();
    settings.setSchedule({ ...settings.getSchedule(), baseCounts: { transcode: 2, health: 0 } });

    const applications = applyEnvSettings({ settings, env: { NUMBER_OF_WORKERS: '6' } });

    // The whole point: a compose file does not silently revert a UI change.
    expect(settings.getSchedule().baseCounts.transcode).toBe(2);
    expect(applications[0]!.applied).toBe('ignored-already-set');
  });

  it('reports the divergence rather than hiding it', () => {
    const settings = repo();
    settings.setSchedule({ ...settings.getSchedule(), baseCounts: { transcode: 2, health: 0 } });
    const env = { NUMBER_OF_WORKERS: '6' };
    const applications = applyEnvSettings({ settings, env });

    const provenance = envProvenance({ settings, env, applications });
    expect(provenance).toEqual([
      {
        name: 'NUMBER_OF_WORKERS',
        target: 'schedule.baseCounts.transcode',
        envValue: '6',
        applied: 'ignored-already-set',
        problem: null,
        currentValue: '2',
        matchesEnv: false,
      },
    ]);
  });

  it('records a bad value as invalid and changes nothing', () => {
    const settings = repo();
    const applications = applyEnvSettings({ settings, env: { NUMBER_OF_WORKERS: 'lots' } });

    expect(settings.getSchedule().baseCounts.transcode).toBe(1);
    expect(applications[0]!.applied).toBe('invalid');
    expect(applications[0]!.problem).not.toBeNull();
  });

  it('seeds hardware availability and caps together', () => {
    const settings = repo();
    applyEnvSettings({
      settings,
      env: { TRAWLARR_HARDWARE: 'cpu,nvenc', TRAWLARR_HARDWARE_CAPS: 'nvenc=2' },
    });
    expect(settings.getHardware()).toEqual({ available: ['cpu', 'nvenc'], caps: { nvenc: 2 } });
  });

  it('seeds scanOnStart from RUN_FULL_SCAN_ON_START', () => {
    const settings = repo();
    expect(settings.getScan().scanOnStart).toBe(true);
    applyEnvSettings({ settings, env: { RUN_FULL_SCAN_ON_START: 'false' } });
    expect(settings.getScan().scanOnStart).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/server/src/config/env-settings.test.ts`
Expected: FAIL — `Cannot find module './env-settings.js'`.

- [ ] **Step 3: Add `isSet` and `scanOnStart` to the settings repo**

In `packages/server/src/db/settings-repo.ts`:

1. Add `scanOnStart: boolean;` to `ScanSettings`.
2. Add `scanOnStart: true` to `DEFAULT_SCAN`.
3. In `validateScan`, accept and validate the new field:

```ts
  scanOnStart: requireBoolean(value.scanOnStart, 'scan.scanOnStart'),
```

   and widen the parameter type to include `scanOnStart: unknown`.
4. Add `isSet(key: string): boolean;` to the `SettingsRepo` interface and implement it in `createSettingsRepo` next to `readRawKey`:

```ts
    isSet: (key) => selectStmt.get(key) !== undefined,
```

Because settings are stored decomposed as `<group>.<field>` rows, `isSet('schedule.baseCounts')` answers exactly "has anyone ever written the base counts", which is the question seeding asks.

- [ ] **Step 4: Write `env-settings.ts`**

Create `packages/server/src/config/env-settings.ts`:

```ts
import { HARDWARE_TYPES, type HardwareType } from '@trawlarr/core';
import type { SettingsRepo } from '../db/settings-repo.js';

export interface EnvBinding {
  name: string;
  /** The dotted setting this seeds, or the CLI option it defaults. */
  target: string;
  describe: string;
}

export interface EnvApplication {
  name: string;
  target: string;
  envValue: string;
  applied: 'seeded' | 'ignored-already-set' | 'invalid';
  problem: string | null;
}

interface SeedBinding extends EnvBinding {
  /** The `setting` row that decides whether this has already been written. */
  settingKey: string;
  apply: (settings: SettingsRepo, raw: string) => void;
  read: (settings: SettingsRepo) => string;
}

const parseWholeNumber = (raw: string, label: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a whole number of 0 or more, got ${JSON.stringify(raw)}.`);
  }
  return value;
};

const parseBoolean = (raw: string, label: string): boolean => {
  const lowered = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
  if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  throw new Error(`${label} must be true or false, got ${JSON.stringify(raw)}.`);
};

const parseHardwareList = (raw: string): HardwareType[] =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      if (!(HARDWARE_TYPES as readonly string[]).includes(entry)) {
        throw new Error(
          `TRAWLARR_HARDWARE lists "${entry}", which is not a hardware type. Valid: ` +
            `${HARDWARE_TYPES.join(', ')}.`,
        );
      }
      return entry as HardwareType;
    });

const parseHardwareCaps = (raw: string): Partial<Record<HardwareType, number>> => {
  const caps: Partial<Record<HardwareType, number>> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const [key, value] = trimmed.split('=');
    if (key === undefined || value === undefined) {
      throw new Error(
        `TRAWLARR_HARDWARE_CAPS entries look like "nvenc=2", got ${JSON.stringify(trimmed)}.`,
      );
    }
    if (!(HARDWARE_TYPES as readonly string[]).includes(key)) {
      throw new Error(
        `TRAWLARR_HARDWARE_CAPS names "${key}", which is not a hardware type. Valid: ` +
          `${HARDWARE_TYPES.join(', ')}.`,
      );
    }
    caps[key as HardwareType] = parseWholeNumber(value, `TRAWLARR_HARDWARE_CAPS.${key}`);
  }
  return caps;
};

const SEEDS: SeedBinding[] = [
  {
    name: 'TZ',
    target: 'schedule.timezone',
    settingKey: 'schedule.timezone',
    describe:
      'The timezone schedule windows are evaluated in. Deliberately a stored setting rather ' +
      'than the host clock, so a container with TZ unset does not shift every window.',
    apply: (settings, raw) => {
      settings.setSchedule({ ...settings.getSchedule(), timezone: raw });
    },
    read: (settings) => settings.getSchedule().timezone,
  },
  {
    name: 'NUMBER_OF_WORKERS',
    target: 'schedule.baseCounts.transcode',
    settingKey: 'schedule.baseCounts',
    describe: 'How many transcode workers run when no schedule window says otherwise.',
    apply: (settings, raw) => {
      const schedule = settings.getSchedule();
      settings.setSchedule({
        ...schedule,
        baseCounts: {
          ...schedule.baseCounts,
          transcode: parseWholeNumber(raw, 'NUMBER_OF_WORKERS'),
        },
      });
    },
    read: (settings) => String(settings.getSchedule().baseCounts.transcode),
  },
  {
    name: 'SCHEDULE_FULL_SCAN_MINUTES',
    target: 'scan.rescanIntervalMs',
    settingKey: 'scan.rescanIntervalMs',
    describe:
      'Minutes between periodic full rescans. This is the correctness backstop for network ' +
      'mounts, where filesystem watch events are dropped.',
    apply: (settings, raw) => {
      settings.setScan({
        rescanIntervalMs: parseWholeNumber(raw, 'SCHEDULE_FULL_SCAN_MINUTES') * 60_000,
      });
    },
    read: (settings) => String(settings.getScan().rescanIntervalMs / 60_000),
  },
  {
    name: 'RUN_FULL_SCAN_ON_START',
    target: 'scan.scanOnStart',
    settingKey: 'scan.scanOnStart',
    describe: 'Whether every enabled library is walked when the daemon starts.',
    apply: (settings, raw) => {
      settings.setScan({ scanOnStart: parseBoolean(raw, 'RUN_FULL_SCAN_ON_START') });
    },
    read: (settings) => String(settings.getScan().scanOnStart),
  },
  {
    name: 'TRAWLARR_API_KEY',
    target: 'daemon.apiKey',
    settingKey: 'daemon.apiKey',
    describe:
      'The API key clients send as X-Api-Key. Set it in compose to know it in advance; leave ' +
      'it unset and one is generated and printed on the first run only.',
    apply: (settings, raw) => {
      if (raw.length < 16) {
        throw new Error(
          `TRAWLARR_API_KEY must be at least 16 characters. A short key is the whole of this ` +
            `API's authentication.`,
        );
      }
      settings.setDaemon({ apiKey: raw });
    },
    // Never returned to a caller — see envProvenance's redaction.
    read: (settings) => settings.getDaemon().apiKey,
  },
  {
    name: 'TRAWLARR_HARDWARE',
    target: 'hardware.available',
    settingKey: 'hardware.available',
    describe:
      'Which hardware this node DECLARES it has, comma-separated (e.g. "cpu,nvenc"). ' +
      'Trawlarr never detects hardware; declaring nvenc on a machine without it produces ' +
      'failing jobs.',
    apply: (settings, raw) => {
      settings.setHardware({ available: parseHardwareList(raw) });
    },
    read: (settings) => settings.getHardware().available.join(','),
  },
  {
    name: 'TRAWLARR_HARDWARE_CAPS',
    target: 'hardware.caps',
    settingKey: 'hardware.caps',
    describe:
      'Concurrency cap per hardware type, e.g. "nvenc=2" for a consumer NVIDIA card whose ' +
      'NVENC session limit fails jobs rather than queueing them.',
    apply: (settings, raw) => {
      settings.setHardware({ caps: parseHardwareCaps(raw) });
    },
    read: (settings) =>
      Object.entries(settings.getHardware().caps)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(','),
  },
];

/** Per-run overrides. Documented here so the reference is one table, not two. */
const OVERRIDES: EnvBinding[] = [
  {
    name: 'TRAWLARR_PORT',
    target: 'daemon.port (this run only)',
    describe: 'Same meaning as "trawlarr daemon --port". Not stored.',
  },
  {
    name: 'TRAWLARR_BIND',
    target: 'daemon.bind (this run only)',
    describe: 'Same meaning as "trawlarr daemon --bind". Not stored.',
  },
  {
    name: 'TRAWLARR_DATA_DIR',
    target: '--data-dir (this run only)',
    describe: 'Default for every command’s --data-dir. Not stored.',
  },
];

export const ENV_BINDINGS: readonly EnvBinding[] = [
  ...SEEDS.map(({ name, target, describe }) => ({ name, target, describe })),
  ...OVERRIDES,
];

/**
 * Seed settings from the environment.
 *
 * SEEDING, NOT OVERRIDING, and the asymmetry is the decision: an operator who
 * changes a value in the UI and finds it reverted on the next restart cannot
 * trust the UI, while an operator whose compose file quietly does nothing
 * cannot trust the compose file. Seeding satisfies the first; `envProvenance`
 * — surfaced on GET /system/settings and in the UI — satisfies the second, by
 * saying out loud that the variable was read and did not win.
 *
 * An invalid value is RECORDED AND SKIPPED rather than thrown: refusing to
 * start a media server because one optional variable is misspelt trades a
 * cosmetic problem for a total outage.
 */
export const applyEnvSettings = (input: {
  settings: SettingsRepo;
  env: NodeJS.ProcessEnv;
}): EnvApplication[] => {
  const applications: EnvApplication[] = [];
  for (const seed of SEEDS) {
    const envValue = input.env[seed.name];
    if (envValue === undefined || envValue === '') continue;

    if (input.settings.isSet(seed.settingKey)) {
      applications.push({
        name: seed.name,
        target: seed.target,
        envValue,
        applied: 'ignored-already-set',
        problem: null,
      });
      continue;
    }
    try {
      seed.apply(input.settings, envValue);
      applications.push({
        name: seed.name,
        target: seed.target,
        envValue,
        applied: 'seeded',
        problem: null,
      });
    } catch (error) {
      applications.push({
        name: seed.name,
        target: seed.target,
        envValue,
        applied: 'invalid',
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return applications;
};

const REDACTED = '(redacted)';

/**
 * What each environment variable did, and whether the live value still agrees
 * with it. `matchesEnv: false` is the sentence a UI puts in front of an
 * operator: the compose file says one thing and the running system another.
 */
export const envProvenance = (input: {
  settings: SettingsRepo;
  env: NodeJS.ProcessEnv;
  applications: EnvApplication[];
}): Array<EnvApplication & { currentValue: string; matchesEnv: boolean }> =>
  input.applications.map((application) => {
    const seed = SEEDS.find((candidate) => candidate.name === application.name)!;
    const secret = seed.settingKey === 'daemon.apiKey';
    const current = seed.read(input.settings);
    return {
      ...application,
      envValue: secret ? REDACTED : application.envValue,
      currentValue: secret ? REDACTED : current,
      matchesEnv: current === application.envValue,
    };
  });
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/src/config/env-settings.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Wire it into the daemon and the CLI**

In `packages/server/src/daemon/daemon.ts`, immediately after the settings repo is built and **before** `checkAllLibraries` (settings must be right before any library health decision reads them), add:

```ts
  const envApplications = applyEnvSettings({ settings, env: process.env });
```

Store `envApplications` on the returned `Daemon` object as `readonly envApplications: EnvApplication[]` and pass it into `createApiContext` as a new `envApplications` field on `ApiContext` (add it to both `CreateApiContextInput` and `ApiContext` in `packages/server/src/api/router.ts` and `server.ts`).

Then honour `scanOnStart` at step 5 of the startup order:

```ts
  if (settings.getScan().scanOnStart) {
    for (const library of createLibraryRepo(db).list()) {
      if (library.enabled) scans.request(library.id, 'startup');
    }
  }
```

In `packages/server/src/cli.ts`, change every `'data-dir': { type: 'string', default: './trawlarr-data' }` to:

```ts
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
```

and in `cmdDaemon` default the port and bind from the environment:

```ts
  const portRaw = values.port ?? process.env.TRAWLARR_PORT;
  const port = portRaw === undefined ? undefined : parseNonNegativeInt(portRaw, 'daemon: --port');
  const bind = values.bind ?? process.env.TRAWLARR_BIND;
```

passing `bind` to `startDaemon`.

- [ ] **Step 7: Report provenance on the API**

In `packages/server/src/api/routes/system.ts`, extend `readSettings(ctx)`'s returned object with:

```ts
    environment: envProvenance({
      settings: ctx.settings,
      env: process.env,
      applications: ctx.envApplications,
    }),
```

- [ ] **Step 8: Write the API test**

Append to `packages/server/src/api/api.test.ts`:

```ts
  it('reports an environment variable that did not win', async () => {
    const harness = createHarness({
      envApplications: [
        {
          name: 'NUMBER_OF_WORKERS',
          target: 'schedule.baseCounts.transcode',
          envValue: '6',
          applied: 'ignored-already-set',
          problem: null,
        },
      ],
    });
    const response = await harness.get('/api/v1/system/settings');
    expect(response.status).toBe(200);
    expect(response.body.environment).toEqual([
      {
        name: 'NUMBER_OF_WORKERS',
        target: 'schedule.baseCounts.transcode',
        envValue: '6',
        applied: 'ignored-already-set',
        problem: null,
        currentValue: '1',
        matchesEnv: false,
      },
    ]);
  });
```

Adapt `createHarness` to accept and forward `envApplications` (default `[]`); follow the existing harness's own conventions in that file rather than inventing a second one.

- [ ] **Step 9: Run the gate**

Run: `nvm use 22 && tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`
Expected: PASS. Test count above 1911, 0 skipped, 281 packages. `git diff --stat -- packages/server/src/worker/run-job.test.ts` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/config packages/server/src/db/settings-repo.ts \
  packages/server/src/daemon/daemon.ts packages/server/src/api packages/server/src/cli.ts
git commit -m "feat(server): seed settings from the environment, and report what each variable did"
```

---

## Task 2: The container entrypoint — PUID, PGID, TZ

The linuxserver.io convention (which Tdarr also follows, and which the owner's compose files use) is that the container starts as root, adjusts a fixed service user to the caller's uid/gid, chowns the state directory, then drops privileges. Getting this wrong shows up as a daemon that cannot write `/config`, or as new media files owned by root that the operator's other tools cannot touch.

The script is small but it is the one part of the image with logic, so it is tested: run it under `bash` with a stubbed `PATH` and assert what it *did* — the directories it created, and the exact argv it exec'd.

**Files:**
- Create: `docker/entrypoint.sh`
- Create: `docker/entrypoint.test.ts`
- Modify: `vitest.config.ts` (include `docker/**/*.test.ts`)
- Modify: `tsconfig.typecheck.json` (include `docker/**/*.ts`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `docker/entrypoint.sh`, which honours `PUID` (default `1000`), `PGID` (default `1000`), `TZ` (default unset), and `TRAWLARR_DATA_DIR` (default `/config`), and finally `exec`s `gosu trawlarr:trawlarr "$@"`. Task 3's `Dockerfile` sets it as `ENTRYPOINT` with `CMD ["trawlarr", "daemon"]`.

- [ ] **Step 1: Write the failing test**

Create `docker/entrypoint.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * POSIX only, decided SYNCHRONOUSLY at module scope: `describe.runIf` is
 * evaluated at collection time, so a condition set by an async `beforeAll`
 * silently skips every run. A POSIX host without /bin/bash is an ERROR, not
 * a skip — "the tool is missing" and "we could not check" must not look the
 * same.
 */
const POSIX = process.platform !== 'win32';
if (POSIX) statSync('/bin/bash');

/** A stub that records its own argv, one line per invocation, and succeeds. */
const stub = (dir: string, name: string, log: string): void => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\nexit 0\n`);
  chmodSync(path, 0o755);
};

describe.runIf(POSIX)('docker/entrypoint.sh', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-entrypoint-'));
    const bin = join(root, 'bin');
    const data = join(root, 'config');
    mkdirSync(bin);
    const log = join(root, 'calls.log');
    for (const name of ['usermod', 'groupmod', 'chown', 'gosu']) stub(bin, name, log);
    return { root, bin, data, log };
  };

  it('aligns the service user to PUID/PGID and execs the command', async () => {
    const { bin, data, log } = setup();

    await run('bash', ['docker/entrypoint.sh', 'trawlarr', 'daemon'], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        PUID: '1234',
        PGID: '5678',
        TRAWLARR_DATA_DIR: data,
      },
    });

    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toContain('groupmod -o -g 5678 trawlarr');
    expect(calls).toContain('usermod -o -u 1234 -g 5678 trawlarr');
    expect(calls).toContain(`chown -R 1234:5678 ${data}`);
    // The exec'd argv is the whole point: the entrypoint must hand the
    // container's command through unchanged, or CMD overrides stop working.
    expect(calls.at(-1)).toBe('gosu trawlarr:trawlarr trawlarr daemon');
  });

  it('defaults PUID and PGID to 1000 and creates the data directory', async () => {
    const { bin, data, log } = setup();

    await run('bash', ['docker/entrypoint.sh', 'trawlarr', 'daemon'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, TRAWLARR_DATA_DIR: data },
    });

    expect(statSync(data).isDirectory()).toBe(true);
    expect(statSync(join(data, 'logs', 'jobs')).isDirectory()).toBe(true);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('usermod -o -u 1000 -g 1000 trawlarr');
  });

  it('writes /etc/localtime and /etc/timezone when TZ is set', async () => {
    const { root, bin, data } = setup();
    const etc = join(root, 'etc');
    mkdirSync(join(root, 'zoneinfo', 'America'), { recursive: true });
    writeFileSync(join(root, 'zoneinfo', 'America', 'Los_Angeles'), 'TZif-stub');
    mkdirSync(etc);

    await run('bash', ['docker/entrypoint.sh', 'trawlarr', 'daemon'], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        TRAWLARR_DATA_DIR: data,
        TZ: 'America/Los_Angeles',
        TRAWLARR_ETC_DIR: etc,
        TRAWLARR_ZONEINFO_DIR: join(root, 'zoneinfo'),
      },
    });

    expect(readFileSync(join(etc, 'timezone'), 'utf8').trim()).toBe('America/Los_Angeles');
    expect(readFileSync(join(etc, 'localtime'), 'utf8')).toBe('TZif-stub');
  });

  it('refuses an unknown TZ by name rather than silently running in UTC', async () => {
    const { root, bin, data } = setup();
    mkdirSync(join(root, 'zoneinfo'), { recursive: true });
    mkdirSync(join(root, 'etc'));

    await expect(
      run('bash', ['docker/entrypoint.sh', 'trawlarr', 'daemon'], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          TRAWLARR_DATA_DIR: data,
          TZ: 'Mars/Olympus_Mons',
          TRAWLARR_ETC_DIR: join(root, 'etc'),
          TRAWLARR_ZONEINFO_DIR: join(root, 'zoneinfo'),
        },
      }),
    ).rejects.toMatchObject({ code: 78 });
  });
});
```

`TRAWLARR_ETC_DIR` and `TRAWLARR_ZONEINFO_DIR` exist **only** so the test does not have to write to the host's real `/etc`. They default to `/etc` and `/usr/share/zoneinfo`, and are not documented as an operator interface.

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run docker/entrypoint.test.ts`
Expected: FAIL — either "No test files found" (before the vitest include is widened) or `bash: docker/entrypoint.sh: No such file or directory`.

- [ ] **Step 3: Widen the vitest and typecheck includes**

In `vitest.config.ts`, add `'docker/**/*.test.ts'` to **both** `test.include` and `test.typecheck.include`.
In `tsconfig.typecheck.json`, add `"docker/**/*.ts"` to `include`.

- [ ] **Step 4: Write the entrypoint**

Create `docker/entrypoint.sh`:

```sh
#!/bin/bash
# Container entrypoint: align the service user with the host's, prepare the
# state directory, then drop privileges and exec the command.
#
# The uid/gid dance exists because bind-mounted media belongs to a host user
# this image cannot know at build time. Running as root instead would work
# and would leave every replaced file owned by root, which is how a media
# library becomes unmanageable by the tools that filled it.
set -euo pipefail

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${TRAWLARR_DATA_DIR:-/config}"
ETC_DIR="${TRAWLARR_ETC_DIR:-/etc}"
ZONEINFO_DIR="${TRAWLARR_ZONEINFO_DIR:-/usr/share/zoneinfo}"

# `-o` allows a duplicate id: a host uid that already belongs to another
# container user is normal and is not a reason to fail to start.
groupmod -o -g "${PGID}" trawlarr
usermod -o -u "${PUID}" -g "${PGID}" trawlarr

if [ -n "${TZ:-}" ]; then
  if [ ! -f "${ZONEINFO_DIR}/${TZ}" ]; then
    # Exit 78 (EX_CONFIG). Falling back to UTC would shift every schedule
    # window by hours with nothing anywhere saying why — the exact failure
    # trawlarr's stored schedule timezone exists to prevent.
    echo "trawlarr: TZ=\"${TZ}\" is not a timezone this image knows (looked in ${ZONEINFO_DIR})." >&2
    exit 78
  fi
  cp "${ZONEINFO_DIR}/${TZ}" "${ETC_DIR}/localtime"
  echo "${TZ}" > "${ETC_DIR}/timezone"
fi

# `logs/jobs` is created here rather than lazily, so a wrong PUID surfaces as
# a chown failure at start instead of as a job that cannot write its log an
# hour into a transcode.
mkdir -p "${DATA_DIR}/logs/jobs"
chown -R "${PUID}:${PGID}" "${DATA_DIR}"

exec gosu trawlarr:trawlarr "$@"
```

Make it executable and record that in git:

```bash
chmod +x docker/entrypoint.sh && git update-index --chmod=+x docker/entrypoint.sh 2>/dev/null || true
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `nvm use 22 && pnpm vitest run docker/entrypoint.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the gate**

Run: `nvm use 22 && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`
Expected: PASS, 0 skipped. If `prettier --check .` objects to `entrypoint.sh`, add `docker/entrypoint.sh` to `.prettierignore` — prettier has no shell parser and reformatting it would be a lie.

- [ ] **Step 7: Commit**

```bash
git add docker/entrypoint.sh docker/entrypoint.test.ts vitest.config.ts tsconfig.typecheck.json .prettierignore
git commit -m "feat(docker): container entrypoint honouring PUID/PGID/TZ"
```

---

## Task 3: The image, the compose file, and the deployment guide

One image, built once. The NVIDIA deployment in Task 4 is the *same image* with a different compose file — Debian's `ffmpeg` already carries `h264_nvenc`/`hevc_nvenc`, and the NVIDIA container runtime injects the driver libraries at run time, so a second Dockerfile would be two things to maintain that differ in nothing that matters.

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker/compose.yml`
- Create: `docker/compose-contract.test.ts`
- Create: `docs/deployment.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `docker/entrypoint.sh` (Task 2); `ENV_BINDINGS` from `packages/server/src/config/env-settings.ts` (Task 1).
- Produces: an image whose default command is `trawlarr daemon`, with `/config` as `TRAWLARR_DATA_DIR`, `/api/v1/system/health` as its `HEALTHCHECK`, and `TRAWLARR_BIND=0.0.0.0` set **in the image** (a container that bound loopback would be unreachable from its own published port; the network boundary is the container's, not the process's).

- [ ] **Step 1: Write the failing test**

The test that keeps this honest is not one that builds an image — that costs minutes and belongs in a script. It is the one that stops the compose file becoming a lie: every environment variable a compose file sets must be one the code actually reads.

Create `docker/compose-contract.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_BINDINGS } from '../packages/server/src/config/env-settings.js';

/** Variables the ENTRYPOINT or the container runtime reads, not the daemon. */
const RUNTIME_VARS = new Set([
  'PUID',
  'PGID',
  'TZ',
  'NVIDIA_VISIBLE_DEVICES',
  'NVIDIA_DRIVER_CAPABILITIES',
]);

const composeFiles = readdirSync('docker')
  .filter((name) => name.startsWith('compose') && name.endsWith('.yml'))
  .map((name) => join('docker', name));

describe('compose files', () => {
  it('are all discovered (a renamed file must not make this suite vacuous)', () => {
    expect(composeFiles).toContain('docker/compose.yml');
  });

  it.each(composeFiles)('%s sets only variables trawlarr reads', (file) => {
    const known = new Set([...ENV_BINDINGS.map((binding) => binding.name), ...RUNTIME_VARS]);
    const body = readFileSync(file, 'utf8');
    // The `environment:` block is a YAML list of `- NAME=value` entries.
    const declared = [...body.matchAll(/^\s+-\s+([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!);

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => !known.has(name))).toEqual([]);
  });

  it('publish the daemon port the image binds', () => {
    for (const file of composeFiles) {
      expect(readFileSync(file, 'utf8')).toContain('8265');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run docker/compose-contract.test.ts`
Expected: FAIL — `ENOENT: no such file or directory, scandir 'docker'` is already gone (Task 2 created it), so it fails on `expect(composeFiles).toContain('docker/compose.yml')`.

- [ ] **Step 3: Write `.dockerignore`**

Create `.dockerignore`:

```
node_modules
**/node_modules
**/dist
**/*.tsbuildinfo
cache
coverage
.git
.github
docs
trawlarr-data
```

- [ ] **Step 4: Write the `Dockerfile`**

Create `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/plugin-api/package.json packages/plugin-api/
COPY packages/plugins-core/package.json packages/plugins-core/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
# better-sqlite3 is a native module: it needs a toolchain to build here, and
# none at run time, which is the whole reason this stage exists.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
 && pnpm deploy --filter @trawlarr/server --prod /out

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="trawlarr" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/rgregg/trawlarr"

# ffmpeg and ffprobe are third-party binaries under their own licences,
# aggregated into this image and not linked into or derived from trawlarr's
# own MIT-licensed code. gosu drops privileges without the signal-forwarding
# problems `su` has as PID 1's child.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg gosu tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 trawlarr \
 && useradd -u 1000 -g 1000 -d /config -s /usr/sbin/nologin trawlarr

COPY --from=build /out /app
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && ln -s /app/dist/cli.js /usr/local/bin/trawlarr

ENV TRAWLARR_DATA_DIR=/config \
    TRAWLARR_BIND=0.0.0.0 \
    NODE_ENV=production
VOLUME ["/config"]
EXPOSE 8265

# The health endpoint is the ONLY anonymous route, precisely so a health
# check needs no API key.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8265/api/v1/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["trawlarr", "daemon"]
```

`ln -s /app/dist/cli.js /usr/local/bin/trawlarr` relies on the CLI's shebang and on its `isMain()` check resolving symlinks — which it does, deliberately, `realpathSync` on `process.argv[1]`. `docker exec <container> trawlarr status` therefore works, and that is how an operator reads state without a browser.

- [ ] **Step 5: Write `docker/compose.yml`**

```yaml
services:
  trawlarr:
    image: ghcr.io/rgregg/trawlarr:latest
    container_name: trawlarr
    restart: unless-stopped
    ports:
      - '8265:8265'
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - NUMBER_OF_WORKERS=2
      - SCHEDULE_FULL_SCAN_MINUTES=60
      - RUN_FULL_SCAN_ON_START=true
      # Set this to know the API key in advance. Leave it out and one is
      # generated on the first run and printed once, to `docker logs`.
      # - TRAWLARR_API_KEY=change-me-to-something-long
    volumes:
      - ./config:/config
      - /srv/media:/library
```

There is deliberately **no cache or staging volume.** Trawlarr stages each library's work inside that library, at `<root>/.trawlarr/staging`, so installing a finished transcode is an atomic `rename(2)`. A staging directory on a separate mount turns every replacement into a cross-device copy: slower, and with a wider window in which a crash leaves a partial file. `docs/deployment.md` says so in the operator's own words.

- [ ] **Step 6: Write `docs/deployment.md`**

Create `docs/deployment.md` covering, in this order:

1. **Quick start** — `docker compose -f docker/compose.yml up -d`, then `docker logs trawlarr` to read the generated API key once, then `http://localhost:8265`.
2. **Volumes** — `/config` is state (SQLite database, `daemon.json`, `logs/jobs/`); back it up by copying the directory with the container stopped. `/library` is the media bind mount.
3. **The staging trap**, stated as consequence: "Trawlarr writes each library's in-progress transcode to `<library root>/.trawlarr/staging` and each replaced original to `<library root>/.trawlarr/trash`. Both are deliberately inside the library, because installing a finished file must be an atomic rename and a rename cannot cross filesystems. If you come from Unmanic and are used to pointing a cache directory at a separate disk, do not do that here: `stagingDir` on a different filesystem degrades every replacement to a copy. The scanner excludes the whole `.trawlarr` directory from its walk, so nothing it writes is ever ingested as media."
4. **Environment variables** — a table generated from the same list as `ENV_BINDINGS`, with the seed-vs-override rule stated plainly: *a variable in the first column seeds its setting only on the first start, when nothing has ever set it. After that the stored value wins, so a change you make in the UI is not reverted by your compose file. `GET /api/v1/system/settings` reports, for every variable you set, whether it was applied and whether the live value still matches it.*
5. **Ports and exposure** — the daemon binds `0.0.0.0` inside the container (the container's network namespace is the boundary) and speaks plain HTTP with a shared-key API. Put a reverse proxy in front of it for TLS; publish it to `127.0.0.1:8265:8265` if it should not be on the LAN.
6. **Users and permissions** — `PUID`/`PGID` must match the owner of your media, or trawlarr will read files it cannot replace.
7. **Hardlinked files are skipped by default.** A library hardlinked into a torrent client's download directory is the normal case for this audience, and replacing such a file either breaks the link or mutates a seeding copy. Files with `nlink > 1` are skipped with a warning; `allowHardlinked` on the library turns that off deliberately.
8. **Licensing of the image** — trawlarr's own code is MIT; the image additionally contains Debian packages (notably `ffmpeg`) under their own licences, aggregated, not derived.

- [ ] **Step 7: Point the README at it**

In `README.md`, under "Status", add a "Run it in Docker" section of three lines pointing at `docs/deployment.md` and the compose file. Do not duplicate the content.

- [ ] **Step 8: Run the test and watch it pass**

Run: `nvm use 22 && pnpm vitest run docker/compose-contract.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Build and run the image by hand**

This is not part of the gate; it is the verification that this task actually delivered a deployable thing. Record the output in the commit message.

```bash
docker build -t trawlarr:dev .
mkdir -p /tmp/trawlarr-config
docker run --rm -d --name trawlarr-dev -p 8265:8265 \
  -e PUID="$(id -u)" -e PGID="$(id -g)" -e TZ=America/Los_Angeles \
  -v /tmp/trawlarr-config:/config trawlarr:dev
sleep 5
curl -fsS http://localhost:8265/api/v1/system/health          # {"status":"ok",...}
docker exec trawlarr-dev trawlarr status                       # exits 0
docker exec trawlarr-dev ffmpeg -hide_banner -encoders | grep -c nvenc || true
stat -c '%u:%g' /tmp/trawlarr-config                           # your uid:gid
docker stop trawlarr-dev
```

Expected: the health endpoint answers without an API key; `trawlarr status` inside the container exits 0; `/tmp/trawlarr-config` is owned by your uid, not root.

- [ ] **Step 10: Run the gate and commit**

```bash
nvm use 22 && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add Dockerfile .dockerignore docker/compose.yml docker/compose-contract.test.ts docs/deployment.md README.md
git commit -m "feat(docker): image, compose file and deployment guide"
```

---

## Task 4: The NVIDIA variant, and a preflight that catches a false declaration

The owner's NVENC deployment uses `runtime: nvidia` and `NVIDIA_VISIBLE_DEVICES`. Trawlarr's standing ruling is that **hardware is declared by the operator, never detected** — so the compose file declares `TRAWLARR_HARDWARE=cpu,nvenc` and `TRAWLARR_HARDWARE_CAPS=nvenc=2`, and Task 1's seeding turns that into `hardware.available` and `hardware.caps`.

Declaring is not the same as verifying. A declaration that is *false* — the most likely mistake here, because `NVIDIA_DRIVER_CAPABILITIES` defaults to `compute,utility` and therefore does **not** inject the encoder library — currently shows up as every GPU job failing, one per file. So the daemon runs a **preflight**: it asks the configured ffmpeg which encoders it has, and if a declared hardware type's encoders are absent it says so once, by name, at start. It does not change the declaration; detecting and silently correcting is exactly what the ruling forbids.

**Files:**
- Create: `docker/compose.nvidia.yml`
- Create: `packages/server/src/daemon/hardware-preflight.ts`
- Create: `packages/server/src/daemon/hardware-preflight.test.ts`
- Modify: `packages/server/src/daemon/daemon.ts`
- Modify: `packages/server/src/api/routes/system.ts`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: `SettingsRepo.getHardware()` and `getBinaries()` (existing); `ApiContext` (existing).
- Produces:
  - `export interface HardwareFinding { hardwareType: HardwareType; expectedEncoder: string; present: boolean }`
  - `export const REQUIRED_ENCODER: Record<HardwareType, string | null>` — `{cpu: null, nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', vaapi: 'hevc_vaapi', videotoolbox: 'hevc_videotoolbox', amf: 'hevc_amf'}`
  - `export const preflightHardware(input: { available: HardwareType[]; listEncoders: () => Promise<string[]> }): Promise<HardwareFinding[]>`
  - `ApiContext.hardwareFindings: HardwareFinding[]`, reported on `GET /system/version` as `hardware`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/daemon/hardware-preflight.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { preflightHardware } from './hardware-preflight.js';

describe('preflightHardware', () => {
  it('reports a declared encoder the ffmpeg build does not have', async () => {
    const findings = await preflightHardware({
      available: ['cpu', 'nvenc'],
      listEncoders: async () => ['libx264', 'libx265'],
    });

    expect(findings).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
  });

  it('reports nothing when every declared encoder is present', async () => {
    const findings = await preflightHardware({
      available: ['cpu', 'nvenc'],
      listEncoders: async () => ['libx265', 'hevc_nvenc'],
    });
    expect(findings).toEqual([]);
  });

  it('never reports cpu, which needs no encoder to exist', async () => {
    const findings = await preflightHardware({ available: ['cpu'], listEncoders: async () => [] });
    expect(findings).toEqual([]);
  });

  it('surfaces an ffmpeg that could not be asked as a finding, not a throw', async () => {
    const findings = await preflightHardware({
      available: ['nvenc'],
      listEncoders: async () => {
        throw new Error('spawn ffmpeg ENOENT');
      },
    });
    // "Could not check" must not read as "checked and fine": the daemon still
    // starts, and the finding says the encoder was not shown to be present.
    expect(findings).toEqual([
      { hardwareType: 'nvenc', expectedEncoder: 'hevc_nvenc', present: false },
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/server/src/daemon/hardware-preflight.test.ts`
Expected: FAIL — `Cannot find module './hardware-preflight.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/daemon/hardware-preflight.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HARDWARE_TYPES, type HardwareType } from '@trawlarr/core';

const run = promisify(execFile);

export interface HardwareFinding {
  hardwareType: HardwareType;
  expectedEncoder: string;
  present: boolean;
}

/**
 * The HEVC encoder each hardware type must be able to name. One encoder per
 * type is enough: a build with `hevc_nvenc` has the NVENC support trawlarr's
 * flows ask for, and a build without it has none of it.
 */
export const REQUIRED_ENCODER: Record<HardwareType, string | null> = {
  cpu: null,
  nvenc: 'hevc_nvenc',
  qsv: 'hevc_qsv',
  vaapi: 'hevc_vaapi',
  videotoolbox: 'hevc_videotoolbox',
  amf: 'hevc_amf',
};

/** `ffmpeg -encoders` output, reduced to the encoder names it lists. */
export const listEncodersWith = async (ffmpegPath: string): Promise<string[]> => {
  const { stdout } = await run(ffmpegPath, ['-hide_banner', '-encoders'], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return [...stdout.matchAll(/^\s*[A-Z.]{6}\s+(\S+)/gm)].map((match) => match[1]!);
};

/**
 * Check a DECLARATION, never replace one.
 *
 * Trawlarr does not detect hardware — an operator says what this node has,
 * and a wrong answer produces failing jobs. This exists because the most
 * common way to be wrong is invisible: the NVIDIA container runtime injects
 * the encoder library only when NVIDIA_DRIVER_CAPABILITIES includes `video`,
 * and its default does not. A finding names that once at start instead of
 * once per file for ever.
 *
 * An ffmpeg that cannot be asked yields `present: false`, deliberately: "we
 * could not check" must not be reported as "checked and fine".
 */
export const preflightHardware = async (input: {
  available: HardwareType[];
  listEncoders: () => Promise<string[]>;
}): Promise<HardwareFinding[]> => {
  const wanted = input.available
    .filter((type) => REQUIRED_ENCODER[type] !== null)
    .map((type) => ({ hardwareType: type, expectedEncoder: REQUIRED_ENCODER[type]! }));
  if (wanted.length === 0) return [];

  let encoders: string[];
  try {
    encoders = await input.listEncoders();
  } catch {
    encoders = [];
  }
  const present = new Set(encoders);
  return wanted
    .filter((entry) => !present.has(entry.expectedEncoder))
    .map((entry) => ({ ...entry, present: false }))
    .sort(
      (a, b) =>
        HARDWARE_TYPES.indexOf(a.hardwareType) - HARDWARE_TYPES.indexOf(b.hardwareType),
    );
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/src/daemon/hardware-preflight.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into the daemon and the API**

In `daemon.ts`, after the env seeds are applied and before the supervisor starts:

```ts
  const hardwareFindings = await preflightHardware({
    available: settings.getHardware().available,
    listEncoders: async () => await listEncodersWith(settings.getBinaries().ffmpeg),
  });
  for (const finding of hardwareFindings) {
    console.warn(
      `[trawlarr] hardware.available declares "${finding.hardwareType}", but ffmpeg at ` +
        `"${settings.getBinaries().ffmpeg}" does not list "${finding.expectedEncoder}". Jobs ` +
        `routed to that hardware will fail. In Docker this usually means ` +
        `NVIDIA_DRIVER_CAPABILITIES does not include "video".`,
    );
  }
```

Pass `hardwareFindings` into `createApiContext`, add it to `ApiContext`, and include it in `GET /system/version`'s body as `hardware: ctx.hardwareFindings`.

- [ ] **Step 6: Write `docker/compose.nvidia.yml`**

```yaml
services:
  trawlarr:
    image: ghcr.io/rgregg/trawlarr:latest
    container_name: trawlarr
    restart: unless-stopped
    runtime: nvidia
    ports:
      - '8265:8265'
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - NUMBER_OF_WORKERS=2
      - SCHEDULE_FULL_SCAN_MINUTES=60
      - RUN_FULL_SCAN_ON_START=true
      - NVIDIA_VISIBLE_DEVICES=all
      # `video` is the capability that injects libnvidia-encode. The default
      # (compute,utility) does NOT, and hevc_nvenc then fails at run time
      # with an error that names nothing useful.
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
      - TRAWLARR_HARDWARE=cpu,nvenc
      # Consumer NVIDIA cards cap concurrent NVENC sessions and FAIL jobs past
      # the cap rather than queueing them. Set this to your card's limit.
      - TRAWLARR_HARDWARE_CAPS=nvenc=2
    volumes:
      - ./config:/config
      - /srv/media:/library
```

- [ ] **Step 7: Document it**

Add a "NVIDIA / NVENC" section to `docs/deployment.md`: the compose file, the `video` capability trap stated as a consequence, how to confirm (`docker exec trawlarr ffmpeg -hide_banner -encoders | grep nvenc`, and `GET /api/v1/system/version` whose `hardware` array is empty when every declaration checks out), and the session-cap reasoning behind `TRAWLARR_HARDWARE_CAPS`.

- [ ] **Step 8: Verify on real hardware if available**

If a machine with an NVIDIA GPU is at hand: bring the stack up with `docker compose -f docker/compose.nvidia.yml up -d`, then `curl -fsS -H "X-Api-Key: $KEY" http://localhost:8265/api/v1/system/version | jq .hardware` — expected `[]`. Then deliberately remove `video` from `NVIDIA_DRIVER_CAPABILITIES`, restart, and expect one finding naming `hevc_nvenc`. If no GPU is available, say so in the commit message rather than claiming it was checked.

- [ ] **Step 9: Run the gate and commit**

```bash
nvm use 22 && tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add docker/compose.nvidia.yml packages/server/src/daemon/hardware-preflight.ts \
  packages/server/src/daemon/hardware-preflight.test.ts packages/server/src/daemon/daemon.ts \
  packages/server/src/api docs/deployment.md
git commit -m "feat(docker): NVIDIA compose variant, and a preflight that names a false hardware declaration"
```

---

## Task 5: Per-job log files on disk, and a pid on `job.started`

`job.log_path` is a column nothing has ever written, and `GET /jobs/:id/log` returns a named 501. What exists is each step's `logExcerpt` in `job_step` and live `job.log` frames on the WebSocket — both capped, neither durable.

**The log file is written by the worker agent process, not by the daemon.** The case where the log matters most is the one where the worker dies: an OOM kill during a four-hour transcode. A daemon writing from IPC frames has only the lines that crossed the channel before the kill; the agent's own appends are already on disk. Writing a file is not opening the database, so the rule that `runPayload` reaches no database is untouched — the daemon allocates the *path* and records it on the job row at start, so the log of a worker that vanished is still findable.

**Files:**
- Create: `packages/server/src/job-log/job-log-store.ts`
- Create: `packages/server/src/job-log/job-log-store.test.ts`
- Create: `packages/server/src/job-log/job-log-writer.ts`
- Create: `packages/server/src/job-log/job-log-writer.test.ts`
- Modify: `packages/server/src/worker/job-payload.ts`
- Modify: `packages/server/src/worker/run-payload.ts`
- Modify: `packages/server/src/db/job-repo.ts`
- Modify: `packages/server/src/api/routes/jobs.ts`
- Modify: `packages/server/src/daemon/daemon.ts`
- Modify: `packages/server/src/daemon/events.ts`
- Modify: `packages/server/src/daemon/supervisor.ts`
- Modify: `packages/server/src/api/ws.test.ts`

**Interfaces:**
- Consumes: `JobPayload` (`packages/server/src/worker/job-payload.ts`); `JobRepo.start` (`packages/server/src/db/job-repo.ts`); `TrawlarrEvent` (`packages/server/src/daemon/events.ts`).
- Produces:
  - `export const JOB_LOG_MAX_BYTES = 5 * 1024 * 1024`
  - `export const JOB_LOG_RETENTION_DAYS = 14`
  - `export const jobLogPath(input: { dataDir: string; jobId: string }): string` — `<dataDir>/logs/jobs/<jobId>.log`
  - `export const sweepJobLogs(input: { dataDir: string; nowMs: number; retentionDays?: number }): Promise<{ removed: number; bytesFreed: number }>`
  - `export interface JobLogWriter { append(text: string): void; close(): void }`
  - `export const createJobLogWriter(input: { path: string; maxBytes?: number }): JobLogWriter`
  - `JobPayload` gains `logPath: string | null`.
  - `JobRepo.start`'s `StartJobInput` gains `logPath: string | null`, written to `job.log_path`.
  - The `job.started` event gains `pid: number | null`.

- [ ] **Step 1: Write the failing writer test**

Create `packages/server/src/job-log/job-log-writer.test.ts`:

```ts
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJobLogWriter } from './job-log-writer.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'trawlarr-joblog-'));

describe('createJobLogWriter', () => {
  it('writes appended lines to the file', () => {
    const path = join(scratch(), 'job.log');
    const writer = createJobLogWriter({ path });
    writer.append('first');
    writer.append('second');
    writer.close();

    expect(readFileSync(path, 'utf8')).toBe('first\nsecond\n');
  });

  it('stops at the cap and says so in the file itself', () => {
    const path = join(scratch(), 'job.log');
    const writer = createJobLogWriter({ path, maxBytes: 64 });
    for (let i = 0; i < 200; i += 1) writer.append(`line ${String(i)} padding padding padding`);
    writer.close();

    const size = statSync(path).size;
    // A runaway plugin must not fill the disk; the cap is a hard byte bound
    // plus one truncation notice, so a reader knows the tail is missing.
    expect(size).toBeLessThan(64 + 200);
    expect(readFileSync(path, 'utf8')).toContain('log truncated at 64 bytes');
  });

  it('creates the parent directory rather than failing the job', () => {
    const path = join(scratch(), 'nested', 'deeper', 'job.log');
    const writer = createJobLogWriter({ path });
    writer.append('hello');
    writer.close();
    expect(readFileSync(path, 'utf8')).toBe('hello\n');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/server/src/job-log/job-log-writer.test.ts`
Expected: FAIL — `Cannot find module './job-log-writer.js'`.

- [ ] **Step 3: Write the writer**

Create `packages/server/src/job-log/job-log-writer.ts`:

```ts
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Five megabytes per job. Large enough for an hour of verbose ffmpeg
 * progress, small enough that a plugin logging in a loop costs one file
 * rather than the volume.
 */
export const JOB_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface JobLogWriter {
  append(text: string): void;
  close(): void;
}

/**
 * A synchronous, capped, append-only writer for one job's log.
 *
 * SYNCHRONOUS ON PURPOSE. This runs inside the worker agent, whose most
 * important log line is the last one before it is killed — an OOM kill
 * during a long transcode is the realistic case, and buffered async writes
 * are exactly the lines that would be lost. `writeSync` to an `a`-mode
 * descriptor is durable enough for that: the kernel keeps the data across a
 * process death, which is the death this is defending against.
 */
export const createJobLogWriter = (input: { path: string; maxBytes?: number }): JobLogWriter => {
  const maxBytes = input.maxBytes ?? JOB_LOG_MAX_BYTES;
  mkdirSync(dirname(input.path), { recursive: true });
  const fd = openSync(input.path, 'a');
  let written = 0;
  let truncated = false;
  let closed = false;

  return {
    append: (text) => {
      if (closed || truncated) return;
      const line = Buffer.from(`${text}\n`, 'utf8');
      if (written + line.byteLength > maxBytes) {
        truncated = true;
        writeSync(fd, Buffer.from(`--- log truncated at ${String(maxBytes)} bytes ---\n`, 'utf8'));
        return;
      }
      writeSync(fd, line);
      written += line.byteLength;
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
};
```

- [ ] **Step 4: Run it and watch it pass**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/src/job-log/job-log-writer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing store test**

Create `packages/server/src/job-log/job-log-store.test.ts`:

```ts
import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobLogPath, sweepJobLogs } from './job-log-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('jobLogPath', () => {
  it('is one file per job under the data directory', () => {
    expect(jobLogPath({ dataDir: '/config', jobId: 'job-1' })).toBe('/config/logs/jobs/job-1.log');
  });
});

describe('sweepJobLogs', () => {
  const seed = (): { dataDir: string; nowMs: number } => {
    const dataDir = mkdtempSync(join(tmpdir(), 'trawlarr-logsweep-'));
    const dir = join(dataDir, 'logs', 'jobs');
    mkdirSync(dir, { recursive: true });
    const nowMs = Date.UTC(2026, 7, 20, 12, 0, 0);

    for (const [name, ageDays] of [
      ['old.log', 30],
      ['edge.log', 14],
      ['fresh.log', 1],
    ] as const) {
      const path = join(dir, name);
      writeFileSync(path, 'x'.repeat(100));
      const seconds = (nowMs - ageDays * DAY_MS) / 1000;
      utimesSync(path, seconds, seconds);
    }
    writeFileSync(join(dir, 'notes.txt'), 'not ours');
    return { dataDir, nowMs };
  };

  it('removes logs past the retention and keeps the rest', async () => {
    const { dataDir, nowMs } = seed();
    const result = await sweepJobLogs({ dataDir, nowMs, retentionDays: 14 });

    const dir = join(dataDir, 'logs', 'jobs');
    expect(existsSync(join(dir, 'old.log'))).toBe(false);
    // Exactly at the boundary is KEPT — the same rule the trash sweep uses.
    expect(existsSync(join(dir, 'edge.log'))).toBe(true);
    expect(existsSync(join(dir, 'fresh.log'))).toBe(true);
    expect(result).toEqual({ removed: 1, bytesFreed: 100 });
  });

  it('never touches a file it did not name', async () => {
    const { dataDir, nowMs } = seed();
    await sweepJobLogs({ dataDir, nowMs: nowMs + 365 * DAY_MS, retentionDays: 1 });
    expect(existsSync(join(dataDir, 'logs', 'jobs', 'notes.txt'))).toBe(true);
  });

  it('reports zero rather than throwing when the directory does not exist', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'trawlarr-logsweep-empty-'));
    expect(await sweepJobLogs({ dataDir, nowMs: Date.now() })).toEqual({
      removed: 0,
      bytesFreed: 0,
    });
  });
});
```

- [ ] **Step 6: Write the store**

Create `packages/server/src/job-log/job-log-store.ts`:

```ts
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const JOB_LOG_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One file per job, named by job id, under the data directory (spec 3.4). */
export const jobLogPath = (input: { dataDir: string; jobId: string }): string =>
  join(input.dataDir, 'logs', 'jobs', `${input.jobId}.log`);

/**
 * Drop job logs older than the retention.
 *
 * ONLY `*.log` ENTRIES ARE CONSIDERED, on the same principle as the trash
 * sweep: a directory trawlarr writes into may also contain something a human
 * put there, and a sweep that deletes what it did not create is a sweep
 * nobody can trust with a path. An entry exactly at the boundary is kept.
 */
export const sweepJobLogs = async (input: {
  dataDir: string;
  nowMs: number;
  retentionDays?: number;
}): Promise<{ removed: number; bytesFreed: number }> => {
  const dir = join(input.dataDir, 'logs', 'jobs');
  const cutoff = input.nowMs - (input.retentionDays ?? JOB_LOG_RETENTION_DAYS) * DAY_MS;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0, bytesFreed: 0 };
  }

  let removed = 0;
  let bytesFreed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoff) continue;
      await rm(path, { force: true });
      removed += 1;
      bytesFreed += info.size;
    } catch {
      // One unreadable log must not cost the others their sweep.
    }
  }
  return { removed, bytesFreed };
};
```

- [ ] **Step 7: Run both store tests and watch them pass**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/src/job-log/`
Expected: PASS, 7 tests total.

- [ ] **Step 8: Thread the path through the payload, the agent and the row**

1. `packages/server/src/worker/job-payload.ts`: add `logPath: string | null;` to `JobPayload`, add `dataDir: string` to `BuildJobPayloadInput`, and populate `logPath: jobLogPath({ dataDir: input.dataDir, jobId: input.jobId })`.
2. `packages/server/src/db/job-repo.ts`: add `logPath: string | null` to `StartJobInput` and write it into the `INSERT INTO job (...)` column list as `log_path`.
3. `packages/server/src/worker/run-payload.ts`: at the top of the run, when `payload.logPath !== null`, `const log = createJobLogWriter({ path: payload.logPath })`; append every line the existing `jobLog` seam receives and every step boundary (`--- step <seq>: <pluginId> ---`); `log.close()` in a `finally`. Do **not** remove the existing `logExcerpt` capture — the excerpt is what `GET /jobs/:id` returns and what the step trace shows.
4. `packages/server/src/daemon/supervisor.ts`: pass the daemon's `dataDir` into `buildJobPayload`, and pass `logPath` to `jobRepo.start`.

- [ ] **Step 9: Serve the log**

Replace the `notImplemented` handler for `GET /jobs/:id/log` in `packages/server/src/api/routes/jobs.ts`, adding `import { readFile } from 'node:fs/promises';` and `import { JOB_LOG_RETENTION_DAYS } from '../../job-log/job-log-store.js';` at the top of the file:

```ts
  {
    method: 'GET',
    path: '/jobs/:id/log',
    handler: async ({ params, ctx }) => {
      const job = createJobRepo(ctx.db).getById(params.id!);
      if (job === null) throw new ApiError(404, 'job-not-found', `No job with id "${params.id!}".`);
      if (job.logPath === null) {
        throw new ApiError(
          404,
          'job-log-absent',
          `Job "${job.id}" has no log file. Jobs recorded before per-job logs existed have ` +
            `none; each step's log excerpt is still on GET /api/v1/jobs/${job.id}.`,
        );
      }
      try {
        return { jobId: job.id, path: job.logPath, text: await readFile(job.logPath, 'utf8') };
      } catch {
        // A swept log is a NAMED absence, never an empty string: an empty
        // log and a deleted one must not look the same to a reader.
        throw new ApiError(
          410,
          'job-log-expired',
          `Job "${job.id}" recorded a log at "${job.logPath}", but it is no longer on disk — ` +
            `job logs are kept for ${String(JOB_LOG_RETENTION_DAYS)} days.`,
        );
      }
    },
  },
```

- [ ] **Step 10: Sweep on the existing daily timer, and add the pid**

In `daemon.ts`, inside the same re-armed 24-hour callback that calls `sweepLibraryTrash`, add `await sweepJobLogs({ dataDir, nowMs: nowMs() })` — inside the same `try`, so one failure costs one interval and the timer still re-arms in its `finally`.

In `packages/server/src/daemon/events.ts`, add `pid: number | null;` to the `job.started` variant. In `supervisor.ts`, emit the forked agent handle's `pid`. This closes the gap the P2b end-to-end suite named: its "no orphaned worker" check samples pids from `GET /workers` every 25 ms and misses a worker that starts and finishes between samples.

- [ ] **Step 11: Write the end-to-end assertion**

Append to `packages/server/test/daemon-end-to-end.test.ts` — inside the existing real-ffmpeg suite, after a job completes:

```ts
    const job = (await api<{ items: Array<{ id: string; logPath: string | null }> }>('/jobs'))
      .items[0]!;
    expect(job.logPath).not.toBeNull();
    // Bytes on disk, not a status code: the point of this feature is that the
    // log survives the process that wrote it.
    expect(statSync(job.logPath!).size).toBeGreaterThan(0);

    const log = await api<{ text: string }>(`/jobs/${job.id}/log`);
    expect(log.text.length).toBeGreaterThan(0);
```

- [ ] **Step 12: Run the gate and commit**

```bash
nvm use 22 && tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git diff --stat -- packages/server/src/worker/run-job.test.ts   # must print nothing
git add packages/server/src/job-log packages/server/src/worker packages/server/src/db/job-repo.ts \
  packages/server/src/api packages/server/src/daemon packages/server/test
git commit -m "feat(server): per-job log files on disk, served and swept; pid on job.started"
```

---

## Task 6: Flow templates, and the migration guide from Unmanic

Spec §3.5 lists templates under the Flows group and §6.3 makes them the front door: "they pick a template, answer three or four plain questions, and are done". Nothing implements them, so today the only way to get a flow is to hand-author a JSON graph — which is not a migration path.

**A question for the owner gates the *content* of the template, not this task's shape.** The template built here is the typical Unmanic transcode stack: *if the video is not already the target codec, transcode it with the chosen encoder and quality, verify the output, and replace the original, keeping the original in trash for 14 days.* Every question in the list at the end of this plan changes only which parameters the template exposes or which nodes it strings together, and both are localised to `TEMPLATES` in one file.

**Honest constraint, and it must go in the migration guide rather than being discovered:** the first-party plugin set is seven nodes — Start, Check Video Codec, Begin Command, Set Video Encoder, Execute, Verify Output, Replace Original File. There is **no** first-party node yet for remuxing a container, setting an audio codec, stripping tracks by language, moving a file, or notifying a webhook. An Unmanic stack that does any of those needs either a community plugin (which needs plugin source syncing — deferred, see the deferrals section) or a new first-party node (a separate piece of work). The guide must say which of the owner's steps trawlarr can reproduce today and which it cannot, rather than implying parity.

**Files:**
- Create: `packages/server/src/flow/templates.ts`
- Create: `packages/server/src/flow/templates.test.ts`
- Create: `docs/migrating-from-unmanic.md`
- Modify: `packages/server/src/api/routes/flows.ts`
- Modify: `packages/server/src/cli.ts`

**Interfaces:**
- Consumes: `FlowDefinition`, `validateFlowDefinition` from `@trawlarr/core`; `createNodeCapabilityResolver` from `packages/server/src/flow/node-capabilities.ts`; `createFlowRepo` from `packages/server/src/db/flow-repo.ts`.
- Produces:
  - `export interface FlowTemplateParameter { name: string; label: string; type: 'string'; defaultValue: string; options?: string[]; tooltip: string }`
  - `export interface FlowTemplate { id: string; name: string; description: string; parameters: FlowTemplateParameter[]; build(values: Record<string, string>): FlowDefinition }`
  - `export const FLOW_TEMPLATES: readonly FlowTemplate[]`
  - `export const buildFromTemplate(input: { templateId: string; values: Record<string, string> }): FlowDefinition`
  - `export class UnknownTemplateError extends Error`
  - `GET /api/v1/flows/templates` → `Array<{id, name, description, parameters}>`
  - `POST /api/v1/flows` additionally accepts `{name, templateId, templateValues}` in place of `{name, definition}`.
  - `trawlarr flow add --name <n> --template <id> [--set key=value ...]`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/flow/templates.test.ts`:

```ts
import { validateFlowDefinition } from '@trawlarr/core';
import { describe, expect, it } from 'vitest';
import { createNodeCapabilityResolver } from './node-capabilities.js';
import { buildFromTemplate, FLOW_TEMPLATES, UnknownTemplateError } from './templates.js';

describe('FLOW_TEMPLATES', () => {
  it('includes the Unmanic-equivalent transcode stack', () => {
    expect(FLOW_TEMPLATES.map((template) => template.id)).toContain('transcode-hevc');
  });

  it.each(FLOW_TEMPLATES.map((template) => template.id))(
    'template %s builds a definition the executor will accept, with its defaults',
    (id) => {
      const template = FLOW_TEMPLATES.find((candidate) => candidate.id === id)!;
      const values = Object.fromEntries(
        template.parameters.map((p) => [p.name, p.defaultValue] as const),
      );
      const problems = validateFlowDefinition(
        buildFromTemplate({ templateId: id, values }),
        createNodeCapabilityResolver(),
      );
      // A template that produces an invalid flow is worse than no template:
      // it pauses the library it is attached to, with a reason naming a node
      // the user never chose.
      expect(problems).toEqual([]);
    },
  );

  it('puts the chosen encoder and quality into the Set Video Encoder node', () => {
    const definition = buildFromTemplate({
      templateId: 'transcode-hevc',
      values: { targetCodec: 'hevc', encoder: 'hevc_nvenc', quality: '22', trashRetentionDays: '7' },
    });
    const encoder = definition.nodes.find((node) => node.id === 'encoder')!;
    expect(encoder.inputs).toEqual({ encoder: 'hevc_nvenc', quality: '22' });
    const check = definition.nodes.find((node) => node.id === 'check')!;
    expect(check.inputs).toEqual({ codec: 'hevc' });
    const replace = definition.nodes.find((node) => node.id === 'replace')!;
    expect(replace.inputs).toEqual({ trashRetentionDays: '7', allowCrossDevice: 'true' });
  });

  it('routes an already-converged file to nothing, and a mismatched one to the transcode', () => {
    const definition = buildFromTemplate({
      templateId: 'transcode-hevc',
      values: { targetCodec: 'hevc', encoder: 'libx265', quality: '24', trashRetentionDays: '14' },
    });
    // Check Video Codec output 1 is "already this codec" and MUST be a dead
    // end: an edge there would transcode files that are already correct, for
    // ever. Output 2 is "differs" and is the working path.
    expect(definition.edges.filter((edge) => edge.fromNodeId === 'check')).toEqual([
      { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
    ]);
  });

  it('refuses an unknown template by name', () => {
    expect(() => buildFromTemplate({ templateId: 'nope', values: {} })).toThrow(
      UnknownTemplateError,
    );
  });

  it('falls back to a parameter default rather than emitting an empty input', () => {
    const definition = buildFromTemplate({ templateId: 'transcode-hevc', values: {} });
    expect(definition.nodes.find((node) => node.id === 'encoder')!.inputs).toEqual({
      encoder: 'libx265',
      quality: '24',
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/server/src/flow/templates.test.ts`
Expected: FAIL — `Cannot find module './templates.js'`.

- [ ] **Step 3: Write the templates**

Create `packages/server/src/flow/templates.ts`:

```ts
import type { FlowDefinition } from '@trawlarr/core';

export interface FlowTemplateParameter {
  name: string;
  label: string;
  type: 'string';
  defaultValue: string;
  options?: string[];
  tooltip: string;
}

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  parameters: FlowTemplateParameter[];
  build(values: Record<string, string>): FlowDefinition;
}

export class UnknownTemplateError extends Error {
  constructor(templateId: string, known: string[]) {
    super(
      `No flow template "${templateId}". Available templates: ${known.join(', ')}. List them ` +
        `with GET /api/v1/flows/templates.`,
    );
    this.name = 'UnknownTemplateError';
  }
}

const PLUGIN_VERSION = '1.0.0';

const transcodeParameters: FlowTemplateParameter[] = [
  {
    name: 'targetCodec',
    label: 'Target video codec',
    type: 'string',
    defaultValue: 'hevc',
    options: ['hevc', 'h264', 'av1'],
    tooltip:
      'A file whose video already uses this codec is left alone. This is the test that stops ' +
      'the flow re-encoding what it has already converted.',
  },
  {
    name: 'encoder',
    label: 'Encoder',
    type: 'string',
    defaultValue: 'libx265',
    options: ['libx265', 'libx264', 'hevc_nvenc', 'h264_nvenc', 'hevc_qsv', 'hevc_vaapi'],
    tooltip:
      'The ffmpeg encoder that produces the target codec. A hardware encoder requires that ' +
      'hardware to be declared on this node AND present in the ffmpeg build.',
  },
  {
    name: 'quality',
    label: 'Quality',
    type: 'string',
    defaultValue: '24',
    tooltip:
      'Lower is better quality and larger files; 20–24 is usually visually lossless. The flag ' +
      'this becomes (-crf, -cq, -qp, -global_quality) depends on the encoder and is chosen for ' +
      'you.',
  },
  {
    name: 'trashRetentionDays',
    label: 'Keep replaced originals for (days)',
    type: 'string',
    defaultValue: '14',
    tooltip:
      'Replaced originals move to <library root>/.trawlarr/trash and are purged after this ' +
      'many days. This is what every mistake is recoverable from; shorten it deliberately.',
  },
];

/**
 * The stack a typical Unmanic transcode library runs, expressed in trawlarr's
 * own nodes: skip what is already the target codec, otherwise build one
 * ffmpeg command, encode, verify the result, and replace the original with
 * the old one kept in trash.
 *
 * `Check Video Codec` output 1 ("already this codec") DELIBERATELY HAS NO
 * OUTGOING EDGE. Routing it anywhere that leads to Execute would re-encode
 * converged files for ever — the failure mode trawlarr's convergence ledger
 * exists to make visible, and one a template must not create.
 */
const transcodeHevc: FlowTemplate = {
  id: 'transcode-hevc',
  name: 'Transcode video to a target codec',
  description:
    'Transcode any file whose video is not already the target codec, verify the result, and ' +
    'replace the original. The equivalent of a standard Unmanic transcode stack.',
  parameters: transcodeParameters,
  build: (values) => {
    const value = (name: string): string =>
      values[name] ?? transcodeParameters.find((p) => p.name === name)!.defaultValue;

    return {
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: PLUGIN_VERSION, inputs: {} },
        {
          id: 'check',
          pluginId: 'trawlarr:checkVideoCodec',
          pluginVersion: PLUGIN_VERSION,
          inputs: { codec: value('targetCodec') },
        },
        {
          id: 'begin',
          pluginId: 'trawlarr:beginCommand',
          pluginVersion: PLUGIN_VERSION,
          inputs: {},
        },
        {
          id: 'encoder',
          pluginId: 'trawlarr:setVideoEncoder',
          pluginVersion: PLUGIN_VERSION,
          inputs: { encoder: value('encoder'), quality: value('quality') },
        },
        { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: PLUGIN_VERSION, inputs: {} },
        {
          id: 'verify',
          pluginId: 'trawlarr:verifyOutput',
          pluginVersion: PLUGIN_VERSION,
          inputs: { durationToleranceSeconds: '1', minSizeRatio: '0.05' },
        },
        {
          id: 'replace',
          pluginId: 'trawlarr:replaceOriginal',
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            trashRetentionDays: value('trashRetentionDays'),
            allowCrossDevice: 'true',
          },
        },
      ],
      edges: [
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
        { fromNodeId: 'check', outputNumber: 2, toNodeId: 'begin' },
        { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'encoder' },
        { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'execute' },
        { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
        { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
      ],
    };
  },
};

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [transcodeHevc];

export const buildFromTemplate = (input: {
  templateId: string;
  values: Record<string, string>;
}): FlowDefinition => {
  const template = FLOW_TEMPLATES.find((candidate) => candidate.id === input.templateId);
  if (template === undefined) {
    throw new UnknownTemplateError(
      input.templateId,
      FLOW_TEMPLATES.map((candidate) => candidate.id),
    );
  }
  return template.build(input.values);
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/src/flow/templates.test.ts`
Expected: PASS, 7 tests (the `it.each` contributes one per template).

- [ ] **Step 5: Expose templates on the API**

In `packages/server/src/api/routes/flows.ts`:

Add the listing route **before** `/flows/:id` in the array (matching is by specificity, so order is documentation only — but keep the file readable):

```ts
  {
    method: 'GET',
    path: '/flows/templates',
    handler: () =>
      FLOW_TEMPLATES.map(({ id, name, description, parameters }) => ({
        id,
        name,
        description,
        parameters,
      })),
  },
```

And in the existing `POST /flows` handler, accept a template in place of a definition:

```ts
      const patch = body as Record<string, unknown>;
      const definition =
        typeof patch.templateId === 'string'
          ? buildFromTemplate({
              templateId: patch.templateId,
              values: (patch.templateValues as Record<string, string> | undefined) ?? {},
            })
          : requireDefinition(body);
```

wrapping the `buildFromTemplate` call so `UnknownTemplateError` becomes `throw new ApiError(400, 'unknown-template', error.message)`.

- [ ] **Step 6: Write the API test**

Append to `packages/server/src/api/api.test.ts`:

```ts
  it('creates a flow from a template', async () => {
    const harness = createHarness();
    const response = await harness.post('/api/v1/flows', {
      name: 'Movies HEVC',
      templateId: 'transcode-hevc',
      templateValues: { encoder: 'hevc_nvenc', quality: '22' },
    });

    expect(response.status).toBe(201);
    // The stored row, not the echo: a template that validated and did not
    // persist would look identical here.
    const stored = await harness.get(`/api/v1/flows/${response.body.id}`);
    expect(stored.body.definition.nodes.find((n) => n.id === 'encoder').inputs).toEqual({
      encoder: 'hevc_nvenc',
      quality: '22',
    });
    expect(stored.body.definitionHash).toBe(response.body.definitionHash);
  });

  it('refuses an unknown template by name', async () => {
    const harness = createHarness();
    const response = await harness.post('/api/v1/flows', { name: 'x', templateId: 'nope' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('unknown-template');
  });
```

- [ ] **Step 7: Add the CLI path**

In `packages/server/src/cli.ts`, extend `cmdFlowAdd`'s `parseArgs` options with `template: { type: 'string' }` and `set: { type: 'string', multiple: true }`, parse each `--set key=value` into a `Record<string, string>`, and when `--template` is given, build the definition with `buildFromTemplate` instead of reading `--file`. Add the form to `USAGE`:

```
  trawlarr flow add --name <name> --template transcode-hevc [--set encoder=hevc_nvenc] [--set quality=22]
```

Keep the daemon-client branch working: when a daemon owns the directory, POST `{name, templateId, templateValues}` rather than opening the database.

- [ ] **Step 8: Write `docs/migrating-from-unmanic.md`**

Sections, in this order:

1. **What is the same** — `PUID`/`PGID`/`TZ`, `/config` for state, a bind-mounted library, `NUMBER_OF_WORKERS`, `SCHEDULE_FULL_SCAN_MINUTES`, `RUN_FULL_SCAN_ON_START`, `runtime: nvidia` with `NVIDIA_VISIBLE_DEVICES`. Side-by-side compose snippets.
2. **What is different, and why** — four items, each stated as a consequence:
   - *No cache/staging mount.* Unmanic stages into a cache directory that is often on another disk. Trawlarr stages inside the library so replacement is an atomic rename; putting staging elsewhere degrades every replacement to a copy. Delete the cache volume from your compose file; do not translate it.
   - *A flow, not a plugin list.* Unmanic runs an ordered plugin stack per file. Trawlarr walks a graph and takes a branch. The equivalent of "only process files that are not already HEVC" is an explicit branch node, not a plugin that returns early.
   - *Convergence, not a queue.* Trawlarr records a signature per file and stops. There is no "process everything again" button, and there does not need to be: editing the flow changes the signature and re-queues exactly the affected files.
   - *Replacement is a node you can see.* Nothing is replaced implicitly. If your flow has no `Replace Original File`, trawlarr transcodes into staging and then throws the result away — which is a legitimate dry-run shape and a common first mistake.
3. **Step by step**: build/pull the image → write the compose file → start → read the API key from `docker logs` → open the UI → add the library → create the flow from the `transcode-hevc` template → attach it → watch the convergence percentage. Give the equivalent `curl` and `docker exec trawlarr trawlarr ...` for each, because the UI has no privileged path and that is worth demonstrating.
4. **Plugin stack mapping**, as a table with a row per common Unmanic step and an honest verdict:

   | Unmanic step | Trawlarr today | Verdict |
   | --- | --- | --- |
   | Transcode video to HEVC/H.264 | `transcode-hevc` template | Supported |
   | Skip files already in the target codec | `Check Video Codec`, output 1 left unconnected | Supported |
   | Choose NVENC/QSV/VAAPI encoder | `Set Video Encoder` + `TRAWLARR_HARDWARE` | Supported |
   | Keep the original file for N days | `Replace Original File` → library trash | Supported |
   | Verify the output before replacing | `Verify Output` | Supported (duration, stream count, size sanity) |
   | Remux to a different container | — | **Not yet.** Needs a first-party remux node or a community plugin. |
   | Transcode/normalise audio, strip tracks by language | — | **Not yet.** Same. |
   | Move/copy the result to another directory | — | **Not yet.** Same. |
   | Notify a webhook / Discord | — | **Not yet.** Same. |
   | Any community Unmanic plugin | — | **Not applicable.** Trawlarr runs *Tdarr flow* plugins, not Unmanic plugins. Unmanic plugins cannot be imported. |

5. **Before you point it at everything** — start with one small library, or a copy; confirm the first few files land correctly and the trash contains their originals; only then widen the roots. Note that hardlinked files are skipped by default and that this is usually what someone with a seeding library wants.

- [ ] **Step 9: Run the gate and commit**

```bash
nvm use 22 && tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/flow/templates.ts packages/server/src/flow/templates.test.ts \
  packages/server/src/api packages/server/src/cli.ts docs/migrating-from-unmanic.md
git commit -m "feat(server): flow templates, and a documented migration path from Unmanic"
```

---

## Task 7: Serve the web bundle from the daemon's own port

One port to publish, one thing to reverse-proxy, one origin — which is also what lets the UI send its API key as a header without any cross-origin machinery.

This lands **before** the UI exists, so that the handler's behaviour when the bundle is absent is designed rather than discovered: a source checkout that has not run the web build must say so, not return a bare 404 that reads like a broken route.

**Files:**
- Create: `packages/server/src/api/static-files.ts`
- Create: `packages/server/src/api/static-files.test.ts`
- Modify: `packages/server/src/api/server.ts`

**Interfaces:**
- Consumes: `createApiHandler` (`packages/server/src/api/server.ts`), `API_PREFIX` (`packages/server/src/api/router.ts`).
- Produces:
  - `export const resolveWebRoot(input?: { override?: string }): string | null` — the built bundle's directory, or `null` when it is not present.
  - `export const createStaticHandler(input: { root: string | null }): (req: IncomingMessage, res: ServerResponse) => boolean` — returns `true` when it answered the request, `false` when the caller should fall through.
  - `CreateApiHandlerOptions` gains `webRoot?: string | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/static-files.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStaticHandler } from './static-files.js';
import { requestOf, responseOf } from './test-doubles.js';

const bundle = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-web-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>trawlarr</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  return root;
};

describe('createStaticHandler', () => {
  it('serves index.html at the root', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('GET', '/'), res)).toBe(true);
    expect(await res.settled).toMatchObject({ status: 200, body: expect.stringContaining('<!doctype html>') });
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('serves an asset with its own content type', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('GET', '/assets/app.js'), res)).toBe(true);
    expect((await res.settled).body).toBe('console.log(1)');
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('falls back to index.html for a client-side route', async () => {
    const handler = createStaticHandler({ root: bundle() });
    const res = responseOf();
    expect(handler(requestOf('GET', '/libraries/abc'), res)).toBe(true);
    expect((await res.settled).body).toContain('<!doctype html>');
  });

  it('never answers an /api/v1 path', () => {
    const handler = createStaticHandler({ root: bundle() });
    // The API must reach its own router even for a path the bundle happens
    // to contain, or a file named `system` would shadow an endpoint.
    expect(handler(requestOf('GET', '/api/v1/system/health'), responseOf())).toBe(false);
  });

  it('refuses a traversal attempt instead of reading outside the bundle', async () => {
    const root = bundle();
    writeFileSync(join(root, '..', 'secret.txt'), 'nope');
    const handler = createStaticHandler({ root });
    const res = responseOf();
    handler(requestOf('GET', '/../secret.txt'), res);
    const settled = await res.settled;
    expect(settled.body ?? '').not.toContain('nope');
  });

  it('explains itself when the bundle was never built', async () => {
    const handler = createStaticHandler({ root: null });
    const res = responseOf();
    expect(handler(requestOf('GET', '/'), res)).toBe(true);
    const settled = await res.settled;
    expect(settled.status).toBe(503);
    expect(JSON.parse(settled.body!).error.code).toBe('web-ui-not-built');
  });
});
```

`requestOf`/`responseOf` are minimal `IncomingMessage`/`ServerResponse` doubles. If `packages/server/src/api/` already has equivalents in `api.test.ts`, extract them to `packages/server/src/api/test-doubles.ts` as part of this task and import them from both files; otherwise create that file with a `writeHead`/`end`-recording double exposing `headers` and a `settled: Promise<{status: number; body: string | null}>`.

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/server/src/api/static-files.test.ts`
Expected: FAIL — `Cannot find module './static-files.js'`.

- [ ] **Step 3: Write the handler**

Create `packages/server/src/api/static-files.ts`:

```ts
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PREFIX } from './router.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const NOT_BUILT = JSON.stringify({
  error: {
    code: 'web-ui-not-built',
    message:
      'The web UI is not present in this installation. The Docker image ships it; a source ' +
      'checkout builds it with "pnpm build". The REST API at /api/v1 is unaffected and the ' +
      '"trawlarr" CLI works exactly as before.',
  },
});

/**
 * Where the built bundle lives, or `null` if it was never built.
 *
 * Two candidates, in order: the path handed in (the image sets it), then
 * `@trawlarr/web`'s `dist` relative to this file in a source checkout. `null`
 * rather than a throw, because a headless install that never wants a UI is a
 * legitimate deployment and must still start.
 */
export const resolveWebRoot = (input?: { override?: string }): string | null => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    input?.override,
    resolve(here, '../../../web/dist'),
    resolve(here, '../../web/dist'),
  ].filter((candidate): candidate is string => candidate !== undefined);

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
};

/**
 * Serve the single-page bundle, and NOTHING under {@link API_PREFIX}.
 *
 * The API-prefix check comes first and is unconditional: a bundle that
 * happened to contain a file called `api` would otherwise shadow the entire
 * REST surface, and the failure would look like the daemon losing its
 * endpoints. Unknown paths fall back to `index.html` because client-side
 * routes are not files; a request for a path that LOOKS like an asset (it
 * has an extension) 404s instead, so a missing chunk is reported as missing
 * rather than served an HTML page the browser cannot parse as JavaScript.
 */
export const createStaticHandler = (input: {
  root: string | null;
}): ((req: IncomingMessage, res: ServerResponse) => boolean) => {
  const { root } = input;

  return (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) return false;
    if (method !== 'GET' && method !== 'HEAD') return false;

    if (root === null) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(NOT_BUILT)),
      });
      res.end(NOT_BUILT);
      return true;
    }

    // `normalize` collapses `..` BEFORE the join, and the prefix check
    // catches anything that still escaped. Serving one file outside the
    // bundle is serving the whole filesystem.
    const requested = normalize(join(root, decodeURIComponent(pathname)));
    const inside = requested === root || requested.startsWith(root + sep);
    const isFile = inside && existsSync(requested) && statSync(requested).isFile();

    if (!isFile && extname(pathname) !== '') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return true;
    }

    const file = isFile ? requested : join(root, 'index.html');
    const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    // `index.html` must never be cached: it names the hashed asset bundle,
    // and a stale copy points a browser at chunks an upgrade deleted.
    const cache = file.endsWith('index.html')
      ? 'no-store'
      : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'content-type': type, 'cache-control': cache });
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  };
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/src/api/static-files.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mount it beneath the API**

In `packages/server/src/api/server.ts`, add `webRoot?: string | null` to `CreateApiHandlerOptions`, build the static handler once in `createApiHandler`, and consult it **first** inside the returned function — it returns `false` for every `/api/v1` path, so the API is unreachable only by a bug in that one check:

```ts
  const serveStatic = createStaticHandler({
    root: options?.webRoot === undefined ? resolveWebRoot() : options.webRoot,
  });
```

```ts
  return (req, res) => {
    if (serveStatic(req, res)) return;
    void (async () => { /* ...existing body unchanged... */ })();
  };
```

- [ ] **Step 6: Prove the API still wins, against the real server**

Append to `packages/server/src/api/api.test.ts`:

```ts
  it('routes /api/v1 to the API even with a bundle mounted', async () => {
    const harness = createHarness({ webRoot: bundleWithApiShapedFile() });
    expect((await harness.get('/api/v1/system/health')).status).toBe(200);
    expect((await harness.get('/some/client/route')).status).toBe(200);
  });
```

where `bundleWithApiShapedFile()` writes a bundle containing `index.html` **and** a file at `api/v1/system/health` — the shape that would shadow the API if the prefix check were removed. Confirm the mutation: delete the `API_PREFIX` check in `static-files.ts`, re-run, and require this test to go red before restoring it.

- [ ] **Step 7: Run the gate and commit**

```bash
nvm use 22 && tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/api
git commit -m "feat(server): serve the web bundle from the daemon's own port"
```

---

## Task 8: The `@trawlarr/web` package and its API client

The UI is a client of the same REST API a shell script uses, holding the same API key, sending it in the same header. There is **no cookie, no session and no server-side login.** That is a deliberate design decision with two consequences worth stating: the spec's "no privileged path" rule stays literally true (anything the UI does, `curl` can do), and the WebSocket's existing security argument — "safe because there is NO AMBIENT AUTHORITY: no cookies, so a hostile cross-origin page has no key to send and there is no CSRF shape" — survives untouched. Introducing a cookie here would silently invalidate that reasoning.

**On spec §4.7's "optional single password":** this phase does not build one, and that is a decision rather than an omission. A password implies a session, a session implies a cookie or a token endpoint, and a cookie is exactly the ambient authority the WebSocket's security argument depends on *not* existing. The API key is already a single secret the operator holds; the UI asks for it once. If a password is wanted later it should mint an API key, not replace the mechanism.

**The build integration is where this task is most likely to go wrong**, because `packages/web` cannot join the existing TypeScript project graph on the same terms as the others: it emits with Vite rather than `tsc --build`, its `.tsx` files are not matched by the root globs, and its DOM types conflict with the base config's `types: ["node"]`. The arrangement below is deliberate:

- `packages/web` is **not** in the root `tsconfig.json` `references`, and **not** in `tsconfig.typecheck.json`'s `include`. `.tsx` and DOM code are typechecked by `packages/web`'s own `tsc --noEmit -p tsconfig.app.json`, run from its `build` script.
- `packages/web/src/**/*.test.ts` **is** added to the root `vitest.config.ts` includes, so web tests join the single gate number. Those tests must be **DOM-free** — the API client, the event reducer, formatting — which is also why components stay thin.
- `packages/web/tsconfig.json` still declares `references: [{ "path": "../plugin-api" }]`, because `pnpm check:refs` requires every workspace dependency to appear as a project reference and it reads package tsconfigs directly.
- The root `build` script gains the web build so `pnpm build` produces the bundle `resolveWebRoot` looks for.

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/tsconfig.app.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/api/client.ts`, `packages/web/src/api/client.test.ts`, `packages/web/src/api/key.ts`, `packages/web/src/api/key.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `eslint.config.js`, `.prettierignore`, `Dockerfile`

**Interfaces:**
- Consumes: the REST surface documented in Task 7 and earlier tasks.
- Produces:
  - `export class ApiClientError extends Error { readonly status: number; readonly code: string }`
  - `export interface ApiClient { get<T>(path: string): Promise<T>; post<T>(path: string, body?: unknown): Promise<T>; patch<T>(path: string, body: unknown): Promise<T>; put<T>(path: string, body: unknown): Promise<T>; del(path: string): Promise<void> }`
  - `export const createApiClient(input: { baseUrl?: string; apiKey: string; fetchImpl?: typeof fetch }): ApiClient`
  - `export const eventsUrl(input: { baseUrl?: string; apiKey: string }): string`
  - `export interface KeyStore { read(): string | null; write(key: string): void; clear(): void }`
  - `export const createKeyStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): KeyStore`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/api/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiClientError, createApiClient, eventsUrl } from './client.js';

const fetchStub = (
  reply: { status: number; body: unknown },
  calls: Array<{ url: string; init: RequestInit | undefined }> = [],
): typeof fetch =>
  (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  }) as unknown as typeof fetch;

describe('createApiClient', () => {
  it('sends the API key as a header, never as a query parameter', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createApiClient({
      apiKey: 'secret-key-1234567890',
      fetchImpl: fetchStub({ status: 200, body: [{ id: 'lib-1' }] }, calls),
    });

    await client.get('/libraries');

    expect(calls[0]!.url).toBe('/api/v1/libraries');
    expect(calls[0]!.url).not.toContain('secret-key');
    expect((calls[0]!.init!.headers as Record<string, string>)['X-Api-Key']).toBe(
      'secret-key-1234567890',
    );
  });

  it('turns the API error envelope into a typed error', async () => {
    const client = createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({
        status: 409,
        body: { error: { code: 'flow-invalid', message: 'its flow still cannot be run.' } },
      }),
    });

    await expect(client.post('/libraries/lib-1/resume')).rejects.toMatchObject({
      status: 409,
      code: 'flow-invalid',
      // The daemon's messages are written FOR a reader; the UI shows them
      // verbatim rather than substituting a generic one.
      message: 'its flow still cannot be run.',
    });
    await expect(client.post('/libraries/lib-1/resume')).rejects.toBeInstanceOf(ApiClientError);
  });

  it('reports a 401 as an unauthorised code the UI can branch on', async () => {
    const client = createApiClient({
      apiKey: 'wrong-key-000000000',
      fetchImpl: fetchStub({ status: 401, body: { error: { code: 'unauthorized', message: 'no' } } }),
    });
    await expect(client.get('/libraries')).rejects.toMatchObject({ status: 401 });
  });

  it('returns nothing for a 204', async () => {
    const client = createApiClient({
      apiKey: 'k'.repeat(20),
      fetchImpl: fetchStub({ status: 204, body: null }),
    });
    await expect(client.del('/flows/flow-1')).resolves.toBeUndefined();
  });
});

describe('eventsUrl', () => {
  it('puts the key in the query string, because a browser cannot set upgrade headers', () => {
    const url = new URL(eventsUrl({ baseUrl: 'http://host:8265', apiKey: 'abc' }));
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/api/v1/events');
    expect(url.searchParams.get('apiKey')).toBe('abc');
  });

  it('uses wss when the page is served over https', () => {
    expect(eventsUrl({ baseUrl: 'https://host', apiKey: 'abc' })).toMatch(/^wss:/);
  });
});
```

And `packages/web/src/api/key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createKeyStore } from './key.js';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

describe('createKeyStore', () => {
  it('round-trips a key', () => {
    const store = createKeyStore(memoryStorage());
    expect(store.read()).toBeNull();
    store.write('secret-key-1234567890');
    expect(store.read()).toBe('secret-key-1234567890');
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('treats an empty stored value as absent', () => {
    const storage = memoryStorage();
    storage.setItem('trawlarr.apiKey', '');
    expect(createKeyStore(storage).read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `nvm use 22 && pnpm vitest run packages/web/src/api/`
Expected: FAIL — "No test files found" (the root vitest include does not cover `packages/web` yet).

- [ ] **Step 3: Create the package**

`packages/web/package.json`:

```json
{
  "name": "@trawlarr/web",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "private": true,
  "scripts": {
    "build": "tsc --noEmit -p tsconfig.app.json && vite build",
    "dev": "vite"
  },
  "dependencies": {
    "@trawlarr/plugin-api": "workspace:*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0"
  }
}
```

React, React DOM, Vite and `@vitejs/plugin-react` are all MIT. Run `pnpm install` and confirm `pnpm audit:licenses` still passes — it will report a package count well above 281; record the new number in the commit message, and if any transitive package fails the allow-list, remove the offending dependency rather than widening the list.

`packages/web/tsconfig.json` (the one `check:refs` reads):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "composite": false, "declaration": false },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../plugin-api" }]
}
```

`packages/web/tsconfig.app.json` (DOM code, used by the build):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": [],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "module": "ESNext",
    "noEmit": true,
    "composite": false,
    "declaration": false,
    "declarationMap": false
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

`packages/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // `pnpm --filter @trawlarr/web dev` proxies to a daemon on the default
    // port, so the dev server and the built bundle see the same origin-
    // relative API paths and there is one code path, not two.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8265', ws: true },
    },
  },
});
```

`packages/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>trawlarr</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Write the client and the key store**

`packages/web/src/api/client.ts`:

```ts
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(input: { status: number; code: string; message: string }) {
    super(input.message);
    this.name = 'ApiClientError';
    this.status = input.status;
    this.code = input.code;
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

const PREFIX = '/api/v1';

/**
 * The same API a shell script talks to, with the same key in the same header.
 *
 * NO COOKIE AND NO SESSION, deliberately. The spec's rule that the UI has no
 * privileged path only holds if the UI's credential is one a script could
 * also hold; and the event socket's security argument depends on there being
 * NO AMBIENT AUTHORITY in the browser — no cookie means a hostile page has
 * nothing to send and there is no CSRF shape to defend against.
 */
export const createApiClient = (input: {
  baseUrl?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ApiClient => {
  const doFetch = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = input.baseUrl ?? '';

  const send = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await doFetch(`${base}${PREFIX}${path}`, {
      method,
      headers: {
        'X-Api-Key': input.apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 204) return undefined as T;
    if (!response.ok) {
      let code = 'unknown';
      let message = `The daemon answered ${String(response.status)}.`;
      try {
        const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        // A non-JSON body from a proxy in front of the daemon. Keep the
        // status-derived message rather than throwing a parse error over it.
      }
      throw new ApiClientError({ status: response.status, code, message });
    }
    return (await response.json()) as T;
  };

  return {
    get: async (path) => await send('GET', path),
    post: async (path, body) => await send('POST', path, body),
    patch: async (path, body) => await send('PATCH', path, body),
    put: async (path, body) => await send('PUT', path, body),
    del: async (path) => {
      await send<void>('DELETE', path);
    },
  };
};

/**
 * The event socket's URL.
 *
 * The key goes in the QUERY STRING here and only here, because a browser
 * cannot set headers on a WebSocket upgrade. The daemon accepts both forms
 * for exactly this reason, and a WebSocket URL is never a Referer and never
 * lands in history — which is what makes this acceptable while the REST
 * client still uses the header.
 */
export const eventsUrl = (input: { baseUrl?: string; apiKey: string }): string => {
  const base = new URL(input.baseUrl ?? globalThis.location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${PREFIX}/events`;
  base.search = `?apiKey=${encodeURIComponent(input.apiKey)}`;
  return base.toString();
};
```

`packages/web/src/api/key.ts`:

```ts
const STORAGE_KEY = 'trawlarr.apiKey';

export interface KeyStore {
  read(): string | null;
  write(key: string): void;
  clear(): void;
}

/**
 * Where the browser keeps the API key it was given.
 *
 * `localStorage` rather than a cookie: a cookie would be sent automatically
 * by every request the browser makes to this origin, which is precisely the
 * ambient authority the API's security model does not have and does not want.
 * The operator pastes the key once; "Sign out" is `clear()`.
 */
export const createKeyStore = (
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): KeyStore => ({
  read: () => {
    const value = storage.getItem(STORAGE_KEY);
    return value === null || value === '' ? null : value;
  },
  write: (key) => {
    storage.setItem(STORAGE_KEY, key);
  },
  clear: () => {
    storage.removeItem(STORAGE_KEY);
  },
});
```

- [ ] **Step 5: Admit the package to the tooling**

1. `vitest.config.ts`: the existing globs `packages/*/src/**/*.test.ts` already match `packages/web/src/api/client.test.ts`. Add the alias `'@trawlarr/web': pkg('web')` for symmetry. **Do not** add `.tsx` to the include.
2. `tsconfig.typecheck.json`: unchanged — `packages/*/src/**/*.ts` already covers the DOM-free files, and `.tsx` is excluded by the glob, which is the intent.
3. Root `package.json`: change `build` to

   ```json
   "build": "tsc --build && pnpm -r --if-present run build:sql && pnpm --filter @trawlarr/web run build"
   ```

4. `eslint.config.js`: add `packages/web/src/**/*.tsx` to the TypeScript-linted files, or add `packages/web/dist` to the ignores — follow whichever shape the existing config already uses.
5. `.prettierignore`: add `packages/web/dist`.
6. `Dockerfile`: add `COPY packages/web/package.json packages/web/` to the manifest-copy block in the build stage, and after `pnpm build`, `COPY --from=build /src/packages/web/dist /app/web/dist` in the runtime stage — matching `resolveWebRoot`'s `../../web/dist` candidate relative to `/app/dist/api/`.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `nvm use 22 && pnpm vitest run packages/web/src/api/`
Expected: PASS, 8 tests.

- [ ] **Step 7: Write a placeholder `App` so the build produces a bundle**

`packages/web/src/main.tsx` and `packages/web/src/App.tsx`: render a single `<h1>trawlarr</h1>` for now. Task 10 replaces `App.tsx`; this exists so `pnpm build` emits `packages/web/dist/index.html` and Task 7's `resolveWebRoot` finds it.

```tsx
// packages/web/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

```tsx
// packages/web/src/App.tsx
export const App = (): JSX.Element => <h1>trawlarr</h1>;
```

- [ ] **Step 8: Run the gate and commit**

```bash
nvm use 22 && pnpm install && tsc --build --force && pnpm check:refs && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web package.json pnpm-lock.yaml vitest.config.ts eslint.config.js .prettierignore Dockerfile
git commit -m "feat(web): package scaffold, typed API client and key store"
```

Record the new `audit:licenses` package count in the commit message; it replaces 281 as the baseline for every later task.

---

## Task 9: The live event reducer

The WebSocket is a push channel for things that change second by second; everything durable is fetched over REST, so a dropped socket costs liveness and never correctness. The UI must be built on exactly that assumption, and the way to guarantee it is to make the reducer *unable* to be the source of truth: it holds only in-flight job progress and a "something changed, re-fetch" signal.

**Files:**
- Create: `packages/web/src/api/events.ts`
- Create: `packages/web/src/api/events.test.ts`

**Interfaces:**
- Consumes: `TrawlarrEvent` — its shape is duplicated here as a hand-written type, because `@trawlarr/server` is a Node package the browser bundle must not import. Task 11's end-to-end check is what keeps the copy honest.
- Produces:
  - `export interface LiveJob { jobId: string; fileId: string; libraryId: string; path: string; workerId: string; pid: number | null; percent: number | null; stage: string; steps: Array<{ seq: number; pluginId: string; outputNumber: number | null; durationMs: number }>; log: string[] }`
  - `export interface LiveState { jobs: Record<string, LiveJob>; scanning: Record<string, number>; staleness: { libraries: number; jobs: number; workers: number } }`
  - `export const initialLiveState: LiveState`
  - `export const reduceLive(state: LiveState, event: TrawlarrEvent): LiveState`
  - `export const LIVE_LOG_LINES = 200`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/api/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { initialLiveState, LIVE_LOG_LINES, reduceLive, type LiveState } from './events.js';

const fold = (events: Parameters<typeof reduceLive>[1][]): LiveState =>
  events.reduce(reduceLive, initialLiveState);

const started = {
  type: 'job.started' as const,
  jobId: 'job-1',
  fileId: 'file-1',
  libraryId: 'lib-1',
  path: '/library/movie.mkv',
  workerId: 'worker-1',
  pid: 4242,
};

describe('reduceLive', () => {
  it('tracks a running job and its progress', () => {
    const state = fold([
      started,
      { type: 'job.progress', jobId: 'job-1', percent: 40, stage: 'encoding' },
    ]);

    expect(state.jobs['job-1']).toMatchObject({
      path: '/library/movie.mkv',
      pid: 4242,
      percent: 40,
      stage: 'encoding',
    });
  });

  it('drops a job when it finishes and flags the durable views as stale', () => {
    const state = fold([
      started,
      { type: 'job.finished', jobId: 'job-1', fileId: 'file-1', state: 'good', outcome: 'ok' },
    ]);

    expect(state.jobs).toEqual({});
    // The reducer NEVER becomes the record. A finish means "re-fetch", not
    // "here is the new file state" — so a client that missed the frame is
    // stale, never wrong.
    expect(state.staleness.jobs).toBe(1);
    expect(state.staleness.libraries).toBe(1);
  });

  it('caps the log tail rather than growing without bound', () => {
    const logs = Array.from({ length: LIVE_LOG_LINES + 50 }, (_, i) => ({
      type: 'job.log' as const,
      jobId: 'job-1',
      text: `line ${String(i)}`,
    }));
    const state = fold([started, ...logs]);

    expect(state.jobs['job-1']!.log).toHaveLength(LIVE_LOG_LINES);
    expect(state.jobs['job-1']!.log.at(-1)).toBe(`line ${String(LIVE_LOG_LINES + 49)}`);
  });

  it('appends steps in order', () => {
    const state = fold([
      started,
      { type: 'job.step', jobId: 'job-1', seq: 1, pluginId: 'trawlarr:start', outputNumber: 1, durationMs: 2 },
      { type: 'job.step', jobId: 'job-1', seq: 2, pluginId: 'trawlarr:execute', outputNumber: 1, durationMs: 900 },
    ]);
    expect(state.jobs['job-1']!.steps.map((step) => step.pluginId)).toEqual([
      'trawlarr:start',
      'trawlarr:execute',
    ]);
  });

  it('ignores a frame for a job it never saw start', () => {
    // Connecting mid-job is normal, and a reconnecting client is owed no
    // replay. A phantom row with no path is worse than no row.
    const state = fold([{ type: 'job.progress', jobId: 'ghost', percent: 10, stage: 'x' }]);
    expect(state.jobs).toEqual({});
  });

  it('tracks scan progress per library and clears it on finish', () => {
    const withScan = fold([{ type: 'scan.progress', libraryId: 'lib-1', seen: 120 }]);
    expect(withScan.scanning['lib-1']).toBe(120);

    const finished = reduceLive(withScan, {
      type: 'scan.finished',
      libraryId: 'lib-1',
      summary: { seen: 120 } as never,
    });
    expect(finished.scanning).toEqual({});
    expect(finished.staleness.libraries).toBe(1);
  });

  it('flags libraries stale when one pauses or resumes', () => {
    const paused = fold([{ type: 'library.paused', libraryId: 'lib-1', reason: 'flow-invalid: x' }]);
    expect(paused.staleness.libraries).toBe(1);
    expect(reduceLive(paused, { type: 'library.resumed', libraryId: 'lib-1' }).staleness.libraries)
      .toBe(2);
  });

  it('flags workers stale on a worker count change', () => {
    const state = fold([
      { type: 'workers.changed', target: { transcode: 2, health: 0 }, active: 1 },
    ]);
    expect(state.staleness.workers).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/web/src/api/events.test.ts`
Expected: FAIL — `Cannot find module './events.js'`.

- [ ] **Step 3: Write the reducer**

Create `packages/web/src/api/events.ts`. **`export type TrawlarrEvent`** as an exact copy of the union in `packages/server/src/daemon/events.ts` — including the `pid` field Task 5 added, and with `summary: unknown` for `scan.finished` so the browser bundle does not need the server's `ScanSummary`. It is exported because `useLive` (Task 10) casts each parsed frame to it. Then:

```ts
export const LIVE_LOG_LINES = 200;

export interface LiveJob {
  jobId: string;
  fileId: string;
  libraryId: string;
  path: string;
  workerId: string;
  pid: number | null;
  percent: number | null;
  stage: string;
  steps: Array<{ seq: number; pluginId: string; outputNumber: number | null; durationMs: number }>;
  log: string[];
}

export interface LiveState {
  jobs: Record<string, LiveJob>;
  /** libraryId -> files seen so far by the scan currently walking it. */
  scanning: Record<string, number>;
  /**
   * Monotonic counters, one per durable view. Every increment means "what you
   * fetched is out of date"; nothing here is ever the answer itself.
   */
  staleness: { libraries: number; jobs: number; workers: number };
}

export const initialLiveState: LiveState = {
  jobs: {},
  scanning: {},
  staleness: { libraries: 0, jobs: 0, workers: 0 },
};

const bump = (state: LiveState, ...views: Array<keyof LiveState['staleness']>): LiveState => {
  const staleness = { ...state.staleness };
  for (const view of views) staleness[view] += 1;
  return { ...state, staleness };
};

/**
 * Fold one live frame into view state.
 *
 * THE REDUCER IS NEVER THE RECORD. Durable facts — a file's state, a
 * library's convergence, a job's outcome — are re-fetched over REST; this
 * holds only what changes faster than a fetch can follow (in-flight progress,
 * a log tail, a scan's running count) plus counters saying which fetch is now
 * out of date. That is what makes a dropped socket cost liveness and never
 * correctness, and a reconnecting client owed no replay.
 */
export const reduceLive = (state: LiveState, event: TrawlarrEvent): LiveState => {
  switch (event.type) {
    case 'job.started':
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [event.jobId]: {
            jobId: event.jobId,
            fileId: event.fileId,
            libraryId: event.libraryId,
            path: event.path,
            workerId: event.workerId,
            pid: event.pid,
            percent: null,
            stage: 'starting',
            steps: [],
            log: [],
          },
        },
        staleness: { ...state.staleness, jobs: state.staleness.jobs + 1 },
      };

    case 'job.progress': {
      const job = state.jobs[event.jobId];
      if (job === undefined) return state;
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [event.jobId]: { ...job, percent: event.percent, stage: event.stage },
        },
      };
    }

    case 'job.step': {
      const job = state.jobs[event.jobId];
      if (job === undefined) return state;
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [event.jobId]: {
            ...job,
            steps: [
              ...job.steps,
              {
                seq: event.seq,
                pluginId: event.pluginId,
                outputNumber: event.outputNumber,
                durationMs: event.durationMs,
              },
            ],
          },
        },
      };
    }

    case 'job.log': {
      const job = state.jobs[event.jobId];
      if (job === undefined) return state;
      const log = [...job.log, event.text];
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [event.jobId]: { ...job, log: log.slice(-LIVE_LOG_LINES) },
        },
      };
    }

    case 'job.finished': {
      const { [event.jobId]: _removed, ...jobs } = state.jobs;
      return bump({ ...state, jobs }, 'jobs', 'libraries');
    }

    case 'scan.progress':
      return { ...state, scanning: { ...state.scanning, [event.libraryId]: event.seen } };

    case 'scan.finished': {
      const { [event.libraryId]: _done, ...scanning } = state.scanning;
      return bump({ ...state, scanning }, 'libraries');
    }

    case 'library.paused':
    case 'library.resumed':
      return bump(state, 'libraries');

    case 'workers.changed':
      return bump(state, 'workers');
  }
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `nvm use 22 && pnpm vitest run packages/web/src/api/events.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the gate and commit**

```bash
nvm use 22 && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src/api
git commit -m "feat(web): live event reducer, holding liveness and never the record"
```

---

## Task 10: The app shell, the key gate, and the Overview screen

Overview is library-centric by decision: convergence is the headline, workers are a secondary strip. This screen must answer "is my library done?" and, when the answer is "it has stopped", **why** — `pausedReason` and `pausedExplanation` travel on every library representation precisely so that a library which has silently stopped converging is distinguishable from one that has finished.

The testable part is the derivation, not the markup. Everything a component decides — which badge a library gets, what the header count says, how a paused library is described — is a pure function in `overview-model.ts`, and that is what the tests pin.

**Files:**
- Create: `packages/web/src/screens/overview-model.ts`, `packages/web/src/screens/overview-model.test.ts`
- Create: `packages/web/src/screens/Overview.tsx`
- Create: `packages/web/src/shell/KeyGate.tsx`, `packages/web/src/shell/useLive.ts`, `packages/web/src/shell/useApi.ts`
- Create: `packages/web/src/styles.css`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `createApiClient`, `eventsUrl`, `createKeyStore` (Task 8); `reduceLive`, `initialLiveState`, `LiveState` (Task 9).
- Produces:
  - `export interface LibraryResource { id: string; name: string; roots: string[]; flowId: string | null; paused: boolean; pausedReason: string | null; pausedBy: string | null; pausedExplanation: string | null }`
  - `export interface LibraryStats { libraryId: string; total: number; byState: Record<string, number>; good: number; missing: number; convergedPercent: number; paused: boolean; pausedExplanation: string | null; scanning: boolean }`
  - `export interface LibraryCard { id: string; name: string; convergedPercent: number; total: number; counts: Record<string, number>; status: 'converged' | 'working' | 'idle' | 'paused' | 'attention'; headline: string; detail: string | null }`
  - `export const toLibraryCard(input: { library: LibraryResource; stats: LibraryStats; live: LiveState }): LibraryCard`
  - `export const overallConvergence(cards: LibraryCard[]): { percent: number; total: number; good: number }`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/screens/overview-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { initialLiveState } from '../api/events.js';
import { overallConvergence, toLibraryCard, type LibraryResource, type LibraryStats } from './overview-model.js';

const library = (patch: Partial<LibraryResource> = {}): LibraryResource => ({
  id: 'lib-1',
  name: 'Movies',
  roots: ['/library/movies'],
  flowId: 'flow-1',
  paused: false,
  pausedReason: null,
  pausedBy: null,
  pausedExplanation: null,
  ...patch,
});

const stats = (patch: Partial<LibraryStats> = {}): LibraryStats => ({
  libraryId: 'lib-1',
  total: 100,
  byState: { good: 100, queued: 0, running: 0, failed: 0, not_converging: 0, held: 0, unknown: 0 },
  good: 100,
  missing: 0,
  convergedPercent: 100,
  paused: false,
  pausedExplanation: null,
  scanning: false,
  ...patch,
});

describe('toLibraryCard', () => {
  it('reports a fully converged library as converged', () => {
    const card = toLibraryCard({ library: library(), stats: stats(), live: initialLiveState });
    expect(card.status).toBe('converged');
    expect(card.convergedPercent).toBe(100);
  });

  it('shows WHY a library is paused, in the daemon’s own words', () => {
    const card = toLibraryCard({
      library: library({
        paused: true,
        pausedReason: 'flow-invalid: no flow is attached',
        pausedBy: 'trawlarr',
        pausedExplanation:
          'This library has no flow, so there is no known-good state to converge toward.',
      }),
      stats: stats({ paused: true, convergedPercent: 0, good: 0, byState: { ...stats().byState, good: 0, unknown: 100 } }),
      live: initialLiveState,
    });

    expect(card.status).toBe('paused');
    // A paused library that says only "paused" is barely better than one that
    // says nothing: the reason IS the diagnosis.
    expect(card.detail).toBe(
      'This library has no flow, so there is no known-good state to converge toward.',
    );
  });

  it('reports files needing a human as needing attention, even at high convergence', () => {
    const card = toLibraryCard({
      library: library(),
      stats: stats({
        convergedPercent: 98,
        good: 98,
        byState: { ...stats().byState, good: 98, failed: 1, not_converging: 1 },
      }),
      live: initialLiveState,
    });
    expect(card.status).toBe('attention');
    expect(card.detail).toContain('1 failed');
    expect(card.detail).toContain('1 not converging');
  });

  it('reports a library with a running job as working', () => {
    const live = {
      ...initialLiveState,
      jobs: {
        'job-1': {
          jobId: 'job-1',
          fileId: 'f',
          libraryId: 'lib-1',
          path: '/library/movies/a.mkv',
          workerId: 'w',
          pid: 1,
          percent: 30,
          stage: 'encoding',
          steps: [],
          log: [],
        },
      },
    };
    expect(toLibraryCard({ library: library(), stats: stats({ convergedPercent: 50 }), live }).status)
      .toBe('working');
  });

  it('reports a scanning library as working', () => {
    const live = { ...initialLiveState, scanning: { 'lib-1': 4200 } };
    const card = toLibraryCard({ library: library(), stats: stats({ convergedPercent: 0, good: 0 }), live });
    expect(card.status).toBe('working');
    expect(card.detail).toContain('4200');
  });

  it('never rounds convergence up to 100', () => {
    // The one number this product exists to report. 100 is reserved for
    // good === total exactly; the daemon floors it and the UI must not undo
    // that by formatting.
    const card = toLibraryCard({
      library: library(),
      stats: stats({ total: 1000, good: 999, convergedPercent: 99 }),
      live: initialLiveState,
    });
    expect(card.headline).toBe('99% converged');
  });
});

describe('overallConvergence', () => {
  it('weights by file count, not by library count', () => {
    const cards = [
      { ...toLibraryCard({ library: library(), stats: stats({ total: 900, good: 900, convergedPercent: 100 }), live: initialLiveState }) },
      { ...toLibraryCard({ library: library({ id: 'lib-2', name: 'TV' }), stats: stats({ libraryId: 'lib-2', total: 100, good: 0, convergedPercent: 0 }), live: initialLiveState }) },
    ];
    expect(overallConvergence(cards)).toEqual({ percent: 90, total: 1000, good: 900 });
  });

  it('reports 0 rather than NaN for an empty install', () => {
    expect(overallConvergence([])).toEqual({ percent: 0, total: 0, good: 0 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/web/src/screens/overview-model.test.ts`
Expected: FAIL — `Cannot find module './overview-model.js'`.

- [ ] **Step 3: Write the model**

Create `packages/web/src/screens/overview-model.ts`:

```ts
import type { LiveState } from '../api/events.js';

export interface LibraryResource {
  id: string;
  name: string;
  roots: string[];
  flowId: string | null;
  paused: boolean;
  pausedReason: string | null;
  pausedBy: string | null;
  pausedExplanation: string | null;
}

export interface LibraryStats {
  libraryId: string;
  total: number;
  byState: Record<string, number>;
  good: number;
  missing: number;
  convergedPercent: number;
  paused: boolean;
  pausedExplanation: string | null;
  scanning: boolean;
}

export interface LibraryCard {
  id: string;
  name: string;
  convergedPercent: number;
  total: number;
  counts: Record<string, number>;
  status: 'converged' | 'working' | 'idle' | 'paused' | 'attention';
  headline: string;
  detail: string | null;
}

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * One library, as a card.
 *
 * THE LADDER'S ORDER IS THE DESIGN: a paused library that also has failures
 * is paused first, because the pause is why nothing is happening and the
 * failures are what stopped mattering the moment it paused.
 *
 * `convergedPercent` is the daemon's number, carried through untouched. It is
 * floored there, and 100 is reserved for `good === total` exactly; recomputing
 * it here would let the UI and the CLI disagree about the one number this
 * product exists to report.
 */
export const toLibraryCard = (input: {
  library: LibraryResource;
  stats: LibraryStats;
  live: LiveState;
}): LibraryCard => {
  const { library, stats, live } = input;
  const base = {
    id: library.id,
    name: library.name,
    convergedPercent: stats.convergedPercent,
    total: stats.total,
    counts: stats.byState,
    headline: `${String(stats.convergedPercent)}% converged`,
  };

  if (library.paused) {
    return {
      ...base,
      status: 'paused',
      detail:
        library.pausedExplanation ?? library.pausedReason ?? 'Paused, with no reason recorded.',
    };
  }

  const seen = live.scanning[library.id];
  if (seen !== undefined) {
    return { ...base, status: 'working', detail: `Scanning — ${String(seen)} files seen` };
  }

  const running = Object.values(live.jobs).find((job) => job.libraryId === library.id);
  if (running !== undefined) {
    return { ...base, status: 'working', detail: `Running ${basename(running.path)}` };
  }

  const failed = stats.byState.failed ?? 0;
  const notConverging = stats.byState.not_converging ?? 0;
  if (failed + notConverging > 0) {
    const parts = [
      ...(failed > 0 ? [plural(failed, 'failed').replace('faileds', 'failed')] : []),
      ...(notConverging > 0 ? [`${String(notConverging)} not converging`] : []),
    ];
    // Both terminal states need a human: nothing re-queues them, so a
    // library sitting at 98% for ever is only explicable by naming them.
    return { ...base, status: 'attention', detail: parts.join(', ') };
  }

  if (stats.total > 0 && stats.good === stats.total) {
    return { ...base, status: 'converged', detail: null };
  }

  const [largestState, largestCount] = Object.entries(stats.byState)
    .filter(([state]) => state !== 'good')
    .sort((a, b) => b[1] - a[1])[0] ?? ['unknown', 0];
  return {
    ...base,
    status: 'idle',
    detail: largestCount > 0 ? `${String(largestCount)} ${largestState}` : null,
  };
};

/** Weighted by FILES, not by libraries: a 900-file library is not one vote. */
export const overallConvergence = (
  cards: LibraryCard[],
): { percent: number; total: number; good: number } => {
  const total = cards.reduce((sum, card) => sum + card.total, 0);
  const good = cards.reduce(
    (sum, card) => sum + Math.round((card.convergedPercent / 100) * card.total),
    0,
  );
  if (total === 0) return { percent: 0, total: 0, good: 0 };
  return { percent: good === total ? 100 : Math.floor((good / total) * 100), total, good };
};
```

The `plural` call for `failed` reads oddly on purpose — "failed" is already an adjective and does not take an `s`. If that bothers the implementer, inline the string; the test pins `1 failed`, not the helper.

- [ ] **Step 4: Run the test and watch it pass**

Run: `nvm use 22 && pnpm vitest run packages/web/src/screens/overview-model.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the shell**

`packages/web/src/shell/useLive.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { eventsUrl } from '../api/client.js';
import { initialLiveState, reduceLive, type LiveState, type TrawlarrEvent } from '../api/events.js';

const RECONNECT_MS = [500, 1_000, 2_000, 5_000, 10_000];

/**
 * The live channel.
 *
 * NOTHING IS EVER REPLAYED on reconnect, and nothing asks for it. Every frame
 * describes a write the daemon has already made, so a client that missed some
 * is stale and re-fetches; one that demanded a replay would be asking the
 * daemon to keep a per-client backlog, which is the thing that turns a slow
 * browser tab into a memory leak in the process supervising transcodes.
 */
export const useLive = (apiKey: string): { live: LiveState; connected: boolean } => {
  const [live, setLive] = useState<LiveState>(initialLiveState);
  const [connected, setConnected] = useState(false);
  const attempt = useRef(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;

    const open = (): void => {
      socket = new WebSocket(eventsUrl({ apiKey }));
      socket.onopen = () => {
        attempt.current = 0;
        setConnected(true);
      };
      socket.onmessage = (message) => {
        setLive((current) => reduceLive(current, JSON.parse(String(message.data)) as TrawlarrEvent));
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = RECONNECT_MS[Math.min(attempt.current, RECONNECT_MS.length - 1)]!;
        attempt.current += 1;
        timer = globalThis.setTimeout(open, delay);
      };
    };
    open();

    return () => {
      closed = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
      socket?.close();
    };
  }, [apiKey]);

  return { live, connected };
};
```

`packages/web/src/shell/useApi.ts`:

```ts
import { useMemo, useState } from 'react';
import { createApiClient, type ApiClient } from '../api/client.js';
import { createKeyStore } from '../api/key.js';

export const useApi = (): {
  client: ApiClient | null;
  apiKey: string | null;
  setKey: (key: string) => void;
  signOut: () => void;
} => {
  const store = useMemo(() => createKeyStore(globalThis.localStorage), []);
  const [apiKey, setApiKey] = useState<string | null>(() => store.read());
  const client = useMemo(() => (apiKey === null ? null : createApiClient({ apiKey })), [apiKey]);

  return {
    client,
    apiKey,
    setKey: (key) => {
      store.write(key);
      setApiKey(key);
    },
    signOut: () => {
      store.clear();
      setApiKey(null);
    },
  };
};
```

`packages/web/src/shell/KeyGate.tsx`:

```tsx
import { useState, type FormEvent, type ReactNode } from 'react';
import { createApiClient } from '../api/client.js';

export const KeyGate = (props: {
  apiKey: string | null;
  onKey: (key: string) => void;
  children: ReactNode;
}): JSX.Element => {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  if (props.apiKey !== null) return <>{props.children}</>;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setChecking(true);
    setProblem(null);
    try {
      // Verified BEFORE it is stored: a stored key that does not work turns
      // every screen into an error and the fix (clear localStorage) is not
      // one anybody guesses.
      await createApiClient({ apiKey: value }).get('/system/version');
      props.onKey(value);
    } catch {
      setProblem('That key was not accepted.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="key-gate">
      <h1>trawlarr</h1>
      <label htmlFor="api-key">API key</label>
      <input
        id="api-key"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <p>
        trawlarr generated an API key on its first start and printed it once. Find it with{' '}
        <code>docker logs trawlarr</code>, or run <code>docker exec trawlarr trawlarr status</code>{' '}
        — the CLI reads it from the same place.
      </p>
      {problem !== null && (
        <p role="alert" className="problem">
          {problem}
        </p>
      )}
      <button type="submit" disabled={checking || value === ''}>
        {checking ? 'Checking…' : 'Save'}
      </button>
    </form>
  );
};
```

Render this same gate whenever a later request fails with status 401 (clear the stored key on that failure), so a rotated key is recoverable without anyone editing browser storage by hand.

`packages/web/src/App.tsx` — `KeyGate` wrapping a header (product name, overall convergence, connection indicator, Sign out) and a nav between Overview, Libraries and Activity, with the screens rendered beneath.

`packages/web/src/styles.css` — a small hand-rolled sheet. Requirements, not polish: every control has a visible label and a focus ring, colour is never the only carrier of status (each badge has text), and loading and error states are rendered honestly rather than as an empty list.

- [ ] **Step 6: Write the Overview screen**

`packages/web/src/screens/Overview.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import type { LiveState } from '../api/events.js';
import {
  overallConvergence,
  toLibraryCard,
  type LibraryCard,
  type LibraryResource,
  type LibraryStats,
} from './overview-model.js';

export const Overview = (props: { client: ApiClient; live: LiveState }): JSX.Element => {
  const [cards, setCards] = useState<LibraryCard[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Re-fetch on the staleness counter, never on a timer: the socket says
  // exactly when a durable fact changed, and polling would both lag and
  // hammer a daemon that is busy transcoding.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const libraries = await props.client.get<LibraryResource[]>('/libraries');
        const stats = await Promise.all(
          libraries.map(async (library) =>
            await props.client.get<LibraryStats>(`/libraries/${library.id}/stats`),
          ),
        );
        if (cancelled) return;
        setProblem(null);
        setCards(
          libraries.map((library, index) =>
            toLibraryCard({ library, stats: stats[index]!, live: props.live }),
          ),
        );
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.client, props.live.staleness.libraries, props.live]);

  if (problem !== null) return <p role="alert">{problem}</p>;
  if (cards === null) return <p>Loading libraries…</p>;
  if (cards.length === 0) {
    // An honest empty state, not a blank page: a fresh install looks exactly
    // like a broken one otherwise.
    return <p>No libraries yet. Add one to start converging something.</p>;
  }

  const overall = overallConvergence(cards);
  return (
    <section>
      <h2>
        {String(overall.percent)}% converged — {String(overall.good)} of {String(overall.total)}{' '}
        files
      </h2>
      <ul className="library-cards">
        {cards.map((card) => (
          <li key={card.id} className={`card status-${card.status}`}>
            <h3>{card.name}</h3>
            <p className="headline">{card.headline}</p>
            <p className="badge">{card.status}</p>
            {card.detail !== null && <p className="detail">{card.detail}</p>}
            <dl>
              {Object.entries(card.counts)
                .filter(([, count]) => count > 0)
                .map(([state, count]) => (
                  <div key={state}>
                    <dt>{state}</dt>
                    <dd>{String(count)}</dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
};
```

The status is rendered as **text** as well as a class, so status is never carried by colour alone.

Add the worker strip beside it: `GET /workers` re-fetched on `live.staleness.workers`, showing `target` per class, `active`, and each worker's class and current file.

- [ ] **Step 7: Verify by hand against a real daemon**

```bash
nvm use 22 && pnpm build
node packages/server/dist/cli.js daemon --data-dir /tmp/p2c-demo --port 8265
```

Open `http://localhost:8265`, paste the key the daemon printed, and confirm: the key is accepted and survives a reload; an install with no libraries renders an honest empty state rather than a blank page; a library created from another terminal appears after its scan finishes; and a library with no flow attached shows the paused badge with the explanation. Then check the network tab: every request carries `X-Api-Key` and no request carries the key in a URL except the WebSocket.

- [ ] **Step 8: Run the gate and commit**

```bash
nvm use 22 && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src
git commit -m "feat(web): app shell, API key gate and the library-centric Overview"
```

---

## Task 11: Library setup and flow attachment

The two things the owner must be able to do in a browser: add a library pointing at his media, and attach a flow built from the transcode template. Both are plain forms over endpoints that already exist and already validate — the UI's job is to surface the daemon's refusals verbatim rather than inventing its own, because those messages name the consequence.

**Files:**
- Create: `packages/web/src/screens/library-form-model.ts`, `packages/web/src/screens/library-form-model.test.ts`
- Create: `packages/web/src/screens/Libraries.tsx`, `packages/web/src/screens/LibrarySetup.tsx`, `packages/web/src/screens/FlowPicker.tsx`

**Interfaces:**
- Consumes: `ApiClient`, `ApiClientError` (Task 8); `GET /flows/templates` and template-aware `POST /flows` (Task 6).
- Produces:
  - `export interface LibraryDraft { name: string; roots: string; extensions: string; allowHardlinked: boolean }`
  - `export interface LibraryCreateBody { name: string; roots: string[]; extensions?: string[]; allowHardlinked?: boolean }`
  - `export const draftProblems(draft: LibraryDraft): string[]`
  - `export const toCreateBody(draft: LibraryDraft): LibraryCreateBody`
  - `export const describeFailure(error: unknown): { title: string; message: string; retryable: boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/screens/library-form-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/client.js';
import { describeFailure, draftProblems, toCreateBody, type LibraryDraft } from './library-form-model.js';

const draft = (patch: Partial<LibraryDraft> = {}): LibraryDraft => ({
  name: 'Movies',
  roots: '/library/movies',
  extensions: 'mkv, mp4',
  allowHardlinked: false,
  ...patch,
});

describe('draftProblems', () => {
  it('accepts a well-formed draft', () => {
    expect(draftProblems(draft())).toEqual([]);
  });

  it('requires a name and at least one root', () => {
    expect(draftProblems(draft({ name: '  ' }))).toContain('Give the library a name.');
    expect(draftProblems(draft({ roots: '' }))).toContain(
      'Give the library at least one root directory: a library with no root has nothing to scan.',
    );
  });

  it('rejects a relative root before the request is sent', () => {
    // The daemon rejects this too, but a container makes it easy to type a
    // host path that is not the container's path — so the form names it
    // rather than round-tripping a 400.
    expect(draftProblems(draft({ roots: 'media/movies' }))).toContain(
      'Roots must be absolute paths as the trawlarr process sees them — in Docker that is the ' +
        'path inside the container, e.g. /library/movies, not the host path.',
    );
  });
});

describe('toCreateBody', () => {
  it('splits roots and extensions and drops empty entries', () => {
    expect(toCreateBody(draft({ roots: '/a\n/b\n\n', extensions: 'mkv, mp4, ' }))).toEqual({
      name: 'Movies',
      roots: ['/a', '/b'],
      extensions: ['mkv', 'mp4'],
      allowHardlinked: false,
    });
  });

  it('omits extensions entirely when the field is blank, rather than sending []', () => {
    // An empty array would mean "match nothing"; omitting it keeps the
    // daemon's default.
    expect(toCreateBody(draft({ extensions: '   ' })).extensions).toBeUndefined();
  });
});

describe('describeFailure', () => {
  it('passes the daemon’s own message through for a rejection it wrote', () => {
    const error = new ApiClientError({
      status: 409,
      code: 'overlapping-roots',
      message: 'Root "/library" overlaps library "TV".',
    });
    expect(describeFailure(error)).toEqual({
      title: 'trawlarr refused this',
      message: 'Root "/library" overlaps library "TV".',
      retryable: false,
    });
  });

  it('marks a 500 as retryable and does not invent a cause', () => {
    const error = new ApiClientError({ status: 500, code: 'internal-error', message: 'The daemon failed.' });
    expect(describeFailure(error).retryable).toBe(true);
  });

  it('describes a lost connection as a connection problem', () => {
    expect(describeFailure(new TypeError('Failed to fetch'))).toEqual({
      title: 'Could not reach trawlarr',
      message:
        'The daemon did not answer. It may be restarting, or this page may have been left open ' +
        'after it stopped.',
      retryable: true,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/web/src/screens/library-form-model.test.ts`
Expected: FAIL — `Cannot find module './library-form-model.js'`.

- [ ] **Step 3: Write the model**

Create `packages/web/src/screens/library-form-model.ts`:

```ts
import { ApiClientError } from '../api/client.js';

export interface LibraryDraft {
  name: string;
  roots: string;
  extensions: string;
  allowHardlinked: boolean;
}

export interface LibraryCreateBody {
  name: string;
  roots: string[];
  extensions?: string[];
  allowHardlinked?: boolean;
}

const split = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

export const draftProblems = (draft: LibraryDraft): string[] => {
  const problems: string[] = [];
  if (draft.name.trim() === '') problems.push('Give the library a name.');

  const roots = split(draft.roots);
  if (roots.length === 0) {
    problems.push(
      'Give the library at least one root directory: a library with no root has nothing to scan.',
    );
  } else if (roots.some((root) => !root.startsWith('/'))) {
    // The daemon rejects this too. Naming it here is worth the duplication,
    // because in a container the tempting value is the HOST path and the
    // correct one is the container path — a distinction a 400 does not teach.
    problems.push(
      'Roots must be absolute paths as the trawlarr process sees them — in Docker that is the ' +
        'path inside the container, e.g. /library/movies, not the host path.',
    );
  }
  return problems;
};

export const toCreateBody = (draft: LibraryDraft): LibraryCreateBody => {
  const extensions = split(draft.extensions);
  return {
    name: draft.name.trim(),
    roots: split(draft.roots),
    // OMITTED when blank, never sent as []: an empty array means "match
    // nothing", which scans as a permanently empty library with no error.
    ...(extensions.length > 0 ? { extensions } : {}),
    allowHardlinked: draft.allowHardlinked,
  };
};

/**
 * Turn a failure into something worth showing.
 *
 * A refusal the daemon wrote is passed through VERBATIM. Those messages were
 * composed for a reader and name the consequence — "resuming would hand every
 * file to a flow that fails on all of them" is the diagnosis, and replacing it
 * with "Could not resume library" throws the diagnosis away.
 */
export const describeFailure = (
  error: unknown,
): { title: string; message: string; retryable: boolean } => {
  if (error instanceof ApiClientError) {
    return {
      title: 'trawlarr refused this',
      message: error.message,
      retryable: error.status >= 500,
    };
  }
  return {
    title: 'Could not reach trawlarr',
    message:
      'The daemon did not answer. It may be restarting, or this page may have been left open ' +
      'after it stopped.',
    retryable: true,
  };
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `nvm use 22 && pnpm vitest run packages/web/src/screens/library-form-model.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the screens**

`LibrarySetup.tsx` — labelled fields for name, roots (a textarea, one per line), extensions and "process hardlinked files". Beneath the hardlinked switch, the consequence in plain words: *"Files hardlinked into a torrent client's download directory are skipped by default. Replacing one either breaks the link or mutates a copy that is still seeding."* Problems from `draftProblems` render inline and disable Submit; a rejection renders `describeFailure` output in an alert region. On success, navigate to the flow step.

`FlowPicker.tsx` — list existing flows from `GET /flows`, plus "Create one from a template": `GET /flows/templates`, render each parameter as a labelled control (`options` → a `<select>`, otherwise a text input, each with its `tooltip` as help text), then `POST /flows` with `{name, templateId, templateValues}`, then `PATCH /libraries/:id {flowId}`. Show the sentence that makes the consequence visible: *"Attaching a flow changes what 'converged' means for every file in this library, so trawlarr will rescan it."*

`Libraries.tsx` — the list, each row linking to setup for editing, with a Scan button (`POST /libraries/:id/scan`, which answers 202) and a Resume button on a paused library that renders the 409 body verbatim when trawlarr refuses, since that refusal names the missing plugin.

- [ ] **Step 6: Verify by hand, end to end**

With a daemon running and a directory of two small h264 files: add the library through the UI, create a flow from `transcode-hevc`, attach it, and watch the Overview percentage move from 0% to 100% without touching the CLI. Then confirm the same sequence with `curl` — the point of the no-privileged-path rule — using the calls listed in `docs/migrating-from-unmanic.md`, and fix the guide if any of them is wrong.

- [ ] **Step 7: Run the gate and commit**

```bash
nvm use 22 && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src docs/migrating-from-unmanic.md
git commit -m "feat(web): library setup and flow attachment"
```

---

## Task 12: The Activity screen — live progress and the log tail

The last of the four things the UI must do: watch progress live over the WebSocket. This is also where the per-job log from Task 5 becomes visible — live over the socket while a job runs, and from `GET /jobs/:id/log` once it has finished.

**Files:**
- Create: `packages/web/src/screens/activity-model.ts`, `packages/web/src/screens/activity-model.test.ts`
- Create: `packages/web/src/screens/Activity.tsx`
- Modify: `packages/server/test/daemon-end-to-end.test.ts`

**Interfaces:**
- Consumes: `LiveState`, `LiveJob` (Task 9); `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/log`, `POST /jobs/:id/cancel`.
- Produces:
  - `export interface JobRow { jobId: string; path: string; live: boolean; percent: number | null; stage: string; outcome: string | null; state: string | null; startedAtMs: number; workerId: string | null; pid: number | null }`
  - `export interface RecentJob { id: string; file_path?: string; path?: string; state: string; outcome: string | null; started_at: number }` — one row of `GET /jobs`.
  - `export const mergeJobs(input: { live: LiveState; recent: RecentJob[] }): JobRow[]`
  - `export const formatProgress(job: JobRow): string`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/screens/activity-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { initialLiveState } from '../api/events.js';
import { formatProgress, mergeJobs } from './activity-model.js';

const liveJob = {
  jobId: 'job-live',
  fileId: 'f1',
  libraryId: 'lib-1',
  path: '/library/movies/new.mkv',
  workerId: 'w1',
  pid: 99,
  percent: 42,
  stage: 'encoding',
  steps: [],
  log: [],
};

describe('mergeJobs', () => {
  it('puts running jobs before finished ones', () => {
    const rows = mergeJobs({
      live: { ...initialLiveState, jobs: { 'job-live': liveJob } },
      recent: [
        { id: 'job-old', path: '/library/movies/old.mkv', state: 'succeeded', outcome: 'ok', started_at: 10 },
      ],
    });
    expect(rows.map((row) => row.jobId)).toEqual(['job-live', 'job-old']);
    expect(rows[0]!.live).toBe(true);
  });

  it('prefers the live frame over the fetched row for a job that is in both', () => {
    // The REST page is a snapshot; the socket is current. A row showing a
    // stale "queued" beside a live 42% is the shape that makes a UI look
    // broken.
    const rows = mergeJobs({
      live: { ...initialLiveState, jobs: { 'job-live': liveJob } },
      recent: [
        { id: 'job-live', path: '/library/movies/new.mkv', state: 'running', outcome: null, started_at: 5 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ live: true, percent: 42, pid: 99 });
  });

  it('carries the outcome of a finished job', () => {
    const rows = mergeJobs({
      live: initialLiveState,
      recent: [
        { id: 'job-old', path: '/a.mkv', state: 'failed', outcome: 'verify rejected output', started_at: 1 },
      ],
    });
    expect(rows[0]).toMatchObject({ live: false, state: 'failed', outcome: 'verify rejected output' });
  });
});

describe('formatProgress', () => {
  it('shows the percentage and stage for a live job', () => {
    expect(
      formatProgress({
        jobId: 'j', path: '/a.mkv', live: true, percent: 42, stage: 'encoding',
        outcome: null, state: null, startedAtMs: 0, workerId: 'w', pid: 1,
      }),
    ).toBe('42% — encoding');
  });

  it('says the stage without a number when the percentage is unknown', () => {
    // ffmpeg cannot always report a percentage; "0%" would be a lie and
    // "" would look like a hang.
    expect(
      formatProgress({
        jobId: 'j', path: '/a.mkv', live: true, percent: null, stage: 'probing',
        outcome: null, state: null, startedAtMs: 0, workerId: 'w', pid: 1,
      }),
    ).toBe('probing');
  });

  it('shows the outcome for a finished job', () => {
    expect(
      formatProgress({
        jobId: 'j', path: '/a.mkv', live: false, percent: null, stage: '',
        outcome: 'ok', state: 'succeeded', startedAtMs: 0, workerId: null, pid: null,
      }),
    ).toBe('succeeded — ok');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && pnpm vitest run packages/web/src/screens/activity-model.test.ts`
Expected: FAIL — `Cannot find module './activity-model.js'`.

- [ ] **Step 3: Write the model and the screen**

Create `packages/web/src/screens/activity-model.ts`:

```ts
import type { LiveState } from '../api/events.js';

export interface JobRow {
  jobId: string;
  path: string;
  live: boolean;
  percent: number | null;
  stage: string;
  outcome: string | null;
  state: string | null;
  startedAtMs: number;
  workerId: string | null;
  pid: number | null;
}

export interface RecentJob {
  id: string;
  file_path?: string;
  path?: string;
  state: string;
  outcome: string | null;
  started_at: number;
}

/**
 * The list Activity renders: what is running now, then what ran recently.
 *
 * A LIVE FRAME BEATS A FETCHED ROW for the same job id, always. The REST page
 * is a snapshot taken when it was requested; the socket is current. A row
 * showing "queued" beside a progress bar at 42% is the shape that makes a UI
 * look broken when nothing is wrong.
 */
export const mergeJobs = (input: { live: LiveState; recent: RecentJob[] }): JobRow[] => {
  const liveRows: JobRow[] = Object.values(input.live.jobs).map((job) => ({
    jobId: job.jobId,
    path: job.path,
    live: true,
    percent: job.percent,
    stage: job.stage,
    outcome: null,
    state: null,
    startedAtMs:
      input.recent.find((candidate) => candidate.id === job.jobId)?.started_at ?? Number.MAX_SAFE_INTEGER,
    workerId: job.workerId,
    pid: job.pid,
  }));

  const liveIds = new Set(liveRows.map((row) => row.jobId));
  const finishedRows: JobRow[] = input.recent
    .filter((job) => !liveIds.has(job.id))
    .map((job) => ({
      jobId: job.id,
      path: job.path ?? job.file_path ?? '',
      live: false,
      percent: null,
      stage: '',
      outcome: job.outcome,
      state: job.state,
      startedAtMs: job.started_at,
      workerId: null,
      pid: null,
    }));

  const byNewest = (a: JobRow, b: JobRow): number => b.startedAtMs - a.startedAtMs;
  return [...liveRows.sort(byNewest), ...finishedRows.sort(byNewest)];
};

/**
 * ffmpeg cannot always report a percentage. "0%" would be a lie and an empty
 * string looks like a hang, so an unknown percentage shows the stage alone.
 */
export const formatProgress = (job: JobRow): string => {
  if (job.live) {
    return job.percent === null ? job.stage : `${String(job.percent)}% — ${job.stage}`;
  }
  const state = job.state ?? 'finished';
  return job.outcome === null ? state : `${state} — ${job.outcome}`;
};
```

`Activity.tsx` — the merged list; selecting a row opens a detail panel with the step timeline (from `live.jobs[id].steps` while running, `GET /jobs/:id`'s `steps` afterwards), the log (from `live.jobs[id].log` while running, `GET /jobs/:id/log` afterwards, rendering the 404/410 bodies verbatim when the log is absent or swept), and a Cancel button for a running job that renders the daemon's 404 body when the job has already finished.

- [ ] **Step 4: Close the loop on the event shape**

`packages/web/src/api/events.ts` hand-copies the server's `TrawlarrEvent` union, so drift is possible. Add one assertion to `packages/server/test/daemon-end-to-end.test.ts` that pins the frames a UI depends on, against a real running daemon:

```ts
    const kinds = new Set(received.map((frame) => frame.type));
    expect([...kinds]).toEqual(
      expect.arrayContaining(['job.started', 'job.progress', 'job.finished']),
    );
    const start = received.find((frame) => frame.type === 'job.started')!;
    expect(Object.keys(start).sort()).toEqual(
      ['fileId', 'jobId', 'libraryId', 'path', 'pid', 'type', 'workerId'].sort(),
    );
```

The exhaustive key list is the point: a field added to the server union without being added to the web copy fails here rather than silently rendering `undefined` in the UI.

- [ ] **Step 5: Verify by hand**

With a daemon transcoding a real file: open Activity and confirm the percentage advances, the step timeline grows, log lines stream, and the row moves to the finished group with its outcome when it completes. Reload the page mid-job and confirm the row reappears from REST and resumes updating — the socket owes no replay, and the screen must not depend on one.

- [ ] **Step 6: Run the gate and commit**

```bash
nvm use 22 && tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/web/src packages/server/test/daemon-end-to-end.test.ts
git commit -m "feat(web): activity screen with live progress and the job log tail"
```

---

## Task 13: The 100,000-file scan benchmark

Spec §4.1 requires probing to be bounded and resumable at this scale, and §3.3 sets the target that no single database transaction exceeds about 50 ms, because `better-sqlite3` is synchronous and a long transaction freezes the API and the WebSocket with it. Probing became genuinely resumable at the end of P2b, so this is now measurable.

**This splits deliberately into a script and a test, and the split is a design decision.** The gate forbids asserting elapsed time — for good reason: a timing assertion is flaky in both directions and this repository has already shipped one that failed one run in fifteen. So the *numbers* come from an opt-in script an operator or maintainer runs and reads, and the *properties those numbers depend on* are asserted structurally in the suite: bounded transactions, exactly one reconciliation, an API that answers while a scan runs, and a resumption that re-probes a bounded number of files rather than starting again.

**Files:**
- Create: `scripts/bench-scan.mjs`
- Create: `packages/server/test/scan-bounded.test.ts`
- Modify: `package.json` (a `bench:scan` script)
- Modify: `docs/engineering-notes/p2-prerequisites.md`

**Interfaces:**
- Consumes: `scanLibrary` (`packages/server/src/scanner/scan-library.ts`), `runChunked`/`DEFAULT_CHUNK_SIZE` (`packages/server/src/db/chunked.ts`), `createApiHandler` (`packages/server/src/api/server.ts`), `startDaemon` (`packages/server/src/daemon/daemon.ts`).
- Produces: `pnpm bench:scan [--files 100000] [--data-dir <path>] [--keep]`, printing a table of `files`, `wallMs`, `filesPerSecond`, `transactions`, `maxTransactionMs`, `p99TransactionMs`, `peakRssMB`, and a second line for the rescan pass.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/scan-bounded.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createLibraryRepo } from '../src/db/library-repo.js';
import { createMediaFileRepo } from '../src/db/media-file-repo.js';
import { scanLibrary } from '../src/scanner/scan-library.js';
import { fakeFfprobe } from './helpers/fake-ffprobe.js';
import { startDaemonForTest } from './helpers/daemon-harness.js';

const FILES = 5_000;

/**
 * FIVE THOUSAND, not one hundred thousand. The 100k run is `pnpm bench:scan`,
 * which reports numbers a human reads; this suite asserts the STRUCTURAL
 * properties those numbers depend on, at a size the gate can afford. A test
 * that took four minutes would be a test people learn to skip.
 */
const seedLibrary = (): { dataDir: string; root: string } => {
  const dataDir = mkdtempSync(join(tmpdir(), 'trawlarr-bounded-'));
  const root = join(dataDir, 'library');
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < FILES; i += 1) {
    if (i % 100 === 0) mkdirSync(join(root, `d${String(i / 100)}`), { recursive: true });
    writeFileSync(join(root, `d${String(Math.floor(i / 100))}`, `f${String(i)}.mkv`), 'x');
  }
  return { dataDir, root };
};

describe('scanning a large library stays bounded', () => {
  it('never writes more rows in one transaction than the chunk size', async () => {
    const { dataDir, root } = seedLibrary();
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const library = createLibraryRepo(db).create({ name: 'Big', roots: [root], nowMs: 0 });

    const sizes: number[] = [];

    await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: fakeFfprobe(),
      nowMs: () => 0,
      onTransactionCommitted: (rows) => sizes.push(rows),
    });

    expect(createMediaFileRepo(db).countsByState(library.id).unknown).toBe(FILES);
    expect(sizes.length).toBeGreaterThan(1);
    // The synchronous driver blocks the event loop for the whole of a
    // transaction. One 5,000-row transaction is a five-second freeze of the
    // API, the websocket and every heartbeat.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers HTTP requests while a scan of that size is running', async () => {
    const { dataDir, root } = seedLibrary();
    const daemon = await startDaemonForTest(dataDir);
    await daemon.api('POST', '/libraries', { name: 'Big', roots: [root] });

    const answers: number[] = [];
    while (
      (await daemon.api<{ scanning: boolean }>('GET', `/libraries/${daemon.libraryId}/stats`))
        .scanning
    ) {
      answers.push(
        (await daemon.raw('GET', '/system/health')).status,
      );
      if (answers.length > 500) break;
    }

    // Every request answered 200 WHILE the walk was running. Not a duration:
    // a count of successful responses, which is the property the chunking
    // exists to provide.
    expect(answers.length).toBeGreaterThan(5);
    expect(answers.every((status) => status === 200)).toBe(true);
    await daemon.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('resumes rather than restarting when a scan is interrupted', async () => {
    const { dataDir, root } = seedLibrary();
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const library = createLibraryRepo(db).create({ name: 'Big', roots: [root], nowMs: 0 });

    const stopAfter = 1_000;
    await expect(
      scanLibrary({
        db,
        libraryId: library.id,
        ffprobePath: fakeFfprobe(),
        nowMs: () => 0,
        onProgress: (seen) => {
          if (seen >= stopAfter) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');

    const second = await scanLibrary({
      db,
      libraryId: library.id,
      ffprobePath: fakeFfprobe(),
      nowMs: () => 0,
    });

    // The whole point of resumability: the second scan re-probes only what
    // the interruption cost, not everything. The allowance is one chunk,
    // because at most one chunk's probes are ever in flight.
    expect(second.probed).toBeLessThanOrEqual(FILES - stopAfter + 500);
    expect(second.probed).toBeGreaterThan(0);

    const third = await scanLibrary({
      db, libraryId: library.id, ffprobePath: fakeFfprobe(), nowMs: () => 0,
    });
    expect(third.probed).toBe(0);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('marks nothing missing when a scan is interrupted', async () => {
    const { dataDir, root } = seedLibrary();
    const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
    migrate(db);
    const library = createLibraryRepo(db).create({ name: 'Big', roots: [root], nowMs: 0 });
    await scanLibrary({ db, libraryId: library.id, ffprobePath: fakeFfprobe(), nowMs: () => 0 });

    rmSync(join(root, 'd0'), { recursive: true, force: true });
    await expect(
      scanLibrary({
        db, libraryId: library.id, ffprobePath: fakeFfprobe(), nowMs: () => 0,
        onProgress: (seen) => { if (seen >= 500) throw new Error('interrupted'); },
      }),
    ).rejects.toThrow('interrupted');

    // Reconciliation needs the WHOLE picture; a partial walk that marked
    // files missing would delete a library from the ledger every time a
    // daemon was restarted mid-scan.
    expect(createMediaFileRepo(db).missingCount(library.id)).toBe(0);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
```

Two helpers this test needs, both created in this task:

- `packages/server/test/helpers/fake-ffprobe.ts` — writes a tiny executable script to a temp path that prints a fixed ffprobe JSON document (one h264 video stream, one aac audio stream, a `format` block with a duration and a size) and returns its path. Real ffprobe at this scale would be benchmarking ffprobe, not the scanner. It must be created once per process and reused.
- `startDaemonForTest(dataDir)` — a thin wrapper over `startDaemon({dataDir, port: 0, installSignalHandlers: false})` exposing `api`, `raw`, `libraryId` and `stop`. If `packages/server/test/` already has an equivalent (the daemon end-to-end suite has one), reuse it rather than writing a second.

If `scanLibrary` has no `onTransactionCommitted` seam, add one: an optional `(rows: number) => void` called from `runChunked`'s commit path, threaded through `ScanLibraryInput`. That seam — not a database event — is how the test observes transaction sizes.

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/test/scan-bounded.test.ts`
Expected: FAIL — the helper modules and the `onTransactionCommitted` seam do not exist.

- [ ] **Step 3: Add the seam and the helpers, then make the tests pass**

Add `onTransactionCommitted?: (rows: number) => void` to `ScanLibraryInput` and to `runChunked`'s options, calling it after each chunk commits. Write the two helpers. Run the suite until green — and if the resumption assertion fails, **that is a real finding, not a test to loosen**: record the measured re-probe count in `docs/engineering-notes/p2-prerequisites.md` and fix the scanner, since spec §4.1 promises this property by name.

- [ ] **Step 4: Write the benchmark script**

Create `scripts/bench-scan.mjs`:

```js
#!/usr/bin/env node
/**
 * Scan benchmark: build a synthetic library of N files, scan it cold, then
 * scan it again warm, and report the numbers spec 3.3 and 4.1 are about.
 *
 * NOT PART OF THE GATE. It builds 100,000 inodes and takes minutes, and its
 * output is a measurement a human reads rather than an assertion — the
 * suite's job is the structural properties (packages/server/test/
 * scan-bounded.test.ts), which is why this can afford to be slow and honest.
 *
 *   pnpm bench:scan --files 100000 --data-dir /var/tmp/trawlarr-bench
 */
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
```

```js
const { values } = parseArgs({
  options: {
    files: { type: 'string', default: '100000' },
    'data-dir': { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});

const fileCount = Number(values.files);
const dataDir = values['data-dir'] ?? join(tmpdir(), `trawlarr-bench-${String(Date.now())}`);
const root = join(dataDir, 'library');
mkdirSync(root, { recursive: true });

// A fake ffprobe. Real ffprobe at this scale benchmarks ffprobe, not the
// scanner — and the scanner is what spec 3.3 and 4.1 make promises about.
const probePath = join(dataDir, 'fake-ffprobe');
writeFileSync(
  probePath,
  `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
    ],
    format: { format_name: 'matroska,webm', duration: '120.0', size: '1024', bit_rate: '68' },
  })}\nJSON\n`,
);
chmodSync(probePath, 0o755);

for (let i = 0; i < fileCount; i += 1) {
  const dir = join(root, `d${String(Math.floor(i / 100))}`);
  if (i % 100 === 0) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `f${String(i)}.mkv`), 'x');
}

// The BUILT artifact, deliberately: a benchmark of src/ through a loader is
// not what ships. If dist is stale the number is wrong, so say so loudly.
const { openDatabase } = await import('../packages/server/dist/db/connection.js');
const { migrate } = await import('../packages/server/dist/db/migrate.js');
const { createLibraryRepo } = await import('../packages/server/dist/db/library-repo.js');
const { scanLibrary } = await import('../packages/server/dist/scanner/scan-library.js');

const db = openDatabase({ file: join(dataDir, 'trawlarr.db') });
migrate(db);
const library = createLibraryRepo(db).create({ name: 'Bench', roots: [root], nowMs: Date.now() });

const pass = async (label) => {
  const durations = [];
  let last = performance.now();
  const started = performance.now();
  const summary = await scanLibrary({
    db,
    libraryId: library.id,
    ffprobePath: probePath,
    nowMs: () => Date.now(),
    onTransactionCommitted: () => {
      const now = performance.now();
      durations.push(now - last);
      last = now;
    },
  });
  const wallMs = performance.now() - started;
  const sorted = [...durations].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        pass: label,
        files: summary.seen,
        probed: summary.probed,
        wallMs: Math.round(wallMs),
        filesPerSecond: Math.round(summary.seen / (wallMs / 1000)),
        transactions: durations.length,
        maxTransactionMs: Number(Math.max(0, ...durations).toFixed(1)),
        p99TransactionMs: Number((sorted[Math.floor(sorted.length * 0.99)] ?? 0).toFixed(1)),
        peakRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      null,
      2,
    ),
  );
};

await pass('cold');
await pass('warm');

db.close();
if (!values.keep) rmSync(dataDir, { recursive: true, force: true });
```

Add to the root `package.json`:

```json
    "bench:scan": "node scripts/bench-scan.mjs"
```

- [ ] **Step 5: Run the real benchmark at 100,000 files**

```bash
nvm use 22 && tsc --build --force && pnpm build
pnpm bench:scan --files 100000 --data-dir /var/tmp/trawlarr-bench
```

Expected shape, and what each number means when it is wrong:
- `maxTransactionMs` should be well under 50 ms. Above that, the API and the WebSocket freeze for exactly that long, repeatedly, during every scan.
- The warm pass should report `probed: 0` and be much faster than the cold pass. Anything else means unchanged files are being re-probed, which is the expensive step the skip exists to avoid.
- `peakRssMB` should not scale with the file count. If it does, something accumulates per file across the walk.

- [ ] **Step 6: Record the results**

Add a section to `docs/engineering-notes/p2-prerequisites.md` titled "P2c — what the 100k scan benchmark measured", giving the machine, the filesystem, the file count, the numbers from both passes, and — most importantly — anything that did **not** meet the target, with the consequence spelled out. If the numbers are good, say so plainly; a benchmark whose result is never written down has to be run again by the next person.

- [ ] **Step 7: Run the gate and commit**

```bash
nvm use 22 && tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add scripts/bench-scan.mjs packages/server/test packages/server/src/scanner packages/server/src/db/chunked.ts \
  package.json pnpm-lock.yaml docs/engineering-notes/p2-prerequisites.md
git commit -m "test(server): 100k scan benchmark and the bounded-scan invariants behind it"
```

---

## Task 14: Bounded-concurrency probing

**This task is conditional on Task 13's numbers, and may be cut.** Probing is currently sequential: one `ffprobe` at a time inside the walk. Spec §4.1 says it "runs at a bounded concurrency", so if the benchmark shows a cold scan of 100,000 files taking longer than the owner will tolerate on his first run, this closes the gap. If the cold pass is acceptable, skip this task and record that decision in the engineering note instead — a restructured scanner is not free, and the resumability property it would put at risk was expensive to get.

The generalisation is small and preserves the existing rule exactly. Today: *at most one probe's work is at risk*, because a probe is flushed in the transaction immediately following the ffprobe that produced it. With a window: *at most one window's probes are at risk*, because the window's results are flushed together the moment the window closes. `reconcileMissing` stays a single call outside the loop, reachable only by the `for await` running to completion — that is what makes an interrupted scan keep its probes and mark nothing missing, and it must not move.

**Files:**
- Modify: `packages/server/src/scanner/scan-library.ts`
- Modify: `packages/server/src/db/settings-repo.ts` (add `scan.probeConcurrency`, default `4`)
- Modify: `packages/server/src/config/env-settings.ts` (bind `TRAWLARR_PROBE_CONCURRENCY`)
- Modify: `packages/server/src/scanner/scan-library.test.ts`
- Modify: `docker/compose.yml`, `docs/deployment.md`

**Interfaces:**
- Consumes: `scanLibrary`'s existing walk and `runChunked` flush.
- Produces: `ScanLibraryInput` gains `probeConcurrency?: number` (default `4`); `ScanSettings` gains `probeConcurrency: number`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/scanner/scan-library.test.ts`:

```ts
  it('probes several files at once, without exceeding the configured bound', async () => {
    const { db, libraryId, root } = seedLibraryWithFiles(20);
    let inFlight = 0;
    let peak = 0;

    await scanLibrary({
      db,
      libraryId,
      ffprobePath: 'unused',
      nowMs: () => 0,
      probeConcurrency: 4,
      probeFileImpl: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return fixedProbe(input.path);
      },
    });

    // Both halves matter: a bound that is never reached proves nothing, and
    // a bound that is exceeded is an unbounded fan-out at 100,000 files.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('still keeps every completed probe when the walk is interrupted', async () => {
    const { db, libraryId } = seedLibraryWithFiles(20);
    await expect(
      scanLibrary({
        db, libraryId, ffprobePath: 'unused', nowMs: () => 0, probeConcurrency: 4,
        probeFileImpl: async (input) => fixedProbe(input.path),
        onProgress: (seen) => { if (seen >= 12) throw new Error('interrupted'); },
      }),
    ).rejects.toThrow('interrupted');

    const rows = createMediaFileRepo(db).query({ libraryId, limit: 100, offset: 0 });
    expect(rows.items.filter((row) => row.probe_json !== null).length).toBeGreaterThan(0);
    // Facts about one file are re-derivable and are kept; a judgement needing
    // the whole picture is not made at all.
    expect(createMediaFileRepo(db).missingCount(libraryId)).toBe(0);
  });
```

`probeFileImpl` is a seam that must be added to `ScanLibraryInput` in this task if it does not already exist, defaulting to the real `probeFile`. `seedLibraryWithFiles(n)` and `fixedProbe(path)` are helpers in `scan-library.test.ts`: reuse the file's existing equivalents if they are there, and add them beside the file's other helpers if they are not — `seedLibraryWithFiles` returns `{db, libraryId, root}` for a migrated in-memory database with `n` one-byte `.mkv` files, and `fixedProbe` returns the same canned ffprobe document `fakeFfprobe` prints.

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/src/scanner/scan-library.test.ts`
Expected: FAIL — `peak` is `1`, because probing is sequential.

- [ ] **Step 3: Implement the window**

In `scan-library.ts`, replace the single in-loop `await probeFile(...)` with a window: collect up to `probeConcurrency` files needing a probe, `await Promise.all` their probes, push all results into `pending`, and `flush()` once. Files not needing a probe continue to accumulate to a full chunk without flushing, exactly as they do now — that is what keeps a 100,000-file rescan at roughly 200 transactions rather than 100,000. A probe that rejects is recorded as `unreadable` for that file only, never failing the window.

The invariants to re-verify after the change, each already covered by an existing test — run the whole scanner suite, not just the new cases:
- `reconcileMissing` is still a single call outside the `for await`.
- The in-flight-output guard still queries `listRunningPaths` **fresh per walked file**; a window must not hoist that read.
- `summary.probed` still counts only real `probeFile` invocations.

- [ ] **Step 4: Run the test and watch it pass**

Run: `nvm use 22 && tsc --build --force && pnpm vitest run packages/server/src/scanner/`
Expected: PASS, including every pre-existing scanner test unchanged.

- [ ] **Step 5: Make it configurable and measure again**

Add `probeConcurrency: number` to `ScanSettings` (default `4`, validated 1–64), bind `TRAWLARR_PROBE_CONCURRENCY` to `scan.probeConcurrency` as a seed in `ENV_BINDINGS`, add it to `docker/compose.yml` as a commented line, and document it in `docs/deployment.md` with the trade-off stated: more concurrency means a faster first scan and more IO contention with the transcodes running beside it.

Re-run `pnpm bench:scan --files 100000` and append the new numbers to the engineering note beside the old ones.

- [ ] **Step 6: Run the gate and commit**

```bash
nvm use 22 && tsc --build --force && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src docker/compose.yml docs
git commit -m "perf(server): bounded-concurrency probing, preserving resumability"
```

---

## What this phase deliberately does not build

Each of these is a decision, not an oversight. State it when reporting the phase.

- **Plugin source syncing and the plugin browser backend.** `GET/POST/PUT/DELETE /plugins/sources` and `POST /plugins/sources/:id/sync` keep their named 501s. The seven first-party nodes are enough for the transcode stack this phase targets, and syncing brings a whole subsystem — fetching from git/HTTP into the data directory, versioning, validation on load, licence questions about what lands on the operator's disk. **This is the deferral most likely to be wrong**, and the answer depends entirely on the owner's plugin stack: if it does anything beyond "transcode video to a target codec", the community-plugin path may have to come forward. Question 3 below decides it.
- **The flow graph editor (React Flow canvas).** Templates in front, canvas behind — this phase ships only the front. A flow that needs editing is edited as JSON through `PUT /flows/:id` or `trawlarr flow add --file`.
- **Playwright end-to-end tests (spec §9).** Adding a browser matrix to the gate is a phase's worth of work on its own. The UI's decision logic is covered by DOM-free unit tests; the screens are verified by hand against a real daemon, which is also this phase's forcing goal.
- **The Files table, stats charts, Settings, Nodes and the schedule-window editor (spec §8).** Every one of these has a working API endpoint already; the CLI and `curl` remain the path until P3.
- **Dry run and trial run in the UI.** `POST /flows/:id/dry-run` exists and is unexposed.
- **Contract-level reporting (spec §2.10).** `GET /system/version` keeps reporting `contractLevel: null` with its stated reason.
- **Hardware detection.** Standing ruling: hardware is declared. Task 4 adds a *preflight that checks a declaration*, which is not the same thing and does not change one.
- **A queue for the `health` worker class.** It stays a type with no queue until health-check nodes exist in v1.1.
- **Extracting `@trawlarr/node-agent`.** Standing ruling from P2b; a two-file move in v1.2.
- **Remux, audio, track-stripping, move and webhook first-party nodes.** Named honestly in the migration guide as "not yet" rather than implied.

---

## Questions for the owner about his Unmanic stack

These gate the *content* of Task 6's template and the migration guide, and question 3 gates whether the plugin-syncing deferral holds. Ask them before Task 6; Tasks 1–5 do not depend on the answers.

1. **What is in your library's plugin stack, in order?** The plugin names as the Unmanic UI lists them, top to bottom — including any that only filter or skip files.
2. **What are you transcoding to?** Target codec, the exact encoder (`hevc_nvenc`? `libx265`?), the quality setting and its mode (CQ/CRF value, or a target bitrate), and the output container.
3. **Are any of those plugins community/third-party rather than Unmanic built-ins — and do you need them, or would a first-party equivalent do?** This is the one that decides whether plugin source syncing has to come forward into this phase.
4. **What decides whether a file is processed at all?** Already-in-target-codec, bitrate above a threshold, resolution, file size, age, path pattern — and is anything excluded outright?
5. **What happens to audio and subtitles?** Passed through untouched, transcoded (to what), or filtered by language/commentary? Same question for the container: are you remuxing, or leaving it as it is?
6. **What happens to the original file, and to sidecars?** Deleted, kept for N days, moved elsewhere? And do you have `.srt`/`.nfo`/artwork alongside your media that must follow a renamed file?
7. **What is the actual mount layout?** Host paths, container paths, and — decisively — whether the media is one filesystem or several, and whether it is a local disk, NFS, SMB or ZFS. This determines where staging can live and whether the filesystem watcher can be trusted or the periodic rescan is doing all the work.
8. **Is any of the library hardlinked from a torrent client that is still seeding?** Trawlarr skips hardlinked files by default; if yours are hardlinked and you expect them processed, nothing will happen and the reason will be in a warning you have to go looking for.
9. **How many files, roughly, and which NVIDIA card?** The file count sets expectations for the first scan; the card's NVENC session limit is what `TRAWLARR_HARDWARE_CAPS=nvenc=N` must be set to, because exceeding it fails jobs rather than queueing them.
10. **What are your current `NUMBER_OF_WORKERS` and `SCHEDULE_FULL_SCAN_MINUTES`, and do you want time-of-day windows?** Trawlarr can express "two workers by day, six overnight" directly; Unmanic cannot, so this may be something you have been working around.
11. **Do you need the UI reachable from other machines?** It binds `0.0.0.0` inside the container and is published by compose; there is no TLS and the only authentication is a shared key, so anything beyond your LAN wants a reverse proxy in front.
12. **Are you migrating in place, or side by side?** Running both against the same library at once means two tools replacing the same files — the answer determines whether the guide's first step is "stop Unmanic" or "point trawlarr at a copy".

---

## Verification at the end of the phase

Before declaring P2c complete:

1. `nvm use 22 && tsc --build --force && pnpm check:refs && pnpm build && pnpm lint && pnpm test && pnpm audit:licenses` — green, 0 skipped, test count above 1911, licence count recorded.
2. `git diff --stat a88e551..HEAD -- packages/server/src/worker/run-job.test.ts` prints nothing.
3. `docker build -t trawlarr:dev .` succeeds, and `docker compose -f docker/compose.yml up -d` against a real directory of media converges it, observed in the UI, without a single CLI command after `docker compose up`.
4. Every step in `docs/migrating-from-unmanic.md` has been executed exactly as written, at least once, by someone following it rather than by its author from memory.
5. `docs/engineering-notes/p2-prerequisites.md` has a P2c section recording the benchmark numbers, anything the phase found, and every deferral above with its reason.
