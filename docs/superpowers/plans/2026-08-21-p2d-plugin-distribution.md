# P2d — Plugin Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tdarr community flow plugins the owner's production pipeline already depends on installable, resolvable and provably correct under trawlarr, so parity is reached by distributing existing plugins rather than by duplicating them.

**Architecture:** Trawlarr already loads and runs Tdarr flow plugins — the compatibility harness proves it for five of them. What it cannot do is *install* one: `/plugins/sources*` answers 501, the `plugin` and `plugin_source` tables are never written, and a flow can only name a community plugin by absolute path. This phase closes that in four layers, beneath the API and never inside it until the last task: (1) extend the compatibility harness to the four plugins his stack needs, including real-ffmpeg assertions on bytes that reach disk; (2) fix the one **host** defect those assertions expose — `Verify Output` rejects every intentional stream removal, which makes every stream-removing community plugin unusable in a flow that replaces its original; (3) a plugin registry and a source syncer that fetch from an HTTPS tarball or a local directory, with no central service anywhere; (4) resolution of an installed plugin id at both points that need it — flow validation in the daemon and plugin loading inside the forked, database-less worker — then a CLI, then the five 501 routes, then his actual pipeline as a validated flow template.

**Tech Stack:** Node 22, TypeScript 5.6, pnpm 9.12 workspaces, better-sqlite3, vitest 2.1, Node's global `fetch`, the system `tar`, real `ffmpeg`/`ffprobe`. **No new dependencies** — `package.json` is out of bounds this phase (see Global Constraints), and nothing below needs one.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22.** Run `nvm use 22` before anything.
- **The gate is `pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`.** All four, every task, before the commit. Entering this phase it is green at **2090 tests, 0 skipped, 281 packages audited**. A task may only raise the test count; it may never raise the skip count above 0.
- **Do not touch these paths.** Another agent is mid-work on the web UI in them: `packages/web`, `packages/server/src/api`, `Dockerfile`, `package.json`, `vitest.config.ts`, `.prettierignore`. **Task 8 is the single, deliberate exception** — it edits exactly one file, `packages/server/src/api/routes/plugins.ts`, replacing five `notImplemented(...)` handlers with delegations to modules that are already fully tested by then. Task 8 is sequenced last but one so the collision window is as small as possible; if that file is being actively rewritten when you reach it, land Tasks 1–7 and 9 and hold Task 8.
- **`package.json` is out of bounds, so no new runtime or dev dependency may be added.** Everything here uses Node 22 built-ins (`fetch`, `node:fs`, `node:child_process`, `node:crypto`) or the system `tar`. If a task appears to need a package, the design is wrong — re-read the task.
- **MIT only.** `pnpm audit:licenses` enforces the allow-list (`scripts/audit-licenses.mjs`). **Nothing in this repository may be derived from Tdarr, Tdarr_Plugins or Unmanic.** The plugin corpus under `cache/tdarr-plugins` is **GPL-3.0, is never committed, and is never copied from**. You may *read* it to write tests that run it and to record factual interface details (a plugin's folder name, its input `name` keys, its output numbers) — that is exactly what the existing compatibility harness does. You may not copy or paraphrase its code, comments or types into `packages/`.
- **The corpus must be fetched before the compat suites mean anything:** `pnpm compat:fetch`. It pins `HaveAGitGat/Tdarr_Plugins` at SHA `26c97a52f9dcf5fc6faeb751071cb82cdf97ca4e`.
- **TDD, and tests assert observable state** — database rows, bytes and codecs on disk, real ffmpeg argv, HTTP status codes and response bodies. **Never assert log text. Never assert elapsed time.** This repository has shipped a green concurrency test against a broken lock, and a `toContain('0% converged')` that passed against `100% converged`.
- **At least one test per capability must run real ffmpeg and assert what the output file actually contains.** The cover-art data-loss bug was invisible to every argument-level test in the fidelity pass and was caught only by a real-ffmpeg assertion. Task 2 exists solely to honour this.
- **Codec and stream flags are addressed by output index (`-c:{outputIndex}`), never by type specifier (`-c:v`).** ffmpeg resolves `-c` by last-matching specifier, and cover art reclassified to `attachment` by `beginFfmpegCommand` is still a video-typed *output* stream. Verified against real ffmpeg: `-c:v libx265` produced `hevc, hevc, aac`; `-c:1 libx265` produced `mjpeg, hevc, aac`. No task here writes a codec flag, but Task 2 asserts that a community plugin's output preserves cover art, which is the same bug seen from the other side.
- **`mapArgs` is seeded per stream as `['-map', '0:<ffprobe index>']`.** The stream-removing and stream-adding plugins under test in Tasks 1–2 are exactly the ones that depend on this being right.
- **`file_size`, `oldSize` and `newSize` are MEGABYTES at the plugin boundary** and bytes in storage; `bit_rate` is bits/second. Do not "unify" them.
- **The contract preserves upstream misspellings deliberately:** `overallOuputArguments`, `lastSuccesfulPlugin`. Do not correct them.
- **Per-stream `inputArgs` are hoisted into one global preamble** by the compiler.
- **Flow validation rejects** duplicate node ids, dangling edges, an output number the node's own `details()` does not declare, a flow with no start node, more than one start node, and two edges leaving one output. A plugin this host cannot resolve is treated as **unknown, not wrong** — which is what lets a flow referencing a not-yet-synced community plugin be stored. Task 9 depends on that being true and must not change it.
- **`packages/server/src/worker/run-job.test.ts` must stay byte-for-byte unmodified.** Verify with `git diff --stat -- packages/server/src/worker/run-job.test.ts` before every commit; it must print nothing.
- **After editing any file under `packages/server/src` — including a test file there — run `tsc --build --force` before running the suites.** `.tsbuildinfo` lives outside `dist`, so a plain `pnpm build` can emit nothing and leave the end-to-end suites validating a stale `dist/cli.js` while reporting green.
- **Every new suite must be unable to skip silently.** Conditions gating `describe.runIf` are computed **synchronously at module scope**, because `describe.runIf` is evaluated at collection time before any async `beforeAll`. Reuse `test-support/tool-availability.ts`, which answers `false` only for a genuine `ENOENT` and throws for every other failure.
- **The owner's parity target, verbatim**, for Task 9's template: encoder `hevc_nvenc`, quality `23`, preset `4`, `-max_muxing_queue_size 2048`, destination container `mkv`, a language filter that keeps `eng` and is safe when language metadata is missing, and a custom pan formula available for stereo downmix.

---

## What was verified before this plan was written

The premise of this phase is that **the capability gap does not exist** — every capability previously scoped as a first-party node already ships as a Tdarr community flow plugin. That was checked against the pinned corpus at `cache/tdarr-plugins/FlowPlugins/CommunityFlowPlugins`, not assumed:

| Capability his stack needs | Existing community plugin | Verified |
| --- | --- | --- |
| Remux to a different container | `ffmpegCommand/ffmpegCommandSetContainer` | Inputs `container`, `forceConform`; one output. Gates on the *file path's* extension, so it is idempotent by construction. Pushes `-fflags +genpts` for `ts`/`avi`/`mpg`/`mpeg` sources. |
| Ensure 2ch AAC audio | `ffmpegCommand/ffmpegCommandEnsureAudioStream` | Inputs `audioEncoder`, `language`, `channels`, `enableBitrate`, `bitrate`, `enableSamplerate`, `samplerate`; one output. Semantics are **add if absent**, and it retries with `und` when the requested language finds nothing. |
| Keep/remove streams by language | `ffmpegCommand/ffmpegCommandRemoveStreamByProperty` | Inputs `codecType`, `propertyToCheck`, `valuesToRemove`, `condition`; one output. |
| Notify on completion | `tools/webRequest` ("Send Web Request") and `tools/notifyRadarrOrSonarr` | `webRequest` takes an arbitrary `method`, `requestUrl`, `requestHeaders`, `requestBody`, plus `output2StatusCodes` and `output2OnNetworkError`; outputs 1 and 2. It calls `args.deps.axios`, which trawlarr already injects as real axios. |
| `-max_muxing_queue_size 2048` | `ffmpegCommand/ffmpegCommandCustomArguments` | Inputs `inputArguments`, `outputArguments`, split on spaces into `overallInputArguments`/`overallOuputArguments`. |
| hevc_nvenc / preset / quality | `ffmpegCommand/ffmpegCommandSetVideoEncoder` | Inputs `outputCodec`, `ffmpegPreset`, `ffmpegQuality`, `hardwareEncoding`, `hardwareType`, `hardwareDecoding`, `forceEncoding`. Already covered by the existing compat suite. |
| Stereo downmix with a custom formula | `ffmpegCommand/ffmpegCommandCustomArguments` | A pan filter is an ordinary ffmpeg argument string. |

Two of his Unmanic-side safety settings were checked specifically, because a language filter that deletes every audio track is catastrophic on a real library:

- **`keep_undefined` is already the plugin's unconditional behaviour.** `ffmpegCommandRemoveStreamByProperty` returns early for any stream whose property reads `undefined` or `null`, so a stream with no `tags.language` is never removed. **Not a gap — nothing to build.**
- **`fail_safe` has no equivalent in the plugin.** Nothing stops it removing every audio stream. Today that is masked by an accidental backstop (`Verify Output` rejects *any* stream loss), and Task 3 removes that accident — so Task 3 must replace it with a deliberate gate in the same commit. This is the one genuinely missing behaviour in the whole phase, and it belongs to the **host**, not to a new node: a gate in `Verify Output` protects against any plugin, community or first-party, present or future, whereas a safety flag on one node protects only against that node.

**Nothing else is missing, and no first-party node is planned.** Note that spec §7 anticipated shipping first-party "set audio codec, remux container, webhook notify" nodes; the owner's direction supersedes it, and Task 9 records that divergence in the engineering notes.

### The one host defect this exposes

`verifyOutput` in `packages/engine/src/executor/verify-output.ts` computes `expected` as the **original probe's** stream count and fails when the output has fewer. Every stream-removing community plugin therefore produces an output that fails verification, which routes to output 2, which refuses the replacement, which burns three attempts and lands the file in `failed`. That is `ffmpegCommandRemoveStreamByProperty`, `ffmpegCommandRemoveSubtitles`, `ffmpegCommandRemoveDataStreams`, and `ffmpegCommandSetContainer` with `forceConform` on — four plugins, one of which is in his pipeline. It is a host bug, and Task 3 fixes it.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `packages/engine/test/compat/parity-plugins.test.ts` | Argument-level compatibility cases for the four plugins his stack needs, plus `webRequest` against a real local HTTP server. |
| `packages/engine/test/compat/parity-plugins-ffmpeg.test.ts` | The same plugins, compiled and run through **real ffmpeg**, asserting codecs, containers and stream lists on disk. |
| `packages/server/src/plugins/plugin-id.ts` | The installed-plugin id scheme, and parsing/formatting it. One definition, because a second one is a latent mismatch between validation and execution. |
| `packages/server/src/plugins/plugin-id.test.ts` | Its tests. |
| `packages/server/src/plugins/plugin-repo.ts` | `plugin_source` and `plugin` row access: sources CRUD, installed-plugin upsert/list/remove, and `resolveAbsPaths()`. |
| `packages/server/src/plugins/plugin-repo.test.ts` | Its tests, against a real in-memory database. |
| `packages/server/src/plugins/fetch-source.ts` | Materialising a source into a local directory: HTTPS tarball via `fetch` + `tar`, or a local directory. Contains the path-traversal guard. |
| `packages/server/src/plugins/fetch-source.test.ts` | Its tests, including a malicious tarball. |
| `packages/server/src/plugins/sync-source.ts` | Walking a materialised source for flow plugins, loading each to capture `details()`, and writing the `plugin` table. |
| `packages/server/src/plugins/sync-source.test.ts` | Its tests, against the real corpus and against hand-built fixtures. |
| `packages/server/src/plugins/registry.ts` | The one place that answers "what does this plugin id resolve to": used by flow validation and by job-payload construction. |
| `packages/server/src/plugins/registry.test.ts` | Its tests. |
| `packages/server/test/plugin-install-end-to-end.test.ts` | Sync a local source, build a flow that names an installed plugin, run it against a real file, assert the file on disk changed. |

**Modified**

| File | Change |
| --- | --- |
| `packages/engine/src/executor/verify-output.ts` | `verifyOutput` takes the flow's intended stream count and an audio-loss gate; the runner supplies both. |
| `packages/engine/src/executor/verify-output.test.ts` | Cases for both. |
| `packages/plugins-core/src/verifyOutput/index.ts` | Tooltip and a new `requireAudioIfOriginalHadAudio` input. |
| `packages/server/src/flow/node-capabilities.ts` | Resolve an installed plugin id through the registry before falling back to treating the id as a path. |
| `packages/server/src/db/flow-repo.ts` | Pass the registry-backed resolver through. |
| `packages/server/src/worker/job-payload.ts` | `JobPayload` gains `pluginPaths: Record<string, string>`. |
| `packages/server/src/worker/run-payload.ts` | `loadPlugin` consults `payload.pluginPaths` before treating the id as a path. |
| `packages/server/src/daemon/library-health.ts` | Resolve installed plugins, so using one does not pause the library. |
| `packages/server/src/cli.ts` | `trawlarr plugin` command group. |
| `packages/server/src/flow/templates.ts` | `requiredPlugins` on `FlowTemplate`, and his pipeline as a new template. |
| `packages/server/src/api/routes/plugins.ts` | **Task 8 only.** The five 501s become real handlers. |
| `docs/migrating-from-unmanic.md` | Replace the "Not yet" rows with the plugin that does each job, and add the plugin-install walkthrough. |
| `docs/engineering-notes/p2-prerequisites.md` | This phase's findings. |
| `docs/flows/` | The new template, checked in and drift-tested like the existing two. |

---

## Task 1: Prove the four parity plugins load, route and compile

The four plugins his pipeline needs are already in the corpus. Before building any distribution machinery, pin their behaviour under **trawlarr's** host — its file-object projection, its `beginFfmpegCommand` (which reclassifies cover art to `attachment`, unlike upstream), its `mapArgs` seeding and its compiler. A failure here is a trawlarr bug to fix, never a reason to write a replacement node.

The existing `packages/engine/test/compat/community-plugins.test.ts` is 420 lines and already carries three distinct concerns. Rather than growing it further, this task adds a sibling suite with its own fixture — a file whose streams actually exercise a language filter (two audio tracks in different languages, one of them untagged) and cover art.

**Files:**
- Create: `packages/engine/test/compat/parity-plugins.test.ts`
- Read (do not modify): `packages/engine/test/compat/community-plugins.test.ts`, `packages/engine/test/compat/corpus.ts`

**Interfaces:**
- Consumes: `corpusAvailable()`, `pluginPath(relative)`, `CORPUS_DIR` from `./corpus.js`; `createPluginLoader` from `../../src/host/loader.js`; `buildPluginDeps` from `../../src/host/deps.js`; `createCrudTransDbn` from `../../src/host/crud-trans-dbn.js`; `createAxiosMiddleware` from `../../src/host/axios-middleware.js`; `toPluginFileObject` from `../../src/host/file-object.js`; `beginFfmpegCommand`, `compileFfmpegArgs`, `emptyFfmpegCommand` from `@trawlarr/core`.
- Produces: nothing importable. This is a pinning suite; Task 2 rebuilds the same fixtures against real ffmpeg rather than importing them, because a shared fixture between an argument-level suite and a real-ffmpeg suite couples them to each other's execution order.

- [ ] **Step 1: Write the fixture and the first failing test**

Create `packages/engine/test/compat/parity-plugins.test.ts`. The probe below is the whole point of the task: stream 0 is cover art (`attached_pic`), stream 1 the real video, stream 2 English 5.1 audio, stream 3 Japanese stereo audio, stream 4 audio with **no language tag at all**, stream 5 an English subtitle. That shape is what makes a language filter's behaviour observable and is drawn from what a real disc rip looks like.

```ts
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand, compileFfmpegArgs, emptyFfmpegCommand } from '@trawlarr/core';
import { createPluginLoader } from '../../src/host/loader.js';
import { buildPluginDeps } from '../../src/host/deps.js';
import { createCrudTransDbn } from '../../src/host/crud-trans-dbn.js';
import { createAxiosMiddleware } from '../../src/host/axios-middleware.js';
import { toPluginFileObject } from '../../src/host/file-object.js';
import { CORPUS_DIR, corpusAvailable, pluginPath } from './corpus.js';

const available = corpusAvailable();

if (!available) {
  console.warn(
    '[compat] Tdarr plugin corpus not found at ' +
      CORPUS_DIR +
      ' — skipping parity plugin tests. Run `pnpm compat:fetch` first.',
  );
}

/**
 * A real disc-rip shape: cover art first, then video, then three audio tracks
 * (English 5.1, Japanese stereo, and one with NO language tag), then a
 * subtitle. The untagged track is the important one — his Unmanic config sets
 * `keep_undefined`, and this fixture is what proves the Tdarr plugin already
 * behaves that way without it.
 */
const probe: ProbeData = {
  format: { duration: '1440.0', bit_rate: '8000000', nb_streams: 6, size: '8000000000' },
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'mjpeg',
      width: 600,
      height: 900,
      disposition: { attached_pic: 1 },
    },
    { index: 1, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'eng' } },
    { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'jpn' } },
    { index: 4, codec_type: 'audio', codec_name: 'ac3', channels: 6 },
    { index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
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
      nodeID: 'test',
      nodeName: 'test',
      serverURL: '',
      serverIP: '',
      serverPort: '',
      handbrakePath: 'HandBrakeCLI',
      ffmpegPath: 'ffmpeg',
      mkvpropeditPath: 'mkvpropedit',
      pathTranslators: [],
      platform_arch_isdocker: 'linux_x64_false',
      logLevel: 'info',
      processPid: 1,
      priority: 0,
      apiKey: '',
      maxLogSizeMB: 10,
      pollInterval: 1000,
      nodeType: 'mapped',
      unmappedNodeCache: '',
      startPaused: false,
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
    workDir: '/tmp/trawlarr-parity',
    platform: 'linux',
    arch: 'x64',
    platform_arch_isdocker: 'linux_x64_false',
    ffmpegPath: 'ffmpeg',
    handbrakePath: 'HandBrakeCLI',
    mkvpropeditPath: 'mkvpropedit',
    nodeHardwareType: 'cpu',
    workerType: 'transcode',
    job: {
      version: '1.0.0',
      footprintId: '2049:42',
      jobId: 'j1',
      start: 1_700_000_000_000,
      type: 'transcode',
      fileId: 'f1',
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

const SET_CONTAINER = 'ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js';
const ENSURE_AUDIO = 'ffmpegCommand/ffmpegCommandEnsureAudioStream/1.0.0/index.js';
const REMOVE_BY_PROPERTY = 'ffmpegCommand/ffmpegCommandRemoveStreamByProperty/1.0.0/index.js';
const CUSTOM_ARGUMENTS = 'ffmpegCommand/ffmpegCommandCustomArguments/1.0.0/index.js';
const WEB_REQUEST = 'tools/webRequest/1.0.0/index.js';
const NOTIFY_ARR = 'tools/notifyRadarrOrSonarr/1.0.0/index.js';

const run = async (rel: string, inputs: Record<string, unknown>, withCommand: boolean) => {
  const abs = pluginPath(rel);
  // Assert existence rather than gating on it: a directory upstream renamed or
  // version-bumped IS the drift this suite exists to detect, and `it.runIf`
  // would report green while running nothing.
  expect(existsSync(abs)).toBe(true);
  const loaded = createPluginLoader().load(abs);
  const args = argsFor(inputs, withCommand);
  const output = await loaded.module.plugin(args);
  expect(loaded.details.outputs.map((o) => o.number)).toContain(output.outputNumber);
  return { loaded, args, output };
};

describe.runIf(available)('Set Container', () => {
  it('remuxes to mp4 by setting the container and marking the command for processing', async () => {
    const { output } = await run(SET_CONTAINER, { container: 'mp4', forceConform: false }, true);
    expect(output.variables.ffmpegCommand.container).toBe('mp4');
    expect(output.variables.ffmpegCommand.shouldProcess).toBe(true);
  });

  it('does nothing when the file is already in the requested container', async () => {
    // The fixture's path is Sample.mkv. Asking for mkv must leave the command
    // untouched, which is what makes this node free on a converged library —
    // `deriveShouldProcess` then reports no work and Execute skips ffmpeg.
    const { output } = await run(SET_CONTAINER, { container: 'mkv', forceConform: false }, true);
    expect(output.variables.ffmpegCommand.shouldProcess).toBe(false);
    expect(output.variables.ffmpegCommand.streams.some((s) => s.removed === true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm compat:fetch && npx vitest run packages/engine/test/compat/parity-plugins.test.ts`
Expected: FAIL — the file does not compile yet if you have typos, and more usefully, this first run is what confirms the corpus paths are right. If `existsSync(abs)` is false, the corpus was not fetched or upstream moved the plugin; fix that before continuing rather than weakening the assertion.

- [ ] **Step 3: Make it pass**

There is no implementation to write — these plugins already exist and already work. If a case fails, that is a **trawlarr host bug**: fix it in `packages/engine/src` or `packages/core/src` and say so in the commit message. Do not adjust the assertion to match broken behaviour, and do not write a first-party replacement.

- [ ] **Step 4: Add the language-filter and ensure-audio cases**

Append to the same file:

```ts
describe.runIf(available)('Remove Stream By Property', () => {
  it('removes audio whose language is not English, and keeps the English track', async () => {
    const { output } = await run(
      REMOVE_BY_PROPERTY,
      {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      true,
    );
    const streams = output.variables.ffmpegCommand.streams;
    // Index 2 is the English track and survives; index 3 is Japanese and goes.
    expect(streams[2]!.removed).toBe(false);
    expect(streams[3]!.removed).toBe(true);
  });

  it('never removes a stream whose language tag is absent', async () => {
    // His Unmanic config sets `keep_undefined` explicitly. This asserts the
    // Tdarr plugin already behaves that way unconditionally, which is why no
    // first-party equivalent and no extra safety input is needed on the NODE.
    // The catastrophic case it guards is a rip whose audio carries no
    // language metadata at all: without this, `not_includes eng` deletes
    // every audio track in the library.
    const { output } = await run(
      REMOVE_BY_PROPERTY,
      {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      true,
    );
    expect(output.variables.ffmpegCommand.streams[4]!.removed).toBe(false);
  });

  it('leaves the video stream and the cover art alone when filtering audio', async () => {
    const { output } = await run(
      REMOVE_BY_PROPERTY,
      {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      true,
    );
    const streams = output.variables.ffmpegCommand.streams;
    // beginFfmpegCommand reclassifies attached_pic to 'attachment', so a
    // codecType filter of 'audio' cannot reach it. Pinned because the
    // reclassification is a trawlarr divergence from upstream and a community
    // plugin has to keep working across it.
    expect(streams[0]!.codec_type).toBe('attachment');
    expect(streams[0]!.removed).toBe(false);
    expect(streams[1]!.removed).toBe(false);
  });

  it('compiles to argv that maps every surviving stream and no removed one', async () => {
    const { output } = await run(
      REMOVE_BY_PROPERTY,
      {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      true,
    );
    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/tmp/out.mkv',
    });
    // mapArgs are seeded '-map 0:<ffprobe index>'. The Japanese track is
    // input index 3, and its map must be absent; every other index present.
    const maps = argv.filter((_, i) => argv[i - 1] === '-map');
    expect(maps).toEqual(['0:0', '0:1', '0:2', '0:4', '0:5']);
  });
});

describe.runIf(available)('Ensure Audio Stream', () => {
  it('adds a stereo aac stream when none exists, without removing anything', async () => {
    // The fixture has an English 5.1 ac3 track but no English stereo aac
    // track, so this plugin ADDS one. That is the semantic difference from
    // Unmanic's "ensure 2ch aac", which converts — see the migration guide.
    const { output } = await run(
      ENSURE_AUDIO,
      { audioEncoder: 'aac', language: 'eng', channels: 2 },
      true,
    );
    const streams = output.variables.ffmpegCommand.streams;
    expect(streams.length).toBe(7);
    expect(streams.some((s) => s.removed === true)).toBe(false);
    expect(output.variables.ffmpegCommand.shouldProcess).toBe(true);
  });

  it('adds nothing on a second pass, so a converged file stays converged', async () => {
    const first = await run(
      ENSURE_AUDIO,
      { audioEncoder: 'aac', language: 'jpn', channels: 2 },
      true,
    );
    // The fixture already has a Japanese 2-channel aac track (index 3), so the
    // plugin must find it and add nothing. This is the property the
    // convergence ledger depends on: a node that added a stream every run
    // would grow the file for ever.
    expect(first.output.variables.ffmpegCommand.streams.length).toBe(6);
  });
});

describe.runIf(available)('Custom Arguments', () => {
  it('carries his -max_muxing_queue_size 2048 into the overall output arguments', async () => {
    const { output } = await run(
      CUSTOM_ARGUMENTS,
      { inputArguments: '', outputArguments: '-max_muxing_queue_size 2048' },
      true,
    );
    expect(output.variables.ffmpegCommand.overallOuputArguments).toEqual([
      '-max_muxing_queue_size',
      '2048',
    ]);
    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/tmp/out.mkv',
    });
    expect(argv.slice(-3)).toEqual(['-max_muxing_queue_size', '2048', '/tmp/out.mkv']);
  });
});
```

- [ ] **Step 5: Run them**

Run: `npx vitest run packages/engine/test/compat/parity-plugins.test.ts`
Expected: PASS. If `Remove Stream By Property` reports the cover art removed, or `Ensure Audio Stream` adds a stream on the second pass, stop and fix the host.

- [ ] **Step 6: Add the notification cases, against a real HTTP server**

`tools/webRequest` is the answer to "Notify Plex" — a Plex partial scan is one HTTP GET. Assert it against a real server rather than a mock, because the thing under test is that trawlarr's injected `deps.axios` reaches the network at all.

```ts
describe.runIf(available)('Send Web Request', () => {
  let server: Server;
  let received: { method: string; url: string; body: string } | null = null;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('performs the Plex partial-scan request shape and routes to output 1', async () => {
    const { output } = await run(
      WEB_REQUEST,
      {
        method: 'get',
        requestUrl: `${base}/library/sections/1/refresh?X-Plex-Token=abc123`,
        requestHeaders: '{"Accept":"application/json"}',
        requestBody: '{}',
        logResponseBody: false,
        output2StatusCodes: '',
        output2OnNetworkError: false,
      },
      false,
    );
    expect(output.outputNumber).toBe(1);
    expect(received?.method).toBe('GET');
    expect(received?.url).toBe('/library/sections/1/refresh?X-Plex-Token=abc123');
  });

  it('routes a network error to output 2 when configured to, instead of failing the flow', async () => {
    // A Plex that is down must not invalidate a transcode that already
    // succeeded. This input is what lets a flow author say so.
    const { output } = await run(
      WEB_REQUEST,
      {
        method: 'get',
        // Port 1 is reserved and refuses connections on every platform.
        requestUrl: 'http://127.0.0.1:1/library/sections/1/refresh',
        requestHeaders: '{}',
        requestBody: '{}',
        logResponseBody: false,
        output2StatusCodes: '',
        output2OnNetworkError: true,
      },
      false,
    );
    expect(output.outputNumber).toBe(2);
  });
});

describe.runIf(available)('Notify Radarr or Sonarr', () => {
  it('loads and exposes usable details()', () => {
    const abs = pluginPath(NOTIFY_ARR);
    expect(existsSync(abs)).toBe(true);
    const loaded = createPluginLoader().load(abs);
    expect(loaded.details.name).toBeTruthy();
    expect(loaded.details.outputs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run the full gate**

Run: `pnpm build && pnpm lint && pnpm test && pnpm audit:licenses`
Expected: all four green; test count above 2090; 0 skipped.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/test/compat/parity-plugins.test.ts
git commit -m "test(compat): pin the four Tdarr plugins the parity pipeline needs"
```

---

## Task 2: Prove them against real ffmpeg, on bytes that reach disk

Argument-level tests missed the cover-art data-loss bug in this codebase, and only a real-ffmpeg assertion found it. Every plugin in Task 1 that emits command arguments gets an assertion here about what the **output file actually contains**.

This suite is also where the host defect in Task 3 becomes undeniable: it builds a real removal, runs it, and probes the result — and the stream count that comes back is what `Verify Output` will be compared against.

**Files:**
- Create: `packages/engine/test/compat/parity-plugins-ffmpeg.test.ts`

**Interfaces:**
- Consumes: `toolAvailableSync` from `../../../../test-support/tool-availability.js`; `corpusAvailable`, `pluginPath` from `./corpus.js`; `createPluginLoader`, `buildPluginDeps` as in Task 1; `beginFfmpegCommand`, `compileFfmpegArgs` from `@trawlarr/core`.
- Produces: nothing importable.

- [ ] **Step 1: Write the fixture builder and the remux test**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PluginInputArgs, ProbeData } from '@trawlarr/plugin-api';
import { beginFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import { createPluginLoader } from '../../src/host/loader.js';
import { toolAvailableSync } from '../../../../test-support/tool-availability.js';
import { corpusAvailable, pluginPath } from './corpus.js';

const execFileAsync = promisify(execFile);

// Both conditions are computed SYNCHRONOUSLY at module scope: describe.runIf
// is evaluated at collection time, before any async beforeAll, so a condition
// set inside beforeAll always reads false and silently skips the whole suite.
const available = toolAvailableSync('ffmpeg') && toolAvailableSync('ffprobe') && corpusAvailable();

let workDir = '';
let sourcePath = '';

/**
 * A real multi-track file: cover art, video, English 5.1, Japanese stereo, one
 * untagged audio track, and an English subtitle. Generated rather than
 * committed, so nothing binary lands in the repository.
 */
const makeSample = async (path: string, coverPath: string) => {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=0.04:r=25',
    '-frames:v', '1', coverPath,
  ]);
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-y',
    '-i', coverPath,
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-map', '0:v:0', '-map', '1:v:0', '-map', '2:a:0', '-map', '3:a:0', '-map', '4:a:0',
    '-c:v:0', 'mjpeg', '-disposition:v:0', 'attached_pic',
    '-c:v:1', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng',
    '-metadata:s:a:1', 'language=jpn',
    // The third audio track deliberately gets NO language metadata.
    path,
  ]);
};

