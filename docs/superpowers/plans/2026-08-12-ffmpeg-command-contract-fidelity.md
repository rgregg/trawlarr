# ffmpegCommand Contract Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make trawlarr's `ffmpegCommand` faithful to Tdarr's *runtime* contract, so community `ffmpegCommand` plugins produce correct ffmpeg invocations instead of silently wrong ones.

**Architecture:** Five gaps, all in the same seam. `@trawlarr/plugin-api` gains the `mapArgs` field the runtime object actually carries; `@trawlarr/core`'s `beginFfmpegCommand` seeds it and applies the cover-art guard; `ffmpeg-compile.ts` gains upstream's output-index helpers, placeholder substitution, and copy-codec rule; the Execute node honours `shouldProcess`. The compatibility harness is then extended to the two plugins that prove it.

**Tech Stack:** Node 22, TypeScript, vitest, ffmpeg 6.1.1.

## Why this exists

P1 declared plugin compatibility validated on four community plugins, none of which exercised stream mapping. Reading the corpus afterwards showed the *declared* interface (four mutation fields) omits a fifth field the *runtime* object carries, and that Execute does work our compiler does not. Concretely, today:

- `ffmpegCommandRorderStreams` deep-clones and reorders `streams` (`splice` + `concat`). Our compiler derives `-map` from array position, so **after a reorder we emit wrongly-mapped tracks, silently**. Upstream is immune because each stream carries its own `mapArgs`.
- `ffmpegCommandEnsureAudioStream` pushes a stream whose `outputArgs` contain the literal strings `-c:{outputIndex}` and `-b:a:{outputTypeIndex}`. Upstream substitutes those at execute time. **We would pass the literal placeholders to ffmpeg**, which fails.
- `ffmpegCommandExecute` spreads `stream.mapArgs` unconditionally, so running the *community* Execute against a trawlarr-built command throws on spreading `undefined`.

## Global Constraints

- License MIT. No code, comment, or type file copied from Tdarr, Tdarr_Plugins, or Unmanic — reimplement behaviour from observed semantics, in our own words.
- `@trawlarr/core` performs no IO: no `node:fs`, `node:child_process`, network, or `Date.now()`. `node:crypto` allowed. Lint-enforced.
- Upstream misspellings are contract keys and must be preserved: `overallOuputArguments`, `lastSuccesfulPlugin`.
- Node 22 required (`.nvmrc`). `better-sqlite3` does not load on the ambient Node 25 — run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` first, or the suite fails confusingly.
- If any `package.json` changes, `pnpm-lock.yaml` must be committed in the same commit; CI runs `pnpm install --frozen-lockfile`.
- New workspace dependencies also need a matching tsconfig project reference — `pnpm check:refs` enforces this.
- Verification standard: `pnpm build && pnpm lint && pnpm test`, run twice. `pnpm lint` includes `prettier --check .`.
- No timing-dependent test assertions.
- The GPL corpus lives in gitignored `cache/tdarr-plugins/` and must never be committed. Fetch with `pnpm compat:fetch`.

## Semantics established by reading the corpus

Recorded here so no task has to guess. Source: `ffmpegCommandStart/1.0.0` and `ffmpegCommandExecute/1.0.0`.

**Seeding (Start):** each ffprobe stream is spread, then given `removed: false`, `mapArgs: ['-map', '0:<stream.index>']`, `inputArgs: []`, `outputArgs: []`. Before that, a stream whose `disposition.attached_pic` is 1 has its `codec_type` rewritten to `'attachment'` — this is the cover-art guard, and its absence is why an mjpeg cover-art stream currently receives the video encoder.

**Execute, in order:**
1. `shouldProcess` becomes true if `overallInputArguments` is non-empty.
2. Removed streams are filtered out; any removal sets `shouldProcess` true.
3. Zero surviving streams throws `No streams mapped for new file`.
4. Per surviving stream: substitute `{outputIndex}` and `{outputTypeIndex}` in `outputArgs`; emit `mapArgs`; if the copy rule applies emit `-c:<outputIndex> copy`; emit `outputArgs`; accumulate `inputArgs`.
5. `overallOuputArguments` are appended and set `shouldProcess` true.

**Output index** is the stream's position among *surviving* streams. **Output type index** is its position among surviving streams *of the same `codec_type`*.

> Both upstream helpers contain a condition that looks wrong — they test the *target* stream's `removed` flag inside the loop rather than the candidate's. It is inert, because Execute filters removed streams before calling them, so the flag is always false there. **Implement the effective semantics (position among survivors), not that condition.** Do not "faithfully" reproduce it; a future reader would rightly delete it.

**The copy rule** adds `-c:<outputIndex> copy` when `outputArgs` is empty, OR when it contains no codec-setting argument and every *flag* in it is copy-compatible. Codec-setting means matching `/^-(c|codec)(:|$)/` or `/^-[vasd]codec(:|$)/`. Copy-compatible flags are exactly `-metadata`, `-metadata:*`, `-disposition`, `-disposition:*`. Upstream scans in flag/value pairs, inspecting only flag positions — so `['-metadata:s:0', 'language=eng']` is copy-compatible because only `-metadata:s:0` is examined.

---

## File Structure

| File | Change |
| --- | --- |
| `packages/plugin-api/src/ffmpeg.ts` | Add `mapArgs: string[]` to `FfmpegCommandStream` |
| `packages/core/src/ffmpeg-command.ts` | Seed `mapArgs`; apply the attached-pic guard; add `deriveShouldProcess` |
| `packages/core/src/ffmpeg-compile.ts` | Output-index helpers, placeholder substitution, copy rule, use `mapArgs`, throw on zero streams |
| `packages/core/src/ffmpeg-command.test.ts` | Seeding and `shouldProcess` tests |
| `packages/core/src/ffmpeg-compile.test.ts` | Compiler tests |
| `packages/engine/src/executor/execute-node.ts` | Honour `shouldProcess` |
| `packages/engine/test/compat/community-plugins.test.ts` | Add reorder and ensure-audio cases |

---

## Task 1: `mapArgs` and the cover-art guard

**Files:**
- Modify: `packages/plugin-api/src/ffmpeg.ts`
- Modify: `packages/core/src/ffmpeg-command.ts`
- Modify: `packages/core/src/ffmpeg-compile.ts`
- Test: `packages/core/src/ffmpeg-command.test.ts`, `packages/core/src/ffmpeg-compile.test.ts`

**Interfaces:**
- Consumes: existing `beginFfmpegCommand`, `compileFfmpegArgs`.
- Produces: `FfmpegCommandStream` gains required `mapArgs: string[]`. `beginFfmpegCommand` seeds it and rewrites attached-pic streams. `compileFfmpegArgs` emits `stream.mapArgs` rather than deriving `-map` from array position.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/ffmpeg-command.test.ts`:

