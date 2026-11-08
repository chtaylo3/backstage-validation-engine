import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged');
const coverage = process.argv.includes('--coverage');
const reports = path.join(
  root,
  '.artifacts/tests',
  coverage ? 'coverage' : packaged ? 'packaged' : 'source',
);
await mkdir(reports, { recursive: true });
const compiled = path.join(root, '.test-dist/test');
const files = (await readdir(compiled))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(compiled, name));
if (!files.length) throw new Error('No compiled test files were discovered.');
const runtime = packaged
  ? path.join(
      root,
      '.artifacts/vscode/stage/runtime',
      process.platform === 'win32' ? 'node.exe' : 'node',
    )
  : process.execPath;
const args = [
  '--test',
  '--test-concurrency=1',
  '--test-timeout=30000',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=junit',
  `--test-reporter-destination=${path.join(reports, 'junit.xml')}`,
  '--test-reporter=./scripts/ci-test-reporter.mjs',
  `--test-reporter-destination=${path.join(reports, 'summary.jsonl')}`,
  ...(coverage
    ? [
        '--experimental-test-coverage',
        '--test-reporter=lcov',
        `--test-reporter-destination=${path.join(reports, 'lcov.info')}`,
      ]
    : []),
  ...files,
];
const env = {
  ...process.env,
  ...(packaged
    ? {
        BVE_TEST_LSP_ENTRY: path.join(root, '.artifacts/vscode/stage/server/dist/lsp/stdio.js'),
        BVE_TEST_CLI_ENTRY: path.join(root, '.artifacts/vscode/stage/server/dist/cli/main.js'),
      }
    : {}),
};
const exit = await new Promise((resolve, reject) => {
  const child = spawn(runtime, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
});
const summaries = (await readFile(path.join(reports, 'summary.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const summary = summaries.findLast((row) => row.file === undefined) ?? summaries.at(-1);
if (!summary?.counts) throw new Error('The test runner did not produce a complete summary.');
await writeFile(
  path.join(reports, 'inventory.json'),
  JSON.stringify(
    {
      packaged,
      platform: process.platform,
      arch: process.arch,
      runtime,
      files: files.map((name) => path.relative(root, name)),
      summary,
    },
    null,
    2,
  ) + '\n',
);
const skipped = summary.counts.skipped ?? 0;
if (process.env.CI && skipped) {
  console.error(`CI requires the entire harness: ${skipped} skipped test(s) must be investigated.`);
  process.exitCode = 1;
} else process.exitCode = exit;
