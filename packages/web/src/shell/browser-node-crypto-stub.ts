/**
 * A stand-in for `node:crypto`, aliased onto that specifier in
 * `vite.config.ts` — never meant to run.
 *
 * Task 7 made `packages/web` depend on `@trawlarr/core` for the first time
 * (`diffFlowDefinitions`/`isEmptyDiff`/`FlowDefinition`, see
 * `flow-version-model.ts` and `FlowCompare.tsx`). `@trawlarr/core`'s index
 * is one barrel (`export * from …` for every module, `canonical-json.ts`
 * included), so importing anything from it makes Rollup statically bind
 * EVERY module the barrel re-exports — including `canonical-json.ts`'s
 * `import { createHash } from 'node:crypto'` — regardless of whether this
 * app's screens ever call `sha256Hex` (they don't; that is the daemon's own
 * file-signature hashing). Vite externalises Node built-ins for the browser
 * with an empty stub that exports nothing, so binding `createHash` against
 * it failed the build outright, before tree-shaking ever got a chance to
 * drop the unused code.
 *
 * This file exists only to give that binding something to resolve to. If it
 * is ever actually called, that is a bug — this build has no working hash
 * primitive and does not need one.
 */
export const createHash = (): never => {
  throw new Error(
    'node:crypto is not available in the browser build — this call should be unreachable.',
  );
};
