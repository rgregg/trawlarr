import { randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, rename, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { PluginInputArgs, PluginModule, PluginOutputArgs } from '@trawlarr/plugin-api';
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

export type UnlinkFileFn = (path: string) => Promise<void>;

/**
 * Create `path` and fail with `EEXIST` if it already exists — `O_CREAT|O_EXCL`.
 * A seam like the others so reservation failures can be driven from tests.
 */
export type OpenExclusiveFn = (path: string) => Promise<void>;

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
  /** Seam for tests: the "remove the old name" half of every move. */
  unlinkFile?: UnlinkFileFn;
  /** Seam for tests: the exclusive reservation used where linking is absent. */
  openExclusive?: OpenExclusiveFn;
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
 * Codes a `link(2)` returns when hardlinking is not available for this file.
 *
 * `EPERM` is emphatically NOT limited to "the filesystem has no hardlinks":
 * with `fs.protected_hardlinks=1`, which is the kernel default, `link(2)`
 * returns it whenever the caller neither owns the source nor holds read+write
 * on it. A container running as one uid over media owned by another, at 0644,
 * on plain ext4, takes this branch for every single move — so this fallback is
 * a mainstream path, not an exotic one, and it must be exactly as exclusive as
 * the hardlink path.
 *
 * `EMLINK` is deliberately absent: it means the source has hit its link-count
 * ceiling, not that the filesystem lacks links, and quietly treating it as
 * "no hardlink support" would downgrade the guarantee for an unrelated
 * condition.
 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP']);

/**
 * How long a reservation must have gone WITHOUT a heartbeat before another
 * worker reclaims it.
 *
 * The obvious version of this comment — "a reservation lives for one rename,
 * microseconds, so an hour cannot collide with a live worker" — is wrong for
 * the deployments this branch exists to serve. A rename blocked on a hung
 * CIFS or FUSE mount can take minutes or hours, and a merely-slow worker is
 * otherwise indistinguishable from a dead one: reclaiming its reservation
 * would put two workers in the critical section, which is the whole hazard.
 *
 * So a held reservation has its mtime refreshed while the move is in flight,
 * and staleness means "nobody has touched this for an hour" rather than
 * "created over an hour ago".
 */
const RESERVATION_STALE_MS = 60 * 60 * 1000;

/** Far below the staleness threshold, so a slow move stays visibly alive. */
const RESERVATION_HEARTBEAT_MS = 60 * 1000;

const eexistAt = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EEXIST: "${path}" already exists`), { code: 'EEXIST' });

/** The hidden name that stands for "this destination is claimed". */
const reservationPathFor = (finalPath: string): string =>
  join(dirname(finalPath), `.trawlarr-reserve-${basename(finalPath)}`);

/** A reservation this worker holds, identified so it can only release its own. */
interface HeldReservation {
  path: string;
  dev: number;
  ino: number;
}

/**
 * Claim `finalPath` for this worker, without ever creating a file AT it.
 *
 * The claim is an exclusive create of a HIDDEN name derived from the
 * destination. Deriving it (rather than using a UUID) is what makes it a lock
 * at all: every worker targeting the same destination computes the same name,
 * so `O_CREAT|O_EXCL` admits exactly one of them. A UUID would be unique by
 * construction and would therefore exclude nobody.
 *
 * Claiming the media path itself would be simpler, but a SIGKILL, OOM or
 * container restart between the claim and the rename then leaves
 * `Movie (2019).mp4` as a 0-byte file with the real original already in trash
 * — permanently, on a container change, because the pre-flight refuses every
 * retry. A crash here leaves only a hidden, empty lock file.
 *
 * Reclaiming an abandoned lock is a COMPARE-AND-SWAP, not an unlink followed
 * by a create. Those are two syscalls with an await between them: a second
 * worker's unlink can land after the first worker's create, deleting a live
 * reservation and admitting them both. `rename(2)` is the atomic primitive
 * here — exactly one racer can move the abandoned file aside, and the losers
 * get `ENOENT` and back off.
 */
const reserveDestination = async (input: {
  finalPath: string;
  openExclusive: OpenExclusiveFn;
  renameFile: RenameFileFn;
  unlinkFile: UnlinkFileFn;
  nowMs: () => number;
  note?: (text: string) => void;
}): Promise<HeldReservation> => {
  const reservationPath = reservationPathFor(input.finalPath);

  const claim = async (): Promise<HeldReservation> => {
    await input.openExclusive(reservationPath);
    const stats = await lstat(reservationPath);
    return { path: reservationPath, dev: stats.dev, ino: stats.ino };
  };

  try {
    return await claim();
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
  }

  const abandoned = await lstat(reservationPath).catch(() => null);
  if (
    abandoned === null ||
    abandoned.size > 0 ||
    input.nowMs() - abandoned.mtimeMs < RESERVATION_STALE_MS
  ) {
    // Held by a worker that is alive, or gone before we could look: either
    // way this destination is not ours to take.
    throw eexistAt(input.finalPath);
  }

  // Compare-and-swap: whoever renames the abandoned reservation away wins the
  // right to reclaim it. Everyone else gets ENOENT and must back off.
  const displaced = `${reservationPath}.${randomUUID()}`;
  try {
    await input.renameFile(reservationPath, displaced);
  } catch {
    throw eexistAt(input.finalPath);
  }
  await input.unlinkFile(displaced).catch(() => {});
  input.note?.(
    `Reclaimed an abandoned reservation at "${reservationPath}", left behind by a run that ` +
      `did not finish.`,
  );
  // Still an exclusive create: another worker may have claimed the freed name
  // between the swap and here, and if so this throws EEXIST and backs off.
  return await claim();
};

/**
 * Release a reservation, but only if it is still the one this worker created.
 *
 * Comparing `(device, inode)` rather than the path: if this reservation was
 * reclaimed as abandoned while the move ran, the file now at that path belongs
 * to another worker, and deleting it would break the lock it is relying on —
 * and produce a "delete it by hand" message about a file that is not ours.
 */
const releaseReservation = async (input: {
  reservation: HeldReservation;
  unlinkFile: UnlinkFileFn;
  note?: (text: string) => void;
}): Promise<void> => {
  const current = await lstat(input.reservation.path).catch(() => null);
  if (current === null) return;
  if (current.dev !== input.reservation.dev || current.ino !== input.reservation.ino) return;
  await input.unlinkFile(input.reservation.path).catch((cause: unknown) => {
    input.note?.(
      `The reservation at "${input.reservation.path}" could not be removed ` +
        `(${messageOf(cause)}); delete it by hand.`,
    );
  });
};

/**
 * Create `to` as a second name for `from`, failing if `to` already exists.
 *
 * `rename(2)` replaces an existing destination silently, which is what makes
 * every check-then-rename a way to destroy a file that appeared in between.
 * Both branches here are therefore exclusive:
 *
 *  - `link(2)` fails `EEXIST` atomically and is same-device by construction.
 *  - Where linking is unavailable, a hidden reservation derived from the
 *    destination serves as the lock (see {@link reserveDestination}), and the
 *    rename happens while it is held. The `exists` check under that lock is
 *    not a check-then-act race: no other worker can be between the two lines,
 *    because no other worker holds the reservation. It is there to catch a
 *    file that something OUTSIDE trawlarr put at the destination.
 */
const createExclusively = async (input: {
  from: string;
  to: string;
  linkFile: LinkFileFn;
  renameFile: RenameFileFn;
  unlinkFile: UnlinkFileFn;
  openExclusive: OpenExclusiveFn;
  nowMs: () => number;
  note?: (text: string) => void;
  noteLinkFallback?: (text: string) => void;
}): Promise<'linked' | 'renamed'> => {
  try {
    await input.linkFile(input.from, input.to);
    return 'linked';
  } catch (error) {
    const code = codeOf(error);
    // The caller decides what an occupied destination or a device boundary
    // means; only "hardlinking is unavailable here" is handled below.
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
    input.noteLinkFallback?.(
      `Hardlinking is unavailable here (${code}), so destinations are being claimed with ` +
        `an exclusive reservation instead. This is expected on SMB/CIFS, exFAT and FUSE ` +
        `mounts, and whenever this process does not own the media it is replacing.`,
    );
  }

  const reservation = await reserveDestination({
    finalPath: input.to,
    openExclusive: input.openExclusive,
    renameFile: input.renameFile,
    unlinkFile: input.unlinkFile,
    nowMs: input.nowMs,
    note: input.note,
  });
  // Keep the reservation visibly alive while the move runs, so a rename that
  // blocks for a long time on a hung mount is not mistaken for a dead worker.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(reservation.path, now, now).catch(() => {});
  }, RESERVATION_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    // Not a check-then-act race: no other worker can be between these two
    // lines, because no other worker holds the reservation. It is here to
    // catch a file something OUTSIDE trawlarr put at the destination.
    if (await exists(input.to)) throw eexistAt(input.to);
    await input.renameFile(input.from, input.to);
  } finally {
    clearInterval(heartbeat);
    await releaseReservation({
      reservation,
      unlinkFile: input.unlinkFile,
      note: input.note,
    });
  }
  return 'renamed';
};

/**
 * Move `from` to `to` without ever overwriting `to`. The inode is preserved
 * either way, so a file's `(device, inode)` identity survives the move — which
 * is what lets the ledger follow an original into the trash.
 *
 * `onSourceRemovalFailure` decides what happens when the destination was
 * created but the old name could not be removed, which leaves the file under
 * two names:
 *
 *  - `'rollback'` removes the name just created, returning the file to a
 *    single link and failing cleanly. Used for moves INTO trash and into the
 *    library, because a library file silently left at `nlink=2` is refused by
 *    the hardlink guard on every subsequent run — trawlarr blaming the user
 *    for a link trawlarr made, with nothing purging trash to undo it.
 *  - `'keep'` keeps the destination and reports the leftover. Used when
 *    restoring an original: having the file back at its own path matters more
 *    than a stray link in the trash, and rolling back would mean abandoning
 *    the restore entirely.
 */
const moveExclusively = async (input: {
  from: string;
  to: string;
  linkFile: LinkFileFn;
  renameFile: RenameFileFn;
  unlinkFile: UnlinkFileFn;
  openExclusive: OpenExclusiveFn;
  nowMs: () => number;
  onSourceRemovalFailure?: 'rollback' | 'keep';
  note?: (text: string) => void;
  noteLinkFallback?: (text: string) => void;
}): Promise<void> => {
  if ((await createExclusively(input)) === 'renamed') return; // rename consumed the old name
  try {
    await input.unlinkFile(input.from);
  } catch (error) {
    if (input.onSourceRemovalFailure === 'keep') {
      input.note?.(
        `"${input.to}" is in place, but "${input.from}" could not be removed ` +
          `(${messageOf(error)}), so the file currently has two names. Deleting ` +
          `"${input.from}" returns it to one.`,
      );
      return;
    }
    let rolledBack = true;
    await input.unlinkFile(input.to).catch(() => {
      rolledBack = false;
    });
    throw new Error(
      rolledBack
        ? `"${input.from}" was linked to "${input.to}" but could not be removed from its ` +
            `old name (${messageOf(error)}). The extra link has been removed, so the file is ` +
            `back to a single name and nothing was lost.`
        : `"${input.from}" was linked to "${input.to}" and NEITHER could be removed ` +
            `(${messageOf(error)}). The file now has two names — "${input.from}" and ` +
            `"${input.to}" — and will be refused as hardlinked until one of them is deleted.`,
    );
  }
};

/**
 * Did the swap actually complete, despite the error that was raised?
 *
 * Decided on IDENTITY, not on size: two flows racing for the same destination
 * hold files of the same length far too often for a size comparison to mean
 * anything (a losing flow would otherwise see the winner's file and claim the
 * win). The destination counts as ours when it shares `(device, inode)` with
 * either source it could have come from:
 *
 *  - `newPath`, when the file was linked or renamed into place directly;
 *  - `stagedPath`, when it crossed a device boundary and therefore descends
 *    from the COPY. Checking only `newPath` made this function structurally
 *    incapable of returning true on the cross-device path — a different inode
 *    by construction, on a different device — so every failure after a
 *    successful cross-device install was reported as "did not land", and the
 *    runner restored the original over a media path already holding the
 *    correct new file.
 *
 * Size stands in only when neither source still exists, since there is then no
 * inode left to compare.
 */
const swapLanded = async (input: {
  newPath: string;
  stagedPath: string | null;
  finalPath: string;
  expectedSize: number;
}): Promise<boolean> => {
  let destination;
  try {
    destination = await lstat(input.finalPath);
  } catch {
    return false;
  }

  const sources = [input.newPath, ...(input.stagedPath === null ? [] : [input.stagedPath])];
  let anySourceExists = false;
  for (const source of sources) {
    const stats = await lstat(source).catch(() => null);
    if (stats === null) continue;
    anySourceExists = true;
    if (stats.dev === destination.dev && stats.ino === destination.ino) return true;
  }

  return anySourceExists ? false : destination.size === input.expectedSize;
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
  unlinkFile: UnlinkFileFn;
  openExclusive: OpenExclusiveFn;
  note?: (text: string) => void;
  noteLinkFallback?: (text: string) => void;
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
        unlinkFile: input.unlinkFile,
        openExclusive: input.openExclusive,
        nowMs: () => input.nowMs,
        note: input.note,
        noteLinkFallback: input.noteLinkFallback,
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
 * Re-stat the replacement and describe it on the file object.
 *
 * The re-stat is the point: nothing else does one, so without it every size
 * the flow reports — `file_size`, `oldSize`, `newSize` — would still describe
 * the pre-transcode file and every size-comparison plugin downstream would
 * compute a saving of exactly zero. Sizes cross the plugin boundary in
 * MEGABYTES while trawlarr stores bytes (see `toPluginFileObject`); anything
 * persisting them back must round to whole bytes, because the round-trip is
 * floating point.
 *
 * Used by the success route AND by the "landed but left hardlinked" failure
 * route: both end with a real file at `finalPath`, and a downstream node must
 * not read a container or a size belonging to the file this one replaced.
 */
const describeReplacement = async (input: {
  args: PluginInputArgs;
  finalPath: string;
  originalSizeBytes: number;
  fallbackStats: FileStats;
  statFile: StatFileFn;
  say: (text: string) => void;
}): Promise<void> => {
  let finalStats: FileStats;
  try {
    finalStats = await input.statFile(input.finalPath);
  } catch (error) {
    // The swap happened; only the measurement failed. Report the truth on
    // disk rather than a stale size.
    input.say(
      `"${input.finalPath}" is in place, but its new size could not be read: ` +
        `${messageOf(error)}`,
    );
    finalStats = input.fallbackStats;
  }

  const file = input.args.inputFileObj;
  file._id = input.finalPath;
  file.file = input.finalPath;
  file.container = extname(input.finalPath).slice(1).toLowerCase();
  file.file_size = finalStats.size / BYTES_PER_MEGABYTE;
  file.newSize = finalStats.size / BYTES_PER_MEGABYTE;
  file.oldSize = input.originalSizeBytes / BYTES_PER_MEGABYTE;
  input.say(
    `"${input.finalPath}" now holds the replacement: ` +
      `${input.originalSizeBytes} bytes -> ${finalStats.size} bytes.`,
  );
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
    const unlinkFile: UnlinkFileFn = input.unlinkFile ?? ((path) => unlink(path));
    const openExclusive: OpenExclusiveFn =
      input.openExclusive ??
      (async (path) => {
        const handle = await open(path, 'wx');
        try {
          await handle.close();
        } catch (error) {
          // A close that rejects would otherwise orphan the reservation with
          // nothing holding a reference to clean it up.
          await unlink(path).catch(() => {});
          throw error;
        }
      });
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
        // Every move takes the fallback on such a deployment, and every trash
        // name retried inside one. Said once per file rather than three times.
        let linkFallbackNoted = false;
        const noteLinkFallback = (text: string) => {
          if (linkFallbackNoted) return;
          linkFallbackNoted = true;
          say(text);
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
            unlinkFile,
            openExclusive,
            note: say,
            noteLinkFallback,
          });
        } catch (error) {
          // Usually the original never moved and there is nothing to undo. But
          // a link that succeeded, an unlink that failed and a rollback that
          // also failed leaves it with a twin in trash — reporting that as a
          // clean no-op would hide the state that makes every later run refuse
          // this file.
          const stranded = await input
            .statFile(originalPath)
            .then((stats) => stats.nlink > 1)
            .catch(() => false);
          return refuse(
            stranded
              ? `the original could not be moved to "${trashDir}" (${messageOf(error)}), and ` +
                  `it is now reachable under more than one name, so it will be refused as ` +
                  `hardlinked until the duplicate under "${trashDir}" is deleted.`
              : `the original could not be moved to "${trashDir}" (${messageOf(error)}). ` +
                  `It is still at its own path and nothing was changed.`,
            originalPath,
          );
        }
        say(
          `Original moved to trash: "${trashPath}" (kept until the retention sweep purges ` +
            `it; the timestamp in that name is what the sweep ages it by).`,
        );

        const restoreOriginal = async (): Promise<void> => {
          try {
            // Exclusive, like every other move here: if anything claimed the
            // original's path during the swap window, restoring over it would
            // destroy that file instead.
            await moveExclusively({
              from: trashPath,
              to: originalPath,
              linkFile,
              renameFile,
              unlinkFile,
              openExclusive,
              nowMs: input.nowMs,
              // Being back at its own path is what matters here; a leftover
              // link in the trash is reported, not treated as a failure.
              onSourceRemovalFailure: 'keep',
              note: say,
              noteLinkFallback,
            });
            say(`Restored the original to "${originalPath}".`);
          } catch (error) {
            say(
              `URGENT: the original could not be restored to "${originalPath}" ` +
                `(${messageOf(error)}). It is intact at "${trashPath}" — move it back by hand.`,
            );
          }
        };

        const swapState: { stagedPath: string | null } = { stagedPath: null };
        try {
          await swapIntoPlace({
            newPath,
            finalPath,
            state: swapState,
            renameFile,
            crossDeviceError,
            allowCrossDevice: booleanInput(args.inputs.allowCrossDevice, true),
            linkFile,
            unlinkFile,
            openExclusive,
            nowMs: input.nowMs,
            say,
            noteLinkFallback,
          });
        } catch (error) {
          // The move can complete even though the call reported failure — the
          // destination is created first and only then is the old name
          // removed, so a cleanup that fails after a successful create leaves
          // the replacement DONE. Ask the filesystem rather than assume:
          // reporting failure here would be a lie that also sends
          // restoreOriginal into an EEXIST and logs an URGENT about a file
          // sitting exactly where it belongs.
          const landed = await swapLanded({
            newPath,
            stagedPath: swapState.stagedPath,
            finalPath,
            expectedSize: newStats.size,
          });
          if (!landed) {
            say(`Replacement failed: ${messageOf(error)}`);
            await restoreOriginal();
            return {
              outputNumber: 2,
              outputFileObj: { _id: originalPath },
              variables: args.variables,
            };
          }
          say(
            `The new file is in place at "${finalPath}", but cleaning up afterwards failed: ` +
              `${messageOf(error)}`,
          );
          // The replacement landed, but if it landed carrying an extra link
          // then the hardlink guard will refuse this file on every future run
          // — the same dead end a failed trash-move rollback creates. Leaving
          // that behind is not a success, whatever the bytes at the path say.
          const leftLinked = await input
            .statFile(finalPath)
            .then((stats) => stats.nlink > 1)
            .catch(() => false);
          if (leftLinked) {
            say(
              `"${finalPath}" now has more than one name, so it will be refused as ` +
                `hardlinked until the duplicate is deleted. Reporting this as a failure ` +
                `rather than leaving a file that cannot be processed again.`,
            );
            // Described as it actually is on disk: a downstream node on output
            // 2 must not read a container and sizes belonging to the file this
            // one replaced.
            await describeReplacement({
              args,
              finalPath,
              originalSizeBytes: originalStats.size,
              fallbackStats: newStats,
              statFile: input.statFile,
              say,
            });
            return {
              outputNumber: 2,
              outputFileObj: { _id: finalPath },
              variables: args.variables,
            };
          }
        }

        await describeReplacement({
          args,
          finalPath,
          originalSizeBytes: originalStats.size,
          fallbackStats: newStats,
          statFile: input.statFile,
          say,
        });

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
  unlinkFile: UnlinkFileFn;
  openExclusive: OpenExclusiveFn;
  nowMs: () => number;
  crossDeviceError: CrossDeviceErrorFn;
  allowCrossDevice: boolean;
  say: (text: string) => void;
  noteLinkFallback: (text: string) => void;
  /** Filled in when the cross-device path stages a copy, so a failure
   * afterwards can still be recognised as a completed replacement. */
  state: { stagedPath: string | null };
}): Promise<void> => {
  if (canonicalPath(input.newPath) === canonicalPath(input.finalPath)) return; // already there
  try {
    await moveExclusively({
      from: input.newPath,
      to: input.finalPath,
      linkFile: input.linkFile,
      renameFile: input.renameFile,
      unlinkFile: input.unlinkFile,
      openExclusive: input.openExclusive,
      nowMs: input.nowMs,
      note: input.say,
      noteLinkFallback: input.noteLinkFallback,
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
  input.state.stagedPath = stagedPath;
  try {
    await copyFile(input.newPath, stagedPath);
    await moveExclusively({
      from: stagedPath,
      to: input.finalPath,
      linkFile: input.linkFile,
      renameFile: input.renameFile,
      unlinkFile: input.unlinkFile,
      openExclusive: input.openExclusive,
      nowMs: input.nowMs,
      note: input.say,
      noteLinkFallback: input.noteLinkFallback,
    });
  } catch (error) {
    await input.unlinkFile(stagedPath).catch((cause: unknown) => {
      // An orphaned full-size copy in the library directory is a silent
      // disk-filler; naming it is the difference between a stray file someone
      // can delete and one nobody knows about.
      input.say(
        `The cross-device staging copy at "${stagedPath}" could not be removed ` +
          `(${messageOf(cause)}); delete it by hand.`,
      );
    });
    if (codeOf(error) === 'EEXIST') {
      throw new Error(
        `"${input.finalPath}" was claimed by something else while this replacement was in ` +
          `progress. Refusing to overwrite it.`,
      );
    }
    throw error;
  }
  // The staged source is now a duplicate of a file that lives in the library.
  await input.unlinkFile(input.newPath).catch((cause: unknown) => {
    input.say(
      `The new file at "${input.newPath}" was copied into place but could not be removed ` +
        `from staging (${messageOf(cause)}); it is a full-size duplicate, delete it by hand.`,
    );
  });
};
