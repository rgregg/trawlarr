import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { LibraryRecord } from '../db/library-repo.js';

/**
 * Thrown when a *configured* staging directory turns out to live on a
 * different device than the file it would stage. Replacement finishes with
 * an atomic `rename(2)`, which the kernel refuses across filesystems, so
 * this is a condition callers must detect and report — not something to
 * silently degrade into a copy. `resolveStagingDir` itself never throws
 * this: it only computes the path. Callers that are about to actually stage
 * a file should check `isSameFilesystem` against the result and raise this
 * error rather than fall back to a slow, non-atomic copy.
 */
export class CrossDeviceStagingError extends Error {
  constructor(input: { stagingDir: string; filePath: string }) {
    super(
      `Configured staging directory "${input.stagingDir}" is on a different filesystem than ` +
        `"${input.filePath}". Replacement requires an atomic rename, which cannot cross ` +
        `devices; point stagingDir at a directory on the same filesystem as the library root, ` +
        `or unset it to use the per-root default.`,
    );
    this.name = 'CrossDeviceStagingError';
  }
}

/**
 * Whether `child` is `parent` or a path underneath it, comparing resolved
 * path *segments* rather than raw strings.
 *
 * A plain `child.startsWith(parent)` is not sufficient: "/library-old" and
 * "/library" share a string prefix without one directory containing the
 * other. An in-place-write guard in this codebase once compared paths this
 * way and let a working-directory argument slip past it, overwriting a
 * source file. Every containment check in this codebase should go through
 * this function rather than adding a second, weaker comparison.
 */
export const pathContains = (parent: string, child: string): boolean => {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return (
    resolvedChild === resolvedParent ||
    resolvedChild.startsWith(resolvedParent.endsWith(sep) ? resolvedParent : resolvedParent + sep)
  );
};

/** Root of `library` whose directory tree actually contains `filePath`. */
const rootContaining = (library: LibraryRecord, filePath: string): string => {
  const resolvedFile = resolve(filePath);
  const root = library.roots.find((candidate) => pathContains(candidate, resolvedFile));
  if (root === undefined) {
    throw new Error(
      `"${filePath}" is not under any root of library "${library.name}" (roots: ` +
        `${library.roots.join(', ')}). Cannot resolve a default staging/trash directory for it.`,
    );
  }
  return root;
};

/**
 * Name of the hidden directory holding the default staging and trash
 * subdirectories under a library root. Exported as a single constant so
 * that everything trawlarr puts under it in the future — staging, trash,
 * or anything else — is pruned from library scans by construction, rather
 * than by remembering to list each subdirectory individually.
 */
export const RESERVED_DIR_NAME = '.trawlarr';

const resolveConfiguredOrDefault = (input: {
  library: LibraryRecord;
  filePath: string;
  configured: string | null;
  defaultSubdirs: readonly [string, string];
}): string => {
  if (input.configured !== null) return resolve(input.configured);
  const root = rootContaining(input.library, input.filePath);
  return join(root, ...input.defaultSubdirs);
};

/**
 * Directory replacement stages a rewritten copy in before the atomic rename
 * that swaps it into place. Defaults to a hidden directory under whichever
 * library root actually contains the file, so a multi-root library stages
 * beside the right filesystem and the rename stays atomic; a configured
 * `stagingDir` always wins.
 */
export const resolveStagingDir = (input: { library: LibraryRecord; filePath: string }): string =>
  resolveConfiguredOrDefault({
    library: input.library,
    filePath: input.filePath,
    configured: input.library.stagingDir,
    defaultSubdirs: [RESERVED_DIR_NAME, 'staging'],
  });

/**
 * Same rule as {@link resolveStagingDir}: a configured `trashDir` wins,
 * otherwise a hidden directory under the root that contains the file, kept
 * on the same device so moving a file there is a cheap, atomic rename
 * rather than a copy.
 */
export const resolveTrashDir = (input: { library: LibraryRecord; filePath: string }): string =>
  resolveConfiguredOrDefault({
    library: input.library,
    filePath: input.filePath,
    configured: input.library.trashDir,
    defaultSubdirs: [RESERVED_DIR_NAME, 'trash'],
  });

/**
 * Every directory a library scan must never descend into: the whole
 * `.trawlarr` reserved directory under each root (covering the default
 * staging and trash locations, and anything added under it later, by
 * construction) plus any explicitly configured `stagingDir`/`trashDir`,
 * wherever they happen to live.
 *
 * `resolveStagingDir`/`resolveTrashDir` take a single `filePath` because
 * they answer "where does *this* file's staging/trash directory live",
 * which only needs the one root containing it. Pruning a scan needs the
 * opposite: every reserved directory across every root, before any file
 * has been seen. Rather than force a fake `filePath` through the
 * per-file resolvers (or worse, re-deriving the default subdirs a second
 * time), this walks `library.roots` directly and applies the same
 * `RESERVED_DIR_NAME` constant those resolvers use.
 */
export const reservedDirsForLibrary = (library: LibraryRecord): string[] => {
  const dirs = new Set<string>();
  for (const root of library.roots) {
    dirs.add(join(resolve(root), RESERVED_DIR_NAME));
  }
  if (library.stagingDir !== null) dirs.add(resolve(library.stagingDir));
  if (library.trashDir !== null) dirs.add(resolve(library.trashDir));
  return [...dirs];
};

/** Creates `path` and any missing parents. A no-op if it already exists. */
export const ensureDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
};

/**
 * Nearest ancestor of `path` (possibly `path` itself) that currently
 * exists, for stat-ing the device of a destination that has not been
 * created yet.
 */
const nearestExistingAncestor = async (path: string): Promise<string> => {
  let current = resolve(path);
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current; // filesystem root; let the caller's stat surface the error
      current = parent;
    }
  }
};

/**
 * Whether `a` and `b` sit on the same device, i.e. whether moving between
 * them can be an atomic `rename(2)` rather than a copy. Neither path needs
 * to exist yet — a destination that doesn't exist is compared by its
 * nearest existing ancestor.
 */
export const isSameFilesystem = async (a: string, b: string): Promise<boolean> => {
  const [statA, statB] = await Promise.all([
    stat(await nearestExistingAncestor(a)),
    stat(await nearestExistingAncestor(b)),
  ]);
  return statA.dev === statB.dev;
};
