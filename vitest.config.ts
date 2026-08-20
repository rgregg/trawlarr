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
    typecheck: {
      // Each package's build tsconfig excludes *.test.ts so `dist/` never
      // contains tests. That means `tsc --build` never sees test files, so
      // structural "don't rename this field" guards written as `.test.ts`
      // literals are inert unless something else type-checks them. This
      // runs `tsc` over the same test files vitest executes at runtime, so
      // a type error (e.g. an object literal assigned the wrong shape)
      // fails `pnpm test` just like a failed assertion would.
      enabled: true,
      include: [
        'packages/*/src/**/*.test.ts',
        'packages/*/test/**/*.test.ts',
        'test-support/**/*.test.ts',
        'docker/**/*.test.ts',
      ],
      tsconfig: './tsconfig.typecheck.json',
    },
  },
});