const probeOf = async (path: string): Promise<ProbeData> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
  ]);
  return JSON.parse(stdout) as ProbeData;
};

const streamSummary = async (path: string) => {
  const probe = await probeOf(path);
  return (probe.streams ?? []).map((s) => ({
    codec_type: s.codec_type,
    codec_name: s.codec_name,
    language: (s.tags as Record<string, string> | undefined)?.language ?? null,
  }));
};

beforeAll(async () => {
  if (!available) return;
  workDir = mkdtempSync(join(tmpdir(), 'trawlarr-parity-'));
  mkdirSync(join(workDir, 'source'), { recursive: true });
  sourcePath = join(workDir, 'source', 'Sample.mkv');
  await makeSample(sourcePath, join(workDir, 'source', 'cover.png'));
}, 180_000);
```

- [ ] **Step 2: Run it to verify the fixture builds**

Run: `npx vitest run packages/engine/test/compat/parity-plugins-ffmpeg.test.ts`
Expected: PASS with zero tests collected (no `it` blocks yet), and no error from `beforeAll`. If `beforeAll` throws, the fixture command is wrong — fix it now, because every assertion below depends on this file's exact stream layout.

- [ ] **Step 3: Write the real-ffmpeg assertions**

Append. The helper below is the whole harness: run one plugin against a real probe, compile, invoke real ffmpeg, and probe the result.

```ts
const argsFor = (input: {
  inputs: Record<string, unknown>;
  probe: ProbeData;
  container: string;
}): PluginInputArgs =>
  ({
    inputFileObj: { _id: sourcePath, container: input.container, ffProbeData: input.probe },
    originalLibraryFile: { _id: sourcePath, container: input.container },
    inputs: input.inputs,
    variables: {
      ffmpegCommand: beginFfmpegCommand({
        probe: input.probe,
        container: input.container,
        inputPath: sourcePath,
      }),
      flowFailed: false,
      user: {},
    },
    jobLog: () => {},
    updateWorker: () => {},
    // Only webRequest reaches deps in this suite, and it is not exercised here.
    deps: {},
  }) as unknown as PluginInputArgs;

const runThroughFfmpeg = async (input: {
  rel: string;
  inputs: Record<string, unknown>;
  outputName: string;
}) => {
  const abs = pluginPath(input.rel);
  expect(existsSync(abs)).toBe(true);
  const probe = await probeOf(sourcePath);
  const loaded = createPluginLoader().load(abs);
  const args = argsFor({ inputs: input.inputs, probe, container: 'mkv' });
  const output = await loaded.module.plugin(args);
  const command = output.variables.ffmpegCommand;
  const outputPath = join(workDir, input.outputName);
  const argv = compileFfmpegArgs({ command, outputPath });
  await execFileAsync('ffmpeg', ['-hide_banner', '-y', ...argv], { maxBuffer: 10 * 1024 * 1024 });
  return { outputPath, command, argv };
};

describe.runIf(available)('Set Container against real ffmpeg', () => {
  it('remuxes mkv to mp4 and the result really is mp4, with the video bit-identical', async () => {
    const before = await streamSummary(sourcePath);
    expect(before.filter((s) => s.codec_type === 'video')).toHaveLength(2);

    const { outputPath } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
      inputs: { container: 'mp4', forceConform: true },
      outputName: 'remuxed.mp4',
    });

    const probe = await probeOf(outputPath);
    // ffprobe names the mp4 family "mov,mp4,m4a,3gp,3g2,mj2".
    expect(String(probe.format?.format_name)).toContain('mp4');
    const video = (probe.streams ?? []).filter((s) => s.codec_type === 'video');
    // The real video track survived as h264 — a remux must never re-encode.
    expect(video.some((s) => s.codec_name === 'h264')).toBe(true);
  }, 120_000);
});

describe.runIf(available)('Remove Stream By Property against real ffmpeg', () => {
  it('drops the Japanese track, keeps English, keeps the untagged track and the cover art', async () => {
    const { outputPath } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandRemoveStreamByProperty/1.0.0/index.js',
      inputs: {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      outputName: 'filtered.mkv',
    });

    const after = await streamSummary(outputPath);
    const audio = after.filter((s) => s.codec_type === 'audio');
    // English survives; Japanese is gone; the untagged track survives because
    // the plugin never judges a stream whose property is absent. This is the
    // assertion that stands in for Unmanic's `keep_undefined`.
    expect(audio.map((s) => s.language)).toEqual(['eng', null]);
    // The cover art is still there, still mjpeg. This is the cover-art
    // data-loss bug seen from the removal side: an implementation that
    // addressed streams by type specifier would have taken it.
    expect(after.filter((s) => s.codec_name === 'mjpeg')).toHaveLength(1);
    // And the real video is untouched.
    expect(after.filter((s) => s.codec_name === 'h264')).toHaveLength(1);
  }, 120_000);

  it('produces an output with FEWER streams than the original — the fact Task 3 depends on', async () => {
    const { outputPath } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandRemoveStreamByProperty/1.0.0/index.js',
      inputs: {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      outputName: 'filtered-count.mkv',
    });
    const originalCount = (await streamSummary(sourcePath)).length;
    const outputCount = (await streamSummary(outputPath)).length;
    expect(outputCount).toBeLessThan(originalCount);
  }, 120_000);
});

