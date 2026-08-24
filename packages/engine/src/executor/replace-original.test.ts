import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { link, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginDetails, PluginInputArgs } from '@trawlarr/plugin-api';
import {
  createReplaceOriginalRunner,
  guardSizeGrowth,
  REPLACEMENT_GROWTH_SLACK_BYTES,
  REPLACEMENT_GROWTH_SLACK_RATIO,
  type ReplaceRunnerInput,
} from './replace-original.js';
import type { LoadedPlugin } from '../host/loader.js';

/**
 * The seams the engine cannot import.
 *
 * `findCompanions`/`moveCompanions` live in `@trawlarr/server`, which depends
 * on the engine — importing them here would either invert that dependency or
 * make this test rely on `packages/server/dist` existing, which on a clean
 * checkout it does not. They are re-expressed here against the real
 * filesystem instead: these tests still move real files, they just do not
 * borrow server's code to do it.
 */
const realStat = async (path: string): Promise<{ size: number; nlink: number }> => {
  const stats = await stat(path);
  return { size: stats.size, nlink: stats.nlink };
};

const stemOf = (path: string): string => basename(path, extname(path));

const codeOfError = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

const findCompanionsHere = async (input: {
  filePath: string;
  companionExtensions: readonly string[];
}): Promise<string[]> => {
  const dir = dirname(input.filePath);
  const stem = stemOf(input.filePath);
  const wanted = new Set(input.companionExtensions.map((extension) => extension.toLowerCase()));
  const names = await readdir(dir);
  return names
    .filter(
      (name) =>
        name !== basename(input.filePath) &&
        name.startsWith(`${stem}.`) &&
        wanted.has(extname(name).slice(1).toLowerCase()),
    )
    .map((name) => join(dir, name))
    .sort();
};

const moveCompanionsHere = async (input: {
  companions: readonly string[];
  oldMediaPath: string;
  newMediaPath: string;
}): Promise<void> => {
  for (const companion of input.companions) {
    const suffix = basename(companion).slice(stemOf(input.oldMediaPath).length);
    const target = join(dirname(input.newMediaPath), `${stemOf(input.newMediaPath)}${suffix}`);
    if (resolve(target) !== resolve(companion)) await rename(companion, target);
  }
};

const details = (): PluginDetails => ({
  name: 'Replace Original File',
  description: 'fixture',
  style: { borderColor: '#aa3333' },
  tags: 'safety,replace',
  isStartPlugin: false,
  pType: '',
  sidebarPosition: 6,
  icon: 'faRightLeft',
  inputs: [],
  outputs: [
    { number: 1, tooltip: 'replaced' },
    { number: 2, tooltip: 'failed' },
  ],
  requiresVersion: '1.0.0',
});

/** Its declared behaviour throws, so an un-substituted node cannot pass. */
const replacePlugin = (): LoadedPlugin =>
  ({
    id: 'trawlarr:replaceOriginal',
    absPath: 'builtin:trawlarr:replaceOriginal',
    version: '1.0.0',
    details: details(),
    module: {
      details,
      plugin: () => {
        throw new Error('the declared Replace Original File behaviour must not run');
      },
    },
  }) as unknown as LoadedPlugin;

const CLOCK_MS = 1_700_000_000_000;

/**
 * 2,000,000 bytes: BIGGER than the replacement below, because the size gate
 * (`guardSizeGrowth`) refuses to install a replacement that is materially
 * bigger than the file it replaces. Every test here that expects an install
 * therefore needs an original a real transcode would plausibly shrink — which
 * is also the ordinary case on a real library (152 of 157 replacements on the
 * owner's Shows library shrank the file). The readable phrase survives at the
 * front so a failing content assertion still says what the file was.
 */
const ORIGINAL_BODY = 'the original the user would be furious to lose'.padEnd(2_000_000, '.');
/** 999999 bytes, so the reported megabyte size is a fraction rather than a
 * whole number and a size assertion cannot pass by accident. (This particular
 * value does survive the MB round-trip exactly; the sizes that do not are
 * pinned in file-object.test.ts, where the conversion itself lives.) */
const NEW_BODY = 'n'.repeat(999_999);

interface Workspace {
  root: string;
  libraryDir: string;
  stagingDir: string;
  trashDir: string;
  originalPath: string;
  newPath: string;
}

const workspace = (options?: { newExtension?: string }): Workspace => {
  const root = mkdtempSync(join(tmpdir(), 'trawlarr-replace-'));
  const libraryDir = join(root, 'library');
  const stagingDir = join(root, 'staging');
  mkdirSync(libraryDir);
  mkdirSync(stagingDir);

  const originalPath = join(libraryDir, 'movie.mkv');
  const newPath = join(stagingDir, `movie.${options?.newExtension ?? 'mkv'}`);
  writeFile(originalPath, ORIGINAL_BODY);
  writeFile(newPath, NEW_BODY);

  // Deliberately NOT created: one test pins that the runner creates it.
  const trashDir = join(libraryDir, '.trawlarr', 'trash');
  return { root, libraryDir, stagingDir, trashDir, originalPath, newPath };
};

function writeFile(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
}

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const argsFor = (input: {
  newPath: string;
  originalPath: string;
  jobLog: (text: string) => void;
  inputs?: Record<string, unknown>;
}): PluginInputArgs =>
  ({
    inputFileObj: {
      _id: input.newPath,
      file: input.newPath,
      container: extname(input.newPath).slice(1),
      file_size: 0,
      oldSize: 0,
      newSize: 0,
    },
    originalLibraryFile: { _id: input.originalPath },
    inputs: input.inputs ?? { trashRetentionDays: '14', allowCrossDevice: 'true' },
    variables: { ffmpegCommand: { init: false }, flowFailed: false, user: {} },
    jobLog: input.jobLog,
    updateWorker: () => {},
  }) as unknown as PluginInputArgs;

const runnerFor = (input: {
  trashDir: string;
  overrides?: Partial<ReplaceRunnerInput>;
}): ReturnType<typeof createReplaceOriginalRunner> =>
  createReplaceOriginalRunner({
    trashDirFor: () => input.trashDir,
    companionExtensions: ['srt', 'nfo'],
    allowHardlinked: false,
    statFile: realStat,
    nowMs: () => CLOCK_MS,
    findCompanions: findCompanionsHere,
    moveCompanions: moveCompanionsHere,
    ...input.overrides,
  });

