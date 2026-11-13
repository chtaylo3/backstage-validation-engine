import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
interface Boundaries {
  readonly LAYERS: readonly (readonly string[])[];
  checkArchitecture(root: string): Promise<string[]>;
}
const boundaries = async () =>
  (await import(
    pathToFileURL(path.join(repository, 'scripts/architecture-boundaries.mjs')).href
  )) as Boundaries;
const tsconfig = JSON.stringify({
  compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
});
async function check(t: TestContext, files: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-layers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries({ 'tsconfig.json': tsconfig, ...files })) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), contents);
  }
  return (await boundaries()).checkArchitecture(directory);
}
const rejects = (failures: readonly string[], ...parts: string[]) =>
  assert(
    failures.some((failure) => parts.every((part) => failure.includes(part))),
    `No failure names ${parts.join(' and ')}:\n${failures.join('\n')}`,
  );
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
    'src/lsp/barrel.ts': "export type { Adapter } from './adapter.js';",
    'src/contracts/reverse.ts':
      "import type { Adapter } from '@adapter/adapter'; export type Result = Adapter;",
    'src/runtime/reverse.ts': "export type { Adapter } from '../lsp/barrel.js';",
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
  assert.match(
    cycle.stderr,
    /Import cycle: src\/lsp\/request-context\.ts -> src\/lsp\/workspace-state\.ts -> src\/lsp\/request-context\.ts/u,
  );
});

void test('layers reject a value import from base to contracts', async (t) => {
  const failures = await check(t, {
    'src/base/a.ts': "import { b } from '../contracts/b.js'; export const a = b;",
    'src/contracts/b.ts': 'export const b = 1;',
  });
  rejects(failures, 'src/base/a.ts -> src/contracts/b.ts', 'upward import from base to contracts');
});

void test('layers reject a type-only import from parsing to compatibility', async (t) => {
  const failures = await check(t, {
    'src/parsing/a.ts': "import type { B } from '../compatibility/b.js'; export type A = B;",
    'src/compatibility/b.ts': 'export interface B { value: string }',
  });
  rejects(failures, 'src/parsing/a.ts -> src/compatibility/b.ts', 'upward import');
});

void test('layers reject a dynamic import from core to pipeline', async (t) => {
  const failures = await check(t, {
    'src/core/a.ts': "export const load = () => import('../pipeline/b.js');",
    'src/pipeline/b.ts': 'export const b = 1;',
  });
  rejects(failures, 'src/core/a.ts -> src/pipeline/b.ts', 'upward import from core to pipeline');
});

void test('layers reject an upward import through a barrel in an intermediate layer and name the chain', async (t) => {
  const failures = await check(t, {
    'src/base/a.ts': "export { b } from '../contracts/barrel.js';",
    'src/contracts/barrel.ts': "export * from '../pipeline/b.js';",
    'src/pipeline/b.ts': 'export const b = 1;',
  });
  rejects(
    failures,
    'src/base/a.ts -> src/pipeline/b.ts',
    'src/base/a.ts -> src/contracts/barrel.ts -> src/pipeline/b.ts',
  );
});

void test('layers accept downward and same-layer imports', async (t) => {
  assert.deepEqual(
    await check(t, {
      'src/pipeline/a.ts': "import { b } from '../core/b.js'; export const a = b;",
      'src/core/b.ts': "import { c } from './c.js'; export const b = c;",
      'src/core/c.ts': "import type { D } from '../base/d.js'; export const c: D = 1;",
      'src/base/d.ts': 'export type D = number;',
    }),
    [],
  );
});

void test('layers reject imports between the cli and lsp peers in both directions', async (t) => {
  const failures = await check(t, {
    'src/cli/a.ts': "import { b } from '../lsp/b.js'; export const a = b;",
    'src/lsp/b.ts': 'export const b = 1;',
    'src/lsp/c.ts': "import { d } from '../cli/d.js'; export const c = d;",
    'src/cli/d.ts': 'export const d = 1;',
  });
  rejects(failures, 'src/cli/a.ts -> src/lsp/b.ts', 'peer layers cli and lsp');
  rejects(failures, 'src/lsp/c.ts -> src/cli/d.ts', 'peer layers lsp and cli');
});

