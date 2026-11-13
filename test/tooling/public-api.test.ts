import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as capabilities from '../../src/capabilities/index.js';
import * as contracts from '../../src/contracts/index.js';
import * as root from '../../src/index.js';
import * as lsp from '../../src/lsp/index.js';
import * as protocol from '../../src/protocol/index.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const baselineFile = path.join(repository, 'test/fixtures/public-api.json');
const entries = {
  '.': 'src/index.ts',
  './contracts': 'src/contracts/index.ts',
  './lsp': 'src/lsp/index.ts',
  './capabilities': 'src/capabilities/index.ts',
  './protocol': 'src/protocol/index.ts',
} as const;
type Entry = keyof typeof entries;
type Surface = Record<Entry, string[]>;
const compiled: Record<Entry, object> = {
  '.': root,
  './contracts': contracts,
  './lsp': lsp,
  './capabilities': capabilities,
  './protocol': protocol,
};

const typeOnly = (checker: ts.TypeChecker, symbol: ts.Symbol) => {
  for (
    let current: ts.Symbol | undefined = symbol;
    current && current.flags & ts.SymbolFlags.Alias;
    current = checker.getImmediateAliasedSymbol(current)
  )
    if (current.declarations?.some((node) => ts.isTypeOnlyImportOrExportDeclaration(node)))
      return true;
  return false;
};

function exportedSurface(): Surface {
  const config = ts.readConfigFile(path.join(repository, 'tsconfig.json'), (file) =>
    ts.sys.readFile(file),
  );
  const { options } = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, repository);
  const files = Object.values(entries).map((file) => path.join(repository, file));
  const program = ts.createProgram(files, { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const surface = {} as Surface;
  for (const [entry, file] of Object.entries(entries) as [Entry, string][]) {
    const source = program.getSourceFile(path.join(repository, file));
    const module = source && checker.getSymbolAtLocation(source);
    assert(module, `${file} has no module symbol.`);
    const names: string[] = [];
    for (const symbol of checker.getExportsOfModule(module)) {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const value = Boolean(target.flags & ts.SymbolFlags.Value) && !typeOnly(checker, symbol);
      const type = Boolean(target.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Namespace));
      if (value) names.push(`${symbol.name}: value`);
      if (type) names.push(`${symbol.name}: type`);
      assert(value || type, `${entry} exports ${symbol.name} with no value or type meaning.`);
    }
    surface[entry] = names.sort();
  }
  return surface;
}

const difference = (actual: string[], expected: string[]) => {
  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));
  return [...added.map((name) => `  + ${name}`), ...removed.map((name) => `  - ${name}`)].join(
    '\n',
  );
};

const readBaseline = async () =>
  JSON.parse(await readFile(baselineFile, 'utf8')) as Record<string, string[]>;

void test('public entry points export exactly the recorded value and type names', async () => {
  const actual = exportedSurface();
  if (process.env.BVE_UPDATE_PUBLIC_API === '1')
    await writeFile(baselineFile, JSON.stringify(actual, null, 2) + '\n');
  const baseline = await readBaseline();
  assert.deepEqual(Object.keys(baseline).sort(), Object.keys(entries).sort());
  for (const entry of Object.keys(entries) as Entry[]) {
    const expected = baseline[entry] ?? [];
    assert.deepEqual(
      actual[entry],
      expected,
      `The public API of "${entry}" changed (+ added, - removed or changed kind):\n` +
        difference(actual[entry], expected),
    );
  }
});

void test('compiled entry points expose exactly the recorded value names at runtime', async () => {
  const baseline = await readBaseline();
  for (const entry of Object.keys(entries) as Entry[]) {
    const expected = (baseline[entry] ?? [])
      .filter((name) => name.endsWith(': value'))
      .map((name) => name.slice(0, -': value'.length))
      .sort();
    const actual = Object.keys(compiled[entry]).sort();
    assert.deepEqual(
      actual,
      expected,
      `The runtime exports of "${entry}" differ from the recorded value names:\n` +
        difference(actual, expected),
    );
  }
});