describe.runIf(available)('Ensure Audio Stream against real ffmpeg', () => {
  it('adds a real stereo aac track alongside the originals', async () => {
    const before = (await streamSummary(sourcePath)).filter((s) => s.codec_type === 'audio');

    const { outputPath } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandEnsureAudioStream/1.0.0/index.js',
      inputs: { audioEncoder: 'ac3', language: 'eng', channels: 6 },
      outputName: 'ensured.mkv',
    });

    const after = (await streamSummary(outputPath)).filter((s) => s.codec_type === 'audio');
    expect(after.length).toBe(before.length + 1);
    // The added track really is the codec that was asked for, on disk.
    expect(after.some((s) => s.codec_name === 'ac3')).toBe(true);
    // And every original audio track is still present and still aac.
    expect(after.filter((s) => s.codec_name === 'aac')).toHaveLength(before.length);
  }, 180_000);
});
```

Note the `ac3`/6-channel choice: the generated fixture's audio is already stereo aac, so asking for stereo aac would correctly add nothing and the test would prove nothing. Asking for something the file does not have is what makes the assertion falsifiable.

- [ ] **Step 4: Run them**

Run: `npx vitest run packages/engine/test/compat/parity-plugins-ffmpeg.test.ts`
Expected: PASS, all cases. A failure here is a host bug — fix `packages/engine/src` or `packages/core/src`, never the plugin and never the assertion.

- [ ] **Step 5: Run the full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/engine/test/compat/parity-plugins-ffmpeg.test.ts
git commit -m "test(compat): assert the parity plugins against real ffmpeg output"
```

---

## Task 3: The host fix — `Verify Output` must expect the flow's intended stream count, and must still refuse an audio-less result

Task 2 proves a stream-removing plugin produces an output with fewer streams than the original. `verifyOutput` compares against the **original probe's** count and fails on exactly that, so `Remove Stream By Property`, `Remove Subtitles`, `Remove Data Streams` and `Set Container` with `forceConform` are all unusable in any flow that ends in Replace Original File: verification routes to output 2, the replacement is refused, three attempts burn, and the file lands in `failed`. That is a host bug and the last thing standing between the community plugins and his pipeline.

Fixing it removes an accidental safety net, and the same commit must replace it deliberately. Today "the language filter deleted every audio track" is caught only because verification rejects *any* stream loss. Once the expectation follows the flow's intent, a flow that intended to remove all audio would be approved and the original trashed. Unmanic's `fail_safe` is exactly this concern; it belongs in the **host gate**, not on a node, because a gate protects against every plugin — community, first-party, present and future — while a node input protects only against that node. This is the same reasoning the engineering notes already record under "An allow-list is not a rule".

Note that adding an input to a node's `details()` does **not** change any stored flow's hash: `flowDefinitionHash` hashes each node's stored `inputs` map, not its declared inputs. No library is re-queued by this task.

**Files:**
- Modify: `packages/engine/src/executor/verify-output.ts`
- Modify: `packages/engine/src/executor/verify-output.test.ts`
- Modify: `packages/plugins-core/src/verifyOutput/index.ts`
- Modify: `packages/plugins-core/src/plugins.test.ts`

**Interfaces:**
- Consumes: `ProbeData` from `@trawlarr/plugin-api`; `args.variables.ffmpegCommand` inside the runner (it survives `closeFfmpegCommand`, which clears `init` and `shouldProcess` but keeps `streams`).
- Produces: `verifyOutput(input)` gains two required fields — `intendedStreamCount: number | null` and `requireAudioIfOriginalHadAudio: boolean`. `VerifyReport` is unchanged. The node gains one input, `requireAudioIfOriginalHadAudio`, default `'true'`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/engine/src/executor/verify-output.test.ts`. Use whatever local probe-building helper that file already defines; the cases below name the shapes they need explicitly so they can be written against it.

```ts
describe('the expected stream count follows the flow, not the original', () => {
  const original: ProbeData = {
    format: { duration: '100' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'audio', codec_name: 'ac3' },
    ],
  };

  it('accepts an output missing exactly the streams the flow removed', () => {
    const report = verifyOutput({
      probe: {
        format: { duration: '100' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      originalProbe: original,
      outputSizeBytes: 900,
      originalSizeBytes: 1000,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
      intendedStreamCount: 2,
      requireAudioIfOriginalHadAudio: true,
    });
    expect(report.ok).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it('still rejects an output missing a stream the flow did NOT remove', () => {
    const report = verifyOutput({
      probe: {
        format: { duration: '100' },
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }],
      },
      originalProbe: original,
      outputSizeBytes: 900,
      originalSizeBytes: 1000,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
      intendedStreamCount: 2,
      requireAudioIfOriginalHadAudio: false,
    });
    expect(report.ok).toBe(false);
  });

  it('falls back to the original count when no command described an intent', () => {
    const report = verifyOutput({
      probe: {
        format: { duration: '100' },
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }],
      },
      originalProbe: original,
      outputSizeBytes: 900,
      originalSizeBytes: 1000,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
      intendedStreamCount: null,
      requireAudioIfOriginalHadAudio: false,
    });
    expect(report.ok).toBe(false);
  });

  it('accepts an output with MORE streams than the original, as Ensure Audio Stream produces', () => {
    const report = verifyOutput({
      probe: {
        format: { duration: '100' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'audio', codec_name: 'ac3' },
          { index: 3, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      originalProbe: original,
      outputSizeBytes: 1100,
      originalSizeBytes: 1000,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
      intendedStreamCount: 4,
      requireAudioIfOriginalHadAudio: true,
    });
    expect(report.ok).toBe(true);
  });
});

describe('the audio fail-safe', () => {
  const original: ProbeData = {
    format: { duration: '100' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'ac3', tags: { language: 'jpn' } },
    ],
  };

  const audioless: ProbeData = {
    format: { duration: '100' },
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }],
  };

  it('refuses a silent output even when the flow intended exactly that', () => {
    // The catastrophic case: every audio track is jpn and the filter keeps
    // only eng. The flow's intent is honoured by the count check, so ONLY
    // this gate stands between the user and a library of silent films.
    const report = verifyOutput({
      probe: audioless,
      originalProbe: original,
      outputSizeBytes: 900,
      originalSizeBytes: 1000,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
      intendedStreamCount: 1,
      requireAudioIfOriginalHadAudio: true,
    });
    expect(report.ok).toBe(false);
    expect(report.reasons).toHaveLength(1);
  });

  it('permits it when the flow author turned the gate off deliberately', () => {
    const report = verifyOutput({
      probe: audioless,
      originalProbe: original,
      outputSizeBytes: 900,
      originalSizeBytes: 1000,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
      intendedStreamCount: 1,
      requireAudioIfOriginalHadAudio: false,
    });
    expect(report.ok).toBe(true);
  });

  it('says nothing about audio when the original had none', () => {
    const report = verifyOutput({
      probe: audioless,
      originalProbe: audioless,
      outputSizeBytes: 900,
      originalSizeBytes: 1000,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
      intendedStreamCount: 1,
      requireAudioIfOriginalHadAudio: true,
    });
    expect(report.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/engine/src/executor/verify-output.test.ts`
Expected: FAIL — a type error on the two new fields, and the first case failing on "the output has 2 streams, fewer than the original's 3".

- [ ] **Step 3: Change the pure function**

In `packages/engine/src/executor/verify-output.ts`, extend the signature and replace the stream-count block:

```ts
export const verifyOutput = (input: {
  probe: ProbeData;
  originalProbe: ProbeData;
  outputSizeBytes: number;
  originalSizeBytes: number;
  durationToleranceSeconds: number;
  minSizeRatio: number;
  /**
   * How many streams the flow's own ffmpeg command intended to write, or
   * `null` when no command described one (a flow that verifies a file it
   * merely copied, for instance).
   *
   * Comparing against the ORIGINAL's count was a host defect that made every
   * stream-removing community plugin unusable: `Remove Stream By Property`,
   * `Remove Subtitles`, `Remove Data Streams` and `Set Container` with
   * `forceConform` all produce an output with fewer streams BY DESIGN, and
   * verification rejected all of them, refused the replacement, and burned
   * three attempts per file.
   */
  intendedStreamCount: number | null;
  /**
   * Refuse an output with no audio when the original had some.
   *
   * This is the fail-safe that replaces the accidental one the line above
   * removed. It is deliberately NOT satisfied by the flow's intent: a
   * language filter matching nothing removes every audio track, and the
   * command it builds says so, so an intent-following check would approve a
   * silent film and trash the original. Unmanic exposes this as `fail_safe`
   * on its own language plugin; it lives in the host instead because a gate
   * here protects against every plugin, including community ones nobody here
   * wrote and future ones nobody here has seen.
   */
  requireAudioIfOriginalHadAudio: boolean;
}): VerifyReport => {
  const reasons: string[] = [];
  const streams = input.probe.streams ?? [];

  if (streams.length === 0) {
    reasons.push('the output has no streams — ffprobe could not read it');
    return { ok: false, reasons };
  }

  const originalStreams = input.originalProbe.streams ?? [];
  const expected = input.intendedStreamCount ?? originalStreams.length;
  // One-sided on purpose: MORE streams than expected is what
  // `Ensure Audio Stream` produces, and is never a symptom of a truncated
  // encode. Fewer is.
  if (streams.length < expected) {
    reasons.push(
      `the output has ${streams.length} streams, fewer than the ${expected} this flow ` +
        `intended to write`,
    );
  }

  if (input.requireAudioIfOriginalHadAudio) {
    const originalHadAudio = originalStreams.some((stream) => stream.codec_type === 'audio');
    const outputHasAudio = streams.some((stream) => stream.codec_type === 'audio');
    if (originalHadAudio && !outputHasAudio) {
      reasons.push(
        `the original has audio and the output has none — a stream filter that matched ` +
          `nothing removes every audio track, which is why this is refused even though the ` +
          `flow asked for it`,
      );
    }
  }

  // ... the duration and size checks below are unchanged ...
```

- [ ] **Step 4: Supply both values from the runner**

In the same file, inside `createVerifyOutputRunner`'s `plugin` body, before the `try`:

```ts
        // The command survives `closeFfmpegCommand` (which clears `init` and
        // `shouldProcess` but keeps `streams`), so the Execute node that just
        // ran has left behind exactly what it intended to write. A flow with
        // no Begin Command has an empty stream array, which means "nothing
        // described an intent" rather than "zero streams".
        const command = args.variables.ffmpegCommand;
        const intendedStreamCount =
          command.streams.length === 0
            ? null
            : command.streams.filter((stream) => stream.removed !== true).length;
        // A node input arrives as the STRING 'false' from a stored flow and as
        // the boolean false from a test. Reading only one of those makes the
        // switch look wired while doing nothing, so both are normalised here.
        const requireAudioIfOriginalHadAudio =
          String(args.inputs.requireAudioIfOriginalHadAudio ?? 'true') !== 'false';
```

and pass both into the `verifyOutput({ ... })` call.

- [ ] **Step 5: Declare the input on the node**

In `packages/plugins-core/src/verifyOutput/index.ts`, append to `inputs`:

```ts
    {
      label: 'Require audio if the original had audio',
      name: 'requireAudioIfOriginalHadAudio',
      type: 'boolean',
      defaultValue: 'true',
      tooltip:
        'Refuse an output with no audio streams when the original had some. A stream filter ' +
        'whose language list matches nothing removes every audio track, and the flow will ' +
        'have asked for exactly that — so this is the only thing that stops a silent file ' +
        'replacing your original. Turn it off only for a flow that deliberately produces ' +
        'video with no sound.',
      inputUI: { type: 'switch' },
    },
```

and extend the node's `description` so the palette says what it now checks: append `' It also refuses an output that lost all of its audio.'`.

- [ ] **Step 6: Pin the new input in the node's contract test**

In `packages/plugins-core/src/plugins.test.ts`, inside `describe('trawlarr:verifyOutput')`, extend the existing input-names assertion:

```ts
    expect(names).toContain('requireAudioIfOriginalHadAudio');
```

- [ ] **Step 7: Run everything**

Run: `pnpm build && npx vitest run packages/engine packages/plugins-core`
Expected: PASS. Other call sites of `verifyOutput` will fail to compile until they pass the two new fields — that is intended; fix each by passing `intendedStreamCount: null` and `requireAudioIfOriginalHadAudio: true` unless the case is specifically about one of them.

- [ ] **Step 8: Prove it end-to-end against real ffmpeg**

Append to `packages/engine/test/compat/parity-plugins-ffmpeg.test.ts` (from Task 2):

```ts
describe.runIf(available)('verification accepts a real language-filtered output', () => {
  it('passes the output the removal plugin actually produced', async () => {
    const { outputPath, command } = await runThroughFfmpeg({
      rel: 'ffmpegCommand/ffmpegCommandRemoveStreamByProperty/1.0.0/index.js',
      inputs: {
        codecType: 'audio',
        propertyToCheck: 'tags.language',
        valuesToRemove: 'eng',
        condition: 'not_includes',
      },
      outputName: 'verified.mkv',
    });

    const report = verifyOutput({
      probe: await probeOf(outputPath),
      originalProbe: await probeOf(sourcePath),
      outputSizeBytes: statSync(outputPath).size,
      originalSizeBytes: statSync(sourcePath).size,
      durationToleranceSeconds: 1,
      minSizeRatio: 0.05,
      intendedStreamCount: command.streams.filter((s) => s.removed !== true).length,
      requireAudioIfOriginalHadAudio: true,
    });
    // Before this task, this assertion was false and every file his language
    // filter touched would have been refused and eventually marked failed.
    expect(report.reasons).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);
});
```

Add `import { statSync } from 'node:fs';` and `import { verifyOutput } from '../../src/executor/verify-output.js';` to that file.

- [ ] **Step 9: Run the full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/engine/src/executor/verify-output.ts packages/engine/src/executor/verify-output.test.ts packages/plugins-core/src/verifyOutput/index.ts packages/plugins-core/src/plugins.test.ts packages/engine/test/compat/parity-plugins-ffmpeg.test.ts
git commit -m "fix(engine): verify against the flow's intended stream count, with an audio fail-safe"
```

---

## Task 4: The installed-plugin id, and the rows behind it

Two places must agree on what a plugin id means — flow validation in the daemon and plugin loading inside the forked worker — and they are in different processes. Anything they disagree about produces a flow that validates and then cannot run. So the id scheme is one module with one definition, and the rows are one repository.

The `plugin_source` and `plugin` tables already exist in `001_initial.sql` and are never written. **No migration is needed.**

**Files:**
- Create: `packages/server/src/plugins/plugin-id.ts`
- Create: `packages/server/src/plugins/plugin-id.test.ts`
- Create: `packages/server/src/plugins/plugin-repo.ts`
- Create: `packages/server/src/plugins/plugin-repo.test.ts`

**Interfaces:**
- Consumes: `Db` and `openDatabase` from `../db/connection.js`; `migrate` from `../db/migrate.js`. Tests open a migrated in-memory database exactly as `packages/server/src/db/flow-repo.test.ts` does: `openDatabase({ file: ':memory:' })` then `migrate(db)`.
- Produces:
  - `FIRST_PARTY_NAMESPACE = 'trawlarr'`
  - `class PluginIdError extends Error`
  - `interface InstalledPluginId { sourceSlug: string; pluginName: string }`
  - `formatPluginId(id: InstalledPluginId): string`
  - `parsePluginId(raw: string): InstalledPluginId | null`
  - `assertValidSourceSlug(slug: string): void`
  - `interface PluginSourceRow { id: string; url: string; kind: PluginSourceKind; enabled: boolean; lastSyncedAtMs: number | null }`
  - `type PluginSourceKind = 'tarball' | 'local'`
  - `interface InstalledPluginRow { id: string; sourceId: string | null; relPath: string; absPath: string; version: string; details: PluginDetails; enabled: boolean }`
  - `createPluginRepo(db: Db): PluginRepo` with `listSources()`, `getSource(id)`, `addSource(input)`, `setSourceEnabled(id, enabled)`, `removeSource(id)`, `markSynced(id, atMs)`, `listPlugins(sourceId?)`, `getPlugin(id)`, `replaceSourcePlugins(sourceId, plugins)`, `resolveAbsPaths(ids)`.

- [ ] **Step 1: Write the failing id tests**

Create `packages/server/src/plugins/plugin-id.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertValidSourceSlug,
  formatPluginId,
  parsePluginId,
  PluginIdError,
  FIRST_PARTY_NAMESPACE,
} from './plugin-id.js';

describe('installed plugin ids', () => {
  it('formats as <source slug>:<plugin name>, matching the first-party shape', () => {
    expect(formatPluginId({ sourceSlug: 'tdarr', pluginName: 'ffmpegCommandSetContainer' })).toBe(
      'tdarr:ffmpegCommandSetContainer',
    );
  });

  it('round-trips', () => {
    const id = { sourceSlug: 'tdarr', pluginName: 'ffmpegCommandSetContainer' };
    expect(parsePluginId(formatPluginId(id))).toEqual(id);
  });

  it('refuses to parse a first-party id, so the namespace can never be shadowed', () => {
    // A source slugged "trawlarr" could otherwise install a plugin that
    // silently replaces a first-party node in every existing flow.
    expect(parsePluginId(`${FIRST_PARTY_NAMESPACE}:execute`)).toBeNull();
  });

  it('refuses an absolute path, which is how a community plugin is named today', () => {
    expect(parsePluginId('/media/plugins/thing/1.0.0/index.js')).toBeNull();
  });

  it('refuses a Windows path that happens to contain a colon', () => {
    expect(parsePluginId('C:\\plugins\\thing\\index.js')).toBeNull();
  });

  it('refuses an empty half', () => {
    expect(parsePluginId(':thing')).toBeNull();
    expect(parsePluginId('tdarr:')).toBeNull();
  });
});

describe('source slugs', () => {
  it('accepts lowercase alphanumerics and hyphens', () => {
    expect(() => assertValidSourceSlug('tdarr-community')).not.toThrow();
  });

  it('rejects the first-party namespace by name', () => {
    expect(() => assertValidSourceSlug(FIRST_PARTY_NAMESPACE)).toThrow(PluginIdError);
  });

  it('rejects a slug containing a colon, which would make ids ambiguous', () => {
    expect(() => assertValidSourceSlug('a:b')).toThrow(PluginIdError);
  });

  it('rejects uppercase, so two sources cannot differ only by case', () => {
    expect(() => assertValidSourceSlug('Tdarr')).toThrow(PluginIdError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/server/src/plugins/plugin-id.test.ts`
Expected: FAIL — cannot resolve `./plugin-id.js`.

- [ ] **Step 3: Write the id module**

Create `packages/server/src/plugins/plugin-id.ts`:

```ts
/**
 * The namespace first-party plugins live in. A source may never claim it:
 * an installed plugin shadowing `trawlarr:execute` would change what every
 * existing flow does without any flow being edited, and `flowDefinitionHash`
 * would not move, so nothing would be re-evaluated.
 */
export const FIRST_PARTY_NAMESPACE = 'trawlarr';

export class PluginIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginIdError';
  }
}

export interface InstalledPluginId {
  sourceSlug: string;
  pluginName: string;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/**
 * A plugin's directory name in its source tree — `ffmpegCommandSetContainer`.
 * Kept deliberately permissive on case, because it is upstream's name and not
 * ours to normalise; normalising it would break the identity translation a
 * Tdarr flow import depends on (spec 2.7).
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const assertValidSourceSlug = (slug: string): void => {
  if (slug === FIRST_PARTY_NAMESPACE) {
    throw new PluginIdError(
      `"${FIRST_PARTY_NAMESPACE}" is reserved for trawlarr's own plugins. A source using it ` +
        `could install a plugin that silently replaces a first-party node in every flow you ` +
        `already have. Choose another name.`,
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new PluginIdError(
      `Plugin source name "${slug}" is not usable as an id prefix. Use lowercase letters, ` +
        `digits and hyphens, starting with a letter or digit — for example "tdarr" or ` +
        `"my-plugins". Uppercase is refused so two sources cannot differ only by case, and a ` +
        `colon is refused because it separates the source from the plugin name.`,
    );
  }
};

export const formatPluginId = (id: InstalledPluginId): string =>
  `${id.sourceSlug}:${id.pluginName}`;

/**
 * Read an id as an INSTALLED plugin reference, or `null` if it is anything
 * else — a first-party id, an absolute path (still how a community plugin is
 * named without a source), or malformed. Returning null rather than throwing
 * is what lets every caller try this first and fall through.
 */
export const parsePluginId = (raw: string): InstalledPluginId | null => {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;

  const sourceSlug = raw.slice(0, separator);
  const pluginName = raw.slice(separator + 1);

  if (sourceSlug === FIRST_PARTY_NAMESPACE) return null;
  if (!SLUG_PATTERN.test(sourceSlug)) return null;
  // Catches `C:\plugins\...` and any other path that happens to carry a colon.
  if (!NAME_PATTERN.test(pluginName)) return null;

  return { sourceSlug, pluginName };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/server/src/plugins/plugin-id.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the failing repository tests**

Create `packages/server/src/plugins/plugin-repo.test.ts`. Open a real migrated database — reuse the helper the other `packages/server/src/db/*.test.ts` files use.

```ts
import { describe, expect, it } from 'vitest';
import type { PluginDetails } from '@trawlarr/plugin-api';
import { createPluginRepo } from './plugin-repo.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

/** Same pattern as `packages/server/src/db/flow-repo.test.ts`. */
const openTestDb = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  return db;
};

const details = (name: string): PluginDetails =>
  ({
    name,
    description: '',
    style: { borderColor: '#fff' },
    tags: '',
    isStartPlugin: false,
    pType: '',
    sidebarPosition: 1,
    icon: '',
    inputs: [],
    outputs: [{ number: 1, tooltip: 'ok' }],
    requiresVersion: '1.0.0',
  }) as PluginDetails;

describe('plugin sources', () => {
  it('stores and lists a source', () => {
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'tdarr', url: 'https://example.test/x.tar.gz', kind: 'tarball' });
    expect(repo.listSources()).toEqual([
      {
        id: 'tdarr',
        url: 'https://example.test/x.tar.gz',
        kind: 'tarball',
        enabled: true,
        lastSyncedAtMs: null,
      },
    ]);
  });

  it('refuses a second source with the same url, by name', () => {
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'a', url: 'https://example.test/x.tar.gz', kind: 'tarball' });
    expect(() =>
      repo.addSource({ id: 'b', url: 'https://example.test/x.tar.gz', kind: 'tarball' }),
    ).toThrow(/already/i);
  });

  it('refuses a source named trawlarr', () => {
    const repo = createPluginRepo(openTestDb());
    expect(() => repo.addSource({ id: 'trawlarr', url: 'file:///x', kind: 'local' })).toThrow(
      /reserved/i,
    );
  });
});

describe('installed plugins', () => {
  const seed = () => {
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'tdarr', url: '/srv/plugins', kind: 'local' });
    repo.replaceSourcePlugins('tdarr', [
      {
        pluginName: 'ffmpegCommandSetContainer',
        relPath: 'FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
        absPath: '/srv/plugins/FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
        version: '1.0.0',
        details: details('Set Container'),
      },
    ]);
    return repo;
  };

  it('gives each plugin a namespaced id', () => {
    expect(seed().listPlugins().map((p) => p.id)).toEqual(['tdarr:ffmpegCommandSetContainer']);
  });

  it('resolves an id to the absolute path the worker will load', () => {
    expect(seed().resolveAbsPaths(['tdarr:ffmpegCommandSetContainer'])).toEqual({
      'tdarr:ffmpegCommandSetContainer':
        '/srv/plugins/FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandSetContainer/1.0.0/index.js',
    });
  });

  it('returns nothing for an id it does not have, rather than guessing', () => {
    expect(seed().resolveAbsPaths(['tdarr:nope', 'trawlarr:execute'])).toEqual({});
  });

  it('replaces a source-s plugins wholesale, so a plugin deleted upstream disappears', () => {
    // A sync that only upserts leaves a plugin behind after upstream removes
    // it, and a flow keeps referencing a path that no longer exists.
    const repo = seed();
    repo.replaceSourcePlugins('tdarr', []);
    expect(repo.listPlugins()).toEqual([]);
  });

  it('removing a source removes its plugins', () => {
    const repo = seed();
    repo.removeSource('tdarr');
    expect(repo.listPlugins()).toEqual([]);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run packages/server/src/plugins/plugin-repo.test.ts`
Expected: FAIL — cannot resolve `./plugin-repo.js`.

- [ ] **Step 7: Write the repository**

Create `packages/server/src/plugins/plugin-repo.ts`. Mirror the style of `packages/server/src/db/flow-repo.ts` — read it first. The load-bearing decisions:

```ts
import type { PluginDetails } from '@trawlarr/plugin-api';
import type { Db } from '../db/connection.js';
import { assertValidSourceSlug, formatPluginId, parsePluginId } from './plugin-id.js';

export type PluginSourceKind = 'tarball' | 'local';

export interface PluginSourceRow {
  id: string;
  url: string;
  kind: PluginSourceKind;
  enabled: boolean;
  lastSyncedAtMs: number | null;
}

export interface DiscoveredPlugin {
  pluginName: string;
  relPath: string;
  absPath: string;
  version: string;
  details: PluginDetails;
}

export interface InstalledPluginRow {
  id: string;
  sourceId: string | null;
  relPath: string;
  absPath: string;
  version: string;
  details: PluginDetails;
  enabled: boolean;
}

export interface PluginRepo {
  listSources(): PluginSourceRow[];
  getSource(id: string): PluginSourceRow | null;
  addSource(input: { id: string; url: string; kind: PluginSourceKind }): PluginSourceRow;
  setSourceEnabled(id: string, enabled: boolean): void;
  removeSource(id: string): void;
  markSynced(id: string, atMs: number): void;
  listPlugins(sourceId?: string): InstalledPluginRow[];
  getPlugin(id: string): InstalledPluginRow | null;
  /**
   * Make this source's installed set EXACTLY these plugins, in one
   * transaction. Not an upsert: a plugin upstream deleted must disappear,
   * or a flow keeps naming a path that is no longer there and fails on the
   * first file with an error that names a file rather than a plugin.
   */
  replaceSourcePlugins(sourceId: string, plugins: DiscoveredPlugin[]): void;
  /** Only ids this host actually has. Unknown ids are absent, never guessed. */
  resolveAbsPaths(ids: readonly string[]): Record<string, string>;
}
```

Implementation notes the implementer must honour:

- `addSource` calls `assertValidSourceSlug(input.id)` first, then catches the `UNIQUE` violation on `url` and rethrows as a named error: `` `A plugin source with url "${url}" already exists (named "${existing.id}"). Remove it first, or sync it instead of adding it again.` ``
- `replaceSourcePlugins` runs `DELETE FROM plugin WHERE source_id = ?` then inserts, inside `db.transaction(...)`, so a sync that dies half way leaves the previous set intact rather than an arbitrary prefix of the new one.
- Each row's `id` is `formatPluginId({ sourceSlug: sourceId, pluginName })`.
- `resolveAbsPaths` filters its input through `parsePluginId` before touching the database, so a first-party id or an absolute path never becomes a query.
- `kind` is validated on read as well as write, the way `SettingsRepo` validates settings: the table is a text column a human can edit.

- [ ] **Step 8: Run, then run the gate and commit**

```bash
npx vitest run packages/server/src/plugins
tsc --build --force
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/plugins/plugin-id.ts packages/server/src/plugins/plugin-id.test.ts packages/server/src/plugins/plugin-repo.ts packages/server/src/plugins/plugin-repo.test.ts
git commit -m "feat(server): installed-plugin id scheme and plugin/plugin_source repository"
```

---

## Task 5: Fetch a source, and refuse a hostile one

A source becomes a directory on disk. Two kinds cover everything the owner needs and neither phones anything home:

- **`tarball`** — any HTTPS URL serving a gzipped tar. GitHub serves one for every repository and every ref at `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`, so "sync from a git repository" is satisfied without a `git` binary. That matters concretely: the runtime image installs `ffmpeg gosu tzdata ca-certificates` and **not git**, and `Dockerfile` is out of bounds this phase. `tar` is a Debian essential and is already used by `scripts/fetch-plugin-corpus.mjs`.
- **`local`** — a directory already on disk. No network at all, which is what an air-gapped or self-hosted catalog needs.

There is deliberately no service to register with, no index to query and no phone-home. The owner's fork removed `api.unmanic.app` for exactly this reason.

**Files:**
- Create: `packages/server/src/plugins/fetch-source.ts`
- Create: `packages/server/src/plugins/fetch-source.test.ts`

**Interfaces:**
- Consumes: `PluginSourceKind` from `./plugin-repo.js`; Node's global `fetch`; `node:child_process` `execFileSync`; `node:fs`.
- Produces:
  - `class PluginSourceError extends Error`
  - `interface MaterialisedSource { dir: string; cleanup: () => void }`
  - `materialiseSource(input: { kind: PluginSourceKind; url: string; cacheDir: string; fetchFn?: typeof fetch }): Promise<MaterialisedSource>`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/plugins/fetch-source.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materialiseSource, PluginSourceError } from './fetch-source.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'trawlarr-src-'));

/** Build a real .tar.gz containing the given relative paths. */
const makeTarball = (entries: Record<string, string>, opts?: { evil?: boolean }): string => {
  const dir = scratch();
  const payload = join(dir, 'payload');
  mkdirSync(payload, { recursive: true });
  for (const [rel, body] of Object.entries(entries)) {
    const abs = join(payload, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  const out = join(dir, 'src.tar.gz');
  if (opts?.evil === true) {
    // A member whose name escapes the extraction root. Built with an explicit
    // transform so the archive really contains "../escaped.js" as a member
    // name, which is the thing under test.
    execFileSync('tar', [
      '-czf', out, '-C', payload,
      '--transform', 's|^|../|',
      ...Object.keys(entries),
    ]);
  } else {
    execFileSync('tar', ['-czf', out, '-C', payload, '.']);
  }
  return out;
};

describe('local sources', () => {
  it('uses the directory as-is', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'marker.txt'), 'hello', 'utf8');
    const source = await materialiseSource({ kind: 'local', url: dir, cacheDir: scratch() });
    expect(readFileSync(join(source.dir, 'marker.txt'), 'utf8')).toBe('hello');
  });

  it('never deletes the user-s own directory on cleanup', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'marker.txt'), 'hello', 'utf8');
    const source = await materialiseSource({ kind: 'local', url: dir, cacheDir: scratch() });
    source.cleanup();
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true);
  });

  it('refuses a path that is not a directory, by name', async () => {
    const dir = scratch();
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x', 'utf8');
    await expect(materialiseSource({ kind: 'local', url: file, cacheDir: scratch() })).rejects.toThrow(
      PluginSourceError,
    );
  });

  it('refuses a relative path, because there is no defensible base to resolve it against', async () => {
    await expect(
      materialiseSource({ kind: 'local', url: 'plugins', cacheDir: scratch() }),
    ).rejects.toThrow(PluginSourceError);
  });
});

