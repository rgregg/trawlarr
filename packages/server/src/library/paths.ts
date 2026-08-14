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
 * source file. Every containment check here goes through this function.
 */
const contains = (parent: string, child: string): boolean => {
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
  const root = library.roots.find((candidate) => contains(candidate, resolvedFile));
  if (root === undefined) {
    throw new Error(
      `"${filePath}" is not under any root of library "${library.name}" (roots: ` +
        `${library.roots.join(', ')}). Cannot resolve a default staging/trash directory for it.`,
    );
  }
  return root;
};

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
    defaultSubdirs: ['.trawlarr', 'staging'],
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
    defaultSubdirs: ['.trawlarr', 'trash'],
  });

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
