import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@trawlarr/plugin-api': pkg('plugin-api'),
      '@trawlarr/core': pkg('core'),
      '@trawlarr/plugins-core': pkg('plugins-core'),
      '@trawlarr/engine': pkg('engine'),
      '@trawlarr/server': pkg('server'),
      '@trawlarr/web': pkg('web'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'test-support/**/*.test.ts',
      'docker/**/*.test.ts',
    ],
    environment: 'node',
    // NO `typecheck` PROJECT HERE, deliberately — see the `typecheck` script
    // in package.json.
    //
    // Each package's build tsconfig excludes `*.test.ts` so `dist/` never
    // contains tests, which means `tsc --build` never sees a test file and a
    // structural "don't rename this field" guard written as a `.test.ts`
    // literal would be inert. That check still runs; it just runs as its own
    // command over `tsconfig.typecheck.json` rather than as a vitest project.
    //
    // Why it moved: vitest's typecheck project needs an `include` glob, and
    // pointing it at the test files meant every file was collected twice —
    // once to run, once to type-check — so the reported totals were exactly
    // double the real ones. That miscount was read as evidence three times
    // across two sub-projects before anyone proved its cause.
  },
});
