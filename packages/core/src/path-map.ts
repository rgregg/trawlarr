/**
 * Server path <-> node path, for a node that mounts the library somewhere
 * else (spec: remote nodes, "Path mapping").
 *
 * Pure string work — core does no I/O, so whether the mapped path EXISTS is
 * the node's probe, not this. An unmapped path is `null`, never passed
 * through: a node that ran against the server's literal path would be
 * operating on whatever that path means on ITS disk.
 */
export interface PathMapping {
  serverPath: string;
  nodePath: string;
}

export class PathMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathMapError';
  }
}

const trimTrailing = (path: string): string =>
  path.length > 1 && path.endsWith('/') ? trimTrailing(path.slice(0, -1)) : path;

const checkAbsolute = (label: string, path: unknown): string => {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new PathMapError(`${label} must be an absolute path, got ${JSON.stringify(path)}.`);
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new PathMapError(`${label} must not contain "." or ".." segments: "${path}".`);
  }
  return trimTrailing(path);
};

export const validatePathMap = (map: unknown): PathMapping[] => {
  if (!Array.isArray(map)) throw new PathMapError('A path map must be a list.');
  const seenServer = new Set<string>();
  const seenNode = new Set<string>();
  const entries = map.map((entry: unknown, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const serverPath = checkAbsolute(
      `Entry ${String(index + 1)}: server path`,
      record['serverPath'],
    );
    const nodePath = checkAbsolute(`Entry ${String(index + 1)}: node path`, record['nodePath']);
    if (seenServer.has(serverPath)) {
      throw new PathMapError(`Server path "${serverPath}" is mapped more than once.`);
    }
    // `reportToServer` maps a node path back via `mapPath(..., 'toServer')`,
    // which picks the longest matching `nodePath` prefix — that lookup must
    // not depend on array order, so a duplicate `nodePath` (two server paths
    // claiming the same node path) is rejected here rather than silently
    // resolved by "whichever entry came first".
    if (seenNode.has(nodePath)) {
      throw new PathMapError(`Node path "${nodePath}" is mapped more than once.`);
    }
    seenServer.add(serverPath);
    seenNode.add(nodePath);
    return { serverPath, nodePath };
  });
  // Nesting has to be the same on both sides. With `/media/movies -> /mnt`
  // and `/media/tv -> /mnt/tv`, the server file `/media/movies/tv/x` maps to
  // `/mnt/tv/x`, and the longest-prefix lookup maps THAT back to
  // `/media/tv/x`: a report (and its replacement) would be recorded against
  // a different file than the one the node was sent.
  for (const a of entries) {
    for (const b of entries) {
      if (a === b) continue;
      const nodeNested = within(b.nodePath, a.nodePath);
      const serverNested = within(b.serverPath, a.serverPath);
      if (nodeNested !== serverNested) {
        const describe = (entry: PathMapping): string =>
          `"${entry.serverPath}" -> "${entry.nodePath}"`;
        throw new PathMapError(
          `Entries ${describe(b)} and ${describe(a)} nest differently on the server and the node, ` +
            `so a path under one could map back to the other. Nest them the same way on both sides.`,
        );
      }
    }
  }
  return entries;
};

const within = (root: string, path: string): boolean =>
  root === '/' || path === root || path.startsWith(`${root}/`);

export const mapPath = (
  map: readonly PathMapping[],
  path: string,
  direction: 'toNode' | 'toServer',
): string | null => {
  let best: { from: string; to: string } | null = null;
  for (const entry of map) {
    const from = direction === 'toNode' ? entry.serverPath : entry.nodePath;
    const to = direction === 'toNode' ? entry.nodePath : entry.serverPath;
    if (within(from, path) && (best === null || from.length > best.from.length)) {
      best = { from, to };
    }
  }
  if (best === null) return null;
  const rest = best.from === '/' ? path.slice(1) : path.slice(best.from.length + 1);
  if (path === best.from) return best.to;
  return best.to === '/' ? `/${rest}` : `${best.to}/${rest}`;
};
