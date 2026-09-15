/**
 * The Nodes tab's data shape and pure logic, parsed once and in one place —
 * `Config.tsx`'s split for the Configure screen's other tabs (see
 * `config-model.ts`'s own comment): `Nodes.tsx` is a thin renderer over this,
 * so every branch worth asserting lives here where a test can reach it with
 * no DOM.
 */

/**
 * `GET /nodes`'s response, field for field as `packages/server/src/api/routes/nodes.ts`
 * reports it (`toNodeResource` plus the per-row `local`/`online`/`running`
 * it joins on). Two fields the task brief's sketch got wrong, corrected
 * against the route that actually ships:
 *
 * - `running` is `string[]` (job ids), not objects with `path`/`percent` —
 *   the route joins on `job.node_id` alone and invents nothing else. Only
 *   the running COUNT is shown for that reason; a path or a percentage here
 *   would be display code fabricating data the API never sent.
 * - `schedule` is unconditionally present (not optional) — every node row
 *   carries a schedule (`DEFAULT_SCHEDULE` when never set).
 */
export interface NodeResource {
  id: string;
  name: string;
  local: boolean;
  online: boolean;
  revokedAt: number | null;
  enrolled: boolean;
  enrollExpiresAt: number | null;
  lastSeenAt: number | null;
  buildVersion: string | null;
  hardwareTypes: string[];
  hardwareCaps: Record<string, number>;
  pathMap: { serverPath: string; nodePath: string }[];
  /** Why the stored map is invalid; a node with one is offered no work. */
  pathMapError: string | null;
  paused: boolean;
  schedule: { baseCounts: { transcode: number; health: number } } & Record<string, unknown>;
  libraries: { libraryId: string; reachable: boolean; detail: string }[];
  running: string[];
}

/**
 * `POST /nodes`, `PUT /nodes/:id` and `POST /nodes/:id/revoke` all answer
 * with the bare `toNodeResource(record)` shape — `NodeResource` MINUS
 * `local`/`online`/`running`, which only the `GET /nodes` LIST handler
 * joins on (`packages/server/src/api/routes/nodes.ts`, the per-row spread
 * after `toNodeResource(record)` in its `.map`). A mutation response is
 * therefore never a valid list row: reaching for `.running.length` (or
 * `.local`/`.online`) on one throws, which is exactly what crashed Add
 * node / Save workers / Toggle paused / Save paths / Revoke before this
 * type existed to keep the two shapes apart. `Nodes.tsx` types every
 * mutation's response as `NodeMutationResponse` and reloads `GET /nodes`
 * for anything that touches a row.
 */
export type NodeMutationResponse = Omit<NodeResource, 'local' | 'online' | 'running'>;

export type NodeStatusLabel = 'Online' | 'Offline' | 'Revoked' | 'Waiting to join';

/**
 * A revoked node is reported as revoked regardless of anything else it
 * reports: a revoke does not stop a node's process, only its ability to
 * authenticate, so a revoked node can still show up "online" on the wire
 * and showing that as "Online" would suggest it is still doing work for
 * this daemon when it categorically is not.
 *
 * "Waiting to join" comes next: an unenrolled node has never proven it
 * holds a secret, so "Online"/"Offline" — both claims about a node this
 * daemon has actually talked to as itself — do not apply yet.
 */
export const nodeStatus = (node: NodeResource): NodeStatusLabel => {
  if (node.revokedAt !== null) return 'Revoked';
  if (!node.enrolled) return 'Waiting to join';
  return node.online ? 'Online' : 'Offline';
};

/**
 * Path-map rows with a stable React key, derived rather than stored: the
 * server has no id for a mapping entry, and index alone breaks identity
 * across a reorder mid-edit (React would then reuse a row's DOM node for a
 * different pair, which briefly shows the wrong node path while a field is
 * still focused). `serverPath`/`nodePath` are validated unique server-side
 * (see `validatePathMapRows` below, mirroring `@trawlarr/core`'s
 * `validatePathMap`), so the pair is a safe key on its own.
 */
export const pathMapRows = (
  map: NodeResource['pathMap'],
): { serverPath: string; nodePath: string; key: string }[] =>
  map.map((entry) => ({ ...entry, key: `${entry.serverPath}\u0000${entry.nodePath}` }));

const isAbsoluteNoDotDot = (path: string): boolean => {
  if (!path.startsWith('/')) return false;
  return !path.split('/').some((segment) => segment === '.' || segment === '..');
};

/**
 * Mirrors `@trawlarr/core`'s `validatePathMap` rules — absolute paths, no
 * `.`/`..` segments, no server path listed twice — so a bad row is caught
 * on screen before the round trip to `PUT /nodes/:id` that would otherwise
 * be the first place it is rejected. The server's own `validatePathMap` is
 * still the source of truth; this is a UI-side echo of the same rules, not
 * a second implementation core depends on.
 */
export const validatePathMapRows = (
  rows: { serverPath: string; nodePath: string }[],
): string | null => {
  const seenServer = new Set<string>();
  for (const row of rows) {
    if (!isAbsoluteNoDotDot(row.serverPath)) {
      if (!row.serverPath.startsWith('/')) {
        return `Server path "${row.serverPath}" must be an absolute path.`;
      }
      return `Server path "${row.serverPath}" must not contain "." or ".." segments.`;
    }
    if (!isAbsoluteNoDotDot(row.nodePath)) {
      if (!row.nodePath.startsWith('/')) {
        return `This node's path "${row.nodePath}" must be an absolute path.`;
      }
      return `This node's path "${row.nodePath}" must not contain "." or ".." segments.`;
    }
    if (seenServer.has(row.serverPath)) {
      return `Server path "${row.serverPath}" is listed more than once.`;
    }
    seenServer.add(row.serverPath);
  }
  return null;
};

/**
 * The two commands the "add a node" dialog shows once, over the token it
 * just issued.
 *
 * The image tag is `:sha-<short commit>` — what CI publishes for every build
 * (`docker/metadata-action`'s 7-character short sha) — and `:main` when the
 * server reports no commit. Never `:<version>`: a main build's version is
 * `0.0.0`, which is never pushed, so that command failed as pasted. The
 * library volume is a visible placeholder because only the operator knows
 * where this machine mounts the library; without any `-v` for it the node
 * probes every library as unreachable.
 */
export const joinCommand = (input: {
  serverUrl: string;
  token: string;
  commit: string | null;
}): { docker: string; cli: string } => {
  const tag =
    input.commit === null || input.commit === '' ? 'main' : `sha-${input.commit.slice(0, 7)}`;
  return {
    docker:
      `docker run -d --name trawlarr-node -e TRAWLARR_MODE=node ` +
      `-e TRAWLARR_SERVER=${input.serverUrl} -e TRAWLARR_NODE_TOKEN=${input.token} ` +
      `-v <library-path>:<path-this-node-uses> -v trawlarr-node:/config ` +
      `ghcr.io/rgregg/trawlarr:${tag}`,
    cli: `trawlarr node --server ${input.serverUrl} --token ${input.token}`,
  };
};

/**
 * Which of a node's libraries it cannot reach, and why — the line the
 * detail panel prints beside each one. `unreachable`/`unmapped` never
 * appear in the copy itself (see the task's ruling): the sentence is
 * "<library>: <detail>", and `detail` is the node's own probe reason.
 */
export const unreachableSummary = (
  node: NodeResource,
  libraryNames: Record<string, string>,
): string[] =>
  node.libraries
    .filter((probe) => !probe.reachable)
    .map((probe) => `${libraryNames[probe.libraryId] ?? probe.libraryId}: ${probe.detail}`);
