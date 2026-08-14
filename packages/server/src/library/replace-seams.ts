import { stat } from 'node:fs/promises';
import type { FindCompanionsFn, MoveCompanionsFn, StatFileFn } from '@trawlarr/engine';
import { findCompanions, moveCompanions } from '../fs/companions.js';

/**
 * The server-side implementations of the seams the Replace Original File
 * runner takes as parameters.
 *
 * The runner lives in `@trawlarr/engine` and cannot import this package: the
 * server depends on the engine (its worker assembles the node runners and
 * calls `runFlow`), so the reverse edge would be a cycle `tsc --build`
 * rejects. The cost of passing the functions in as parameters is that a
 * signature drift on either side would otherwise only show up as a runtime
 * failure inside the one node that destroys the user's file.
 *
 * These annotated bindings close that gap: `findCompanions` and
 * `moveCompanions` are checked against the engine's exported seam types at
 * compile time, so changing either shape fails the build instead of the
 * replacement. Wire these into `createReplaceOriginalRunner` rather than
 * passing the raw functions.
 */
export const findCompanionsSeam: FindCompanionsFn = findCompanions;

export const moveCompanionsSeam: MoveCompanionsFn = moveCompanions;

/**
 * `nlink` is the load-bearing field: it is how the runner refuses to replace a
 * hardlinked original, which would leave every other name for that file
 * pointing at the old content.
 */
export const statFileSeam: StatFileFn = async (path) => {
  const stats = await stat(path);
  return { size: stats.size, nlink: stats.nlink };
};
