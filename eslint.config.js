import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'cache/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'fs',
            'node:fs',
            'node:fs/promises',
            'child_process',
            'node:child_process',
            'http',
            'node:http',
            'https',
            'node:https',
            'node:net',
            'node:dgram',
          ],
          patterns: ['node:fs/*'],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '@trawlarr/core must not perform IO.' },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'core must receive nowMs as a parameter, not read the clock.',
        },
      ],
    },
  },
  {
    // `new Date(x).toISOString()` THROWS for NaN and for any magnitude past
    // ±8.64e15 ms, and in a React render a throw unmounts the whole tree. A
    // file whose `mtimeMs` was out of range — a number the daemon stores
    // exactly as `fs.stat()` reported it — turned every screen into a white
    // page with no message and no way back.
    //
    // `shell/time.ts` is the one place allowed to construct a Date, because
    // it is the one place that checks the value first. This is a lint rule
    // rather than a test for the same reason core's clock ban is: it has to
    // fire on the line someone is writing, not in a suite they might not run.
    files: ['packages/web/src/**/*.ts', 'packages/web/src/**/*.tsx'],
    ignores: ['packages/web/src/shell/time.ts', 'packages/web/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'Render an instant with formatTimestamp/toIsoInstant from shell/time.js — a bare Date can throw from toISOString and take the whole UI down.',
        },
      ],
    },
  },
);
