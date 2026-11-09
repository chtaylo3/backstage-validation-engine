import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

void test('JetBrains template quotes host-owned paths and uses stdio without a shell installer', async () => {
  const module = (await import(
    pathToFileURL(path.resolve('scripts/jetbrains-template.mjs')).href
  )) as {
    jetbrainsTemplate(input: { runtime: string; server: string; config: string }): {
      programArgs: { default: string };
      fileTypeMappings: { languageId: string }[];
    };
  };
  const input = {
    runtime: process.execPath,
    server: path.resolve('server with spaces/stdio.js'),
    config: path.resolve('trusted config.json'),
  };
  const template = module.jetbrainsTemplate(input);
  assert(template.programArgs.default.includes('" --config "'));
  assert(template.programArgs.default.includes('server with spaces/stdio.js"'));
  assert.deepEqual(
    template.fileTypeMappings.map((row) => row.languageId),
    ['yaml', 'json'],
  );
  assert.throws(() => module.jetbrainsTemplate({ ...input, config: 'relative.json' }));
  assert.throws(() => module.jetbrainsTemplate({ ...input, config: input.config + '\ncommand' }));
});