void test('layers reject a file in a directory that LAYERS does not name', async (t) => {
  const failures = await check(t, { 'src/misc/x.ts': 'export const x = 1;' });
  rejects(failures, 'src/misc/x.ts', 'not in a layer');
});

void test('cycles reject a two-file cycle inside one layer with value and with type-only imports', async (t) => {
  for (const [kind, importer] of [
    ['value', (name: string) => `import { ${name} } from './${name}.js'; export const`],
    ['type', (name: string) => `import type { ${name} } from './${name}.js'; export type`],
  ] as const) {
    const failures = await check(t, {
      'src/core/a.ts': `${importer('b')} a = b;`,
      'src/core/b.ts': `${importer('a')} b = a;`,
    });
    assert.deepEqual(
      failures,
      ['Import cycle: src/core/a.ts -> src/core/b.ts -> src/core/a.ts'],
      `${kind} cycle`,
    );
  }
});

void test('cycles across two layers report a chain that names all three files', async (t) => {
  const failures = await check(t, {
    'src/core/a.ts': "import type { B } from './b.js'; export type A = B;",
    'src/core/b.ts': "import type { C } from '../base/c.js'; export type B = C;",
    'src/base/c.ts': "import type { A } from '../core/a.js'; export type C = A | string;",
  });
  rejects(
    failures,
    'Import cycle: src/base/c.ts -> src/core/a.ts -> src/core/b.ts -> src/base/c.ts',
  );
});

void test('no file under src imports the public barrel, directly or transitively', async (t) => {
  const failures = await check(t, {
    'src/index.ts': "export { d } from './base/d.js';",
    'src/base/d.ts': 'export const d = 1;',
    'src/lsp/a.ts': "import { d } from '../index.js'; export const a = d;",
    'src/base/a.ts': "import { d } from '../index.js'; export const a = d;",
    'src/lsp/t.ts': "import { h } from '../host/h.js'; export const t = h;",
    'src/host/h.ts': "export * as h from '../index.js';",
  });
  rejects(failures, 'src/lsp/a.ts -> src/index.ts', 'public barrel src/index.ts');
  rejects(failures, 'src/base/a.ts -> src/index.ts', 'public barrel src/index.ts');
  rejects(
    failures,
    'src/lsp/t.ts -> src/index.ts',
    'public barrel src/index.ts',
    'src/lsp/t.ts -> src/host/h.ts -> src/index.ts',
  );
});

void test('packages are contained: yaml only in parsing and lsp, catalog-model only in compatibility', async (t) => {
  const failures = await check(t, {
    'src/policy/a.ts': "import { parse } from 'yaml'; export const a = parse;",
    'src/parsing/b.ts': "import { parse } from 'yaml'; export const b = parse;",
    'src/providers/c.ts':
      "import type { Entity } from '@backstage/catalog-model'; export type C = Entity;",
  });
  rejects(failures, 'src/policy/a.ts -> yaml', 'parsing, lsp');
  rejects(failures, 'src/providers/c.ts -> @backstage/catalog-model', 'compatibility');
  assert.deepEqual(
    failures.filter((failure) => failure.includes('src/parsing/b.ts')),
    [],
  );
  assert.equal(failures.length, 2);
});

void test('protocol: the client may import src/protocol and nothing else under src', async (t) => {
  const protocol = {
    'src/protocol/index.ts': "export { METHOD } from './methods.js';",
    'src/protocol/methods.ts': "export const METHOD = 'bve/x';",
  };
  assert.deepEqual(
    await check(t, {
      ...protocol,
      'extensions/vscode/src/extension.ts':
        "import { METHOD } from '../../../src/protocol/index.js'; export const m = METHOD;",
    }),
    [],
  );
  const failures = await check(t, {
    ...protocol,
    'src/lsp/a.ts': 'export const a = 1;',
    'src/base/b.ts': 'export const b = 1;',
    'extensions/vscode/src/lsp.ts':
      "import { a } from '../../../src/lsp/a.js'; export const x = a;",
    'extensions/vscode/src/base.ts':
      "import type { B } from '../../../src/base/b.js'; export type Y = B;",
  });
  rejects(failures, 'extensions/vscode/src/lsp.ts -> src/lsp/a.ts', 'client imports src/');
  rejects(failures, 'extensions/vscode/src/base.ts -> src/base/b.ts', 'client imports src/');
});