```ts
describe('beginFfmpegCommand — mapArgs and attachments', () => {
  it('seeds mapArgs from the ffprobe stream index, not the array position', () => {
    // Index 0 is absent from the array on purpose: ffprobe indices need not
    // start at 0 or be contiguous, and the map argument must follow the real
    // index or ffmpeg selects the wrong track.
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [
          { index: 3, codec_type: 'video', codec_name: 'h264' },
          { index: 7, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(cmd.streams[0]?.mapArgs).toEqual(['-map', '0:3']);
    expect(cmd.streams[1]?.mapArgs).toEqual(['-map', '0:7']);
  });

  it('falls back to the array position when a stream has no index', () => {
    const cmd = beginFfmpegCommand({
      probe: { streams: [{ codec_type: 'video', codec_name: 'h264' }] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(cmd.streams[0]?.mapArgs).toEqual(['-map', '0:0']);
  });

  it('gives each stream its own mapArgs array', () => {
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    cmd.streams[0]?.mapArgs.push('-extra');
    expect(cmd.streams[1]?.mapArgs).toEqual(['-map', '0:1']);
  });

  it('reclassifies an attached-picture stream as an attachment', () => {
    // Cover art is an mjpeg "video" stream. Left as video, a Set Video Encoder
    // node would try to re-encode the poster frame.
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(cmd.streams[0]?.codec_type).toBe('video');
    expect(cmd.streams[1]?.codec_type).toBe('attachment');
  });

  it('leaves a normal video stream alone when disposition is absent or zero', () => {
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 0 } },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    expect(cmd.streams.map((s) => s.codec_type)).toEqual(['video', 'video']);
  });
});
```

Add to `packages/core/src/ffmpeg-compile.test.ts`:

