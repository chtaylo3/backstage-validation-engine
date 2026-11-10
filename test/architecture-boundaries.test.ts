import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
void test('architecture checks reject adapter dependencies through aliases, barrels, type imports and module loaders', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-architecture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        baseUrl: '.',
        paths: { '@adapter/*': ['src/lsp/*'] },
      },
    }),
    'src/lsp/adapter.ts': 'export interface Adapter { value: string }',
    'src/shared/barrel.ts': "export type { Adapter } from '../lsp/adapter.js';",
    'src/contracts/reverse.ts':
      "import type { Adapter } from '@adapter/adapter'; export type Result = Adapter;",
    'src/runtime/reverse.ts': "export type { Adapter } from '../shared/barrel.js';",
    'src/core/dynamic.ts': "export const load = () => import('../lsp/adapter.js');",
    'src/providers/require.ts':
      "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('../lsp/adapter.js');",
    'src/providers/aliased-loader.ts':
      "import { createRequire as factory } from 'node:module'; const load = factory(import.meta.url); load('../lsp/adapter.js');",
    'src/runtime/namespace-loader.ts':
      "import * as modules from 'node:module'; const load = modules.createRequire(import.meta.url); load('../lsp/adapter.js');",
    'src/capabilities/reverse.ts': "export type { Adapter } from '../lsp/adapter.js';",
    'src/capabilities/host-reverse.ts': "export { adapter } from '../host/builtin.js';",
    'src/host/builtin.ts': 'export const adapter = 1;',
  };
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), contents);
  }
  const failure = await execute(process.execPath, [
    'scripts/architecture-boundaries.mjs',
    directory,
    '--no-exceptions',
  ]).then(
    () => assert.fail('Forbidden imports passed.'),
    (error: unknown) => error as { stderr: string },
  );
  for (const name of [
    'contracts/reverse',
    'runtime/reverse',
    'core/dynamic',
    'providers/require',
    'providers/aliased-loader',
    'runtime/namespace-loader',
    'capabilities/reverse',
    'capabilities/host-reverse',
  ])
    assert(failure.stderr.includes(name));
  for (const name of [
    'src/contracts/reverse.ts',
    'src/runtime/reverse.ts',
    'src/core/dynamic.ts',
    'src/providers/require.ts',
    'src/providers/aliased-loader.ts',
    'src/runtime/namespace-loader.ts',
    'src/capabilities/reverse.ts',
    'src/capabilities/host-reverse.ts',
  ])
    await writeFile(path.join(directory, name), 'export const value = 1;');
  const success = await execute(process.execPath, [
    'scripts/architecture-boundaries.mjs',
    directory,
    '--no-exceptions',
  ]);
  assert.match(success.stdout, /boundaries pass/u);
  await writeFile(
    path.join(directory, 'src/lsp/workspace-state.ts'),
    "export * from './request-context.js';",
  );
  await writeFile(
    path.join(directory, 'src/lsp/request-context.ts'),
    "export * from './workspace-state.js';",
  );
  const cycle = await execute(process.execPath, [
    'scripts/architecture-boundaries.mjs',
    directory,
  ]).then(
    () => assert.fail('Ownership cycle passed.'),
    (error: unknown) => error as { stderr: string },
  );
  assert.match(cycle.stderr, /Ownership dependency cycle/u);
});
