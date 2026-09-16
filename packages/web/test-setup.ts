/**
 * Setup for the `web` vitest project (see `vitest.workspace.ts`).
 *
 * Lives at the package root, NOT under `src/` or `test/`: both of those are
 * globbed by `tsconfig.typecheck.json`, which type-checks with `lib: ES2023`
 * and no DOM, and this file's imports only make sense with one.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only registers its own auto-cleanup when a global
// `afterEach` exists, and this repo runs vitest WITHOUT `globals: true`. Left
// to itself, every test would render into the same document as the last one
// and `getByRole` would find two of everything.
afterEach(() => {
  cleanup();
});