void test('protocol: a protocol file may not import a lower engine file, a package or a Node built-in', async (t) => {
  const failures = await check(t, {
    'src/base/json.ts': 'export type Json = string;',
    'src/protocol/engine.ts': "import type { Json } from '../base/json.js'; export type X = Json;",
    'src/protocol/package.ts': "import { parse } from 'yaml'; export const x = parse;",
    'src/protocol/builtin.ts':
      "import { createHash } from 'node:crypto'; export const x = createHash;",
    'src/protocol/methods.ts': "export const METHOD = 'bve/x';",
    'src/protocol/index.ts': "export { METHOD } from './methods.js';",
  });
  rejects(failures, 'src/protocol/engine.ts -> src/base/json.ts', 'protocol files may import only');
  rejects(failures, 'src/protocol/package.ts -> yaml', 'protocol files may not import packages');
  rejects(failures, 'src/protocol/builtin.ts -> node:crypto', 'protocol files may not import');
  assert.deepEqual(
    failures.filter((failure) => failure.startsWith('src/protocol/index.ts')),
    [],
  );
});

void test('protocol: every engine layer may import src/protocol', async (t) => {
  const { LAYERS } = await boundaries();
  const files: Record<string, string> = {
    'src/protocol/index.ts': "export const METHOD = 'bve/x';",
  };
  for (const name of LAYERS.flat().filter((layer) => layer !== 'protocol'))
    files[`src/${name}/a.ts`] =
      "import { METHOD } from '../protocol/index.js'; export const a = METHOD;";
  assert.deepEqual(await check(t, files), []);
});

/** The defining module of the shared CEL runtime accessors, as the runtime layer lays it out. */
const sharedRuntime = {
  'src/runtime/cel/pool.ts': 'export interface CelRuntime { evaluate(): Promise<boolean> }',
  'src/runtime/cel/index.ts':
    "import type { CelRuntime } from './pool.js';\n" +
    'export function getSharedCelRuntime(): CelRuntime { return { evaluate: () => Promise.resolve(true) }; }\n' +
    'export async function closeSharedCelRuntime(): Promise<void> {}\n' +
    "export type { CelRuntime } from './pool.js';\n" +
    'export const CEL_LIMITS = { requestMs: 5000 };',
};
void test('shared runtime: a file outside the allowlist that imports the shared CEL runtime is rejected', async (t) => {
  const failures = await check(t, {
    ...sharedRuntime,
    'src/lsp/editor/named.ts':
      "import { getSharedCelRuntime } from '../../runtime/cel/index.js'; export const a = getSharedCelRuntime;",
    'src/lsp/aliased.ts':
      "import { getSharedCelRuntime as shared } from '../runtime/cel/index.js'; export const a = shared;",
    'src/host/close.ts':
      "import { closeSharedCelRuntime } from '../runtime/cel/index.js'; export const a = closeSharedCelRuntime;",
    'src/pipeline/reexport.ts': "export { getSharedCelRuntime } from '../runtime/cel/index.js';",
    'src/capabilities/namespace.ts':
      "import * as cel from '../runtime/cel/index.js'; export const a = cel.getSharedCelRuntime;",
    'src/providers/star.ts': "export * from '../runtime/cel/index.js';",
    'src/compatibility/dynamic.ts': "export const load = () => import('../runtime/cel/index.js');",
  });
  for (const [file, reached] of [
    ['src/lsp/editor/named.ts', 'getSharedCelRuntime'],
    ['src/lsp/aliased.ts', 'getSharedCelRuntime'],
    ['src/host/close.ts', 'closeSharedCelRuntime'],
    ['src/pipeline/reexport.ts', 'getSharedCelRuntime'],
    ['src/capabilities/namespace.ts', 'the whole of'],
    ['src/providers/star.ts', 'the whole of'],
    ['src/compatibility/dynamic.ts', 'a dynamic import of'],
  ] as const)
    rejects(failures, `${file} imports`, reached, 'may import the shared CEL runtime');
});

