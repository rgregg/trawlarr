import { randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { PluginModule, PluginOutputArgs } from '@trawlarr/plugin-api';
import type { LoadedPlugin } from '../host/loader.js';
import { canonicalPath } from './encode-target.js';
import { BYTES_PER_MEGABYTE } from '../host/file-object.js';

/** What the runner needs from a `stat`: size for reporting, nlink for safety. */
export interface FileStats {
  size: number;
  nlink: number;
}

export type StatFileFn = (path: string) => Promise<FileStats>;

/**
 * The seams the engine cannot import.
 *
 * `findCompanions`/`moveCompanions` live in `@trawlarr/server`, and the server
 * depends on the engine (its worker assembles these runners and calls
 * `runFlow`). Importing them here would make that a cycle, which
 * `tsc --build` refuses outright, so they arrive as parameters instead — the
 * same treatment `trashDirFor` and `statFile` already get. Their types are
 * exported so the server can assert its real implementations satisfy them at
 * compile time; see `packages/server/src/library/replace-seams.ts`.
 */
export type FindCompanionsFn = (input: {
  filePath: string;
  companionExtensions: readonly string[];
}) => Promise<string[]>;

export type MoveCompanionsFn = (input: {
  companions: readonly string[];
  oldMediaPath: string;
  newMediaPath: string;
}) => Promise<void>;

export type RenameFileFn = (from: string, to: string) => Promise<void>;

export type LinkFileFn = (from: string, to: string) => Promise<void>;

/**
 * Builds the error raised when replacement would have to cross a filesystem
 * boundary and the operator has forbidden the copy fallback. Defaults to a
 * plain `Error`; the server passes a factory for its own
 * `CrossDeviceStagingError`, which lives on the far side of the dependency
 * edge described above.
 */
export type CrossDeviceErrorFn = (input: { stagingDir: string; filePath: string }) => Error;

export interface ReplaceRunnerInput {
  /** Where this file's replaced original should be kept. */
  trashDirFor: (originalPath: string) => string;
  companionExtensions: readonly string[];
  /** Whether a file with more than one link may be replaced. */
  allowHardlinked: boolean;
  statFile: StatFileFn;
  nowMs: () => number;
  log?: (text: string) => void;
  findCompanions: FindCompanionsFn;
  moveCompanions: MoveCompanionsFn;
  crossDeviceError?: CrossDeviceErrorFn;
  /** Seam for tests: simulate an `EXDEV` without a second filesystem. */
  renameFile?: RenameFileFn;
  /** Seam for tests: the exclusive-create half of every move this node makes. */
  linkFile?: LinkFileFn;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeOf = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

const exists = async (path: string): Promise<boolean> => {
  try {
    // lstat, not stat: a dangling symlink at the destination is still a real
    // filesystem entry, and renaming over it would destroy it.
    await lstat(path);
    return true;
  } catch (cause) {
    if (codeOf(cause) === 'ENOENT') return false;
    throw cause;
  }
};

/**
 * Where the replacement belongs: the original's name, carrying the new file's
 * container. A transcode to a different container must not keep the old
 * extension — an mp4 stream named `.mkv` misleads every tool downstream —
 * but the *name* is the user's, and renaming their file is not this node's
 * job.
 *
 * The staged file's name is an implementation detail of whatever produced it,
 * so adopting it would hand a user back `Movie Title (2019) [1080p].mkv` as
 * whatever the encoder happened to write — in bulk, across a whole library,
 * from an unattended worker, and with Plex, Jellyfin, Sonarr and Radarr all
 * identifying content by filename. Only the container is ours to change.
 *
 * A consequence worth stating: because the stem is preserved, a companion's
 * computed target equals its current path, so `moveCompanions` legitimately
 * has nothing to do here. That is the correct outcome, not a gap — the
 * sidecars already sit beside the media file under the right names. Its
 * genuine renaming behaviour is covered where it lives, in
 * `packages/server/src/fs/companions.test.ts`.
 */
export const replacementPathFor = (input: { originalPath: string; newPath: string }): string => {
  const originalExtension = extname(input.originalPath);
  const newExtension = extname(input.newPath);
  const stem = basename(input.originalPath, originalExtension);
  return join(
    dirname(input.originalPath),
    `${stem}${newExtension === '' ? originalExtension : newExtension}`,
  );
};

/**
 * Codes a `link(2)` returns when the filesystem cannot hardlink at all —
 * exFAT, FAT32 and some network mounts. Only these fall back to a rename;
 * anything else is a real failure and must surface.
 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK']);

/**
 * Create `to` as a second name for `from`, failing if `to` already exists.
 *
 * `rename(2)` silently replaces an existing destination, which is what makes
 * every check-then-rename in this node a way to destroy a file that appeared
 * in between. `link(2)` fails `EEXIST` atomically instead, and is same-device
 * by construction — exactly the property the trash and the swap both need.
 *
 * Returns whether the source still exists afterwards, since the fallback path
 * consumes it.
 */
const createExclusively = async (input: {
  from: string;
  to: string;
  linkFile: LinkFileFn;
  renameFile: RenameFileFn;
}): Promise<'linked' | 'renamed'> => {
  try {
    await input.linkFile(input.from, input.to);
    return 'linked';
  } catch (error) {
    const code = codeOf(error);
    // The caller decides what an occupied destination or a device boundary
    // means; only "this filesystem has no hardlinks" is handled here.
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
    // No atomic exclusive create exists on such a filesystem. Re-check as late
    // as possible and rename: the window shrinks to the gap between these two
    // calls rather than spanning the whole node, but it does not vanish.
    if (await exists(input.to)) {
      throw Object.assign(new Error(`EEXIST: "${input.to}" already exists`), { code: 'EEXIST' });
    }
    await input.renameFile(input.from, input.to);
    return 'renamed';
  }
};

/**
 * Move `from` to `to` without ever overwriting `to`. The inode is preserved
 * either way, so a file's `(device, inode)` identity survives the move — which
 * is what lets the ledger follow an original into the trash.
 *
 * Interrupted between the link and the unlink, the file exists under BOTH
 * names: a duplicate, never a loss.
 */
const moveExclusively = async (input: {
  from: string;
  to: string;
  linkFile: LinkFileFn;
  renameFile: RenameFileFn;
}): Promise<void> => {
  if ((await createExclusively(input)) === 'linked') await unlink(input.from);
};

/**
 * Move the original into `trashDir` under a name nothing else holds.
 *
 * The timestamp keeps trash entries readable and orders them, but it is NOT
 * what makes the name unique: one trash directory serves a whole library root,
 * so two different files sharing a basename — `Show A/S1/title00.mkv` and
 * `Show B/S1/title00.mkv`, which disc rips produce by the hundred — compute
 * the same name, and workers running at the same moment compute the same
 * millisecond too. A counter cannot fix that: it only sees what is already on
 * disk, never what another worker has in flight. Uniqueness comes from the
 * exclusive create, and the counter merely picks the next readable name when
 * that create reports the collision.
 */
const moveToTrash = async (input: {
  trashDir: string;
  originalPath: string;
  nowMs: number;
  linkFile: LinkFileFn;
  renameFile: RenameFileFn;
}): Promise<string> => {
  const extension = extname(input.originalPath);
  const stem = basename(input.originalPath, extension);
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = join(input.trashDir, `${stem}.${input.nowMs}${suffix}${extension}`);
    try {
      await moveExclusively({
        from: input.originalPath,
        to: candidate,
        linkFile: input.linkFile,
        renameFile: input.renameFile,
      });
      return candidate;
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
    }
  }
  throw new Error(
    `Could not find a free name for "${input.originalPath}" in "${input.trashDir}" after ` +
      `10000 attempts.`,
  );
};

/** `'false'`, `false` and `'0'` are false; anything unset defaults to `true`. */
const booleanInput = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'false' || text === '0' || text === 'no') return false;
  if (text === 'true' || text === '1' || text === 'yes') return true;
  return fallback;
};