```ts
describe('compileFfmpegArgs — mapArgs', () => {
  it('emits each stream mapArgs rather than deriving from array position', () => {
    // This is the reorder case: a plugin may reorder the streams array, after
    // which array position no longer matches the source track.
    const cmd = beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    cmd.streams.reverse();
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    // Audio (source index 1) is now first, and must still map to 0:1.
    expect(args.slice(args.indexOf('-i') + 2)).toEqual([
      '-map', '0:1', '-map', '0:0', '-c', 'copy', '/out.mkv',
    ]);
  });

  it('honours mapArgs a plugin has rewritten', () => {
    const cmd = beginFfmpegCommand({
      probe: { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    cmd.streams[0]!.mapArgs = ['-map', '1:5'];
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toContain('1:5');
  });

  it('falls back to the stream index when mapArgs was emptied', () => {
    const cmd = beginFfmpegCommand({
      probe: { streams: [{ index: 4, codec_type: 'video', codec_name: 'h264' }] },
      container: 'mkv',
      inputPath: '/in.mkv',
    });
    cmd.streams[0]!.mapArgs = [];
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toContain('0:4');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

```
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
pnpm test -- packages/core
```
Expected: failures on `mapArgs` being undefined, on `codec_type` still `'video'` for the attached-pic stream, and on the reorder case emitting `0:0 0:1`.

- [ ] **Step 3: Add the field to the contract**

In `packages/plugin-api/src/ffmpeg.ts`, add to `FfmpegCommandStream`:

```ts
  /**
   * The `-map` arguments selecting this stream from its input. Carried per
   * stream rather than derived from array position, because plugins reorder,
   * insert and clone streams — after a reorder, position no longer identifies
   * the source track. Seeded as ['-map', '0:<ffprobe index>'].
   *
   * Present on the runtime object even though it is easy to overlook when
   * reading the published interface; community plugins spread it directly.
   */
  mapArgs: string[];
```

- [ ] **Step 4: Seed it and add the guard**

In `packages/core/src/ffmpeg-command.ts`, replace the `streams` mapping inside `beginFfmpegCommand`:

```ts
/** ffprobe reports cover art as a video stream carrying this disposition. */
const isAttachedPicture = (stream: ProbeStream): boolean =>
  Number((stream.disposition as Record<string, unknown> | undefined)?.attached_pic) === 1;

const mapArgsFor = (stream: ProbeStream, position: number): string[] => {
  const index = typeof stream.index === 'number' ? stream.index : position;
  return ['-map', `0:${index}`];
};
```

and in the returned object:

```ts
  streams: (input.probe.streams ?? []).map(
    (stream, position): FfmpegCommandStream => ({
      ...stream,
      // Cover art is an mjpeg "video" stream; reclassifying it keeps encoder
      // nodes, which select on codec_type, from trying to re-encode a poster.
      codec_type: isAttachedPicture(stream) ? 'attachment' : stream.codec_type,
      removed: false,
      forceEncoding: false,
      mapArgs: mapArgsFor(stream, position),
      inputArgs: [],
      outputArgs: [],
    }),
  ),
```

- [ ] **Step 5: Use mapArgs in the compiler**

In `packages/core/src/ffmpeg-compile.ts`, replace the `-map` emission. Where it currently pushes `'-map', \`0:${index}\``, push the stream's own arguments instead, falling back only if a plugin emptied them:

```ts
const mapArgsOf = (stream: FfmpegCommandStream, position: number): string[] => {
  if (stream.mapArgs.length > 0) return stream.mapArgs;
  const index = typeof stream.index === 'number' ? stream.index : position;
  return ['-map', `0:${index}`];
};
```

and in the per-stream loop use `args.push(...mapArgsOf(stream, command.streams.indexOf(stream)))`.

- [ ] **Step 6: Run the tests**

Run: `pnpm test -- packages/core`
Expected: PASS. Existing compile tests that assert `-map 0:N` still pass, because seeding produces the same values when the array is in probe order.

- [ ] **Step 7: Full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/plugin-api packages/core
git commit -m "feat(plugin-api,core): carry mapArgs per stream and reclassify cover art

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Output indices and placeholder substitution

**Files:**
- Modify: `packages/core/src/ffmpeg-compile.ts`
- Test: `packages/core/src/ffmpeg-compile.test.ts`

