import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'plan/**',
      'test/integration/backstage/apps/**',
      'dist/**',
      '.test-dist/**',
      'node_modules/**',
      'coverage/**',
      '.agents/**',
      '.codex/**',
      '.aws/**',
      '.artifacts/**',
      '.vscode-test/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // Engine decisions read time through an injected `Clock` (src/base/clock.ts), never directly.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Read wall time through an injected Clock (src/base/clock.ts).',
        },
        {
          object: 'performance',
          property: 'now',
          message: 'Read monotonic time through an injected Clock (src/base/clock.ts).',
        },
      ],
    },
  },
  {
    // The real-time allowlist. Each file measures real elapsed time on purpose:
    // - src/base/clock.ts: the systemClock implementation.
    // - src/runtime/cel/pool.ts: worker supervision with real timers across the worker boundary.
    // - src/parsing/budget.ts: cooperative yielding by real elapsed CPU time.
    // - src/compatibility/adapter.ts: the native-call yield loop, by real elapsed CPU time.
    files: [
      'src/base/clock.ts',
      'src/runtime/cel/pool.ts',
      'src/parsing/budget.ts',
      'src/compatibility/adapter.ts',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);
