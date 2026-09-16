/**
 * The version this build reports through `GET /system/version`, kept equal to
 * `packages/server/package.json` (asserted by `build-info.test.ts`; a release
 * tag must match that file before the image workflow publishes). A literal rather than a runtime read of
 * `package.json`: the built `dist/` is what a real install runs, and
 * resolving a sibling file from it is a path that breaks differently in a
 * bundle, a global install and a test.
 *
 * Its own module, with no imports, because a remote node reports it in its
 * `hello` and the node host may not reach `daemon.ts` — which opens the
 * database — through its import graph (see the module-graph guard in
 * `worker/agent-handle.test.ts`).
 */
export const DAEMON_VERSION = '0.0.0';