**Interfaces:**
- Consumes: Task 1's `mapArgs`.
- Produces: `outputStreamIndex(streams, stream): number` and `outputStreamTypeIndex(streams, stream): number`, both exported from `ffmpeg-compile.ts` and both taking the *surviving* streams. `compileFfmpegArgs` substitutes `{outputIndex}` and `{outputTypeIndex}` in every stream's `outputArgs`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('compileFfmpegArgs — placeholder substitution', () => {
  const threeStreams = () =>
    beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'audio', codec_name: 'ac3' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });

  it('substitutes {outputIndex} with the position among surviving streams', () => {
    const cmd = threeStreams();
    cmd.streams[2]!.outputArgs.push('-c:{outputIndex}', 'libopus');
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toContain('-c:2');
  });

  it('substitutes {outputTypeIndex} with the position among same-type survivors', () => {
    // Stream 2 is the second audio stream, so its type index is 1.
    const cmd = threeStreams();
    cmd.streams[2]!.outputArgs.push('-b:a:{outputTypeIndex}', '128k');
    expect(compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toContain('-b:a:1');
  });

  it('renumbers after a removal, so indices follow survivors not originals', () => {
    const cmd = threeStreams();
    cmd.streams[1]!.removed = true;
    cmd.streams[2]!.outputArgs.push('-c:{outputIndex}', 'libopus', '-b:a:{outputTypeIndex}', '96k');
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    // Survivors are video(0) and ac3, so the ac3 output index is 1 and, being
    // the only surviving audio stream, its type index is 0.
    expect(args).toContain('-c:1');
    expect(args).toContain('-b:a:0');
    expect(args).not.toContain('-c:2');
  });

  it('substitutes every occurrence in one argument', () => {
    const cmd = threeStreams();
    cmd.streams[1]!.outputArgs.push('-filter:{outputIndex}', 'x={outputIndex}');
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    expect(args).toContain('-filter:1');
    expect(args).toContain('x=1');
  });

  it('does not mutate the caller command', () => {
    // The compiler must stay pure: a dry run compiles the same command a real
    // run later executes, and must not leave substituted values behind.
    const cmd = threeStreams();
    cmd.streams[1]!.outputArgs.push('-c:{outputIndex}', 'libopus');
    compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    expect(cmd.streams[1]!.outputArgs).toEqual(['-c:{outputIndex}', 'libopus']);
  });
});

