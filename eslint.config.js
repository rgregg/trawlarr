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
);
