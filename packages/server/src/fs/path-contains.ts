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

/**
 * `pathContains(subtree, path)` for any of `subtrees`, for a caller that asks
 * about many paths under the same `roots` and cannot afford a filesystem call
 * per question.
 *
 * `pathContains` canonicalises both of its arguments every time, which is a
 * synchronous `lstat` of every segment of the path. The watcher asked it about
 * every event, and a replacement copying onto an NFS library produces a stream
 * of events for the file being written — each stat of which waits behind the
 * write. That ran on the daemon's only thread: the API and the event socket
 * froze for up to 29 seconds at a time, for as long as the copy lasted.
 *
 * So everything that needs the filesystem is read ONCE, here, and the returned
 * predicate is string comparison only. What `realpathSync` was buying per path
 * is recovered from the roots: a path handed to the predicate is spelled the
 * way its root was (it comes from a walk or a watch of that root, neither of
 * which follows a directory symlink below it), so swapping the root's spelling
 * for the root's canonical form canonicalises the path. A subtree is matched
 * under both its given spelling and its canonical one, because one that does
 * not exist yet has no canonical form to read.
 */
export const createSubtreeMatcher = (input: {
  roots: readonly string[];
  subtrees: readonly string[];
  /** Seam: a test counts the filesystem reads. */
  canonicalise?: (path: string) => string;
}): ((path: string) => boolean) => {
  const canonicalise = input.canonicalise ?? canonicalPath;
  const isUnder = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

  const subtrees = new Set<string>();
  for (const subtree of input.subtrees) {
    subtrees.add(resolve(subtree));
    subtrees.add(canonicalise(subtree));
  }
  const aliasedRoots = input.roots
    .map((root) => ({ spelled: resolve(root), canonical: canonicalise(root) }))
    .filter((root) => root.spelled !== root.canonical);

  const inSubtree = (path: string): boolean => {
    for (const subtree of subtrees) {
      if (isUnder(subtree, path)) return true;
    }
    return false;
  };

  return (path) => {
    const resolved = resolve(path);
    if (inSubtree(resolved)) return true;
    return aliasedRoots.some(
      (root) =>
        isUnder(root.spelled, resolved) &&
        inSubtree(root.canonical + resolved.slice(root.spelled.length)),
    );
  };
};
