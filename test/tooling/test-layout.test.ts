import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { GROUPS } = (await import(
  pathToFileURL(path.resolve('scripts/test-selection.mjs')).href
)) as {
  GROUPS: readonly string[];
};
const scripts = (
  JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
).scripts;
/** A compiled test file path, such as `.test-dist/test/lsp/lsp.test.js`. */
const COMPILED_TEST = /\.test-dist\/test\/[^\s'"`]*\.test\.js/gu;

async function testSources() {
  const entries = await readdir('test', { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) =>
      path.relative('test', path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
    )
    .filter((file) => !file.split('/').includes('node_modules'))
    .sort();
}

void test('no test source sits directly under test/', async () => {
  const flat = (await readdir('test')).filter((name) => name.endsWith('.test.ts'));
  assert.deepEqual(flat, []);
});

void test('every test source lives under exactly one of the five group directories', async () => {
  const files = await testSources();
  assert(files.length > 0);
  const outside = files.filter((file) => !GROUPS.includes(file.split('/')[0]!));
  assert.deepEqual(outside, []);
  for (const group of GROUPS)
    assert(
      files.some((file) => file.startsWith(`${group}/`)),
      `The ${group} group has no test files.`,
    );
});

void test('no package script lists two or more test files', () => {
  for (const [name, command] of Object.entries(scripts))
    assert.doesNotMatch(command, /\.test\.js\b.*\.test\.js\b/u, `package.json script ${name}`);
});

void test('scripts and workflows name at most one compiled test file each', async () => {
  const files = [
    ...(await readdir('scripts'))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => `scripts/${name}`),
    ...(await readdir('.github/workflows'))
      .filter((name) => name.endsWith('.yml'))
      .map((name) => `.github/workflows/${name}`),
  ];
  for (const file of files) {
    const matches = (await readFile(file, 'utf8')).match(COMPILED_TEST) ?? [];
    assert(matches.length <= 1, `${file} lists compiled test files: ${matches.join(', ')}`);
    for (const match of matches)
      assert(
        existsSync(match.replace(/^\.test-dist\//u, '').replace(/\.js$/u, '.ts')),
        `${file} names ${match}, which has no test source`,
      );
  }
});

void test('every group that a package script names exists', () => {
  const named = Object.values(scripts).flatMap((command) =>
    [...command.matchAll(/--group\s+([^\s&|;]+)/gu)].map((match) => match[1]!),
  );
  assert(named.length > 0, 'No package script selects a group.');
  for (const group of named) {
    assert(GROUPS.includes(group), `Unknown group ${group}`);
    assert(existsSync(path.join('test', group)), `Missing directory test/${group}`);
  }
});
