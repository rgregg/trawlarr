import { dirname, isAbsolute, resolve } from 'node:path';
import type { LibraryRecord } from '../db/library-repo.js';
import { createSubtreeMatcher } from '../fs/path-contains.js';
import { reservedDirsForLibrary } from '../library/paths.js';

/** A scope path a scan of this library must not be given. */
export class ScopeError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ScopeError';
    this.path = path;
  }
}

const lexicalPath = (path: string): string => resolve(path);

/**
 * The first library with a root that contains `path`, by string comparison
 * alone. A request handler finds the library for a webhook with this: a
 * canonical lookup would stat every root on the daemon's only thread.
 */
export const libraryContaining = (
  libraries: readonly LibraryRecord[],
  path: string,
): LibraryRecord | undefined =>
  libraries.find((candidate) =>
    createSubtreeMatcher({
      roots: candidate.roots,
      subtrees: candidate.roots,
      canonicalise: lexicalPath,
    })(path),
  );

/**
 * The scope paths of one scan, normalised and checked against its library.
 *
 * A scoped scan stats, probes and may mark rows missing under whatever it is
 * handed, and the paths arrive from outside: a webhook, an API caller. So a
 * path is refused unless it is absolute, free of `..`, inside one of the
 * library's roots, and outside its reserved directories — the same boundary
 * the full walk never crosses, stated up front instead of discovered by it.
 *
 * Existence is NOT required. A deleted file is reported by the path that is
 * now gone.
 *
 * All-or-nothing: the first unacceptable path throws, naming it. Quietly
 * dropping one would have the caller believe it had been scanned.
 *
 * The one thing that IS dropped is a path lying under another path of the same
 * scope, and only after it has passed every check above. It is still scanned:
 * the path that covers it is walked to the bottom, and the missing pass
 * considers every row at or under a scope path. A watcher burst for a new
 * folder names the folder, each subfolder and each file, and kept as given
 * that walked the same subtree once per level. Compared as spelled, like the
 * duplicate check — two spellings of one folder are both kept, which costs a
 * second walk and nothing else.
 */
export const validateScope = (input: {
  library: LibraryRecord;
  paths: readonly string[];
  /**
   * Compare path strings only, reading nothing from the filesystem.
   *
   * For a request handler: it runs on the daemon's only thread, and a
   * synchronous realpath of a network directory per webhook is the stall
   * removed from the watcher and the walk (PRs #68 and #69). The cost: a path
   * spelled through a symlink alias of a root is not recognised here. The
   * scan that follows re-validates canonically, so it stays the authority.
   */
  lexical?: boolean;
  /**
   * How the library's roots and reserved directories are canonicalised, for a
   * caller that read them ahead of time (`canonicalisePathsOnce`): the scan,
   * which validates on the stack of whoever requested it and must not read the
   * filesystem synchronously there either. Unlike `lexical` this loses
   * nothing — an aliased root is still recognised. `lexical` wins if both are
   * given. With neither, each root and reserved directory is read
   * synchronously, once.
   */
  canonicalise?: (path: string) => string;
}): string[] => {
  const { library } = input;
  const canonicalise = input.lexical === true ? lexicalPath : input.canonicalise;
  const inRoots = createSubtreeMatcher({
    roots: library.roots,
    subtrees: library.roots,
    ...(canonicalise === undefined ? {} : { canonicalise }),
  });
  const inReserved = createSubtreeMatcher({
    roots: library.roots,
    subtrees: reservedDirsForLibrary(library),
    ...(canonicalise === undefined ? {} : { canonicalise }),
  });

  const accepted = new Set<string>();
  for (const path of input.paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new ScopeError(String(path), `"${String(path)}" is not an absolute path.`);
    }
    if (path.split('/').includes('..')) {
      throw new ScopeError(path, `"${path}" contains a ".." segment.`);
    }
    const normalised = resolve(path);
    if (!inRoots(normalised)) {
      throw new ScopeError(
        path,
        `"${path}" is not inside any root of library "${library.name}" (roots: ` +
          `${library.roots.join(', ')}).`,
      );
    }
    if (inReserved(normalised)) {
      throw new ScopeError(
        path,
        `"${path}" is inside a directory trawlarr reserves for its own staging and trash, ` +
          `which is never scanned.`,
      );
    }
    accepted.add(normalised);
  }

  // By each path's own ancestors rather than by comparing every pair: a
  // request may name thousands of paths, and this runs in a request handler.
  const isCovered = (path: string): boolean => {
    let current = path;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) return false;
      if (accepted.has(parent)) return true;
      current = parent;
    }
  };
  return [...accepted].filter((path) => !isCovered(path));
};