describe('tarball sources', () => {
  const serve = (path: string): typeof fetch =>
    (async () =>
      new Response(readFileSync(path), { status: 200 })) as unknown as typeof fetch;

  it('extracts the archive into the cache directory', async () => {
    const tarball = makeTarball({ 'a/b/index.js': 'module.exports = {};' });
    const source = await materialiseSource({
      kind: 'tarball',
      url: 'https://example.test/x.tar.gz',
      cacheDir: scratch(),
      fetchFn: serve(tarball),
    });
    expect(existsSync(join(source.dir, 'a', 'b', 'index.js'))).toBe(true);
  });

  it('cleans up what it extracted', async () => {
    const tarball = makeTarball({ 'a/index.js': 'x' });
    const source = await materialiseSource({
      kind: 'tarball',
      url: 'https://example.test/x.tar.gz',
      cacheDir: scratch(),
      fetchFn: serve(tarball),
    });
    source.cleanup();
    expect(existsSync(source.dir)).toBe(false);
  });

  it('refuses an archive containing a member that escapes the extraction root', async () => {
    // The whole point: a plugin source is a URL a user pasted, and a tarball
    // member named "../../etc/cron.d/x" would otherwise be written outside the
    // cache directory as the service user.
    const tarball = makeTarball({ 'escaped.js': 'pwned' }, { evil: true });
    await expect(
      materialiseSource({
        kind: 'tarball',
        url: 'https://example.test/evil.tar.gz',
        cacheDir: scratch(),
        fetchFn: serve(tarball),
      }),
    ).rejects.toThrow(/outside/i);
  });

  it('refuses a non-https url, so a source cannot be fetched in the clear', async () => {
    await expect(
      materialiseSource({
        kind: 'tarball',
        url: 'http://example.test/x.tar.gz',
        cacheDir: scratch(),
      }),
    ).rejects.toThrow(PluginSourceError);
  });

  it('reports a failed fetch with the status, not an anonymous throw', async () => {
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(
      materialiseSource({
        kind: 'tarball',
        url: 'https://example.test/missing.tar.gz',
        cacheDir: scratch(),
        fetchFn: failing,
      }),
    ).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/server/src/plugins/fetch-source.test.ts`
Expected: FAIL — cannot resolve `./fetch-source.js`.

- [ ] **Step 3: Write the module**

Create `packages/server/src/plugins/fetch-source.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginSourceKind } from './plugin-repo.js';

export class PluginSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSourceError';
  }
}

export interface MaterialisedSource {
  dir: string;
  /** Removes anything this call created. A NO-OP for a local source. */
  cleanup: () => void;
}

/**
 * Every member name in the archive, as tar itself reports them. Listing
 * before extracting is what makes the containment check meaningful: checking
 * afterwards means the escape has already happened.
 */
const memberNames = (tarball: string): string[] =>
  execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * Refuse an archive that would write outside the directory we extract into.
 *
 * A plugin source URL is something a user pasted, and it is fetched and
 * unpacked by the service user, which owns the whole data directory. GNU tar
 * does strip a leading slash and skip `..` members with a warning, but a
 * warning on stderr that nobody reads is not a control, and the behaviour is
 * not the same across tar implementations. Refusing outright, by name, is.
 */
const assertNoEscapingMembers = (tarball: string): void => {
  for (const name of memberNames(tarball)) {
    const escapes =
      name.startsWith('/') ||
      name.startsWith('../') ||
      name.includes('/../') ||
      name === '..' ||
      name.endsWith('/..');
    if (escapes) {
      throw new PluginSourceError(
        `Refusing this plugin source: its archive contains "${name}", which would be written ` +
          `outside the directory it is unpacked into. That is not a layout any plugin ` +
          `repository needs, so the archive is rejected rather than sanitised.`,
      );
    }
  }
};

export const materialiseSource = async (input: {
  kind: PluginSourceKind;
  url: string;
  cacheDir: string;
  /** Seam for tests; production uses the global fetch. */
  fetchFn?: typeof fetch;
}): Promise<MaterialisedSource> => {
  if (input.kind === 'local') {
    // Rejected rather than resolved, for the same reason a relative
    // `stagingDir` is rejected at library creation: there is no defensible
    // base. The service's cwd is meaningless to the user, and `path.resolve`
    // is defined against it, so resolving early stores the wrong answer.
    if (!isAbsolute(input.url)) {
      throw new PluginSourceError(
        `Plugin source path "${input.url}" is relative. Give an absolute path — the service's ` +
          `working directory is not something you can predict, so a relative path would point ` +
          `somewhere different depending on how trawlarr was started.`,
      );
    }
    let stats;
    try {
      stats = statSync(input.url);
    } catch {
      throw new PluginSourceError(`Plugin source path "${input.url}" does not exist.`);
    }
    if (!stats.isDirectory()) {
      throw new PluginSourceError(
        `Plugin source path "${input.url}" is not a directory. A local source is the ROOT of a ` +
          `plugin tree, not a single plugin file.`,
      );
    }
    // No cleanup: this is the user's own directory, not something we made.
    return { dir: input.url, cleanup: () => {} };
  }

  if (!input.url.startsWith('https://')) {
    throw new PluginSourceError(
      `Plugin source url "${input.url}" is not https. Plugin code is executed by trawlarr as ` +
        `the service user, so it is only ever fetched over a channel that authenticates the ` +
        `server it came from.`,
    );
  }

  mkdirSync(input.cacheDir, { recursive: true });
  const workDir = mkdtempSync(join(input.cacheDir, 'source-'));
  const tarball = join(workDir, `${randomUUID()}.tar.gz`);
  const extractDir = join(workDir, 'tree');

  try {
    const response = await (input.fetchFn ?? fetch)(input.url);
    if (!response.ok) {
      throw new PluginSourceError(
        `Could not fetch plugin source "${input.url}": HTTP ${response.status}.`,
      );
    }
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
    assertNoEscapingMembers(tarball);
    mkdirSync(extractDir, { recursive: true });
    // `--strip-components=1` matches how every GitHub tarball is shaped: one
    // top-level `<repo>-<sha>` directory wrapping the tree.
    execFileSync('tar', ['-xzf', tarball, '-C', extractDir, '--strip-components=1']);
    rmSync(tarball, { force: true });
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }

  return { dir: extractDir, cleanup: () => rmSync(workDir, { recursive: true, force: true }) };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/server/src/plugins/fetch-source.test.ts`
Expected: PASS, 10 tests. If the escaping-member case passes for the wrong reason (tar refusing to *build* the evil archive), the test is worthless — check by printing `memberNames(tarball)` once and confirming it really contains `../escaped.js`, then remove the print.

- [ ] **Step 5: Run the gate and commit**

```bash
tsc --build --force
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/plugins/fetch-source.ts packages/server/src/plugins/fetch-source.test.ts
git commit -m "feat(server): materialise a plugin source from an https tarball or a local directory"
```

---

## Task 6: Sync — discover flow plugins, validate each by loading it, and write the table

A source directory becomes a set of installed rows. Discovery is one stated rule rather than a hardcoded path, so a source that is not Tdarr's repository still works: **a flow plugin is any `index.js` whose directory path ends `.../<pluginName>/<version>/index.js`, where `<version>` is `MAJOR.MINOR.PATCH`.** That is exactly the corpus layout, it naturally excludes classic plugins (which are bare `Tdarr_Plugin_*.js` files, not versioned `index.js`), and it is testable without the corpus.

Every candidate is then **loaded** and must expose a callable `plugin` and a `details()` with at least one output. A plugin that cannot be loaded is reported and skipped, never installed: an unloadable row would validate a flow and then fail on the first file, with an error naming a file rather than a plugin.

**Files:**
- Create: `packages/server/src/plugins/sync-source.ts`
- Create: `packages/server/src/plugins/sync-source.test.ts`

**Interfaces:**
- Consumes: `materialiseSource` from `./fetch-source.js`; `DiscoveredPlugin`, `PluginRepo` from `./plugin-repo.js`; `createPluginLoader` from `@trawlarr/engine` (already exported — `packages/server/src/api/routes/plugins.ts` imports it today). Tests additionally use `CORPUS_DIR`/`corpusAvailable` from the compat corpus helper.
- Produces:
  - `interface SyncReport { sourceId: string; installed: number; skipped: { relPath: string; reason: string }[] }`
  - `interface DiscoveredCandidate { pluginName: string; version: string; relPath: string; absPath: string }`
  - `discoverFlowPlugins(root: string): DiscoveredCandidate[]`
  - `syncSource(input: { repo: PluginRepo; sourceId: string; cacheDir: string; nowMs: () => number; fetchFn?: typeof fetch }): Promise<SyncReport>`

- [ ] **Step 1: Write the failing discovery tests**

Create `packages/server/src/plugins/sync-source.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverFlowPlugins, syncSource } from './sync-source.js';
import { createPluginRepo } from './plugin-repo.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

const openTestDb = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  return db;
};

