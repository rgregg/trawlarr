import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Canonicalise `path` to its real, absolute form: normalises relative
 * segments and, when the path exists, follows symlinks so two different
 * spellings of the same location compare equal — a bind mount, a Docker
 * `/media -> /mnt/media` alias (the shape of essentially every containerised
 * media stack), or a case-insensitive volume all collapse to one canonical
 * path. Falls back to a plain `resolve` when the path does not exist yet
 * (a destination that hasn't been created), since `realpathSync` requires
 * the target to exist.
 *
 * Mirrors the helper of the same shape in
 * `packages/engine/src/executor/encode-target.ts`, written for the same
 * in-place-write incident this module's `pathContains` guards against: a
 * comparison that only `resolve()`s, without following symlinks, can be
 * defeated by exactly this kind of alias.
 */
export const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * Whether `child` is `parent` or a path underneath it, comparing
 * *canonicalised* path segments. Two hazards this guards against:
 *
 * 1. A plain `child.startsWith(parent)` treats "/library-old" as inside
 *    "/library" because they share a string prefix, without one directory
 *    containing the other — the reason this compares path *segments*
 *    (via a trailing separator boundary) rather than raw strings.
 * 2. A comparison that only `resolve()`s (segment-aware, but not
 *    canonical) is defeated by a symlink alias, or by two relative-path
 *    spellings of the same directory reaching it differently.
 *
 * Every containment check in this codebase should go through this
 * function rather than adding a second, weaker comparison.
 */
export const pathContains = (parent: string, child: string): boolean => {
  const resolvedParent = canonicalPath(parent);
  const resolvedChild = canonicalPath(child);
  return (
    resolvedChild === resolvedParent ||
    resolvedChild.startsWith(resolvedParent.endsWith(sep) ? resolvedParent : resolvedParent + sep)
  );
};