/**
 * The engine's substitute for the Replace Original File node: the one step in
 * trawlarr that destroys the user's file.
 *
 * The order below is chosen so that a crash at any point leaves the original
 * recoverable:
 *
 *  1. Every refusal (hardlink, missing or empty replacement, an occupied
 *     destination, a replacement that IS the original) is decided before
 *     anything moves, so a refusal cannot be half-applied.
 *  2. The original moves to trash *before* the replacement is renamed in. The
 *     destination is normally the original's own path, so renaming first would
 *     silently overwrite the file this node exists to preserve. A crash in the
 *     gap leaves the library missing the file and the original intact in trash
 *     — visible and recoverable, which a clobbered file is not.
 *  3. Every move is an EXCLUSIVE create — `link(2)`, which fails `EEXIST`
 *     atomically — never a bare `rename(2)`, which replaces its destination
 *     silently. That is what stops two concurrent replacements from consuming
 *     each other's original or each other's output. Across devices the swap
 *     becomes copy-to-a-temporary-path-on-the-destination then an exclusive
 *     create, so an interrupted copy can only ever leave a stray temp file,
 *     never a truncated file at the live path.
 *  4. If the swap fails after the original was trashed, the original is
 *     restored before routing to failure.
 */
export const createReplaceOriginalRunner =
  (input: ReplaceRunnerInput) =>
  (plugin: LoadedPlugin): PluginModule | null => {
    if (plugin.id !== 'trawlarr:replaceOriginal') return null;

    const renameFile: RenameFileFn = input.renameFile ?? ((from, to) => rename(from, to));
    const linkFile: LinkFileFn = input.linkFile ?? ((from, to) => link(from, to));
    const crossDeviceError: CrossDeviceErrorFn =
      input.crossDeviceError ??
      ((crossDevice) =>
        new Error(
          `The new file in "${crossDevice.stagingDir}" is on a different filesystem than ` +
            `"${crossDevice.filePath}". Replacement requires an atomic rename, which cannot ` +
            `cross devices, and this node's cross-device fallback is switched off.`,
        ));

    return {
      details: () => plugin.details,
      plugin: async (args): Promise<PluginOutputArgs> => {
        const say = (text: string) => {
          args.jobLog(text);
          input.log?.(text);
        };
        const newPath = args.inputFileObj._id;
        const originalPath = args.originalLibraryFile._id;

        const refuse = (reason: string, path: string): PluginOutputArgs => {
          say(`Replacement refused: ${reason}`);
          return { outputNumber: 2, outputFileObj: { _id: path }, variables: args.variables };
        };

        // Compared canonically, never as raw strings: the in-place-write
        // incident this codebase already lived through was a string compare
        // that a symlink alias walked straight past.
        if (canonicalPath(newPath) === canonicalPath(originalPath)) {
          say(
            `Nothing to replace: "${originalPath}" is already the file this flow produced. ` +
              `Leaving it alone.`,
          );
          return {
            outputNumber: 1,
            outputFileObj: { _id: originalPath },
            variables: args.variables,
          };
        }

        // --- Everything below decides; nothing below MOVES, until the trash
        // --- step. The original is never given up on the strength of a
        // --- replacement that has not been shown to exist.
        let newStats: FileStats;
        try {
          newStats = await input.statFile(newPath);
        } catch (error) {
          return refuse(
            `the new file "${newPath}" is not there (${messageOf(error)}). The original ` +
              `stays where it is.`,
            originalPath,
          );
        }
        if (newStats.size === 0) {
          return refuse(
            `the new file "${newPath}" is empty. An empty replacement is a failed encode, ` +
              `not a result.`,
            originalPath,
          );
        }

        let originalStats: FileStats;
        try {
          originalStats = await input.statFile(originalPath);
        } catch (error) {
          return refuse(
            `the original "${originalPath}" could not be read (${messageOf(error)}).`,
            originalPath,
          );
        }
        if (originalStats.nlink > 1 && !input.allowHardlinked) {
          return refuse(
            `"${originalPath}" is hardlinked (${originalStats.nlink} links). Replacing it ` +
              `would leave the other names pointing at the old content, so this library's ` +
              `"allow hardlinked" setting must be turned on to do it deliberately.`,
            originalPath,
          );
        }

        // A symlinked library entry is refused outright. Replacing the LINK
        // installs a regular file over it, silently orphaning whatever the
        // link pointed at and reclaiming none of the space the user expected
        // to reclaim; replacing its TARGET reaches outside the library
        // altogether. Refusing an operation we do not fully understand is the
        // conservative call, and it can be relaxed later far more safely than
        // it could be retracted.
        let originalIsSymlink: boolean;
        try {
          originalIsSymlink = (await lstat(originalPath)).isSymbolicLink();
        } catch (error) {
          return refuse(
            `the original "${originalPath}" could not be examined (${messageOf(error)}).`,
            originalPath,
          );
        }
        if (originalIsSymlink) {
          return refuse(
            `"${originalPath}" is a symlink. Replacing it would install a regular file over ` +
              `the link and orphan the file it points at, freeing none of the space you are ` +
              `expecting. Point the library at the real location of this file instead.`,
            originalPath,
          );
        }

        const finalPath = replacementPathFor({ originalPath, newPath });
        const replacingInPlace = canonicalPath(finalPath) === canonicalPath(originalPath);
        // The new file can already BE at its destination — a flow that staged
        // its output beside the original under a different name. Then the
        // replacement is purely the trashing of the original, and the
        // occupied-destination check below must not mistake the new file for
        // a bystander it is about to overwrite.
        const alreadyInPlace = canonicalPath(finalPath) === canonicalPath(newPath);
        // Advisory only: it reports the common case cheaply, before anything
        // moves. The authority is the exclusive create in the swap itself,
        // because between this check and that swap another worker can claim
        // the same destination — two flows transcoding "movie.mkv" and
        // "movie.avi" to mp4 both compute "movie.mp4".
        if (!replacingInPlace && !alreadyInPlace && (await exists(finalPath))) {
          return refuse(
            `"${finalPath}" already exists and is not the file being replaced. Renaming ` +
              `onto it would destroy it.`,
            originalPath,
          );
        }

        // Read-only, and done while the original is still in place.
        let companions: string[] = [];
        try {
          companions = await input.findCompanions({
            filePath: originalPath,
            companionExtensions: input.companionExtensions,
          });
        } catch (error) {
          return refuse(
            `the companion files of "${originalPath}" could not be listed ` +
              `(${messageOf(error)}), so the move cannot be planned.`,
            originalPath,
          );
        }

        // --- From here on, the filesystem changes. ---
        const trashDir = input.trashDirFor(originalPath);
        let trashPath: string;
        try {
          await mkdir(trashDir, { recursive: true });
          trashPath = await moveToTrash({
            trashDir,
            originalPath,
            nowMs: input.nowMs(),
            linkFile,
            renameFile,
          });
        } catch (error) {
          // The original is still at its own path: nothing to undo.
          return refuse(
            `the original could not be moved to "${trashDir}" (${messageOf(error)}).`,
            originalPath,
          );
        }
        say(`Original moved to trash: "${trashPath}" (nothing purges it automatically).`);

        const restoreOriginal = async (): Promise<void> => {
          try {
            // Exclusive, like every other move here: if anything claimed the
            // original's path during the swap window, restoring over it would
            // destroy that file instead.
            await moveExclusively({ from: trashPath, to: originalPath, linkFile, renameFile });
            say(`Restored the original to "${originalPath}".`);
          } catch (error) {
            say(
              `URGENT: the original could not be restored to "${originalPath}" ` +
                `(${messageOf(error)}). It is intact at "${trashPath}" — move it back by hand.`,
            );
          }
        };

        try {
          await swapIntoPlace({
            newPath,
            finalPath,
            renameFile,
            crossDeviceError,
            allowCrossDevice: booleanInput(args.inputs.allowCrossDevice, true),
            linkFile,
            say,
          });
        } catch (error) {
          say(`Replacement failed: ${messageOf(error)}`);
          await restoreOriginal();
          return {
            outputNumber: 2,
            outputFileObj: { _id: originalPath },
            variables: args.variables,
          };
        }

        // Re-stat AFTER the swap. Nothing else does, so without this every
        // size the flow reports — file_size, oldSize, newSize — would still
        // describe the pre-transcode file and every size-comparison plugin
        // downstream would compute a saving of exactly zero.
        let finalStats: FileStats;
        try {
          finalStats = await input.statFile(finalPath);
        } catch (error) {
          // The swap succeeded; only the measurement failed. Report the truth
          // on disk rather than a stale size.
          say(
            `Replaced "${originalPath}", but its new size could not be read: ${messageOf(error)}`,
          );
          finalStats = newStats;
        }

        // The plugin contract carries sizes in MEGABYTES while trawlarr stores
        // bytes (see toPluginFileObject). Anything persisting these back must
        // round to whole bytes: the round-trip is floating point, so 999999
        // bytes returns as 999999.0000000001.
        args.inputFileObj._id = finalPath;
        args.inputFileObj.file = finalPath;
        args.inputFileObj.container = extname(finalPath).slice(1).toLowerCase();
        args.inputFileObj.file_size = finalStats.size / BYTES_PER_MEGABYTE;
        args.inputFileObj.newSize = finalStats.size / BYTES_PER_MEGABYTE;
        args.inputFileObj.oldSize = originalStats.size / BYTES_PER_MEGABYTE;
        say(
          `Replaced "${originalPath}" with "${finalPath}": ` +
            `${originalStats.size} bytes -> ${finalStats.size} bytes.`,
        );

        try {
          await input.moveCompanions({
            companions,
            oldMediaPath: originalPath,
            newMediaPath: finalPath,
          });
        } catch (error) {
          // Moving companions is not atomic and has no rollback: a failure
          // partway through leaves them split across two names. The media swap
          // is sound and stays — undoing it would compound the split — but
          // this is NOT a success, so it routes to failure with the path that
          // is actually on disk.
          say(
            `The media file was replaced, but its companion files were left split between ` +
              `"${basename(originalPath)}" and "${basename(finalPath)}" (${messageOf(error)}). ` +
              `Companions: ${companions.join(', ')}`,
          );
          return { outputNumber: 2, outputFileObj: { _id: finalPath }, variables: args.variables };
        }

        return { outputNumber: 1, outputFileObj: { _id: finalPath }, variables: args.variables };
      },
    };
  };

