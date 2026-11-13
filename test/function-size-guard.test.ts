import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const repository = fileURLToPath(new URL('../../', import.meta.url));
interface Guard {
  readonly FUNCTION_LINE_LIMIT: number;
  readonly FUNCTION_ALLOWLIST: string;
  readonly checkArchitecture: (root: string) => Promise<string[]>;
  readonly measureFunctions: (source: ts.SourceFile) => { name: string; lines: number }[];
}
const guard = async () =>
  (await import(
    pathToFileURL(path.join(repository, 'scripts/architecture-boundaries.mjs')).href
  )) as Guard;
const tsconfig = JSON.stringify({
  compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
});
async function check(
  t: TestContext,
  files: Record<string, string>,
  allowlist?: Record<string, Record<string, number>>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-function-size-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { FUNCTION_ALLOWLIST, checkArchitecture } = await guard();
  for (const [name, contents] of Object.entries({
    'tsconfig.json': tsconfig,
    ...files,
    ...(allowlist ? { [FUNCTION_ALLOWLIST]: JSON.stringify(allowlist) } : {}),
  })) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), contents);
  }
  return checkArchitecture(directory);
}
/** A body of `lines` lines in total, including the opening and closing lines. */
const body = (lines: number, indent = '  ') =>
  Array.from({ length: lines - 2 }, (_, index) => `${indent}void ${index};`).join('\n');
const fn = (name: string, lines: number) => `export function ${name}() {\n${body(lines)}\n}\n`;
const measure = async (text: string) =>
  (await guard()).measureFunctions(ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true));

void test('the limit is 150 lines: a 150-line function passes and a 151-line function fails', async (t) => {
  assert.equal((await guard()).FUNCTION_LINE_LIMIT, 150);
  assert.deepEqual(await check(t, { 'src/core/a.ts': fn('within', 150) }), []);
  assert.deepEqual(await check(t, { 'src/core/a.ts': fn('over', 151) }), [
    'src/core/a.ts over is 151 lines: functions may have at most 150',
  ]);
  assert.deepEqual(await check(t, { 'extensions/vscode/src/a.ts': fn('client', 151) }), [
    'extensions/vscode/src/a.ts client is 151 lines: functions may have at most 150',
  ]);
});

void test('an allowlisted function may reach its ceiling but not grow past it', async (t) => {
  const allowlist = { 'src/core/a.ts': { legacy: 200 } };
  assert.deepEqual(await check(t, { 'src/core/a.ts': fn('legacy', 200) }, allowlist), []);
  assert.deepEqual(await check(t, { 'src/core/a.ts': fn('legacy', 180) }, allowlist), []);
  assert.deepEqual(await check(t, { 'src/core/a.ts': fn('legacy', 201) }, allowlist), [
    'src/core/a.ts legacy is 201 lines, above its function size allowlist ceiling of 200',
  ]);
});

void test('a stale allowlist entry fails, whether the function shrank or is gone', async (t) => {
  const allowlist = { 'src/core/a.ts': { shrunk: 200, removed: 300 } };
  assert.deepEqual(await check(t, { 'src/core/a.ts': fn('shrunk', 150) }, allowlist), [
    'src/core/a.ts removed is in the function size allowlist but does not exist: remove its entry',
    'src/core/a.ts shrunk is 150 lines, within the 150-line limit: remove its function size allowlist entry',
  ]);
});

void test('methods, accessors, constructors, arrow functions and nested functions are each measured', async () => {
  const measured = await measure(
    [
      'export class Store {',
      `  constructor() {\n${body(3, '    ')}\n  }`,
      `  get size() {\n${body(4, '    ')}\n  }`,
      `  load() {\n${body(5, '    ')}\n  }`,
      '}',
      `export const arrow = () => {\n${body(6)}\n};`,
      'export function outer() {',
      `  function inner() {\n${body(7, '    ')}\n  }`,
      `  const helper = function () {\n${body(8, '    ')}\n  };`,
      '  return { inner, helper, method: () => 1 };',
      '}',
      'export const table = { entry: () => 2, entry2() { return 3; } };',
    ].join('\n'),
  );
  assert.deepEqual(measured, [
    { name: 'Store.constructor', lines: 3 },
    { name: 'Store.size', lines: 4 },
    { name: 'Store.load', lines: 5 },
    { name: 'arrow', lines: 6 },
    { name: 'outer', lines: 18 },
    { name: 'outer.inner', lines: 7 },
    { name: 'outer.helper', lines: 8 },
    { name: 'outer.method', lines: 1 },
    // Object literals are not scopes: a property function takes its own name.
    { name: 'entry', lines: 1 },
    { name: 'entry2', lines: 1 },
  ]);
});

void test('a long nested function fails on its own, and repeated names take an ordinal suffix', async (t) => {
  const text = [
    'export function outer() {',
    `  const run = () => {\n${body(151, '    ')}\n  };`,
    '  return run;',
    '}',
    `export const items = [() => {\n${body(151)}\n}, () => {\n${body(151)}\n}];`,
  ].join('\n');
  const failures = await check(t, { 'src/core/a.ts': text }, { 'src/core/a.ts': { outer: 154 } });
  assert.deepEqual(failures, [
    'src/core/a.ts <anonymous> is 151 lines: functions may have at most 150',
    'src/core/a.ts <anonymous>#2 is 151 lines: functions may have at most 150',
    'src/core/a.ts outer.run is 151 lines: functions may have at most 150',
  ]);
});

void test('the committed allowlist has no entry for the pipeline stages split in phase 2', async () => {
  const allowlist = JSON.parse(
    await readFile(path.join(repository, (await guard()).FUNCTION_ALLOWLIST), 'utf8'),
  ) as Record<string, Record<string, number>>;
  const files = Object.keys(allowlist);
  assert(files.length > 0);
  assert.deepEqual(
    files.filter(
      (file) =>
        file === 'src/compatibility/sources.ts' ||
        file.startsWith('src/compatibility/stages/') ||
        file.startsWith('src/pipeline/'),
    ),
    [],
  );
  for (const names of Object.values(allowlist))
    for (const ceiling of Object.values(names)) assert(ceiling > 150);
});
