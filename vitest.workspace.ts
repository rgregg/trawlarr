import { defineWorkspace } from 'vitest/config';
import { workspaceAlias } from './vitest.alias.js';

/**
 * Two environments, one `pnpm test`.
 *
 * Everything in this repo runs under `node` and must keep doing so: a DOM
 * environment silently replaces `globalThis.fetch`, `XMLHttpRequest`, timers
 * and `URL` with the window's own, and the engine's plugin-parity suites make
 * real HTTP calls through the ones Node provides. Running them in a DOM
 * produced 338 failures and two unhandled rejections the first time this
 * split was attempted, which is why the DOM environment is scoped as narrowly
 * as it can be: `packages/web/src/**\/*.test.tsx` and nothing else.
 *
 * The split is by EXTENSION, not directory — a component test lands in the
 * right environment by being named `.test.tsx`, and the existing
 * `packages/web/src/**\/*.test.ts` model tests stay in `node` untouched.
 *
 * The node half is `./vitest.config.ts` by reference rather than by `extends`:
 * an `extends`-ed project MERGES its parent's `include` rather than replacing
 * it, so the DOM project inherited the whole repo's test glob.
 */
export default defineWorkspace([
  './vitest.config.ts',
  {
    resolve: { alias: workspaceAlias },
    // esbuild does the JSX transform here exactly as it does for `vite build`
    // — see `packages/web/vite.config.ts` for why @vitejs/plugin-react is not
    // in this repo (its Babel dependency chain fails `pnpm audit:licenses`).
    esbuild: { jsx: 'automatic' },
    test: {
      name: 'web',
      include: ['packages/web/src/**/*.test.tsx'],
      // `happy-dom`, not `jsdom`: jsdom's `cssstyle` chain pulls
      // `@csstools/color-helpers` and
      // `@csstools/css-syntax-patches-for-csstree`, both declared `MIT-0`,
      // which fails `pnpm audit:licenses`. This repo's rule is to drop the
      // offending dependency rather than widen the allow-list (the same call
      // `vite.config.ts` records for caniuse-lite), and happy-dom is MIT with
      // no transitive dependencies at all.
      environment: 'happy-dom',
      setupFiles: ['./packages/web/test-setup.ts'],
    },
  },
]);