describe('createReplaceOriginalRunner', () => {
  it('leaves plugins other than Replace Original File alone', () => {
    const { trashDir } = workspace();
    const runner = runnerFor({ trashDir });
    const other = { ...replacePlugin(), id: 'trawlarr:verifyOutput' } as LoadedPlugin;

    expect(runner(other)).toBeNull();
    expect(runner(replacePlugin())).not.toBeNull();
  });

  it('puts the original in the trash and the new file at the original path', async () => {
    const space = workspace();
    const originalDigest = sha256(space.originalPath);
    const newDigest = sha256(space.newPath);
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe(space.originalPath);
    // The new file really is at the library path, byte for byte.
    expect(sha256(space.originalPath)).toBe(newDigest);
    // And the original is RECOVERABLE: in trash, not deleted, unchanged.
    const trashed = readdirSync(space.trashDir);
    expect(trashed).toHaveLength(1);
    expect(sha256(join(space.trashDir, trashed[0]!))).toBe(originalDigest);
    expect(readFileSync(join(space.trashDir, trashed[0]!), 'utf8')).toBe(ORIGINAL_BODY);
    // Named so two replacements of the same file cannot collide, and named
    // after the ORIGINAL — a human recovering from trash has to recognise it.
    expect(trashed[0]).toBe(`movie.${CLOCK_MS}.mkv`);
    // The staged file is consumed, not left behind as a duplicate.
    expect(existsSync(space.newPath)).toBe(false);
  });

  it('creates the trash directory when it does not exist yet', async () => {
    const space = workspace();
    expect(existsSync(space.trashDir)).toBe(false);
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(1);
    expect(existsSync(space.trashDir)).toBe(true);
  });

  it('re-stats after the swap so the sizes describe the NEW file', async () => {
    const space = workspace();
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;
    const args = argsFor({
      newPath: space.newPath,
      originalPath: space.originalPath,
      jobLog: () => {},
    });

    await module.plugin(args);

    // Megabytes at the plugin boundary (the Tdarr contract), bytes internally.
    expect(args.inputFileObj.file_size).toBeCloseTo(NEW_BODY.length / 1_000_000, 9);
    expect(args.inputFileObj.newSize).toBeCloseTo(NEW_BODY.length / 1_000_000, 9);
    expect(args.inputFileObj.oldSize).toBeCloseTo(ORIGINAL_BODY.length / 1_000_000, 9);
    // Not the pre-transcode value: a size-comparison plugin must see a change.
    expect(args.inputFileObj.file_size).not.toBe(0);
    expect(args.inputFileObj.newSize).not.toBe(args.inputFileObj.oldSize);
    // Whole bytes come back out of the megabyte projection. The conversion
    // rounds at the producer (absorbPluginFileObject), which is where the
    // sizes that genuinely do not round-trip are pinned.
    expect(Math.round(args.inputFileObj.newSize * 1_000_000)).toBe(NEW_BODY.length);
    // And the file object now points at the file that actually exists.
    expect(args.inputFileObj._id).toBe(space.originalPath);
    expect(args.inputFileObj.file).toBe(space.originalPath);
  });

  it('names BOTH sizes, and which is which, when it does install a replacement', async () => {
    const space = workspace();
    const lines: string[] = [];
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => lines.push(text),
      }),
    );

    // The line a human reads to see what the flow did to their file. The
    // replacement's own size must be attached to the replacement — reading
    // the ORIGINAL's number there is exactly how a 2.06x inflation went
    // unnoticed on the owner's library until the filesystem was measured.
    const line = lines.find((text) => text.includes('now holds the replacement'))!;
    expect(line).toContain(`it is ${NEW_BODY.length} bytes`);
    expect(line).toContain(`against the original's ${ORIGINAL_BODY.length} bytes`);
    expect(line).toContain('50.0% smaller');
  });

  it('refuses to install a replacement bigger than the original, and keeps the original', async () => {
    const space = workspace();
    // A 2.0x inflation, the shape of the real incident: hevc_nvenc -cq 23
    // against an already-lean 1.6 Mbps source, which doubled five episodes.
    const inflatedBody = 'i'.repeat(ORIGINAL_BODY.length * 2);
    writeFile(space.newPath, inflatedBody);
    const originalDigest = sha256(space.originalPath);
    const lines: string[] = [];
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => lines.push(text),
      }),
    );

    // The original is still the library file, byte for byte...
    expect(sha256(space.originalPath)).toBe(originalDigest);
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(statSync(space.originalPath).size).toBe(ORIGINAL_BODY.length);
    // ...and it was never moved to trash: the trash directory the runner
    // would have had to create does not even exist.
    expect(existsSync(space.trashDir)).toBe(false);

    // Output 1 with the ORIGINAL's path: a run that changed nothing and
    // succeeded, which is what lets the file settle in `good` and stop being
    // queued. Output 2 here would be a failed attempt, and three more encodes.
    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe(space.originalPath);

    // Both sizes, in the log, on the file that did NOT change.
    const line = lines.find((text) => text.includes('Not installing this replacement'))!;
    expect(line).toContain(`${inflatedBody.length} bytes`);
    expect(line).toContain(`${ORIGINAL_BODY.length} bytes`);
    expect(line).toContain('100.0% larger');
  });

  it('leaves the file object describing the ORIGINAL when it refuses an inflated replacement', async () => {
    const space = workspace();
    writeFile(space.newPath, 'i'.repeat(ORIGINAL_BODY.length * 2));
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;
    const args = argsFor({
      newPath: space.newPath,
      originalPath: space.originalPath,
      jobLog: () => {},
    });

    await module.plugin(args);

    // `describeReplacement` never ran, so nothing downstream can be told the
    // library now holds a file it does not hold. The sizes are still the
    // untouched fixture values.
    expect(args.inputFileObj.file_size).toBe(0);
    expect(args.inputFileObj.newSize).toBe(0);
  });

  it('still installs a replacement that grew only within the slack', async () => {
    const space = workspace();
    // +500 bytes on a 2 MB original: 0.025%, and far under a mebibyte. This
    // is the shape of a container change (an mp4 moov, matroska cues), which
    // the guard must not mistake for an inflated encode.
    const slightlyBigger = ORIGINAL_BODY.length + 500;
    writeFile(space.newPath, 'n'.repeat(slightlyBigger));
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(1);
    expect(statSync(space.originalPath).size).toBe(slightlyBigger);
    expect(readdirSync(space.trashDir)).toHaveLength(1);
  });

  it('carries a companion across a container change', async () => {
    const space = workspace({ newExtension: 'mp4' });
    writeFile(join(space.libraryDir, 'movie.en.srt'), 'subtitles');
    writeFile(join(space.libraryDir, 'movie.nfo'), 'metadata');
    const moves: { oldMediaPath: string; newMediaPath: string }[] = [];
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        moveCompanions: async (moveInput) => {
          moves.push({
            oldMediaPath: moveInput.oldMediaPath,
            newMediaPath: moveInput.newMediaPath,
          });
          await moveCompanionsHere(moveInput);
        },
      },
    })(replacePlugin())!;

    const args = argsFor({
      newPath: space.newPath,
      originalPath: space.originalPath,
      jobLog: () => {},
    });
    const out = await module.plugin(args);

    const finalPath = join(space.libraryDir, 'movie.mp4');
    expect(out.outputNumber).toBe(1);
    // The replacement keeps the original's NAME and takes only the new
    // container.
    expect(out.outputFileObj._id).toBe(finalPath);
    expect(existsSync(space.originalPath)).toBe(false);
    // Asserted as the NAMES ON DISK, not merely as a call that was made.
    expect(readdirSync(space.libraryDir).sort()).toEqual([
      '.trawlarr',
      'movie.en.srt',
      'movie.mp4',
      'movie.nfo',
    ]);
    // The companions sit beside the new file under their own names, with
    // their contents intact. `moveCompanions` is asked and correctly has
    // nothing to do: preserving the stem means each companion's computed
    // target IS its current path. Its genuine renaming behaviour is covered
    // in packages/server/src/fs/companions.test.ts, where the rename happens.
    expect(moves).toEqual([{ oldMediaPath: space.originalPath, newMediaPath: finalPath }]);
    expect(readFileSync(join(space.libraryDir, 'movie.en.srt'), 'utf8')).toBe('subtitles');
    expect(readFileSync(join(space.libraryDir, 'movie.nfo'), 'utf8')).toBe('metadata');
    // The file object's container follows the new extension, or every
    // container-branching plugin downstream reads a stale one.
    expect(args.inputFileObj.container).toBe('mp4');
  });

  it('keeps the ORIGINAL name when the staged file was written under another', async () => {
    // The name belongs to the user; only the container is ours to change. An
    // encoder that wrote "out.mp4" must not rename "Movie Title (2019).mkv" —
    // Plex, Jellyfin, Sonarr and Radarr all identify content by filename, and
    // an unattended worker would do this across a whole library.
    const space = workspace();
    const stagedUnderAnotherName = join(space.stagingDir, 'out.mp4');
    writeFile(stagedUnderAnotherName, NEW_BODY);
    writeFile(join(space.libraryDir, 'movie.en.srt'), 'subtitles');
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: stagedUnderAnotherName,
        originalPath: space.originalPath,
        jobLog: () => {},
      }),
    );

    expect(out.outputNumber).toBe(1);
    // The original's stem, the new file's extension. Not "out.mp4".
    expect(out.outputFileObj._id).toBe(join(space.libraryDir, 'movie.mp4'));
    expect(readdirSync(space.libraryDir).sort()).toEqual([
      '.trawlarr',
      'movie.en.srt',
      'movie.mp4',
    ]);
    expect(readFileSync(join(space.libraryDir, 'movie.mp4'), 'utf8')).toBe(NEW_BODY);
    // The companion keeps its own name too: it was never renamed to follow an
    // encoder-chosen stem.
    expect(readFileSync(join(space.libraryDir, 'movie.en.srt'), 'utf8')).toBe('subtitles');
  });

  it('refuses a hardlinked original and leaves both files untouched', async () => {
    const space = workspace();
    const linkPath = join(space.libraryDir, 'hardlink-to-movie.mkv');
    linkSync(space.originalPath, linkPath);
    const logged: string[] = [];
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    expect(logged.join('\n')).toMatch(/hardlink/i);
    // NOTHING moved: the original, its link and the staged file all survive.
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(readFileSync(linkPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(existsSync(space.newPath)).toBe(true);
    expect(existsSync(space.trashDir)).toBe(false);
  });

  it('replaces a hardlinked original when the library allows it', async () => {
    const space = workspace();
    linkSync(space.originalPath, join(space.libraryDir, 'hardlink-to-movie.mkv'));
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: { allowHardlinked: true },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(1);
    expect(readFileSync(space.originalPath, 'utf8')).toBe(NEW_BODY);
    // The other link still names the original content, as hardlinks do.
    expect(readFileSync(join(space.libraryDir, 'hardlink-to-movie.mkv'), 'utf8')).toBe(
      ORIGINAL_BODY,
    );
  });

  it('routes to output 2 rather than throwing when the new file is missing', async () => {
    const space = workspace();
    const logged: string[] = [];
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: join(space.stagingDir, 'never-encoded.mkv'),
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    expect(out.outputFileObj._id).toBe(space.originalPath);
    expect(logged.join('\n')).toContain('never-encoded.mkv');
    // The original is never trashed on the strength of a file that isn't there.
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(existsSync(space.trashDir)).toBe(false);
  });

  it('routes to output 2 when the new file is zero-length', async () => {
    const space = workspace();
    writeFile(space.newPath, '');
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(2);
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(existsSync(space.trashDir)).toBe(false);
  });

  it('does nothing at all when the new file IS the original', async () => {
    // Execute's "nothing to do" branch hands the original path straight on.
    // Trashing a file to rename it back is pure risk for no gain.
    const space = workspace();
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: space.originalPath,
        originalPath: space.originalPath,
        jobLog: () => {},
      }),
    );

    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe(space.originalPath);
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(existsSync(space.trashDir)).toBe(false);
  });

  it('replaces correctly when the new file already sits at its destination', async () => {
    // Reachable without any naming trickery, whenever the work directory IS
    // the library directory: Execute writes <work-dir>/<stem>.<container>, so
    // a flow configured that way hands Replace a new file already standing at
    // the exact path the replacement belongs at. The node must trash the
    // original and leave the new file alone — not mistake it for a bystander
    // about to be overwritten, and not try to move it onto itself.
    const space = workspace();
    const newInPlace = join(space.libraryDir, 'movie.mp4');
    writeFile(newInPlace, NEW_BODY);
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: newInPlace, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(1);
    expect(out.outputFileObj._id).toBe(newInPlace);
    expect(readFileSync(newInPlace, 'utf8')).toBe(NEW_BODY);
    expect(existsSync(space.originalPath)).toBe(false);
    const trashed = readdirSync(space.trashDir);
    expect(trashed).toHaveLength(1);
    expect(readFileSync(join(space.trashDir, trashed[0]!), 'utf8')).toBe(ORIGINAL_BODY);
  });

  it('refuses when an unrelated file already occupies the replacement path', async () => {
    const space = workspace({ newExtension: 'mp4' });
    const occupied = join(space.libraryDir, 'movie.mp4');
    writeFile(occupied, 'someone else already lives here');
    const logged: string[] = [];
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    expect(readFileSync(occupied, 'utf8')).toBe('someone else already lives here');
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(existsSync(space.trashDir)).toBe(false);
    expect(logged.join('\n')).toContain('movie.mp4');
  });

  it('copies to a temporary path on the DESTINATION filesystem, then renames', async () => {
    const space = workspace();
    const links: { from: string; to: string }[] = [];
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: async (from, to) => {
          links.push({ from, to });
          // Only the staging -> library move is cross-device, exactly as a
          // staging area on another filesystem behaves.
          if (dirname(from) === space.stagingDir) {
            const error: NodeJS.ErrnoException = new Error(
              'EXDEV: cross-device link not permitted',
            );
            error.code = 'EXDEV';
            throw error;
          }
          await link(from, to);
        },
      },
    })(replacePlugin())!;
    const logged: string[] = [];

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(1);
    expect(readFileSync(space.originalPath, 'utf8')).toBe(NEW_BODY);
    // The final step is a rename FROM the destination filesystem, never a copy
    // onto the live path: an interrupted copy must not be able to leave a
    // truncated file where the user's original used to be.
    const last = links.at(-1)!;
    expect(last.to).toBe(space.originalPath);
    expect(dirname(last.from)).toBe(space.libraryDir);
    expect(last.from).not.toBe(space.newPath);
    // A temporary path DISTINCT from the live one: copying onto the live path
    // and calling that a swap is precisely the failure mode this guards.
    expect(last.from).not.toBe(last.to);
    // No temporary file is left lying around in the library.
    expect(readdirSync(space.libraryDir).sort()).toEqual(['.trawlarr', 'movie.mkv']);
    // Nor is the staged source: a full-size duplicate left in staging after a
    // successful cross-device swap is a silent disk-filler.
    expect(existsSync(space.newPath)).toBe(false);
    expect(readdirSync(space.stagingDir)).toEqual([]);
    expect(logged.join('\n')).toMatch(/cross-device/i);
  });

  it('refuses the cross-device fallback when allowCrossDevice is false, and restores the original', async () => {
    const space = workspace();
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: async (from, to) => {
          if (dirname(from) === space.stagingDir) {
            const error: NodeJS.ErrnoException = new Error(
              'EXDEV: cross-device link not permitted',
            );
            error.code = 'EXDEV';
            throw error;
          }
          await link(from, to);
        },
      },
    })(replacePlugin())!;
    const logged: string[] = [];

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
        inputs: { trashRetentionDays: '14', allowCrossDevice: 'false' },
      }),
    );

    expect(out.outputNumber).toBe(2);
    expect(out.outputFileObj._id).toBe(space.originalPath);
    // The original was already in trash by then: it must come back.
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(readdirSync(space.trashDir)).toEqual([]);
    expect(existsSync(space.newPath)).toBe(true);
    expect(logged.join('\n')).toMatch(/atomic rename/i);
  });

  it('restores the original from trash when the swap fails outright', async () => {
    const space = workspace();
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: async (from, to) => {
          if (dirname(from) === space.stagingDir) {
            const error: NodeJS.ErrnoException = new Error('EACCES: permission denied');
            error.code = 'EACCES';
            throw error;
          }
          await link(from, to);
        },
      },
    })(replacePlugin())!;
    const logged: string[] = [];

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    // The worst outcome this node can produce is a half-applied replacement
    // that loses the file. The original is back where it belongs.
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(readdirSync(space.trashDir)).toEqual([]);
    expect(logged.join('\n')).toContain('EACCES');
  });

  it('keeps every original when files sharing a basename are replaced at once', async () => {
    // One trash directory serves a whole library ROOT, and duplicate basenames
    // are ordinary — disc rips produce "Show A/S1/title00.mkv" and
    // "Show B/S1/title00.mkv". Workers that reach the trash step together all
    // compute the same trash name, all find it free, and a plain rename(2)
    // silently unlinks whichever original got there first, with every job
    // still reporting success.
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-replace-race-'));
    const trashDir = join(root, '.trawlarr', 'trash');
    const shows = ['A', 'B', 'C', 'D', 'E', 'F'];
    const sources = shows.map((show) => {
      const dir = join(root, `Show ${show}`, 'S1');
      const stagingDir = join(root, '.trawlarr', 'staging', show);
      mkdirSync(dir, { recursive: true });
      mkdirSync(stagingDir, { recursive: true });
      const originalPath = join(dir, 'title00.mkv');
      const newPath = join(stagingDir, 'title00.mkv');
      writeFile(originalPath, `the ${show} original`);
      writeFile(newPath, `the ${show} transcode`);
      return { originalPath, newPath };
    });
    const module = runnerFor({ trashDir })(replacePlugin())!;

    const outs = await Promise.all(
      sources.map((source) => module.plugin(argsFor({ ...source, jobLog: () => {} }))),
    );

    expect(outs.map((out) => out.outputNumber)).toEqual(shows.map(() => 1));
    // Every original is in the trash under a DISTINCT name. No user's file was
    // consumed by another file's replacement.
    const bodies = readdirSync(trashDir)
      .map((name) => readFileSync(join(trashDir, name), 'utf8'))
      .sort();
    expect(bodies).toEqual(shows.map((show) => `the ${show} original`).sort());
    // And each library path holds its own transcode, not a neighbour's.
    for (const [index, source] of sources.entries()) {
      expect(readFileSync(source.originalPath, 'utf8')).toBe(`the ${shows[index]!} transcode`);
    }
  });

  it('lets only one of two flows claim the same replacement path', async () => {
    // "movie.mkv" and "movie.avi" in one directory, both transcoding to mp4,
    // both computing "movie.mp4". The destination check is a check-then-act,
    // so without an exclusive create the second rename destroys the first's
    // freshly transcoded output.
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-replace-claim-'));
    const libraryDir = join(root, 'library');
    mkdirSync(libraryDir, { recursive: true });
    const trashDir = join(root, '.trawlarr', 'trash');
    const make = (extension: string, body: string) => {
      const originalPath = join(libraryDir, `movie.${extension}`);
      // Each flow stages its own output, both named for the media file, so
      // both resolve to the same destination: library/movie.mp4.
      const stagingDir = join(root, '.trawlarr', 'staging', extension);
      mkdirSync(stagingDir, { recursive: true });
      const newPath = join(stagingDir, 'movie.mp4');
      writeFile(originalPath, body);
      writeFile(newPath, `${body} (transcoded)`);
      return { originalPath, newPath };
    };
    const mkv = make('mkv', 'the mkv original');
    const avi = make('avi', 'the avi original');
    const module = runnerFor({ trashDir })(replacePlugin())!;

    const outs = await Promise.all([
      module.plugin(argsFor({ ...mkv, jobLog: () => {} })),
      module.plugin(argsFor({ ...avi, jobLog: () => {} })),
    ]);

    // Exactly one wins; the other refuses rather than overwriting it.
    expect(outs.map((out) => out.outputNumber).sort()).toEqual([1, 2]);
    const winner = outs.findIndex((out) => out.outputNumber === 1);
    const winnerSource = [mkv, avi][winner]!;
    const loserSource = [mkv, avi][1 - winner]!;

    // The winner's transcode is intact at the shared destination.
    expect(readFileSync(join(libraryDir, 'movie.mp4'), 'utf8')).toBe(
      `${winner === 0 ? 'the mkv original' : 'the avi original'} (transcoded)`,
    );
    // The loser gave up nothing: its original is back at its own path.
    expect(existsSync(loserSource.originalPath)).toBe(true);
    expect(readFileSync(loserSource.originalPath, 'utf8')).toBe(
      winner === 0 ? 'the avi original' : 'the mkv original',
    );
    // And only the winner's original is in the trash.
    const trashed = readdirSync(trashDir);
    expect(trashed).toHaveLength(1);
    expect(readFileSync(join(trashDir, trashed[0]!), 'utf8')).toBe(
      winner === 0 ? 'the mkv original' : 'the avi original',
    );
    expect(basename(winnerSource.originalPath)).toBe(winner === 0 ? 'movie.mkv' : 'movie.avi');
  });

  it('refuses to replace a symlinked library entry', async () => {
    // Replacing the LINK would install a regular file over it, orphaning the
    // target the link pointed at and reclaiming none of the space the user
    // expected. Refusing something we do not fully understand is the
    // conservative call.
    const space = workspace();
    const targetPath = join(space.root, 'real-media.mkv');
    writeFile(targetPath, 'the real media, living elsewhere');
    const linkPath = join(space.libraryDir, 'linked.mkv');
    symlinkSync(targetPath, linkPath);
    const logged: string[] = [];
    const module = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: linkPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    expect(logged.join('\n')).toMatch(/symlink/i);
    // The link, its target and the staged file all survive untouched.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('the real media, living elsewhere');
    expect(existsSync(space.newPath)).toBe(true);
    expect(existsSync(space.trashDir)).toBe(false);
  });

  it('keeps every original when the filesystem cannot hardlink at all', async () => {
    // The link-unsupported fallback is on the destructive path and must be
    // exclusive too, or C1 is simply reintroduced for every deployment where
    // link(2) does not work: SMB/CIFS without unix extensions, exFAT/FAT32,
    // several FUSE mounts — and, on plain ext4, any container whose uid
    // neither owns the media nor has read+write on it, because
    // fs.protected_hardlinks=1 (the kernel default) makes link(2) return
    // EPERM there.
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-replace-nolink-'));
    const trashDir = join(root, '.trawlarr', 'trash');
    const shows = ['A', 'B', 'C', 'D', 'E', 'F'];
    const sources = shows.map((show) => {
      const dir = join(root, `Show ${show}`, 'S1');
      const stagingDir = join(root, '.trawlarr', 'staging', show);
      mkdirSync(dir, { recursive: true });
      mkdirSync(stagingDir, { recursive: true });
      const originalPath = join(dir, 'title00.mkv');
      const newPath = join(stagingDir, 'title00.mkv');
      writeFile(originalPath, `the ${show} original`);
      writeFile(newPath, `the ${show} transcode`);
      return { originalPath, newPath };
    });
    let renames = 0;
    const module = runnerFor({
      trashDir,
      overrides: {
        linkFile: () => {
          // Exactly what protected_hardlinks reports for a file this process
          // may read but does not own.
          throw Object.assign(new Error('EPERM: operation not permitted, link'), {
            code: 'EPERM',
          });
        },
        renameFile: async (from, to) => {
          renames += 1;
          await rename(from, to);
        },
      },
    })(replacePlugin())!;

    const outs = await Promise.all(
      sources.map((source) => module.plugin(argsFor({ ...source, jobLog: () => {} }))),
    );

    // The fallback really was the path taken.
    expect(renames).toBeGreaterThan(0);
    expect(outs.map((out) => out.outputNumber)).toEqual(shows.map(() => 1));
    const bodies = readdirSync(trashDir)
      .map((name) => readFileSync(join(trashDir, name), 'utf8'))
      .sort();
    expect(bodies).toEqual(shows.map((show) => `the ${show} original`).sort());
    for (const [index, source] of sources.entries()) {
      expect(readFileSync(source.originalPath, 'utf8')).toBe(`the ${shows[index]!} transcode`);
    }
  });

  it('leaves no orphan link when the original cannot be removed from its old name', async () => {
    // link(2) succeeds into trash, then unlink of the original fails (a
    // read-only library directory does this). Without a rollback the file is
    // left with TWO names, so every later run refuses it as "hardlinked" —
    // blaming the user for a link trawlarr created, and pointing them at a
    // setting that would make it worse. Nothing purges trash, so it never
    // recovers on its own.
    const space = workspace();
    const logged: string[] = [];
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        unlinkFile: async (path) => {
          if (path === space.originalPath) {
            throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), {
              code: 'EACCES',
            });
          }
          await unlink(path);
        },
      },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    // Back to ONE name: the file is not bricked for every future run.
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(statSync(space.originalPath).nlink).toBe(1);
    expect(readdirSync(space.trashDir)).toEqual([]);
    // And the message says what actually happened.
    expect(logged.join('\n')).toMatch(/could not be removed|extra link/i);

    // The proof that it is not stuck: a normal run afterwards succeeds.
    const second = runnerFor({ trashDir: space.trashDir })(replacePlugin())!;
    const secondOut = await second.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );
    expect(secondOut.outputNumber).toBe(1);
    expect(readFileSync(space.originalPath, 'utf8')).toBe(NEW_BODY);
  });

  it('rolls the swap back when the staged file cannot be cleaned up', async () => {
    const space = workspace();
    const logged: string[] = [];
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        unlinkFile: async (path) => {
          if (path === space.newPath) {
            throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), {
              code: 'EACCES',
            });
          }
          await unlink(path);
        },
      },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    // A clean, honest failure: the original is back, at one link, and the
    // staged file still exists to be retried.
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(statSync(space.originalPath).nlink).toBe(1);
    expect(existsSync(space.newPath)).toBe(true);
    expect(readdirSync(space.trashDir)).toEqual([]);
    // Not an URGENT unrecoverable report: nothing was lost and nothing needs
    // a human.
    expect(logged.join('\n')).not.toMatch(/URGENT/);
  });

  it('refuses when the replacement landed but is left under two names', async () => {
    // The rollback itself fails too, so the destination holds the new content
    // AND still carries the staged file's link. Reporting success here leaves
    // a library file at nlink=2 that the hardlink guard refuses on every
    // later run — I4's failure mode, relocated — while the log claims the
    // extra link was removed and nothing was lost. Both halves are lies.
    const space = workspace({ newExtension: 'mp4' });
    const finalPath = join(space.libraryDir, 'movie.mp4');
    const logged: string[] = [];
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        unlinkFile: async (path) => {
          // The staged file cannot be removed, and neither can the link just
          // created for it — so the rollback fails and the replacement stands.
          if (path === space.newPath || path === finalPath) {
            throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), {
              code: 'EACCES',
            });
          }
          await unlink(path);
        },
      },
    })(replacePlugin())!;

    const args = argsFor({
      newPath: space.newPath,
      originalPath: space.originalPath,
      jobLog: (text) => logged.push(text),
    });
    const out = await module.plugin(args);

    // Even on this failure route the file object describes what is ON DISK: a
    // downstream node reading a stale container or a pre-swap size would be
    // reasoning about the file this one replaced.
    expect(args.inputFileObj.container).toBe('mp4');
    expect(args.inputFileObj.file_size).toBeCloseTo(NEW_BODY.length / 1_000_000, 9);
    expect(args.inputFileObj.newSize).toBeCloseTo(NEW_BODY.length / 1_000_000, 9);
    expect(args.inputFileObj.oldSize).toBeCloseTo(ORIGINAL_BODY.length / 1_000_000, 9);

    // The replacement did land, and the reported path is the truth on disk...
    expect(out.outputFileObj._id).toBe(finalPath);
    expect(readFileSync(finalPath, 'utf8')).toBe(NEW_BODY);
    expect(statSync(finalPath).nlink).toBe(2);
    // ...but a file we know every future run will refuse is not a success.
    expect(out.outputNumber).toBe(2);
    // And the log says what is actually true, not that the link was removed.
    const log = logged.join('\n');
    expect(log).not.toMatch(/extra link has been removed/);
    expect(log).not.toMatch(/nothing was lost/);
    expect(log).toMatch(/two names/i);
    expect(log).toContain(space.newPath);
    // The original is still recoverable, and nothing claims it is lost.
    const trashed = readdirSync(space.trashDir);
    expect(trashed).toHaveLength(1);
    expect(readFileSync(join(space.trashDir, trashed[0]!), 'utf8')).toBe(ORIGINAL_BODY);
    expect(log).not.toMatch(/URGENT/);
  });

  it('never puts an empty placeholder at the user-visible media path', async () => {
    // On the EPERM/no-hardlink path the destination has to be claimed before
    // the content is moved into it. If the claim is made AT the media path, a
    // SIGKILL, OOM or container restart in that gap leaves "Movie (2019).mp4"
    // as a 0-byte file with the real original in trash — and on a container
    // change that is permanent, because the pre-flight refuses every retry
    // with "already exists and is not the file being replaced".
    //
    // Observed from inside the window: the rename seam looks at the media path
    // at the exact moment the claim is held.
    const space = workspace({ newExtension: 'mp4' });
    const finalPath = join(space.libraryDir, 'movie.mp4');
    let emptyFileAtMediaPath: boolean | null = null;
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: () => {
          throw Object.assign(new Error('EPERM: operation not permitted, link'), {
            code: 'EPERM',
          });
        },
        renameFile: async (from, to) => {
          if (to === finalPath) {
            emptyFileAtMediaPath = existsSync(finalPath) && statSync(finalPath).size === 0;
          }
          await rename(from, to);
        },
      },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(1);
    // The window was entered — this is not vacuously true.
    expect(emptyFileAtMediaPath).not.toBeNull();
    // ...and the user's media path was never an empty file.
    expect(emptyFileAtMediaPath).toBe(false);
    expect(readFileSync(finalPath, 'utf8')).toBe(NEW_BODY);
    // No reservation left behind, hidden or otherwise.
    expect(readdirSync(space.libraryDir).sort()).toEqual(['.trawlarr', 'movie.mp4']);
  });

  it('leaves no reservation behind when the fallback rename fails', async () => {
    // The placeholder cleanup was dead code: deleting it broke nothing.
    const space = workspace({ newExtension: 'mp4' });
    const finalPath = join(space.libraryDir, 'movie.mp4');
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: () => {
          throw Object.assign(new Error('EPERM: operation not permitted, link'), {
            code: 'EPERM',
          });
        },
        renameFile: async (from, to) => {
          if (to === finalPath) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          }
          await rename(from, to);
        },
      },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(2);
    // The destination name is free for the retry, and nothing was orphaned.
    expect(existsSync(finalPath)).toBe(false);
    expect(readdirSync(space.libraryDir).sort()).toEqual(['.trawlarr', 'movie.mkv']);
    // The original came back.
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
  });

  it('lets only one worker reclaim an abandoned reservation', async () => {
    // The reclaim used to be unlink-then-create: two syscalls with an await
    // between them, which is not a lock. B's unlink can land AFTER A's
    // exclusive create, deleting A's brand-new reservation, after which B's
    // create succeeds too. Both are then inside the critical section and the
    // exists/rename pair degrades to check-then-rename — C3 again, reached
    // through the one path C3's fix never touched.
    //
    // The interleaving is forced through the seams rather than left to the
    // scheduler: run naturally, the two workers usually miss each other and
    // the test passes against the broken code.
    const root = mkdtempSync(join(tmpdir(), 'trawlarr-replace-reclaim-'));
    const libraryDir = join(root, 'library');
    mkdirSync(libraryDir, { recursive: true });
    const trashDir = join(root, '.trawlarr', 'trash');
    const finalPath = join(libraryDir, 'movie.mp4');
    const reservationPath = join(libraryDir, '.trawlarr-reserve-movie.mp4');

    const make = (extension: string, body: string) => {
      const originalPath = join(libraryDir, `movie.${extension}`);
      const stagingDir = join(root, '.trawlarr', 'staging', extension);
      mkdirSync(stagingDir, { recursive: true });
      const newPath = join(stagingDir, 'movie.mp4');
      writeFile(originalPath, body);
      writeFile(newPath, `${body} (transcoded)`);
      return { originalPath, newPath };
    };
    const mkv = make('mkv', 'the mkv original');
    const avi = make('avi', 'the avi original');

    // Left behind by a run killed two hours ago.
    writeFile(reservationPath, '');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(reservationPath, twoHoursAgo, twoHoursAgo);

    let resolveFirstClaim = () => {};
    const firstClaim = new Promise<void>((resolve) => {
      resolveFirstClaim = resolve;
    });
    let releaseBothSaw = () => {};
    const bothSawItOccupied = new Promise<void>((resolve) => {
      releaseBothSaw = resolve;
    });
    let occupiedObservations = 0;
    let reservationUnlinks = 0;
    let reservationClaims = 0;

    const module = runnerFor({
      trashDir,
      overrides: {
        // Hardlinking unavailable: the only way to reach the reservation.
        linkFile: () => {
          throw Object.assign(new Error('EPERM: operation not permitted, link'), {
            code: 'EPERM',
          });
        },
        // The suite's fixed CLOCK_MS predates every real file mtime, which
        // would make staleness evaluate negative and leave this branch
        // unreachable.
        nowMs: () => Date.now(),
        unlinkFile: async (path) => {
          if (path === reservationPath) {
            reservationUnlinks += 1;
            // The second racer's removal lands after the first has claimed:
            // the exact ordering that breaks an unlink-then-create "lock".
            if (reservationUnlinks === 2) await firstClaim;
          }
          await unlink(path).catch(() => {});
        },
        openExclusive: async (path) => {
          let handle;
          try {
            handle = await open(path, 'wx');
          } catch (error) {
            if (path === reservationPath && codeOfError(error) === 'EEXIST') {
              // Hold both workers here until each has seen the abandoned
              // reservation, so neither can quietly miss the race.
              occupiedObservations += 1;
              if (occupiedObservations >= 2) releaseBothSaw();
              else await bothSawItOccupied;
            }
            throw error;
          }
          await handle.close();
          if (path === reservationPath) {
            reservationClaims += 1;
            if (reservationClaims === 1) resolveFirstClaim();
          }
        },
      },
    })(replacePlugin())!;

    const outs = await Promise.all([
      module.plugin(argsFor({ ...mkv, jobLog: () => {} })),
      module.plugin(argsFor({ ...avi, jobLog: () => {} })),
    ]);

    // THE invariant: a reclaim is a lock, so exactly one worker may end up
    // holding the reservation. With both inside the critical section the
    // exists/rename pair is a check-then-rename again, and whether data
    // survives comes down to which syscall lands first.
    expect(reservationClaims).toBe(1);
    expect(outs.map((out) => out.outputNumber).sort()).toEqual([1, 2]);
    const winner = outs.findIndex((out) => out.outputNumber === 1);
    const loser = [mkv, avi][1 - winner]!;

    // The winner's transcode is intact, not consumed by the loser's rename.
    expect(readFileSync(finalPath, 'utf8')).toBe(
      winner === 0 ? 'the mkv original (transcoded)' : 'the avi original (transcoded)',
    );
    // The loser gave up nothing: its original is still its own.
    expect(readFileSync(loser.originalPath, 'utf8')).toBe(
      winner === 0 ? 'the avi original' : 'the mkv original',
    );
    // Two library entries went in; two came out.
    expect(readdirSync(trashDir)).toHaveLength(1);
  });

  it("never releases a reservation that has become another worker's", async () => {
    // If this worker's reservation is reclaimed as abandoned while its move
    // runs, the file at that path now belongs to somebody else. Deleting it on
    // the way out would break the lock that worker is relying on — and produce
    // a "delete it by hand" message about a file that was never ours.
    const space = workspace({ newExtension: 'mp4' });
    const finalPath = join(space.libraryDir, 'movie.mp4');
    const reservationPath = join(space.libraryDir, '.trawlarr-reserve-movie.mp4');
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: () => {
          throw Object.assign(new Error('EPERM: operation not permitted, link'), {
            code: 'EPERM',
          });
        },
        nowMs: () => Date.now(),
        renameFile: async (from, to) => {
          if (to === finalPath) {
            // Stand in for another worker reclaiming ours: same path, DIFFERENT
            // inode. Written as create-then-rename because unlink-then-create
            // hands back the inode just freed — the substitute would then be
            // indistinguishable from our own reservation and the test would be
            // asserting nothing.
            writeFileSync(`${reservationPath}.other`, '', 'utf8');
            renameSync(`${reservationPath}.other`, reservationPath);
          }
          await rename(from, to);
        },
      },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(1);
    expect(readFileSync(finalPath, 'utf8')).toBe(NEW_BODY);
    // The other worker's reservation is still standing.
    expect(existsSync(reservationPath)).toBe(true);
  });

  it('reclaims an abandoned reservation rather than refusing forever', async () => {
    const space = workspace({ newExtension: 'mp4' });
    const finalPath = join(space.libraryDir, 'movie.mp4');
    const reservationPath = join(space.libraryDir, '.trawlarr-reserve-movie.mp4');
    writeFile(reservationPath, '');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(reservationPath, twoHoursAgo, twoHoursAgo);
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: () => {
          throw Object.assign(new Error('EPERM: operation not permitted, link'), {
            code: 'EPERM',
          });
        },
        nowMs: () => Date.now(),
      },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(1);
    expect(readFileSync(finalPath, 'utf8')).toBe(NEW_BODY);
    // Neither the abandoned reservation nor the one taken to replace it.
    expect(readdirSync(space.libraryDir).sort()).toEqual(['.trawlarr', 'movie.mp4']);
  });

  it('refuses while another worker is genuinely holding the reservation', async () => {
    const space = workspace({ newExtension: 'mp4' });
    // Fresh, not abandoned: a live worker is mid-move.
    writeFile(join(space.libraryDir, '.trawlarr-reserve-movie.mp4'), '');
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: () => {
          throw Object.assign(new Error('EPERM: operation not permitted, link'), {
            code: 'EPERM',
          });
        },
        nowMs: () => Date.now(),
      },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({ newPath: space.newPath, originalPath: space.originalPath, jobLog: () => {} }),
    );

    expect(out.outputNumber).toBe(2);
    // Untouched: the original is back and the live reservation still stands.
    expect(readFileSync(space.originalPath, 'utf8')).toBe(ORIGINAL_BODY);
    expect(existsSync(join(space.libraryDir, '.trawlarr-reserve-movie.mp4'))).toBe(true);
  });

  it('knows the replacement landed even when it arrived by cross-device copy', async () => {
    // swapLanded decided on (dev, ino) identity against the STAGED file, but a
    // cross-device replacement descends from the copy — a different inode by
    // construction. So on that path it always answered "did not land", the
    // runner restored over a media path already holding the correct new file,
    // and told the user to move the trash copy back over it.
    const space = workspace({ newExtension: 'mp4' });
    const finalPath = join(space.libraryDir, 'movie.mp4');
    const logged: string[] = [];
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        linkFile: async (from, to) => {
          if (dirname(from) === space.stagingDir) {
            throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
              code: 'EXDEV',
            });
          }
          await link(from, to);
        },
        unlinkFile: async (path) => {
          // The staged copy cannot be removed, and neither can the link made
          // from it — so the rollback fails and the replacement stands.
          if (basename(path).startsWith('.trawlarr-replace-') || path === finalPath) {
            throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), {
              code: 'EACCES',
            });
          }
          await unlink(path);
        },
      },
    })(replacePlugin())!;

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    const log = logged.join('\n');
    // The new file really is at the media path...
    expect(readFileSync(finalPath, 'utf8')).toBe(NEW_BODY);
    // ...so nothing may tell the user to move the trash copy back over it.
    expect(log).not.toMatch(/URGENT/);
    // ...and the original must NOT be restored on top of it: doing so leaves
    // the library holding the same title twice, one under each container,
    // with the ledger pointing two records at one replacement.
    expect(existsSync(space.originalPath)).toBe(false);
    // It carries an extra name, so it is reported as a failure with the reason
    // said out loud rather than left silently unprocessable.
    expect(out.outputNumber).toBe(2);
    expect(out.outputFileObj._id).toBe(finalPath);
    expect(log).toMatch(/two names|hardlinked/i);
    // The original stays recoverable in trash.
    const trashed = readdirSync(space.trashDir);
    expect(trashed).toHaveLength(1);
    expect(readFileSync(join(space.trashDir, trashed[0]!), 'utf8')).toBe(ORIGINAL_BODY);
  });

  it('routes a partial companion failure to output 2, reporting the split', async () => {
    const space = workspace({ newExtension: 'mp4' });
    writeFile(join(space.libraryDir, 'movie.en.srt'), 'subtitles');
    writeFile(join(space.libraryDir, 'movie.nfo'), 'metadata');
    const module = runnerFor({
      trashDir: space.trashDir,
      overrides: {
        // Moves the first companion, then fails: no rollback exists for this,
        // which is exactly why it cannot be reported as success.
        moveCompanions: async (moveInput) => {
          await moveCompanionsHere({ ...moveInput, companions: moveInput.companions.slice(0, 1) });
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      },
    })(replacePlugin())!;
    const logged: string[] = [];

    const out = await module.plugin(
      argsFor({
        newPath: space.newPath,
        originalPath: space.originalPath,
        jobLog: (text) => logged.push(text),
      }),
    );

    expect(out.outputNumber).toBe(2);
    // The media swap itself succeeded and is reported truthfully: the path
    // that now holds the file is the one downstream nodes must see.
    expect(out.outputFileObj._id).toBe(join(space.libraryDir, 'movie.mp4'));
    expect(readFileSync(join(space.libraryDir, 'movie.mp4'), 'utf8')).toBe(NEW_BODY);
    expect(logged.join('\n')).toMatch(/companion/i);
    // And the original is still recoverable while a human sorts the split out.
    const trashed = readdirSync(space.trashDir);
    expect(trashed).toHaveLength(1);
    expect(readFileSync(join(space.trashDir, trashed[0]!), 'utf8')).toBe(ORIGINAL_BODY);
  });
});

