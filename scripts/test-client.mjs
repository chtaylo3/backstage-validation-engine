import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const directory = '.artifacts/tests/client';
await mkdir(directory, { recursive: true });
const exit = await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      '--enable-source-maps',
      '--test',
      '--experimental-test-coverage',
      '--test-coverage-lines=90',
      '--test-coverage-branches=85',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=junit',
      `--test-reporter-destination=${directory}/junit.xml`,
      '--test-reporter=lcov',
      `--test-reporter-destination=${directory}/lcov.info`,
      '--test-reporter=./scripts/ci-test-reporter.mjs',
      `--test-reporter-destination=${directory}/summary.jsonl`,
      '.test-dist/test/extension-client.test.js',
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? 1));
});
const lcov = await readFile(path.join(directory, 'lcov.info'), 'utf8');
const sources = [...lcov.matchAll(/^SF:(.+)$/gmu)]
  .map((row) => row[1].trim().replaceAll('\\', '/'))
  .sort();
// The client bundles the dependency-free src/protocol module and nothing else from src/. The
// protocol files it bundles are measured with the client, so they join the expected set. The
// bundle options follow scripts/package-extension.mjs.
const bundled = await build({
  entryPoints: ['extensions/vscode/src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  metafile: true,
  write: false,
  logLevel: 'silent',
});
const protocol = Object.keys(bundled.metafile.inputs)
  .map((input) => input.replaceAll('\\', '/'))
  .filter((input) => input.startsWith('src/protocol/') && input.endsWith('.ts'));
const expected = [
  ...(await readdir('extensions/vscode/src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => 'extensions/vscode/src/' + name),
  ...protocol,
].sort();
assert(expected.length > 0, 'Client coverage inventory cannot be empty.');
// Node remaps to TypeScript before reporting. Requiring the exact source set
// rejects empty 100% reports, missing files and dependency/test contamination.
assert.deepEqual(
  sources,
  expected,
  'Coverage must measure every client TypeScript source, with no bundled dependencies.',
);
const summaries = (await readFile(path.join(directory, 'summary.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const summary = summaries.findLast((row) => row.file === undefined) ?? summaries.at(-1);
assert(summary?.counts?.tests > 0, 'No client tests executed.');
assert.equal(summary.counts.skipped, 0, 'Client tests cannot be skipped.');
await writeFile(
  path.join(directory, 'inventory.json'),
  JSON.stringify(
    {
      sources,
      summary,
      platform: process.platform,
      arch: process.arch,
      thresholds: { lines: 90, branches: 85 },
    },
    null,
    2,
  ) + '\n',
);
process.exitCode = exit;
