import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@trawlarr/plugin-api': pkg('plugin-api'),
      '@trawlarr/core': pkg('core'),
      '@trawlarr/engine': pkg('engine'),
      '@trawlarr/server': pkg('server'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
