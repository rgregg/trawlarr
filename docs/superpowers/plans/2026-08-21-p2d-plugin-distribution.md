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
| `packages/server/src/daemon/daemon.ts` | Construct the registry once and hand it to the payload builder and the capability resolver. |
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
import { AddressInfo } from 'node:net';
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
        const requireAudioIfOriginalHadAudio = args.inputs.requireAudioIfOriginalHadAudio !== false
          && String(args.inputs.requireAudioIfOriginalHadAudio ?? 'true') !== 'false';
```

and pass both into the `verifyOutput({ ... })` call. Note the double read: node inputs arrive as the string `'false'` from a stored flow and as the boolean `false` from a test, and treating only one of them as off would make the switch look wired while doing nothing.

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
- Consumes: `materialiseSource`, `PluginSourceError` from `./fetch-source.js`; `createPluginRepo`, `DiscoveredPlugin`, `PluginRepo` from `./plugin-repo.js`; `createPluginLoader` from `@trawlarr/engine`; `pluginPath`/`corpusAvailable` from the compat corpus helper **only in tests**.
- Produces:
  - `interface SyncReport { sourceId: string; installed: number; skipped: { relPath: string; reason: string }[] }`
  - `discoverFlowPlugins(root: string): { pluginName: string; version: string; relPath: string; absPath: string }[]`
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
import { corpusAvailable, pluginPath } from '../../../engine/test/compat/corpus.js';

const corpusRoot = () => join(pluginPath(''), '..', '..', '..');

describe.runIf(corpusAvailable())('against the real Tdarr corpus', () => {
  it('discovers the four plugins the parity pipeline needs', () => {
    const found = new Set(discoverFlowPlugins(corpusRoot()).map((p) => p.pluginName));
    expect(found.has('ffmpegCommandSetContainer')).toBe(true);
    expect(found.has('ffmpegCommandEnsureAudioStream')).toBe(true);
    expect(found.has('ffmpegCommandRemoveStreamByProperty')).toBe(true);
    expect(found.has('webRequest')).toBe(true);
  });

  it('does not discover classic plugins', () => {
    const found = discoverFlowPlugins(corpusRoot()).map((p) => p.pluginName);
    expect(found.some((name) => name.startsWith('Tdarr_Plugin_'))).toBe(false);
  });
});
```

If importing across package test directories is awkward under the typecheck config, inline the two constants instead — `join(process.cwd(), 'cache', 'tdarr-plugins')` and an `existsSync` on `FlowPlugins/CommunityFlowPlugins` — rather than weakening the assertion or dropping the case.

- [ ] **Step 6: Run the gate and commit**

```bash
tsc --build --force
pnpm build && pnpm lint && pnpm test && pnpm audit:licenses
git add packages/server/src/plugins/sync-source.ts packages/server/src/plugins/sync-source.test.ts
git commit -m "feat(server): discover, validate and install flow plugins from a source"
```