/**
 * Put the new file at `finalPath` without ever overwriting what is there.
 *
 * Two separate hazards, and both cost a user their data if handled loosely:
 *
 *  - `rename(2)` replaces an existing destination silently, so the swap is an
 *    exclusive create. Two flows can compute the same destination — a library
 *    holding `movie.mkv` and `movie.avi`, both transcoding to mp4 — and the
 *    second must be told the name is taken, not hand it a way to delete the
 *    first's freshly encoded file.
 *  - Across devices the fallback stages a copy on the DESTINATION filesystem
 *    and finishes with an exclusive create, so the live path only ever changes
 *    in one atomic step. Copying straight onto `finalPath` would mean a killed
 *    process, a full disk or a power cut could leave a truncated file exactly
 *    where the user's original used to be — the node's own tooltip promise,
 *    and the reason this is not merely a slower `copyFile`.
 */
const swapIntoPlace = async (input: {
  newPath: string;
  finalPath: string;
  renameFile: RenameFileFn;
  linkFile: LinkFileFn;
  crossDeviceError: CrossDeviceErrorFn;
  allowCrossDevice: boolean;
  say: (text: string) => void;
}): Promise<void> => {
  if (canonicalPath(input.newPath) === canonicalPath(input.finalPath)) return; // already there
  try {
    await moveExclusively({
      from: input.newPath,
      to: input.finalPath,
      linkFile: input.linkFile,
      renameFile: input.renameFile,
    });
    return;
  } catch (error) {
    if (codeOf(error) === 'EEXIST') {
      throw new Error(
        `"${input.finalPath}" was claimed by something else while this replacement was in ` +
          `progress. Refusing to overwrite it.`,
      );
    }
    if (codeOf(error) !== 'EXDEV') throw error;
    if (!input.allowCrossDevice) {
      throw input.crossDeviceError({
        stagingDir: dirname(input.newPath),
        filePath: input.finalPath,
      });
    }
    input.say(
      `The new file is on a different filesystem, so an atomic rename is not possible. ` +
        `Falling back to a cross-device copy into "${dirname(input.finalPath)}" followed by ` +
        `an atomic rename; this is slower and its failure window is wider.`,
    );
  }

  const extension = extname(input.finalPath);
  // A UUID, so the staging name cannot collide with a concurrent replacement's
  // even before the exclusive create below has a chance to say so.
  const stagedPath = join(
    dirname(input.finalPath),
    `.trawlarr-replace-${randomUUID()}${extension}`,
  );
  try {
    await copyFile(input.newPath, stagedPath);
    await moveExclusively({
      from: stagedPath,
      to: input.finalPath,
      linkFile: input.linkFile,
      renameFile: input.renameFile,
    });
  } catch (error) {
    await unlink(stagedPath).catch(() => {});
    if (codeOf(error) === 'EEXIST') {
      throw new Error(
        `"${input.finalPath}" was claimed by something else while this replacement was in ` +
          `progress. Refusing to overwrite it.`,
      );
    }
    throw error;
  }
  // The staged source is now a duplicate of a file that lives in the library.
  await unlink(input.newPath).catch(() => {});
};