describe('output index helpers', () => {
  const streams = () =>
    beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'audio', codec_name: 'ac3' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    }).streams;

  it('numbers output streams from zero in order', () => {
    const s = streams();
    expect(s.map((stream) => outputStreamIndex(s, stream))).toEqual([0, 1, 2]);
  });

  it('numbers type indices per codec_type', () => {
    const s = streams();
    expect(s.map((stream) => outputStreamTypeIndex(s, stream))).toEqual([0, 0, 1]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm test -- packages/core/src/ffmpeg-compile.test.ts`
Expected: FAIL — `outputStreamIndex` not exported, and placeholders passing through literally.

- [ ] **Step 3: Implement**

In `packages/core/src/ffmpeg-compile.ts`:

```ts
/**
 * Position of a stream among the streams that will actually be written.
 * ffmpeg's `-c:<n>` and friends address output streams, which renumber from
 * zero after any removal — so this is not the input index and not the array
 * position.
 *
 * Callers pass the already-filtered surviving streams.
 */
export const outputStreamIndex = (
  streams: readonly FfmpegCommandStream[],
  stream: FfmpegCommandStream,
): number => streams.indexOf(stream);

/** As above, but counted within the stream's own codec_type. */
export const outputStreamTypeIndex = (
  streams: readonly FfmpegCommandStream[],
  stream: FfmpegCommandStream,
): number =>
  streams.filter((candidate) => candidate.codec_type === stream.codec_type).indexOf(stream);

/**
 * Plugins write `-c:{outputIndex}` and `-b:a:{outputTypeIndex}` because they
 * cannot know their stream's final output position — removals and insertions
 * elsewhere in the flow decide it. Resolving them is the host's job; passing
 * them through would hand ffmpeg a literal brace.
 */
const substitutePlaceholders = (
  outputArgs: readonly string[],
  streams: readonly FfmpegCommandStream[],
  stream: FfmpegCommandStream,
): string[] =>
  outputArgs.map((arg) =>
    arg
      .replaceAll('{outputIndex}', String(outputStreamIndex(streams, stream)))
      .replaceAll('{outputTypeIndex}', String(outputStreamTypeIndex(streams, stream))),
  );
```

In the per-stream loop, compute `const resolvedOutputArgs = substitutePlaceholders(stream.outputArgs, kept, stream);` and emit that instead of `stream.outputArgs`. Do not write back onto the stream — the command must be reusable.

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- packages/core`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core
git commit -m "feat(core): resolve {outputIndex} and {outputTypeIndex} when compiling

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The copy-codec rule

**Files:**
- Modify: `packages/core/src/ffmpeg-compile.ts`
- Test: `packages/core/src/ffmpeg-compile.test.ts`

**Interfaces:**
- Consumes: Task 2's helpers.
- Produces: `shouldCopyStream(outputArgs: readonly string[]): boolean`, exported. The per-stream copy directive now follows it.

Trawlarr currently copies a stream when it has no `outputArgs` and no `forceEncoding`. Upstream's rule is different and better: a stream also gets copied when its args only *tag* it — metadata or disposition changes need no re-encode. Under the current rule, a plugin that sets a language tag silently triggers a full re-encode of that stream.

- [ ] **Step 1: Write the failing tests**

```ts
describe('shouldCopyStream', () => {
  it('copies a stream with no output arguments', () => {
    expect(shouldCopyStream([])).toBe(true);
  });

  it('does not copy a stream that sets a codec', () => {
    expect(shouldCopyStream(['-c:v', 'libx265'])).toBe(false);
    expect(shouldCopyStream(['-c:1', 'libopus'])).toBe(false);
    expect(shouldCopyStream(['-codec:a', 'aac'])).toBe(false);
    expect(shouldCopyStream(['-vcodec', 'libx264'])).toBe(false);
    expect(shouldCopyStream(['-acodec', 'aac'])).toBe(false);
  });

  it('still copies when the arguments only tag the stream', () => {
    // Setting a language or a disposition does not require re-encoding, and
    // treating it as an encode would silently transcode a stream the user
    // only wanted relabelled.
    expect(shouldCopyStream(['-metadata:s:1', 'language=eng'])).toBe(true);
    expect(shouldCopyStream(['-disposition:s:0', 'default'])).toBe(true);
    expect(shouldCopyStream(['-metadata', 'title=x'])).toBe(true);
  });

  it('does not copy when a non-tagging argument is present', () => {
    expect(shouldCopyStream(['-b:v', '2M'])).toBe(false);
    expect(shouldCopyStream(['-metadata:s:1', 'language=eng', '-b:v', '2M'])).toBe(false);
  });
});

describe('compileFfmpegArgs — copy directives', () => {
  const twoStreams = () =>
    beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });

  it('copies a tagged stream while encoding the one that asked for it', () => {
    const cmd = twoStreams();
    cmd.streams[0]!.outputArgs.push('-c:v', 'libx265');
    cmd.streams[1]!.outputArgs.push('-metadata:s:a:0', 'language=eng');
    const args = compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' });
    expect(args).toContain('-c:v');
    // The audio stream is only relabelled, so it must be copied, not encoded.
    expect(args.join(' ')).toContain('-c:1 copy');
    expect(args.join(' ')).toContain('-metadata:s:a:0 language=eng');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm test -- packages/core/src/ffmpeg-compile.test.ts`
Expected: FAIL — `shouldCopyStream` not exported; the tagged stream currently gets no copy directive.

- [ ] **Step 3: Implement**

```ts
/** Matches the arguments that set a codec, in any of ffmpeg's spellings. */
const CODEC_ARG = /^-(c|codec)(:|$)/;
const TYPED_CODEC_ARG = /^-[vasd]codec(:|$)/;

/** Arguments that only label a stream, and so survive a stream copy. */
const isTaggingOnlyFlag = (arg: string): boolean =>
  arg === '-metadata' ||
  arg.startsWith('-metadata:') ||
  arg === '-disposition' ||
  arg.startsWith('-disposition:');

/**
 * Should this stream be copied rather than re-encoded?
 *
 * True when nothing was asked of it, or when everything asked of it is a
 * label change. Arguments arrive as flag/value pairs, so only the even
 * positions are flags — `['-metadata:s:0', 'language=eng']` is a single
 * tagging operation, not a flag plus an unknown option.
 */
export const shouldCopyStream = (outputArgs: readonly string[]): boolean => {
  if (outputArgs.length === 0) return true;
  for (let i = 0; i < outputArgs.length; i += 2) {
    const flag = outputArgs[i];
    if (flag === undefined) break;
    if (CODEC_ARG.test(flag) || TYPED_CODEC_ARG.test(flag)) return false;
    if (!isTaggingOnlyFlag(flag)) return false;
  }
  return true;
};
```

Then in the per-stream loop emit the copy directive when `shouldCopyStream(stream.outputArgs)` holds:

```ts
    if (shouldCopyStream(stream.outputArgs)) {
      args.push(`-c:${outputStreamIndex(kept, stream)}`, 'copy');
    }
```

Keep the existing whole-command shortcut: when NO stream requests encoding, a single `-c copy` is emitted instead of one directive per stream. Existing tests assert that and it must keep passing.

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- packages/core`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core
git commit -m "fix(core): copy streams that are only relabelled instead of re-encoding them

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `shouldProcess` and the no-streams error

**Files:**
- Modify: `packages/core/src/ffmpeg-command.ts`, `packages/core/src/ffmpeg-compile.ts`
- Modify: `packages/engine/src/executor/execute-node.ts`
- Test: `packages/core/src/ffmpeg-command.test.ts`, `packages/core/src/ffmpeg-compile.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `deriveShouldProcess(command: FfmpegCommand): boolean` exported from `ffmpeg-command.ts`. `compileFfmpegArgs` throws `Error('No streams mapped for new file')` when every stream was removed. The Execute node skips ffmpeg entirely when nothing needs doing.

- [ ] **Step 1: Write the failing tests**

In `ffmpeg-command.test.ts`:

```ts
describe('deriveShouldProcess', () => {
  const cmd = () =>
    beginFfmpegCommand({
      probe: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
        ],
      },
      container: 'mkv',
      inputPath: '/in.mkv',
    });

  it('is false for an untouched command', () => {
    expect(deriveShouldProcess(cmd())).toBe(false);
  });

  it('is true when a plugin set the flag directly', () => {
    const c = cmd();
    c.shouldProcess = true;
    expect(deriveShouldProcess(c)).toBe(true);
  });

  it('is true when a stream was removed', () => {
    const c = cmd();
    c.streams[1]!.removed = true;
    expect(deriveShouldProcess(c)).toBe(true);
  });

  it('is true when a stream requests encoding', () => {
    const c = cmd();
    c.streams[0]!.outputArgs.push('-c:v', 'libx265');
    expect(deriveShouldProcess(c)).toBe(true);
  });

  it('is true when overall arguments were added', () => {
    const withInput = cmd();
    withInput.overallInputArguments.push('-fflags', '+genpts');
    expect(deriveShouldProcess(withInput)).toBe(true);

    const withOutput = cmd();
    withOutput.overallOuputArguments.push('-max_muxing_queue_size', '9999');
    expect(deriveShouldProcess(withOutput)).toBe(true);
  });
});
```

In `ffmpeg-compile.test.ts`:

```ts
it('refuses to compile when every stream was removed, naming the problem', () => {
  const cmd = beginFfmpegCommand({
    probe: { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }] },
    container: 'mkv',
    inputPath: '/in.mkv',
  });
  cmd.streams[0]!.removed = true;
  expect(() => compileFfmpegArgs({ command: cmd, outputPath: '/out.mkv' })).toThrow(
    /No streams mapped for new file/,
  );
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm test -- packages/core`
Expected: FAIL — `deriveShouldProcess` does not exist. The removal test may already pass if the existing guard throws a different message; if so, note it and align the message.

- [ ] **Step 3: Implement `deriveShouldProcess`**

In `packages/core/src/ffmpeg-command.ts`:

```ts
/**
 * Does this command actually change anything?
 *
 * Plugins set `shouldProcess` when they know they have made a change, but
 * some changes are implicit: removing a stream, asking a stream to encode,
 * or adding overall arguments all mean work is needed even if no plugin said
 * so. Running ffmpeg when nothing changed would rewrite the file for no
 * reason — a needless remux of every file in a library.
 */
export const deriveShouldProcess = (command: FfmpegCommand): boolean =>
  command.shouldProcess ||
  command.overallInputArguments.length > 0 ||
  command.overallOuputArguments.length > 0 ||
  command.streams.some(
    (stream) => stream.removed === true || stream.outputArgs.length > 0 || stream.forceEncoding,
  );
```

- [ ] **Step 4: Align the compiler's empty-output guard**

In `ffmpeg-compile.ts`, make the all-streams-removed case throw with upstream's wording so a user searching the message finds the same explanation:

```ts
  if (command.streams.length > 0 && kept.length === 0) {
    throw new Error(
      'No streams mapped for new file: every stream was removed, so the output would ' +
        'contain nothing. Check which streams the flow is removing.',
    );
  }
```

- [ ] **Step 5: Have Execute honour it**

In `packages/engine/src/executor/execute-node.ts`, before resolving the encode target and spawning ffmpeg:

```ts
      if (!deriveShouldProcess(command)) {
        input.log?.('Nothing to do: no stream changes and no overall arguments. Skipping ffmpeg.');
        return {
          outputNumber: 1,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: { ...args.variables, ffmpegCommand: closeFfmpegCommand(command) },
        };
      }
```

This routes to the success output with the file untouched. It also means a flow whose only Execute has nothing to do no longer trips the in-place-output guard, because no encode is attempted.

- [ ] **Step 6: Run the tests**

Run: `pnpm test`
Expected: PASS. If an existing engine test asserted that Execute always spawns ffmpeg, update it to reflect the skip — but only after confirming the flow in that test genuinely has nothing to do.

- [ ] **Step 7: Full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core packages/engine
git commit -m "feat(core,engine): skip ffmpeg when the command changes nothing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Prove it against the plugins that break

**Files:**
- Modify: `packages/engine/test/compat/community-plugins.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: compatibility coverage for `ffmpegCommandRorderStreams` and `ffmpegCommandEnsureAudioStream`.

These two are the reason this plan exists. Reorder proves `mapArgs` travels with its stream; ensure-audio proves placeholders resolve. Without them the work is unverified against real plugin code.

Fetch the corpus first if it is absent: `pnpm compat:fetch`.

- [ ] **Step 1: Confirm the plugin paths**

Run:
```
ls cache/tdarr-plugins/FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandRorderStreams
ls cache/tdarr-plugins/FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandEnsureAudioStream
```
Note the directory spells it `Rorder`, not `Reorder`. Record the version directory you find and use it; if it differs from `1.0.0`, use what exists and say so in your report.

The input names below were read from the corpus and are given in each test. Confirm they still
match `details().inputs` for the version you find; if upstream renamed one, correct the test and
say so in your report.

- `ffmpegCommandRorderStreams`: `processOrder` (default `codecs,channels,languages,streamTypes`),
  `languages`, `channels` (default `7.1,5.1,2,1`), `codecs`, `streamTypes` (default
  `video,audio,subtitle`).
- `ffmpegCommandEnsureAudioStream`: `audioEncoder` (default `aac`), `language` (default `en`),
  `channels` (default `2`), `enableBitrate` (default `false`), `bitrate` (default `128k`),
  `enableSamplerate` (default `false`).

- [ ] **Step 2: Write the failing reorder test**

```ts
describe('ffmpegCommandRorderStreams', () => {
  const abs = pluginPath('ffmpegCommand/ffmpegCommandRorderStreams/1.0.0/index.js');

  it('reorders streams while keeping each mapped to its source track', async () => {
    expect(existsSync(abs)).toBe(true);
    const loaded = createPluginLoader().load(abs);
    // Reorder by stream type so video leads. The fixture's streams are seeded
    // in probe order, so this genuinely moves them and array position stops
    // matching the source track — which is the case that used to mis-map.
    const args = argsFor(
      {
        processOrder: 'streamTypes',
        streamTypes: 'audio,video,subtitle',
        languages: '',
        channels: '',
        codecs: '',
      },
      true,
    );
    const output = await loaded.module.plugin(args);

    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/staging/out.mkv',
    });

    // Whatever order the streams ended up in, every original track must still
    // be mapped exactly once, from its own source index.
    const maps = argv.reduce<string[]>(
      (acc, arg, i) => (arg === '-map' ? [...acc, argv[i + 1] ?? ''] : acc),
      [],
    );
    expect(new Set(maps).size).toBe(maps.length);
    expect(maps.sort()).toEqual(['0:0', '0:1', '0:2'].slice(0, maps.length).sort());
  });
});
```

- [ ] **Step 3: Write the failing ensure-audio test**

```ts
describe('ffmpegCommandEnsureAudioStream', () => {
  const abs = pluginPath('ffmpegCommand/ffmpegCommandEnsureAudioStream/1.0.0/index.js');

  it('adds a stream whose placeholder arguments resolve to real indices', async () => {
    expect(existsSync(abs)).toBe(true);
    const loaded = createPluginLoader().load(abs);
    const args = argsFor(
      {
        audioEncoder: 'aac',
        language: 'en',
        channels: '2',
        // Bitrate on, so the plugin also emits a '-b:a:{outputTypeIndex}'
        // argument and the type-index placeholder is exercised too.
        enableBitrate: 'true',
        bitrate: '128k',
        enableSamplerate: 'false',
      },
      true,
    );
    const output = await loaded.module.plugin(args);

    const argv = compileFfmpegArgs({
      command: output.variables.ffmpegCommand,
      outputPath: '/staging/out.mkv',
    });

    // The plugin writes literal '-c:{outputIndex}' and '-b:a:{outputTypeIndex}'.
    // Reaching ffmpeg unresolved, those are a hard failure.
    expect(argv.join(' ')).not.toContain('{outputIndex}');
    expect(argv.join(' ')).not.toContain('{outputTypeIndex}');
    expect(argv.some((arg) => /^-c:\d+$/.test(arg))).toBe(true);
  });
});
```

- [ ] **Step 4: Run them**

Run: `pnpm test -- packages/engine/test/compat`

Both should now pass on the work from Tasks 1–4. **If either fails, that is a real finding — read why.** If the host is missing something the plugin needs, fix the host and record it; do not weaken the assertion. If an input name or path is wrong, correct the test.

To prove the tests have teeth, temporarily revert Task 2's substitution and confirm the ensure-audio test fails, then restore it. Capture that output.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/engine
git commit -m "test(engine): cover the community plugins that reorder and insert streams

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Correct the spec claim this work falsifies

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-trawlarr-design.md`

**Interfaces:**
- Consumes: nothing. Documentation only.
- Produces: nothing code depends on.

The spec's §2.5 states, of the ffmpeg command stream shape: *"There is no separate
map-argument field."* Tasks 1–5 establish that there is, that community plugins depend on it,
and that omitting it silently mis-maps tracks. Leaving the sentence in place would send the next
reader — quite possibly a future implementer of P2 — to the opposite conclusion.

- [ ] **Step 1: Correct the sentence**

In `docs/superpowers/specs/2026-08-10-trawlarr-design.md` §2.5, replace the claim that no
map-argument field exists with the truth: a `FfmpegCommandStream` is a raw ffprobe stream plus
`removed`, `forceEncoding`, `inputArgs`, `outputArgs` **and `mapArgs`**, where `mapArgs` holds the
`-map` arguments selecting that stream and is seeded from the ffprobe index. Note in one sentence
that it is carried per stream because plugins reorder and insert streams, after which array
position no longer identifies the source track.

Also add, to the compilation steps in the same section, that `{outputIndex}` and
`{outputTypeIndex}` placeholders in a stream's `outputArgs` are resolved by the host at
compile time.

Keep the edit surgical — do not restructure §2.5 or touch other sections. The remaining
known-inaccurate claims (§5.4's two-strike wording, §2.10's contract level) are deliberately out
of scope here and stay recorded for the owner.

- [ ] **Step 2: Verify and commit**

Run: `pnpm lint` — prettier checks markdown, so formatting must be clean.

```bash
git add docs/superpowers/specs/2026-08-10-trawlarr-design.md
git commit -m "docs(spec): correct 2.5, which claimed no map-argument field exists

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Definition of done

- `pnpm build && pnpm lint && pnpm test` green from a clean checkout, twice.
- `pnpm check:refs`, `pnpm audit:licenses` green; CI green on GitHub.
- A reordered stream array still produces correct `-map` arguments.
- No `{outputIndex}` or `{outputTypeIndex}` can reach ffmpeg.
- A stream whose only arguments are metadata or disposition changes is copied, not re-encoded.
- Cover art is classified as an attachment and does not receive a video encoder.
- Execute performs no work when the command changes nothing.
- `ffmpegCommandRorderStreams` and `ffmpegCommandEnsureAudioStream` are covered by the compatibility harness.
- Spec §2.5 no longer denies the existence of the map-argument field.

## Not in this plan

- The community `ffmpegCommandExecute` plugin is still not runnable as a substitute for trawlarr's own Execute; only the data it consumes is now correct. Running upstream's Execute verbatim would need its CLI helper stack.
- `inputFiles` starts empty upstream and seeded in trawlarr. Harmless today; revisit if a plugin is found that depends on pushing the first entry itself.
- Broader spec amendments identified after P1 (§5.4's two-strike wording, §2.10's contract level).
  Task 6 corrects only §2.5, which these changes directly falsify.