const GOOD_PLUGIN = `
exports.details = () => ({
  name: 'Fixture Plugin',
  description: 'x',
  style: { borderColor: '#fff' },
  tags: '',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});
`;

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-sync-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
};

describe('discovery', () => {
  it('finds a plugin at <name>/<version>/index.js', () => {
    const root = tree({ 'FlowPlugins/x/myPlugin/1.0.0/index.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root).map((p) => p.pluginName)).toEqual(['myPlugin']);
  });

  it('ignores an index.js that is not under a version directory', () => {
    const root = tree({ 'src/index.js': GOOD_PLUGIN, 'methods/lib/index.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root)).toEqual([]);
  });

  it('ignores classic plugins, which are bare files rather than versioned index.js', () => {
    const root = tree({ 'Community/Tdarr_Plugin_abc_Thing.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root)).toEqual([]);
  });

  it('keeps the highest version when a plugin ships several', () => {
    const root = tree({
      'p/myPlugin/1.0.0/index.js': GOOD_PLUGIN,
      'p/myPlugin/1.10.0/index.js': GOOD_PLUGIN,
      'p/myPlugin/1.9.0/index.js': GOOD_PLUGIN,
    });
    // Compared numerically per component, so 1.10.0 beats 1.9.0. A string
    // sort would pick 1.9.0 and silently install the older plugin.
    expect(discoverFlowPlugins(root).map((p) => p.version)).toEqual(['1.10.0']);
  });

  it('records a path relative to the source root, for later flow-import translation', () => {
    const root = tree({ 'a/b/myPlugin/2.1.0/index.js': GOOD_PLUGIN });
    expect(discoverFlowPlugins(root)[0]!.relPath).toBe('a/b/myPlugin/2.1.0/index.js');
  });
});

describe('sync', () => {
  it('installs a discovered plugin under the source-s namespace', async () => {
    const root = tree({ 'p/myPlugin/1.0.0/index.js': GOOD_PLUGIN });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });

    const report = await syncSource({
      repo,
      sourceId: 'fixtures',
      cacheDir: mkdtempSync(join(tmpdir(), 'trawlarr-cache-')),
      nowMs: () => 1_700_000_000_000,
    });

    expect(report.installed).toBe(1);
    const installed = repo.listPlugins();
    expect(installed.map((p) => p.id)).toEqual(['fixtures:myPlugin']);
    expect(installed[0]!.details.name).toBe('Fixture Plugin');
    expect(installed[0]!.version).toBe('1.0.0');
    expect(repo.getSource('fixtures')!.lastSyncedAtMs).toBe(1_700_000_000_000);
  });

  it('skips a plugin that will not load, and names it, rather than installing a broken row', async () => {
    const root = tree({
      'p/good/1.0.0/index.js': GOOD_PLUGIN,
      'p/broken/1.0.0/index.js': 'throw new Error("boom");',
    });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });

    const report = await syncSource({
      repo,
      sourceId: 'fixtures',
      cacheDir: mkdtempSync(join(tmpdir(), 'trawlarr-cache-')),
      nowMs: () => 1,
    });

    expect(report.installed).toBe(1);
    expect(report.skipped.map((s) => s.relPath)).toEqual(['p/broken/1.0.0/index.js']);
    expect(repo.listPlugins().map((p) => p.id)).toEqual(['fixtures:good']);
  });

  it('skips a module that loads but is not a flow plugin', async () => {
    const root = tree({ 'p/notAPlugin/1.0.0/index.js': 'exports.hello = 1;' });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });
    const report = await syncSource({
      repo,
      sourceId: 'fixtures',
      cacheDir: mkdtempSync(join(tmpdir(), 'trawlarr-cache-')),
      nowMs: () => 1,
    });
    expect(report.installed).toBe(0);
    expect(report.skipped).toHaveLength(1);
  });

  it('a second sync removes a plugin that disappeared upstream', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'trawlarr-cache-'));
    const root = tree({ 'p/a/1.0.0/index.js': GOOD_PLUGIN, 'p/b/1.0.0/index.js': GOOD_PLUGIN });
    const repo = createPluginRepo(openTestDb());
    repo.addSource({ id: 'fixtures', url: root, kind: 'local' });
    await syncSource({ repo, sourceId: 'fixtures', cacheDir, nowMs: () => 1 });
    expect(repo.listPlugins()).toHaveLength(2);

    const shrunk = tree({ 'p/a/1.0.0/index.js': GOOD_PLUGIN });
    repo.removeSource('fixtures');
    repo.addSource({ id: 'fixtures', url: shrunk, kind: 'local' });
    await syncSource({ repo, sourceId: 'fixtures', cacheDir, nowMs: () => 2 });
    expect(repo.listPlugins().map((p) => p.id)).toEqual(['fixtures:a']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/server/src/plugins/sync-source.test.ts`
Expected: FAIL — cannot resolve `./sync-source.js`.

- [ ] **Step 3: Write the module**

Create `packages/server/src/plugins/sync-source.ts`:

```ts
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createPluginLoader } from '@trawlarr/engine';
import { materialiseSource } from './fetch-source.js';
import type { DiscoveredPlugin, PluginRepo } from './plugin-repo.js';

export interface SyncReport {
  sourceId: string;
  installed: number;
  skipped: { relPath: string; reason: string }[];
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Directories a plugin tree never keeps plugins in, and which are large
 * enough that walking them is the difference between a sync taking a second
 * and taking a minute.
 */
const PRUNED = new Set(['node_modules', '.git', '.github', 'dist', 'coverage']);

const compareVersions = (a: string, b: string): number => {
  const left = VERSION_PATTERN.exec(a)!;
  const right = VERSION_PATTERN.exec(b)!;
  for (let i = 1; i <= 3; i += 1) {
    // Numeric per component, not lexicographic: a string comparison ranks
    // "1.9.0" above "1.10.0" and silently installs the older plugin.
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return 0;
};

export interface DiscoveredCandidate {
  pluginName: string;
  version: string;
  relPath: string;
  absPath: string;
}

/**
 * A flow plugin is an `index.js` at `<pluginName>/<version>/index.js`.
 *
 * Stated as a rule rather than a hardcoded `FlowPlugins/CommunityFlowPlugins`
 * prefix so a source that is not Tdarr's repository works too — and because a
 * hardcoded prefix silently finds nothing when upstream reorganises, which
 * looks exactly like an empty repository.
 *
 * Classic plugins are excluded for free: they are bare `Tdarr_Plugin_*.js`
 * files, not versioned `index.js`, and trawlarr does not run them (spec 2.8).
 */
export const discoverFlowPlugins = (root: string): DiscoveredCandidate[] => {
  const best = new Map<string, DiscoveredCandidate>();

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!PRUNED.has(entry.name)) walk(abs);
        continue;
      }
      if (entry.name !== 'index.js') continue;

      const rel = relative(root, abs);
      const parts = rel.split(sep);
      // .../<pluginName>/<version>/index.js
      if (parts.length < 3) continue;
      const version = parts[parts.length - 2]!;
      const pluginName = parts[parts.length - 3]!;
      if (!VERSION_PATTERN.test(version)) continue;

      const candidate: DiscoveredCandidate = {
        pluginName,
        version,
        relPath: parts.join('/'),
        absPath: abs,
      };
      const existing = best.get(pluginName);
      if (existing === undefined || compareVersions(version, existing.version) > 0) {
        best.set(pluginName, candidate);
      }
    }
  };

  walk(root);
  return [...best.values()].sort((a, b) => (a.pluginName < b.pluginName ? -1 : 1));
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const syncSource = async (input: {
  repo: PluginRepo;
  sourceId: string;
  cacheDir: string;
  nowMs: () => number;
  fetchFn?: typeof fetch;
}): Promise<SyncReport> => {
  const source = input.repo.getSource(input.sourceId);
  if (source === null) {
    throw new Error(`No plugin source "${input.sourceId}". Add it before syncing.`);
  }

  const materialised = await materialiseSource({
    kind: source.kind,
    url: source.url,
    cacheDir: input.cacheDir,
    fetchFn: input.fetchFn,
  });

  try {
    const loader = createPluginLoader();
    const installed: DiscoveredPlugin[] = [];
    const skipped: { relPath: string; reason: string }[] = [];

    for (const candidate of discoverFlowPlugins(materialised.dir)) {
      try {
        // Loading is the validation. It runs the module body, which is what
        // `details()` costs, and it is the same thing the executor will do —
        // so a plugin that installs is a plugin that runs. Installing a row
        // we never loaded means a flow validates and then fails on the first
        // file, with an error naming a file rather than a plugin.
        const loaded = loader.load(candidate.absPath);
        if (typeof loaded.module.plugin !== 'function') {
          skipped.push({ relPath: candidate.relPath, reason: 'no plugin() export' });
          continue;
        }
        if (!Array.isArray(loaded.details.outputs) || loaded.details.outputs.length === 0) {
          skipped.push({ relPath: candidate.relPath, reason: 'details() declares no outputs' });
          continue;
        }
        installed.push({
          pluginName: candidate.pluginName,
          relPath: candidate.relPath,
          absPath: candidate.absPath,
          version: candidate.version,
          details: loaded.details,
        });
      } catch (error) {
        skipped.push({ relPath: candidate.relPath, reason: messageOf(error) });
      }
    }

    input.repo.replaceSourcePlugins(input.sourceId, installed);
    input.repo.markSynced(input.sourceId, input.nowMs());

    return { sourceId: input.sourceId, installed: installed.length, skipped };
  } finally {
    // A LOCAL source's cleanup is a no-op, so this cannot delete a user's
    // tree; a tarball source's extracted copy is what `absPath` points at,
    // which is why a tarball source keeps its extraction under the cache
    // directory rather than a temp dir that a reboot clears.
    if (source.kind !== 'tarball') materialised.cleanup();
  }
};
```

**Note the asymmetry in the `finally`, and do not "tidy" it:** a `local` source's `absPath` points into the user's own tree, which outlives the sync. A `tarball` source's `absPath` points into the extracted copy, so that copy **must not** be deleted — it is the installed plugin. It lives under `cacheDir`, which is inside the data directory, and the next sync of the same source replaces it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/server/src/plugins/sync-source.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add a real-corpus case**

Append to the same file — this proves discovery works on the tree it will actually meet:

```ts
import { CORPUS_DIR, corpusAvailable } from '../../../engine/test/compat/corpus.js';

describe.runIf(corpusAvailable())('against the real Tdarr corpus', () => {
  it('discovers the four plugins the parity pipeline needs', () => {
    const found = new Set(discoverFlowPlugins(CORPUS_DIR).map((p) => p.pluginName));
    expect(found.has('ffmpegCommandSetContainer')).toBe(true);
    expect(found.has('ffmpegCommandEnsureAudioStream')).toBe(true);
    expect(found.has('ffmpegCommandRemoveStreamByProperty')).toBe(true);
    expect(found.has('webRequest')).toBe(true);
  });

  it('does not discover classic plugins', () => {
    const found = discoverFlowPlugins(CORPUS_DIR).map((p) => p.pluginName);
    expect(found.some((name) => name.startsWith('Tdarr_Plugin_'))).toBe(false);
  });
});
```

`CORPUS_DIR` is `join(process.cwd(), 'cache', 'tdarr-plugins')`. If importing across package test directories is awkward under `tsconfig.typecheck.json`, inline that expression and an `existsSync` check on `FlowPlugins/CommunityFlowPlugins` rather than weakening the assertion or dropping the case.

- [ ] **Step 6: Run the gate and commit**

```bash
tsc --build --force
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/plugins/sync-source.ts packages/server/src/plugins/sync-source.test.ts
git commit -m "feat(server): discover, validate and install flow plugins from a source"
```

---

## Task 7: Resolve an installed id everywhere it is asked — validation, health, and the database-less worker

Installing a plugin is worthless until a flow can name it. Four places resolve a plugin id, and they must agree, because a disagreement produces a flow that validates and then cannot run — or, worse, a library that pauses itself:

1. `createNodeCapabilityResolver` — what flow validation reads.
2. `library-health.ts`'s own `createResolver()` — which **pauses a library** whose flow names an unresolvable plugin. Miss this one and installing a plugin, then using it, pauses the library with "this host cannot resolve it".
3. `buildJobPayload` — the daemon, which has the database.
4. `run-payload.ts`'s `loadPlugin` — the **forked worker, which never opens the database** (P2b decision 1). It therefore cannot look anything up and must be told, which is why the payload carries a map.

`JobPayload` must survive `JSON.parse(JSON.stringify(payload))` unchanged, so the map is a plain `Record<string, string>` and nothing else.

Only the ids the flow actually names go into the payload. Shipping the whole table would put a growing, mostly-irrelevant object through an IPC boundary on every job.

**Files:**
- Create: `packages/server/src/plugins/registry.ts`
- Create: `packages/server/src/plugins/registry.test.ts`
- Modify: `packages/server/src/flow/node-capabilities.ts`
- Modify: `packages/server/src/db/flow-repo.ts`
- Modify: `packages/server/src/daemon/library-health.ts`
- Modify: `packages/server/src/worker/job-payload.ts`
- Modify: `packages/server/src/worker/run-payload.ts`
- Create: `packages/server/test/plugin-install-end-to-end.test.ts`

**Interfaces:**
- Consumes: `createPluginRepo`, `parsePluginId` from `../plugins/*`; `Db` from `../db/connection.js`.
- Produces:
  - `interface PluginRegistry { resolveAbsPath(pluginId: string): string | null; resolveMany(ids: readonly string[]): Record<string, string> }`
  - `createPluginRegistry(db: Db): PluginRegistry`
  - `createNodeCapabilityResolver(options?: { loader?: PluginLoader; registry?: PluginRegistry })` — the parameter is added, the existing shape is unchanged.
  - `JobPayload.pluginPaths: Record<string, string>`

- [ ] **Step 1: Write the failing registry test**

Create `packages/server/src/plugins/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPluginRegistry } from './registry.js';
import { createPluginRepo } from './plugin-repo.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import type { PluginDetails } from '@trawlarr/plugin-api';

const details = (): PluginDetails =>
  ({
    name: 'x',
    description: '',
    style: { borderColor: '#fff' },
    tags: '',
    isStartPlugin: false,
    pType: '',
    sidebarPosition: 1,
    icon: '',
    inputs: [],
    outputs: [{ number: 1, tooltip: 'ok' }],
    requiresVersion: '1.0.0',
  }) as PluginDetails;

const seeded = () => {
  const db = openDatabase({ file: ':memory:' });
  migrate(db);
  const repo = createPluginRepo(db);
  repo.addSource({ id: 'tdarr', url: '/srv/p', kind: 'local' });
  repo.replaceSourcePlugins('tdarr', [
    {
      pluginName: 'ffmpegCommandSetContainer',
      relPath: 'a/ffmpegCommandSetContainer/1.0.0/index.js',
      absPath: '/srv/p/a/ffmpegCommandSetContainer/1.0.0/index.js',
      version: '1.0.0',
      details: details(),
    },
  ]);
  return db;
};

describe('the plugin registry', () => {
  it('resolves an installed id to its absolute path', () => {
    expect(
      createPluginRegistry(seeded()).resolveAbsPath('tdarr:ffmpegCommandSetContainer'),
    ).toBe('/srv/p/a/ffmpegCommandSetContainer/1.0.0/index.js');
  });

  it('answers null for a first-party id, leaving it to the first-party table', () => {
    expect(createPluginRegistry(seeded()).resolveAbsPath('trawlarr:execute')).toBeNull();
  });

  it('answers null for an absolute path, leaving it to the loader', () => {
    expect(createPluginRegistry(seeded()).resolveAbsPath('/media/p/index.js')).toBeNull();
  });

  it('resolveMany returns only the ids it knows', () => {
    expect(
      createPluginRegistry(seeded()).resolveMany([
        'tdarr:ffmpegCommandSetContainer',
        'tdarr:nope',
        'trawlarr:start',
      ]),
    ).toEqual({
      'tdarr:ffmpegCommandSetContainer': '/srv/p/a/ffmpegCommandSetContainer/1.0.0/index.js',
    });
  });

  it('sees a plugin installed after it was constructed', () => {
    // No caching: a sync must take effect on the very next validation, or a
    // user who just installed a plugin is told it does not exist.
    const db = seeded();
    const registry = createPluginRegistry(db);
    createPluginRepo(db).replaceSourcePlugins('tdarr', [
      {
        pluginName: 'newOne',
        relPath: 'a/newOne/1.0.0/index.js',
        absPath: '/srv/p/a/newOne/1.0.0/index.js',
        version: '1.0.0',
        details: details(),
      },
    ]);
    expect(registry.resolveAbsPath('tdarr:newOne')).toBe('/srv/p/a/newOne/1.0.0/index.js');
  });
});
```

- [ ] **Step 2: Run to verify it fails, then write the registry**

Run: `npx vitest run packages/server/src/plugins/registry.test.ts` — FAIL, cannot resolve `./registry.js`.

Create `packages/server/src/plugins/registry.ts`:

```ts
import type { Db } from '../db/connection.js';
import { createPluginRepo } from './plugin-repo.js';
import { parsePluginId } from './plugin-id.js';

/**
 * The single answer to "what file is this plugin id?".
 *
 * Deliberately uncached and deliberately tiny. Uncached because a sync must
 * take effect on the next validation — a cache here means "I just installed
 * it and trawlarr says it does not exist". Tiny because it is the seam handed
 * to the flow validator and the payload builder, neither of which should need
 * a database handle to be tested.
 */
