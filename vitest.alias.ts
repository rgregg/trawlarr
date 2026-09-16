import { fileURLToPath } from 'node:url';

/**
 * `@trawlarr/*` resolved to SOURCE, not to `dist`, so `pnpm test` never needs
 * a build first. Declared here rather than inline in `vitest.config.ts`
 * because `vitest.workspace.ts` defines a second project that needs exactly
 * the same map, and two copies of it drift.
 */
export const workspaceAlias = Object.fromEntries(
  ['plugin-api', 'core', 'plugins-core', 'engine', 'server', 'web'].map((name) => [
    `@trawlarr/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url)),
  ]),
);
