import { defineConfig } from 'vite';

export default defineConfig({
  // NO `@vitejs/plugin-react`. That plugin exists to run Babel for React Fast
  // Refresh, and it drags in @babel/core -> browserslist -> caniuse-lite,
  // whose licence is CC-BY-4.0 and fails `pnpm audit:licenses`. The rule this
  // repo follows is to drop the offending dependency rather than widen the
  // allow-list, and the cost is small and confined to `pnpm dev`: esbuild
  // performs the JSX transform for both dev and build, and a component edit
  // reloads the page instead of hot-swapping.
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // `pnpm --filter @trawlarr/web dev` proxies to a daemon on the default
    // port, so the dev server and the built bundle see the same origin-
    // relative API paths and there is one code path, not two.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8265', ws: true },
    },
  },
});