export interface PluginRegistry {
  resolveAbsPath(pluginId: string): string | null;
  resolveMany(ids: readonly string[]): Record<string, string>;
}

export const createPluginRegistry = (db: Db): PluginRegistry => {
  const repo = createPluginRepo(db);
  return {
    resolveAbsPath: (pluginId) => {
      // `parsePluginId` rejects first-party ids and absolute paths, so those
      // never reach the database and keep their existing resolution.
      if (parsePluginId(pluginId) === null) return null;
      return repo.resolveAbsPaths([pluginId])[pluginId] ?? null;
    },
    resolveMany: (ids) => repo.resolveAbsPaths(ids),
  };
};
```

Run again: PASS, 5 tests.

- [ ] **Step 3: Teach the capability resolver about the registry**

In `packages/server/src/flow/node-capabilities.ts`, add `registry?: PluginRegistry` to the options and insert one branch between the first-party lookup and the path fallback:

```ts
    const installed = options?.registry?.resolveAbsPath(node.pluginId) ?? null;
    if (installed !== null) {
      try {
        const loaded = loader.load(installed);
        return capabilitiesFrom(loaded.details.outputs, loaded.details.isStartPlugin);
      } catch {
        return null;
      }
    }
```

In `packages/server/src/db/flow-repo.ts`, make the default resolver registry-aware. `createFlowRepo` already has `db`, so no caller changes:

```ts
  const resolveNodeCapabilities =
    options?.resolveNodeCapabilities ??
    createNodeCapabilityResolver({ registry: createPluginRegistry(db) });
```

- [ ] **Step 4: Teach library health about it, or installing a plugin pauses the library**

In `packages/server/src/daemon/library-health.ts`, `createResolver()` must take the registry and pass it through to `createNodeCapabilityResolver`. `checkLibraryHealth` and `checkAllLibraries` both receive `db`, so thread `createPluginRegistry(db)` down to it. Without this, a flow that uses an installed plugin reports `flow-invalid: flow "X" uses plugin(s) "tdarr:..." which this host cannot resolve` and the library is **paused** — the exact opposite of what installing the plugin was for.

Add a test to `packages/server/src/daemon/library-health.test.ts` alongside the existing unresolvable-plugin case. Reuse whatever that file already uses to seed a library and a flow; only the plugin-row seeding below is new.

```ts
const FIXTURE_PLUGIN = `
exports.details = () => ({
  name: 'Fixture Plugin',
  description: 'x',
  style: { borderColor: '#fff' },
  tags: '',
  isStartPlugin: true,
  pType: 'start',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});
`;

const installFixturePlugin = (db: Db): string => {
  const dir = join(mkdtempSync(join(tmpdir(), 'trawlarr-hp-')), 'p', 'myPlugin', '1.0.0');
  mkdirSync(dir, { recursive: true });
  const absPath = join(dir, 'index.js');
  writeFileSync(absPath, FIXTURE_PLUGIN, 'utf8');

  const repo = createPluginRepo(db);
  repo.addSource({ id: 'fx', url: join(dir, '..', '..', '..'), kind: 'local' });
  repo.replaceSourcePlugins('fx', [
    {
      pluginName: 'myPlugin',
      relPath: 'p/myPlugin/1.0.0/index.js',
      absPath,
      version: '1.0.0',
      details: createPluginLoader().load(absPath).details,
    },
  ]);
  return 'fx:myPlugin';
};

it('does not pause a library whose flow uses an INSTALLED plugin', () => {
  const db = openTestDb();
  const pluginId = installFixturePlugin(db);
  const flow = createFlowRepo(db).create({
    name: 'Installed',
    definition: {
      nodes: [{ id: 'a', pluginId, pluginVersion: '1.0.0', inputs: {} }],
      edges: [],
    },
  });
  const library = seedLibrary(db, { flowId: flow.id });

  const result = checkLibraryHealth({ db, bus, libraryId: library.id });

  // The pair matters: the sibling test asserts an UNRESOLVABLE plugin does
  // pause the library. A resolver that resolves everything passes this one
  // and fails that; a resolver that resolves nothing does the reverse.
  // Neither test alone can tell a working resolver from a broken one.
  expect(result.paused).toBe(false);
  expect(result.reason).toBeNull();
});
```

Adjust `seedLibrary`, `bus` and the `checkLibraryHealth` result field names to match what that file already does — read it first. If the existing unresolvable-plugin test asserts on a `pausedReason` string instead, mirror it exactly.

- [ ] **Step 5: Carry the map into the payload, and read it in the worker**

In `packages/server/src/worker/job-payload.ts`, add to `JobPayload`:

```ts
  /**
   * Installed plugin id -> absolute path, for exactly the ids this flow names.
   *
   * The worker is a forked process that never opens the database, so it
   * cannot look this up; and shipping the whole plugin table across the IPC
   * boundary on every job would grow without bound for no benefit. Plain
   * strings only: the payload must survive JSON round-tripping unchanged.
   */
  pluginPaths: Record<string, string>;
```

and populate it in `buildJobPayload`, which already holds `input.db`:

```ts
    pluginPaths: createPluginRegistry(input.db).resolveMany(
      flow.definition.nodes.map((node) => node.pluginId),
    ),
```

In `packages/server/src/worker/run-payload.ts`, inside `loadPlugin`, replace the final `return loader.load(node.pluginId);` with:

```ts
        // An installed plugin is named by its id; the daemon resolved it to a
        // path when it built this payload. An id that is not in the map is
        // still tried as a path, which is how a community plugin is named
        // without a source and must keep working.
        return loader.load(payload.pluginPaths[node.pluginId] ?? node.pluginId);
```

Every construction of a `JobPayload` in tests will now fail to type-check. Add `pluginPaths: {}` to each — that is the correct value for a test that uses only first-party plugins. **`packages/server/src/worker/run-job.test.ts` must stay byte-for-byte unmodified**; if it constructs a payload literal and now fails, that is a signal the field should be optional-with-default rather than required — make it `pluginPaths?: Record<string, string>` and read it as `payload.pluginPaths?.[node.pluginId] ?? node.pluginId`, and note the choice in the commit message.

- [ ] **Step 6: Write the end-to-end proof**

Create `packages/server/test/plugin-install-end-to-end.test.ts`. This is the test that says the whole phase works: sync a local source, build a flow naming an installed plugin, run it against a real file, and assert the file on disk changed.

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolAvailableSync } from '../../../test-support/tool-availability.js';
import { corpusAvailable, CORPUS_DIR } from '../../engine/test/compat/corpus.js';

const execFileAsync = promisify(execFile);
const available = toolAvailableSync('ffmpeg') && toolAvailableSync('ffprobe') && corpusAvailable();

describe.runIf(available)('installing a community plugin and running it', () => {
  it('remuxes a real file through a flow that names an installed plugin', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'trawlarr-install-'));
    const libraryDir = join(dataDir, 'library');
    mkdirSync(libraryDir, { recursive: true });
    const mediaPath = join(libraryDir, 'Sample.mkv');
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      mediaPath,
    ]);

    const cli = (args: string[]) =>
      execFileAsync('node', [join(process.cwd(), 'packages/server/dist/cli.js'), ...args], {
        maxBuffer: 10 * 1024 * 1024,
      });

    // The corpus IS a local plugin source — no network needed, and it is the
    // same tree the compat suites run against.
    await cli(['--data-dir', dataDir, 'plugin', 'source', 'add', '--name', 'tdarr', '--path', CORPUS_DIR]);
    const { stdout: syncOut } = await cli(['--data-dir', dataDir, 'plugin', 'source', 'sync', '--name', 'tdarr']);
    expect(syncOut).toMatch(/tdarr/);

    const { stdout: listOut } = await cli(['--data-dir', dataDir, 'plugin', 'list']);
    expect(listOut).toContain('tdarr:ffmpegCommandSetContainer');

    const flowPath = join(dataDir, 'flow.json');
    writeFileSync(
      flowPath,
      JSON.stringify({
        nodes: [
          { id: 'start', pluginId: 'trawlarr:start', pluginVersion: '1.0.0', inputs: {} },
          { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: '1.0.0', inputs: {} },
          {
            id: 'container',
            pluginId: 'tdarr:ffmpegCommandSetContainer',
            pluginVersion: '1.0.0',
            inputs: { container: 'mp4', forceConform: 'true' },
          },
          { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: '1.0.0', inputs: {} },
          {
            id: 'verify',
            pluginId: 'trawlarr:verifyOutput',
            pluginVersion: '1.0.0',
            inputs: { durationToleranceSeconds: '1', minSizeRatio: '0.05' },
          },
          {
            id: 'replace',
            pluginId: 'trawlarr:replaceOriginal',
            pluginVersion: '1.0.0',
            inputs: { trashRetentionDays: '14', allowCrossDevice: 'true' },
          },
        ],
        edges: [
          { fromNodeId: 'start', outputNumber: 1, toNodeId: 'begin' },
          { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'container' },
          { fromNodeId: 'container', outputNumber: 1, toNodeId: 'execute' },
          { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
          { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
        ],
      }),
      'utf8',
    );

    await cli(['--data-dir', dataDir, 'library', 'add', '--name', 'Movies', '--root', libraryDir]);
    await cli(['--data-dir', dataDir, 'flow', 'add', '--name', 'Remux', '--file', flowPath]);
    await cli(['--data-dir', dataDir, 'library', 'set-flow', '--library', 'Movies', '--flow', 'Remux']);
    await cli(['--data-dir', dataDir, 'scan', '--library', 'Movies']);
    await cli(['--data-dir', dataDir, 'run', '--library', 'Movies', '--max', '1']);

    // The observable outcome: the library file is now an mp4, at the stem the
    // user's file had. Not a log line, not an exit code.
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0',
      join(libraryDir, 'Sample.mp4'),
    ]);
    expect(stdout).toContain('mp4');
  }, 300_000);
});
```

- [ ] **Step 7: Run everything and commit**

```bash
tsc --build --force
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git diff --stat -- packages/server/src/worker/run-job.test.ts   # must print nothing
git add packages/server/src/plugins/registry.ts packages/server/src/plugins/registry.test.ts \
        packages/server/src/flow/node-capabilities.ts packages/server/src/db/flow-repo.ts \
        packages/server/src/daemon/library-health.ts packages/server/src/daemon/library-health.test.ts \
        packages/server/src/worker/job-payload.ts packages/server/src/worker/run-payload.ts \
        packages/server/test/plugin-install-end-to-end.test.ts
git commit -m "feat(server): resolve installed plugin ids in validation, health and the worker"
```

Note: this task's end-to-end test depends on the CLI commands built in Task 8. Write the test in Task 7, watch it fail for the right reason (`unknown command: plugin`), and complete it at the end of Task 8 — or reorder the two if you prefer a green suite at every commit. If you leave it red across one commit, say so in that commit's message.

---

## Task 8: The `trawlarr plugin` command group

The CLI is the only interface this phase can safely finish, since the API surface belongs to another agent this week. It is also the interface the migration guide will tell the owner to use.

**Files:**
- Modify: `packages/server/src/cli.ts`
- Modify: `packages/server/src/cli.test.ts`

**Interfaces:**
- Consumes: `createPluginRepo`, `syncSource`, `assertValidSourceSlug`, `PluginSourceError` from `../plugins/*`; the existing `CliError`, argument parsing and daemon-lock-file routing already in `cli.ts`.
- Produces: no exports; six commands.

Commands, matching the shapes `library` and `flow` already use:

| Command | Flags | Behaviour |
| --- | --- | --- |
| `plugin source add` | `--name`, and one of `--url` (https tarball) or `--path` (local directory) | Validates the slug, stores the row, prints the id and kind. |
| `plugin source list` | — | Name, kind, url, last sync, installed count. |
| `plugin source remove` | `--name` | Removes the source and its plugins. |
| `plugin source sync` | `--name`, or `--all` | Runs `syncSource`; prints installed count and every skipped plugin with its reason. |
| `plugin list` | `--source` (optional) | First-party and installed plugins, id then display name. |
| `plugin show` | `--id` | The plugin's `details()`: inputs with defaults, outputs with tooltips. |

- [ ] **Step 1: Write the failing CLI tests**

Add to `packages/server/src/cli.test.ts`. That file drives the CLI **in process** via `main(argv)`, which returns the exit code, and reads output through the `stdout()` / `stderr()` spy helpers already defined at the top of the file. `newDataDir()` is its temp-directory helper. Match those; do not introduce a subprocess runner.

```ts
/** Writes <tmp>/p/myPlugin/1.0.0/index.js — the layout `discoverFlowPlugins` looks for. */
const writeFixturePluginTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-cli-plugins-'));
  const dir = join(root, 'p', 'myPlugin', '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.js'),
    `
exports.details = () => ({
  name: 'Fixture Plugin',
  description: 'x',
  style: { borderColor: '#fff' },
  tags: '',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 1,
  icon: '',
  inputs: [],
  outputs: [{ number: 1, tooltip: 'ok' }],
  requiresVersion: '1.0.0',
});
exports.plugin = (args) => ({
  outputNumber: 1,
  outputFileObj: { _id: args.inputFileObj._id },
  variables: args.variables,
});
`,
    'utf8',
  );
  return root;
};

describe('plugin source', () => {
  it('adds a local source and lists it', async () => {
    const dataDir = newDataDir();
    const tree = writeFixturePluginTree();
    expect(
      await main(['plugin', 'source', 'add', '--name', 'fx', '--path', tree, '--data-dir', dataDir]),
    ).toBe(0);
    expect(await main(['plugin', 'source', 'list', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('fx');
    expect(stdout()).toContain(tree);
  });

  it('refuses a source named trawlarr, by name', async () => {
    const dataDir = newDataDir();
    expect(
      await main([
        'plugin', 'source', 'add', '--name', 'trawlarr', '--path', '/tmp', '--data-dir', dataDir,
      ]),
    ).not.toBe(0);
    expect(stderr()).toMatch(/reserved/i);
  });

  it('refuses both --url and --path together rather than picking one', async () => {
    const dataDir = newDataDir();
    expect(
      await main([
        'plugin', 'source', 'add', '--name', 'fx',
        '--url', 'https://example.test/x.tar.gz', '--path', '/tmp',
        '--data-dir', dataDir,
      ]),
    ).not.toBe(0);
    expect(stderr()).toMatch(/one of/i);
  });

  it('refuses neither --url nor --path', async () => {
    const dataDir = newDataDir();
    expect(
      await main(['plugin', 'source', 'add', '--name', 'fx', '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toMatch(/one of/i);
  });

  it('syncs a local source, and the installed plugin appears beside the first-party ones', async () => {
    const dataDir = newDataDir();
    const tree = writeFixturePluginTree();
    await main(['plugin', 'source', 'add', '--name', 'fx', '--path', tree, '--data-dir', dataDir]);
    expect(await main(['plugin', 'source', 'sync', '--name', 'fx', '--data-dir', dataDir])).toBe(0);
    expect(await main(['plugin', 'list', '--data-dir', dataDir])).toBe(0);
    expect(stdout()).toContain('fx:myPlugin');
    expect(stdout()).toContain('trawlarr:execute');
  });

  it('names the source that does not exist rather than failing anonymously', async () => {
    const dataDir = newDataDir();
    expect(
      await main(['plugin', 'source', 'sync', '--name', 'nope', '--data-dir', dataDir]),
    ).not.toBe(0);
    expect(stderr()).toContain('nope');
  });

  it('removing a source removes its plugins', async () => {
    const dataDir = newDataDir();
    const tree = writeFixturePluginTree();
    await main(['plugin', 'source', 'add', '--name', 'fx', '--path', tree, '--data-dir', dataDir]);
    await main(['plugin', 'source', 'sync', '--name', 'fx', '--data-dir', dataDir]);
    expect(await main(['plugin', 'source', 'remove', '--name', 'fx', '--data-dir', dataDir])).toBe(0);
    await main(['plugin', 'list', '--data-dir', dataDir]);
    expect(stdout()).not.toContain('fx:myPlugin');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `tsc --build --force && npx vitest run packages/server/src/cli.test.ts`
Expected: FAIL with the CLI's own unknown-command error naming `plugin`.

- [ ] **Step 3: Implement the command group**

In `packages/server/src/cli.ts`, add the dispatch alongside the existing `library` / `flow` / `trash` ones (near line 1538) and write the group in their style:

```ts
  if (cmd === 'plugin') {
    const [sub, ...pluginRest] = rest;
    if (sub === 'source') return cmdPluginSource(pluginRest);
    if (sub === 'list') return cmdPluginList(pluginRest);
    if (sub === 'show') return cmdPluginShow(pluginRest);
    throw new CliError(
      `plugin: unknown subcommand "${sub ?? ''}". Expected one of: source, list, show.`,
    );
  }
