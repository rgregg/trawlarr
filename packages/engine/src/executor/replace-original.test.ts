import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { link, readdir, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginDetails, PluginInputArgs } from '@trawlarr/plugin-api';
import { createReplaceOriginalRunner, type ReplaceRunnerInput } from './replace-original.js';
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

const ORIGINAL_BODY = 'the original the user would be furious to lose';
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