void test('shared runtime: allowlisted importers and type-only CelRuntime imports at or above runtime are accepted', async (t) => {
  const { LAYERS } = await boundaries();
  const files: Record<string, string> = {
    ...sharedRuntime,
    'src/index.ts':
      "export { getSharedCelRuntime, closeSharedCelRuntime } from './runtime/cel/index.js';",
    'src/cli/main.ts':
      "import { closeSharedCelRuntime } from '../runtime/cel/index.js'; await closeSharedCelRuntime();",
    'src/lsp/stdio.ts':
      "import { getSharedCelRuntime } from '../runtime/cel/index.js'; export const runtime = getSharedCelRuntime();",
    'src/pipeline/rules/context.ts':
      "import { getSharedCelRuntime } from '../../runtime/cel/index.js'; export const fallback = getSharedCelRuntime;",
  };
  const runtimeRank = LAYERS.findIndex((names) => names.includes('runtime'));
  for (const name of LAYERS.slice(runtimeRank).flat())
    files[`src/${name}/typed.ts`] =
      `import type { CelRuntime } from '../runtime/cel/index.js'; import { CEL_LIMITS } from '../runtime/cel/index.js'; export type Runtime = CelRuntime; export const limit = CEL_LIMITS.requestMs;`;
  assert.deepEqual(await check(t, files), []);
});

void test('default runtime: only its module and the editor state fallback may import defaultRuleRuntime', async (t) => {
  const failures = await check(t, {
    ...sharedRuntime,
    'src/pipeline/rules/context.ts':
      "import { getSharedCelRuntime } from '../../runtime/cel/index.js';\n" +
      'export function defaultRuleRuntime() { return getSharedCelRuntime(); }\n' +
      'export function prepareRuleRun() { return 1; }',
    'src/pipeline/cel-rules.ts':
      "import { prepareRuleRun } from './rules/context.js'; export const run = prepareRuleRun;",
    'src/lsp/editor/state.ts':
      "import { defaultRuleRuntime } from '../../pipeline/rules/context.js'; export const a = defaultRuleRuntime;",
    'src/lsp/editor/index-store.ts':
      "import { defaultRuleRuntime } from '../../pipeline/rules/context.js'; export const a = defaultRuleRuntime;",
    'src/host/fallback.ts':
      "import { defaultRuleRuntime as fallback } from '../pipeline/rules/context.js'; export const a = fallback;",
    'src/lsp/namespace.ts':
      "import * as rules from '../pipeline/rules/context.js'; export const a = rules.prepareRuleRun;",
  });
  for (const [file, reached] of [
    ['src/lsp/editor/index-store.ts', 'defaultRuleRuntime'],
    ['src/host/fallback.ts', 'defaultRuleRuntime'],
    ['src/lsp/namespace.ts', 'the whole of'],
  ] as const)
    rejects(failures, `${file} imports`, reached, 'may import the default rule runtime');
  for (const allowed of ['src/pipeline/cel-rules.ts', 'src/lsp/editor/state.ts'])
    assert(
      !failures.some((failure) => failure.startsWith(`${allowed} `)),
      `${allowed} was rejected:\n${failures.join('\n')}`,
    );
  assert.equal(failures.length, 3, failures.join('\n'));
});

void test('the repository satisfies every architecture rule', async () => {
  assert.deepEqual(await (await boundaries()).checkArchitecture(repository), []);
});

void test('docs/architecture.md lists the layers in LAYERS order', async () => {
  const markdown = await readFile(path.join(repository, 'docs/architecture.md'), 'utf8');
  const section = markdown.slice(markdown.indexOf('### Engine layers'));
  const rows = section
    .split('\n')
    .filter((line) => /^\|\s*\d+\s*\|/u.test(line))
    .map((line) =>
      [...(line.split('|')[2] ?? '').matchAll(/`([^`]+)`/gu)].map((match) => match[1]),
    );
  assert.deepEqual(
    rows,
    (await boundaries()).LAYERS.map((names) => [...names]),
  );
});