```

and, mirroring how `cmdFlowAdd` parses and validates:

```ts
const cmdPluginSourceAdd = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      url: { type: 'string' },
      path: { type: 'string' },
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
    },
  });

  if (values.name === undefined) throw new CliError('plugin source add: --name is required.');

  const hasUrl = values.url !== undefined && values.url !== '';
  const hasPath = values.path !== undefined && values.path !== '';
  if (hasUrl === hasPath) {
    // Both, or neither. Refused rather than resolved by precedence: an
    // ignored flag silently gives the user the OTHER one's behaviour, which
    // is a source pointing somewhere they did not ask for.
    throw new CliError(
      `plugin source add: exactly one of --url (an https .tar.gz, for example ` +
        `https://codeload.github.com/HaveAGitGat/Tdarr_Plugins/tar.gz/master) or --path (a ` +
        `directory already on this machine) is required.`,
    );
  }

  const db = await openDb(values['data-dir']!);
  const repo = createPluginRepo(db);
  const source = repo.addSource({
    id: values.name,
    url: hasUrl ? values.url! : values.path!,
    // There is exactly one sensible kind per flag, so the user never types one.
    kind: hasUrl ? 'tarball' : 'local',
  });
  console.log(
    `Added plugin source "${source.id}" (${source.kind}): ${source.url}. ` +
      `Run "trawlarr plugin source sync --name ${source.id}" to install its plugins.`,
  );
  return 0;
};

const cmdPluginSourceSync = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      all: { type: 'boolean', default: false },
      'data-dir': { type: 'string', default: process.env.TRAWLARR_DATA_DIR ?? './trawlarr-data' },
    },
  });
  if (values.name === undefined && values.all !== true) {
    throw new CliError('plugin source sync: --name <source> or --all is required.');
  }

  const dataDir = resolve(values['data-dir']!);
  const db = await openDb(dataDir);
  const repo = createPluginRepo(db);

  const targets =
    values.all === true
      ? repo.listSources().filter((source) => source.enabled)
      : [
          repo.getSource(values.name!) ??
            (() => {
              throw new CliError(
                `plugin source sync: no plugin source "${values.name!}". ` +
                  `Known: ${repo.listSources().map((s) => s.id).join(', ') || '(none)'}.`,
              );
            })(),
        ];

  for (const target of targets) {
    const report = await syncSource({
      repo,
      sourceId: target.id,
      // A tarball source's extracted tree IS the installed plugin, so it lives
      // permanently under the data directory, not in a temp dir a reboot clears.
      cacheDir: join(dataDir, 'plugins'),
      nowMs: () => Date.now(),
    });
    console.log(`Synced "${target.id}": ${report.installed} plugin(s) installed.`);
    for (const skip of report.skipped) {
      // Printed individually: a source where half the plugins failed to load
      // must not look like a source where they never existed.
      console.log(`  skipped ${skip.relPath}: ${skip.reason}`);
    }
  }
  return 0;
};
```

`cmdPluginSourceList`, `cmdPluginSourceRemove`, `cmdPluginList` and `cmdPluginShow` follow the same shape: parse, open, read, print one line per row. Requirements that are not obvious from the table:

- **`--url` and `--path` are alternatives, and passing both is an error**, not a precedence rule. Mirror the wording `flow add` uses for `--file`/`--template`: an ignored flag silently gives the user the other one's behaviour.
- **`--path` implies `kind: 'local'`; `--url` implies `kind: 'tarball'`.** The user never types a kind — there is exactly one sensible kind per flag, and asking would be a question with only one answer.
- **The sync cache directory is `<data-dir>/plugins`.** A tarball source's extracted tree lives there permanently, because it *is* the installed plugin (see Task 6's note on the asymmetric cleanup).
- **`plugin source sync` prints every skipped plugin and why.** A source where half the plugins failed to load must not look like a source where they did not exist.
- **`plugin` commands route through the daemon when one holds the lock**, exactly as `library` and `flow` do — a sync writes the database, and the daemon is the sole writer. Follow whatever the existing commands do; do not open the database behind a live daemon. If the API routes are not landed yet (Task 9), these commands must fail with a named message saying the daemon owns the database and to stop it or wait for the routes, rather than corrupting anything.

- [ ] **Step 4: Run the tests, then complete Task 7's end-to-end test**

Run: `tsc --build --force && npx vitest run packages/server/src/cli.test.ts packages/server/test/plugin-install-end-to-end.test.ts`
Expected: PASS. The end-to-end test from Task 7 should now go green; if it does not, the failure is real and is the point of the test.

- [ ] **Step 5: Run the gate and commit**

```bash
tsc --build --force
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/cli.ts packages/server/src/cli.test.ts
git commit -m "feat(cli): trawlarr plugin source add/list/remove/sync and plugin list/show"
```

---

## Task 9: The five 501s become real handlers

**This is the one task that edits `packages/server/src/api`.** It edits exactly one file, `packages/server/src/api/routes/plugins.ts`, and every module it calls is already tested by Task 4–7. Before starting, check whether the web-UI agent is currently editing that file; if so, land Task 10 first and come back, or hand this task to whoever owns the file that week. Nothing else in this plan depends on it.

**Files:**
- Modify: `packages/server/src/api/routes/plugins.ts`
- Modify: `packages/server/src/api/api.test.ts`

**Interfaces:**
- Consumes: `createPluginRepo` from `../../plugins/plugin-repo.js`; `syncSource` from `../../plugins/sync-source.js`; `PluginSourceError` from `../../plugins/fetch-source.js`; `PluginIdError` from `../../plugins/plugin-id.js`; the existing `ApiError`, `Route`, and `ctx.db`.
- Produces: five working endpoints.

| Route | Body / params | Response |
| --- | --- | --- |
| `GET /plugins/sources` | — | `PluginSourceRow[]`, each with `installedCount`. |
| `POST /plugins/sources` | `{ id, url?, path?, }` | 201 with the created row. 400 (`invalid-source`) for a bad slug or both/neither of url and path; 409 (`source-exists`) for a duplicate url. |
| `PUT /plugins/sources/:id` | `{ enabled }` | The updated row. 404 if unknown. |
| `DELETE /plugins/sources/:id` | — | 204. 404 if unknown. |
| `POST /plugins/sources/:id/sync` | — | The `SyncReport`. 404 if unknown; 400 (`source-unreachable`) wrapping a `PluginSourceError`, with its message passed through — those messages are written for a human and are the whole diagnostic. |

Also: `installedResources(db)` currently parses `details_json` three times per row and derives the name from `rel_path`. Replace it with `createPluginRepo(ctx.db).listPlugins()`, which parses once and returns typed rows, and delete the local `PluginRow` interface — a second definition of the plugin table's shape is exactly the drift this phase exists to remove.

- [ ] **Step 1: Write the failing API tests**

Add to `packages/server/src/api/api.test.ts`, using the `api(method, path, body?)` helper already in that file. That file also already defines `THIRD_PARTY_PLUGIN_CODE`, a loadable flow-plugin module body — reuse it rather than writing a second fixture:

```ts
/** <tmp>/p/myPlugin/1.0.0/index.js — the layout `discoverFlowPlugins` looks for. */
const writeFixtureTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-api-plugins-'));
  const dir = join(root, 'p', 'myPlugin', '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), THIRD_PARTY_PLUGIN_CODE, 'utf8');
  return root;
};