describe('guardSizeGrowth', () => {
  const verdict = (newSizeBytes: number, originalSizeBytes: number) =>
    guardSizeGrowth({ newSizeBytes, originalSizeBytes }).install;

  it('installs anything that shrank, which is the ordinary case', () => {
    expect(verdict(1, 1_000_000_000)).toBe(true);
    expect(verdict(883_853_072, 1_823_927_056)).toBe(true);
  });

  it('installs a file that came out exactly the same size', () => {
    expect(verdict(1_000_000_000, 1_000_000_000)).toBe(true);
  });

  it('refuses the real incident: 884 MB in, 1.82 GB out', () => {
    const result = guardSizeGrowth({ newSizeBytes: 1_823_927_056, originalSizeBytes: 883_853_072 });
    expect(result.install).toBe(false);
    expect(result.grewByBytes).toBe(940_073_984);
    expect(result.ratio).toBeCloseTo(2.06, 2);
  });

  it('needs BOTH bounds exceeded, so a small file is not refused over container overhead', () => {
    // The measured mkv -> mp4 remux of this repo's 2-second fixture: 50,773
    // bytes in, 51,430 out. 1.3% larger — past the ratio, nowhere near the
    // byte floor — and a flow doing exactly what it was asked to do.
    expect(verdict(51_430, 50_773)).toBe(true);
    // A gigabyte-scale file gets no such licence: 2 MiB of growth is under
    // the ratio, which is what admits it, not the floor.
    expect(verdict(1_000_000_000 + 2 * REPLACEMENT_GROWTH_SLACK_BYTES, 1_000_000_000)).toBe(true);
    // Past both: refused.
    expect(verdict(1_100_000_000, 1_000_000_000)).toBe(false);
  });

  it('treats each bound as the most a file MAY grow by, not the least', () => {
    const original = 1_000_000_000;
    const atRatio = original + original * REPLACEMENT_GROWTH_SLACK_RATIO;
    expect(verdict(atRatio, original)).toBe(true);
    expect(verdict(atRatio + 1, original)).toBe(false);

    // Under the ratio's reach, the byte floor is the operative bound.
    const small = 1_000_000;
    expect(verdict(small + REPLACEMENT_GROWTH_SLACK_BYTES, small)).toBe(true);
    expect(verdict(small + REPLACEMENT_GROWTH_SLACK_BYTES + 1, small)).toBe(false);
  });

  it("abstains when the original's size is no basis for a judgement", () => {
    // The same abstention `verifyOutput` makes on a zero-byte original —
    // where it refuses the file outright, before this ever runs.
    expect(verdict(1_000_000_000, 0)).toBe(true);
  });
});