describe('plugin sources', () => {
  let fixtureTree = '';
  beforeEach(() => {
    fixtureTree = writeFixtureTree();
  });

  it('lists no sources on a fresh install, rather than 501', async () => {
    const res = await api('GET', '/plugins/sources');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('creates a local source and reports it', async () => {
    const created = await api('POST', '/plugins/sources', { id: 'fx', path: fixtureTree });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'fx', kind: 'local', enabled: true });
  });

  it('refuses a duplicate url with 409, naming the source that already has it', async () => {
    await api('POST', '/plugins/sources', { id: 'fx', path: fixtureTree });
    const again = await api('POST', '/plugins/sources', { id: 'fx2', path: fixtureTree });
    expect(again.status).toBe(409);
    expect(String(again.body.message)).toContain('fx');
  });

  it('refuses the reserved namespace with 400', async () => {
    const res = await api('POST', '/plugins/sources', { id: 'trawlarr', path: fixtureTree });
    expect(res.status).toBe(400);
  });

  it('syncs and then lists the installed plugin through GET /plugins', async () => {
    await api('POST', '/plugins/sources', { id: 'fx', path: fixtureTree });
    const sync = await api('POST', '/plugins/sources/fx/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.installed).toBe(1);

    const plugins = await api('GET', '/plugins');
    const ids = (plugins.body as { id: string }[]).map((p) => p.id);
    expect(ids).toContain('fx:myPlugin');
    expect(ids).toContain('trawlarr:execute');
  });

  it('reports a sync of an unknown source as 404, not 500', async () => {
    const res = await api('POST', '/plugins/sources/nope/sync');
    expect(res.status).toBe(404);
  });

  it('deleting a source removes its plugins from GET /plugins', async () => {
    await api('POST', '/plugins/sources', { id: 'fx', path: fixtureTree });
    await api('POST', '/plugins/sources/fx/sync');
    expect((await api('DELETE', '/plugins/sources/fx')).status).toBe(204);
    const ids = ((await api('GET', '/plugins')).body as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain('fx:myPlugin');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `tsc --build --force && npx vitest run packages/server/src/api/api.test.ts`
Expected: FAIL with 501 on the first case.

- [ ] **Step 3: Implement the handlers**

Replace each `notImplemented(SOURCES_NOT_IMPLEMENTED)` with a handler delegating to `createPluginRepo(ctx.db)` and `syncSource`. Delete `SOURCES_NOT_IMPLEMENTED`. Keep `GET /plugins/:id`'s path fallback exactly as it is — naming a plugin by absolute path must keep working, and Task 7 preserved it for the same reason.

The two that carry the error mapping, in full; the other three are plain reads and deletes:

```ts
  {
    method: 'POST',
    path: '/plugins/sources',
    handler: ({ body, ctx }) => {
      const input = body as { id?: string; url?: string; path?: string };
      const hasUrl = typeof input.url === 'string' && input.url !== '';
      const hasPath = typeof input.path === 'string' && input.path !== '';
      if (typeof input.id !== 'string' || hasUrl === hasPath) {
        throw new ApiError(
          400,
          'invalid-source',
          `A plugin source needs an "id" and exactly one of "url" (an https .tar.gz) or ` +
            `"path" (an absolute directory on the server).`,
        );
      }
      try {
        return {
          status: 201,
          body: createPluginRepo(ctx.db).addSource({
            id: input.id,
            url: hasUrl ? input.url! : input.path!,
            kind: hasUrl ? 'tarball' : 'local',
          }),
        };
      } catch (error) {
        // A reserved or malformed slug is the client's mistake (400); a url
        // that is already registered is a conflict (409). Collapsing both to
        // 500 would tell a UI author nothing about which one to fix.
        if (error instanceof PluginIdError) {
          throw new ApiError(400, 'invalid-source', error.message);
        }
        if (error instanceof Error && /already exists/i.test(error.message)) {
          throw new ApiError(409, 'source-exists', error.message);
        }
        throw error;
      }
    },
  },

  {
    method: 'POST',
    path: '/plugins/sources/:id/sync',
    handler: async ({ params, ctx }) => {
      const repo = createPluginRepo(ctx.db);
      const id = params.id!;
      if (repo.getSource(id) === null) {
        throw new ApiError(404, 'source-not-found', `No plugin source "${id}".`);
      }
      if (ctx.dataDir == null) {
        throw new ApiError(
          400,
          'no-data-directory',
          `This host has no data directory, so there is nowhere to install plugins into.`,
        );
      }
      try {
        return await syncSource({
          repo,
          sourceId: id,
          cacheDir: join(ctx.dataDir, 'plugins'),
          nowMs: ctx.nowMs,
        });
      } catch (error) {
        if (error instanceof PluginSourceError) {
          // These messages are written for a human and are the whole
          // diagnostic — pass them through rather than replacing them.
          throw new ApiError(400, 'source-unreachable', error.message);
        }
        throw error;
      }
    },
  },
```

Adjust `ctx.dataDir` / `ctx.nowMs` to whatever the router context actually exposes — read `packages/server/src/api/router.ts` first. If the context carries no data directory, thread one in from wherever the server is constructed rather than reading `process.cwd()`.

The sync handler needs a cache directory; take it from the same place the rest of the API learns the data directory (`ctx`), and if `ctx` has no data directory, answer 400 with a named message rather than writing into the process's cwd.

- [ ] **Step 4: Run, gate, commit**

```bash
tsc --build --force
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/api/routes/plugins.ts packages/server/src/api/api.test.ts
git commit -m "feat(api): implement plugin sources — list, create, enable, delete, sync"
```

---

## Task 10: His pipeline as a validated template, and the documentation that was wrong

The last task turns everything above into something the owner runs. It also corrects the migration guide, whose "Not yet" rows are now false in a way that would send him away from a capability he has.

**One finding belongs in the template and nowhere else:** his Movies and Shows libraries differ only in where "Ensure 2ch AAC Audio" sits relative to "Transcode". That ordering difference is an **Unmanic artifact** — Unmanic runs a separate ffmpeg pass per plugin, so plugin order is encode order. In trawlarr every command-building node contributes to **one** ffmpeg invocation that is compiled once by `compileFfmpegArgs`, so the audio node and the encoder node touch different streams and their order does not change the argv. **Both libraries therefore use one template.** Say so in the migration guide, because "why did my two pipelines become one?" is otherwise an unanswered question.

**Files:**
- Modify: `packages/server/src/flow/templates.ts`
- Modify: `packages/server/src/flow/templates.test.ts`
- Create: `docs/flows/conform-mkv-hevc-nvenc.json`
- Modify: `docs/migrating-from-unmanic.md`
- Modify: `docs/engineering-notes/p2-prerequisites.md`

**Interfaces:**
- Consumes: `FlowTemplate`, `FlowTemplateParameter`, `buildFromTemplate`, `FLOW_TEMPLATES` from `./templates.js`.
- Produces: `FlowTemplate` gains `requiredPlugins: string[]`; a new template `conform-library`.

- [ ] **Step 1: Write the failing template tests**

Add to `packages/server/src/flow/templates.test.ts`:

```ts
describe('the conform-library template', () => {
  const build = (values: Record<string, string> = {}) =>
    buildFromTemplate({ templateId: 'conform-library', values });

  it('declares the community plugins it needs, so a fresh install is told to sync', () => {
    const template = FLOW_TEMPLATES.find((t) => t.id === 'conform-library')!;
    expect(template.requiredPlugins).toEqual([
      'ffmpegCommandSetContainer',
      'ffmpegCommandCustomArguments',
      'ffmpegCommandEnsureAudioStream',
      'ffmpegCommandRemoveStreamByProperty',
    ]);
  });

  it('carries his exact encoder settings into the node inputs', () => {
    const flow = build({ encoder: 'hevc_nvenc', quality: '23' });
    const encoder = flow.nodes.find((n) => n.id === 'encoder')!;
    expect(encoder.inputs).toMatchObject({ encoder: 'hevc_nvenc', quality: '23' });
  });

  it('carries -max_muxing_queue_size 2048 as a custom argument, with no preset by default', () => {
    const flow = build();
    const custom = flow.nodes.find((n) => n.id === 'muxqueue')!;
    // No preset by default: preset names are encoder-specific (nvenc takes
    // p1..p7, libx265 takes ultrafast..placebo), so a default that suits one
    // encoder is an invalid argument for the other and fails every job.
    expect(custom.inputs.outputArguments).toBe('-max_muxing_queue_size 2048');
  });

  it('appends a preset only when one was asked for', () => {
    const flow = build({ preset: 'p4' });
    const custom = flow.nodes.find((n) => n.id === 'muxqueue')!;
    expect(custom.inputs.outputArguments).toBe('-max_muxing_queue_size 2048 -preset p4');
  });

  it('defaults the destination container to mkv', () => {
    expect(build().nodes.find((n) => n.id === 'container')!.inputs.container).toBe('mkv');
  });

  it('keeps English audio and never removes an untagged track', () => {
    const remove = build().nodes.find((n) => n.id === 'language')!;
    expect(remove.inputs).toMatchObject({
      codecType: 'audio',
      propertyToCheck: 'tags.language',
      valuesToRemove: 'eng',
      condition: 'not_includes',
    });
    // keep_undefined needs no input: the plugin never judges a stream whose
    // property is absent. Pinned in packages/engine/test/compat.
  });

  it('leaves the already-target-codec output of the check node routed onward, not dead-ended', () => {
    // Unlike transcode-hevc, a converged-codec file may still need a remux,
    // an audio track or a language filter — so output 1 rejoins the chain
    // rather than ending the flow.
    const flow = build();
    const fromCheck = flow.edges.filter((e) => e.fromNodeId === 'check');
    expect(fromCheck.map((e) => e.outputNumber).sort()).toEqual([1, 2]);
  });

  it('validates', () => {
    const problems = validateFlowDefinition(build(), () => null);
    expect(problems).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then write the template**

Run: `tsc --build --force && npx vitest run packages/server/src/flow/templates.test.ts` — FAIL, unknown template.

Add `requiredPlugins: string[]` to the `FlowTemplate` interface (`transcodeHevc` gets `requiredPlugins: []`), then add the new template:

```ts
const conformParameters: FlowTemplateParameter[] = [
  {
    name: 'pluginSource',
    label: 'Plugin source name',
    type: 'string',
    defaultValue: 'tdarr',
    tooltip:
      'The name you gave the plugin source with "trawlarr plugin source add". It prefixes ' +
      'every community plugin id this template uses, because you choose your own source name.',
  },
  {
    name: 'container',
    label: 'Destination container',
    type: 'string',
    defaultValue: 'mkv',
    options: ['mkv', 'mp4'],
    tooltip:
      'Files already in this container are not remuxed — the node compares against the ' +
      'file extension, so a converged library costs nothing here.',
  },
  {
    name: 'targetCodec',
    label: 'Target video codec',
    type: 'string',
    defaultValue: 'hevc',
    options: ['hevc', 'h264', 'av1'],
    tooltip:
      'A file whose video already uses this codec skips the encoder — but NOT the rest of ' +
      'the flow, because it may still need a remux, an audio track or a language filter.',
  },
  {
    name: 'encoder',
    label: 'Encoder',
    type: 'string',
    defaultValue: 'hevc_nvenc',
    options: ['hevc_nvenc', 'libx265', 'libx264', 'h264_nvenc', 'hevc_qsv', 'hevc_vaapi'],
    tooltip:
      'A hardware encoder requires that hardware to be declared on this node AND present in ' +
      'the ffmpeg build. Trawlarr never falls back to software: a wrong declaration produces ' +
      'failing jobs, three attempts per file.',
  },
  {
    name: 'quality',
    label: 'Quality',
    type: 'string',
    defaultValue: '23',
    tooltip:
      'Lower is better quality and larger files. The flag this becomes (-crf, -cq, -qp, ' +
      '-global_quality) depends on the encoder and is chosen for you.',
  },
  {
    name: 'audioLanguage',
    label: 'Audio language to guarantee',
    type: 'string',
    defaultValue: 'eng',
    tooltip:
      'A stereo AAC track in this language is ADDED if the file does not already have one. ' +
      'Note "added", not "converted" — the original track is kept beside it.',
  },
  {
    name: 'keepLanguages',
    label: 'Audio languages to keep',
    type: 'string',
    defaultValue: 'eng',
    tooltip:
      'Comma-separated. Audio in any other language is removed. A track with NO language ' +
      'tag is always kept — the plugin never judges a stream whose language is missing, ' +
      'which is what stops a badly-tagged rip losing all of its audio.',
  },
  {
    name: 'preset',
    label: 'Encoder preset',
    type: 'string',
    defaultValue: '',
    tooltip:
      'Optional, and encoder-specific: NVENC takes p1-p7 (Unmanic\'s "preset 4" is p4), ' +
      'libx264/libx265 take ultrafast through placebo. Left empty by default because a ' +
      'preset name valid for one encoder is an invalid argument for the other, and ffmpeg ' +
      'fails outright rather than ignoring it.',
  },
  {
    name: 'maxMuxingQueueSize',
    label: 'Max muxing queue size',
    type: 'string',
    defaultValue: '2048',
    tooltip:
      'Raises ffmpeg\'s muxing queue. Needed for files that would otherwise fail with ' +
      '"Too many packets buffered for output stream".',
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

const conformLibrary: FlowTemplate = {
  id: 'conform-library',
  name: 'Remux, transcode, and conform audio and languages',
  description:
    'The full parity stack: remux to one container, transcode video that is not already the ' +
    'target codec, guarantee a stereo AAC track, drop audio in unwanted languages, verify, ' +
    'and replace the original. Requires community plugins — sync a plugin source first.',
  parameters: conformParameters,
  requiredPlugins: [
    'ffmpegCommandSetContainer',
    'ffmpegCommandCustomArguments',
    'ffmpegCommandEnsureAudioStream',
    'ffmpegCommandRemoveStreamByProperty',
  ],
  build: (values) => {
    const value = (name: string): string => {
      const given = values[name];
      const parameter = conformParameters.find((candidate) => candidate.name === name)!;
      // An empty string is a MISSING value, not a chosen one: it arrives from
      // an untouched form field and from `--set quality=`, and passing it
      // through would put "" where a node expects a codec.
      return given === undefined || given === '' ? parameter.defaultValue : given;
    };
    const community = (pluginName: string): string => `${value('pluginSource')}:${pluginName}`;

    return {
      nodes: [
        { id: 'start', pluginId: 'trawlarr:start', pluginVersion: PLUGIN_VERSION, inputs: {} },
        { id: 'begin', pluginId: 'trawlarr:beginCommand', pluginVersion: PLUGIN_VERSION, inputs: {} },
        {
          id: 'container',
          pluginId: community('ffmpegCommandSetContainer'),
          pluginVersion: PLUGIN_VERSION,
          // forceConform removes streams the target container cannot carry.
          // Right for mkv->mp4, wrong as a default: for a library already in
          // the target container it can only take things away.
          inputs: { container: value('container'), forceConform: 'false' },
        },
        {
          id: 'check',
          pluginId: 'trawlarr:checkVideoCodec',
          pluginVersion: PLUGIN_VERSION,
          inputs: { codec: value('targetCodec') },
        },
        {
          id: 'encoder',
          pluginId: 'trawlarr:setVideoEncoder',
          pluginVersion: PLUGIN_VERSION,
          inputs: { encoder: value('encoder'), quality: value('quality') },
        },
        {
          id: 'muxqueue',
          pluginId: community('ffmpegCommandCustomArguments'),
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            inputArguments: '',
            // The preset is appended here rather than set on Set Video
            // Encoder, which has no preset input. It reaches the encoder as a
            // global output option, which is safe because the video is the
            // only stream being encoded — a copied audio stream ignores it.
            outputArguments: [
              `-max_muxing_queue_size ${value('maxMuxingQueueSize')}`,
              value('preset') === '' ? '' : `-preset ${value('preset')}`,
            ]
              .filter((part) => part !== '')
              .join(' '),
          },
        },
        {
          id: 'audio',
          pluginId: community('ffmpegCommandEnsureAudioStream'),
          pluginVersion: PLUGIN_VERSION,
          inputs: { audioEncoder: 'aac', language: value('audioLanguage'), channels: '2' },
        },
        {
          id: 'language',
          pluginId: community('ffmpegCommandRemoveStreamByProperty'),
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            codecType: 'audio',
            propertyToCheck: 'tags.language',
            valuesToRemove: value('keepLanguages'),
            condition: 'not_includes',
          },
        },
        { id: 'execute', pluginId: 'trawlarr:execute', pluginVersion: PLUGIN_VERSION, inputs: {} },
        {
          id: 'verify',
          pluginId: 'trawlarr:verifyOutput',
          pluginVersion: PLUGIN_VERSION,
          inputs: {
            durationToleranceSeconds: '1',
            minSizeRatio: '0.05',
            requireAudioIfOriginalHadAudio: 'true',
          },
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
        { fromNodeId: 'start', outputNumber: 1, toNodeId: 'begin' },
        { fromNodeId: 'begin', outputNumber: 1, toNodeId: 'container' },
        { fromNodeId: 'container', outputNumber: 1, toNodeId: 'check' },
        // Output 1 is "already the target codec". Unlike transcode-hevc it is
        // NOT dead-ended: such a file may still need a remux, a stereo track
        // or a language filter. It rejoins after the encoder, which is the
        // only node it skips. Two edges INTO one node is legal; two edges out
        // of one OUTPUT is not.
        { fromNodeId: 'check', outputNumber: 1, toNodeId: 'muxqueue' },
        { fromNodeId: 'check', outputNumber: 2, toNodeId: 'encoder' },
        { fromNodeId: 'encoder', outputNumber: 1, toNodeId: 'muxqueue' },
        { fromNodeId: 'muxqueue', outputNumber: 1, toNodeId: 'audio' },
        { fromNodeId: 'audio', outputNumber: 1, toNodeId: 'language' },
        { fromNodeId: 'language', outputNumber: 1, toNodeId: 'execute' },
        { fromNodeId: 'execute', outputNumber: 1, toNodeId: 'verify' },
        { fromNodeId: 'verify', outputNumber: 1, toNodeId: 'replace' },
      ],
    };
  },
};

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [transcodeHevc, conformLibrary];
```

The graph, and the reasoning for the shape:

```
start -> begin -> container -> check
check output 2 (codec differs)  -> encoder -> muxqueue
check output 1 (already target) -> muxqueue
muxqueue -> audio -> language -> execute -> verify -> replace
```

Both branches rejoin at `muxqueue`. Two edges INTO one node is allowed; only two edges OUT of one output is not. `Check Video Codec`'s "already this codec" output is **not** dead-ended here, unlike `transcode-hevc`: a file that is already HEVC may still need a remux, a stereo track or a language filter, and dead-ending it would leave those undone for ever. The only node it skips is the encoder.

Nodes and plugin ids — community ids are written as `<sourceSlug>:<pluginName>` with the slug supplied as a template parameter (`pluginSource`, default `tdarr`), because the user chooses their own source name:

| Node id | Plugin | Inputs from parameters |
| --- | --- | --- |
| `start` | `trawlarr:start` | — |
| `begin` | `trawlarr:beginCommand` | — |
| `container` | `<src>:ffmpegCommandSetContainer` | `container` (default `mkv`), `forceConform` (default `false`) |
| `check` | `trawlarr:checkVideoCodec` | `codec` = `targetCodec` (default `hevc`) |
| `encoder` | `trawlarr:setVideoEncoder` | `encoder` (default `hevc_nvenc`), `quality` (default `23`) |
| `muxqueue` | `<src>:ffmpegCommandCustomArguments` | `inputArguments` `''`, `outputArguments` `-max_muxing_queue_size 2048`, plus `-preset <preset>` when `preset` is set |
| `audio` | `<src>:ffmpegCommandEnsureAudioStream` | `audioEncoder` `aac`, `language` `eng`, `channels` `2` |
| `language` | `<src>:ffmpegCommandRemoveStreamByProperty` | `codecType` `audio`, `propertyToCheck` `tags.language`, `valuesToRemove` = `keepLanguages` (default `eng`), `condition` `not_includes` |
| `execute` | `trawlarr:execute` | — |
| `verify` | `trawlarr:verifyOutput` | `durationToleranceSeconds` `1`, `minSizeRatio` `0.05`, `requireAudioIfOriginalHadAudio` `true` |
| `replace` | `trawlarr:replaceOriginal` | `trashRetentionDays` (default `14`), `allowCrossDevice` `true` |

Two things the implementer must not "simplify":

- **`forceConform` defaults to `false`.** It removes streams the target container cannot carry, which is right for mkv→mp4 and wrong as a default: for a user whose container is already mkv it can only take things away.
- **`muxqueue` is on the common path, after the branches rejoin.** `Custom Arguments` pushes to `overallOuputArguments`, and `deriveShouldProcess` treats a non-empty `overallOuputArguments` as work to be done — so putting it anywhere that a converged file passes through makes **every file** run ffmpeg for ever. Here that is intentional and harmless because the flow always transcodes or remuxes something by the time it reaches Execute; if you move it, re-check that claim.

- [ ] **Step 3: Make `flow add --template` refuse when required plugins are missing**

In `packages/server/src/cli.ts`'s `flow add`, after resolving the template, check every `requiredPlugins` entry against `createPluginRepo(db).listPlugins()` (prefixed with the chosen `pluginSource`) and refuse by name:

```
Error: flow add: template "conform-library" needs plugin(s) "tdarr:ffmpegCommandSetContainer",
"tdarr:ffmpegCommandEnsureAudioStream" which are not installed. Add and sync a plugin source
first:
  trawlarr plugin source add --name tdarr --url https://codeload.github.com/HaveAGitGat/Tdarr_Plugins/tar.gz/master
  trawlarr plugin source sync --name tdarr
(exit 1)
```

Storing the flow anyway would be worse than refusing: validation treats an unresolvable plugin as *unknown, not wrong*, so it would be accepted, attached, and then fail on the first file with an error naming a file.

Add a CLI test asserting exit code 1 and that the message names both the missing plugin and the two commands.

- [ ] **Step 4: Check the built flow into `docs/flows/`, drift-tested**

Write `docs/flows/conform-mkv-hevc-nvenc.json` as the output of `buildFromTemplate({ templateId: 'conform-library', values: { encoder: 'hevc_nvenc', quality: '23' } })`, and add the drift test alongside whatever guards the existing two:

```ts
it('docs/flows/conform-mkv-hevc-nvenc.json matches what the template builds', () => {
  const path = join(process.cwd(), 'docs/flows/conform-mkv-hevc-nvenc.json');
  // Assert the path EXISTS rather than gating on it: gating on existsSync
  // makes a renamed fixture skip silently, which makes a drift alarm green.
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
    buildFromTemplate({
      templateId: 'conform-library',
      values: { encoder: 'hevc_nvenc', quality: '23' },
    }),
  );
});
```

- [ ] **Step 5: Correct the migration guide**

In `docs/migrating-from-unmanic.md` §4, replace the five wrong rows. The current table says "Not yet" for capabilities that exist today:

| Unmanic step | Trawlarr today | Verdict |
| --- | --- | --- |
| Remux to a different container | `Set Container` (community plugin) | **Supported** |
| Transcode or normalise audio | `Ensure Audio Stream`, `Normalize Audio` (community) | **Supported** |
| Strip tracks by language, drop commentary | `Remove Stream By Property` (community) | **Supported** |
| Notify a webhook / Discord / Telegram / Plex | `Send Web Request`, `Apprise`, `Notify Radarr or Sonarr` (community) | **Supported** |
| Rename, move or copy the result | `Move To Directory`, `Rename File`, `Copy To Directory` (community) | **Supported** |
| Extract or burn in subtitles | — | **Not yet.** No community flow plugin covers it. |

Also add, as a new subsection under §4:

- **Installing plugins**: the two `trawlarr plugin source` commands, the fact that a source is a git/HTTP tarball URL or a local directory and that **there is no central service to register with**, and that plugins land in `<data-dir>/plugins`.
- **The Plex recipe**, concretely: a `Send Web Request` node with method `get` and URL `http://<plex>:32400/library/sections/<id>/refresh?X-Plex-Token=<token>`, with `output2OnNetworkError` **on** — because a Plex that is down must not invalidate a transcode that already succeeded.
- **Why Movies and Shows become one flow** (the single-ffmpeg-invocation point above).
- **Where his `preset 4` went**: `trawlarr:setVideoEncoder` has no preset input, so the template appends one as a custom argument. For NVENC that is `--set preset=p4`. Say plainly that the mapping from Unmanic's numeric preset to NVENC's `p1`-`p7` is a judgement, not a documented equivalence, so he can check it against a single file before running the library.
- **The `Ensure Audio Stream` semantic difference**: Unmanic's `ensure_2ch_aac_audio` *converts*; the Tdarr plugin *adds* a track alongside the original. To end up with only the stereo track, follow it with `Remove Stream By Property`.

- [ ] **Step 6: Record this phase in the engineering notes**

Append a `## P2d — plugin distribution` section to `docs/engineering-notes/p2-prerequisites.md` covering, at minimum:

- **`Verify Output` compared against the original's stream count**, which made every stream-removing community plugin unusable in any flow that replaces its original — four plugins, one of them in the owner's pipeline, each failing three attempts per file and landing in `failed`. Record that the fix removed an accidental fail-safe and that the audio gate deliberately replaces it, and *why the gate is in the host rather than on a node*.
- **`keep_undefined` needed no work**: `Remove Stream By Property` already skips any stream whose property reads `undefined`. Record it so nobody re-derives it or "adds" it.
- **Spec §7 is now divergent, by the owner's call**: it anticipated 10–15 first-party plugins including "set audio codec, remux container, webhook notify". The rule is now that a capability with an existing Tdarr community plugin is **not** reimplemented first-party; a duplicate fragments the ecosystem the project exists to run. Put this under "Still inaccurate in the spec — owner's call".
- **No `git` in the runtime image**, which is why sources are HTTPS tarballs and local directories rather than clones. If a future phase wants `git` sources, it must add the binary to the Dockerfile first.
- **The tarball source's extraction is the installed plugin**, so `syncSource`'s cleanup is asymmetric by kind, and `<data-dir>/plugins` must be backed up or re-synced — it is not scratch.
- **`packages/server/src/api/routes/flows.ts`'s standalone validate endpoint still constructs a registry-less resolver**, so it under-validates a flow naming an installed plugin. Harmless (unknown is treated as neutral) but should be threaded through when that file is next free.

- [ ] **Step 7: Run the full gate and commit**

```bash
tsc --build --force
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/flow/templates.ts packages/server/src/flow/templates.test.ts \
        packages/server/src/cli.ts packages/server/src/cli.test.ts \
        docs/flows/conform-mkv-hevc-nvenc.json docs/migrating-from-unmanic.md \
        docs/engineering-notes/p2-prerequisites.md
git commit -m "feat(server): conform-library flow template, and correct the migration guide"
```

---

## Appendix: decisions taken, and what was deliberately not built

**No first-party node is added by this phase.** Every capability previously scoped as one already exists as a Tdarr community flow plugin; the audit is in "What was verified" above. Building duplicates would fragment the ecosystem the project's premise depends on.

**No Plex node, and no general webhook node.** `tools/webRequest` already sends an arbitrary method, URL, headers and body through `args.deps.axios`, which trawlarr injects as real axios; a Plex partial scan is one HTTP GET, so it is already expressible, and Task 1 asserts exactly that request shape against a real server. A Plex-specific node would be a worse version of a plugin that exists, and Tdarr itself ships no Plex flow node. What *is* worth building later, and is not built here, is a **daemon-side, per-library, debounced** library refresh: a flow node fires once per file, so a library-wide conversion sends thousands of refreshes at a media server. That is not a flow node at all, it needs settings and API surface that belong to the web-UI agent this week, and the WebSocket already carries the job events a script can act on today.

**`fail_safe` became a host gate, not a node input.** It is the one genuinely missing behaviour, and putting it in `Verify Output` protects against every plugin rather than one.

**Recommended cuts if this phase must be shortened.** In order: Task 9 (the API routes) — the CLI reaches everything and the routes collide with another agent's file; then the `tarball` source kind, leaving `local` only, which still lets the owner point at a checkout he controls and removes the fetch, the archive guard and their tests. Do **not** cut Task 3: without it his language filter fails every file it touches. Do not cut Task 2: this repository has already shipped a data-loss bug that only a real-ffmpeg assertion could see.
