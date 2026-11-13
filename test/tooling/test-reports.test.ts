import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

const { GROUPS, SERIAL_FILES } = (await import(
  pathToFileURL(path.resolve('scripts/test-selection.mjs')).href
)) as { GROUPS: readonly string[]; SERIAL_FILES: Readonly<Record<string, string>> };
const runner = path.resolve('scripts/test.mjs');

interface Summary {
  counts: Record<string, number>;
  file?: string;
  success?: boolean;
}

const passing = (name: string) => `require('node:test')(${JSON.stringify(name)}, () => {});\n`;

/**
 * A project tree with a file in every group; engine is the parallel group by default. The
 * repository serial list must name existing files, so the tree holds a passing file for each of its
 * entries.
 */
async function project(t: TestContext, overrides: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'bve-test-reports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    'engine/a.test.js': passing('engine a') + passing('engine a second'),
    'engine/nested/b.test.js': passing('engine b'),
    'tooling/c.test.js': passing('tooling c'),
    'lsp/d.test.js': passing('lsp d'),
    'cli/e.test.js': passing('cli e'),
    'extension/f.test.js': passing('extension f'),
    ...Object.fromEntries(Object.keys(SERIAL_FILES).map((file) => [file, passing(file)])),
    ...overrides,
  };
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, '.test-dist/test', file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  return { root, files: Object.keys(files) };
}

async function run(root: string, env: Record<string, string> = {}, groups: readonly string[] = []) {
  const environment: NodeJS.ProcessEnv = { ...process.env, BVE_TEST_CONCURRENCY: '2', ...env };
  // A nested runner must not report to the outer test runner, and the outer run's overrides must
  // not leak into it.
  delete environment.NODE_TEST_CONTEXT;
  if (!('CI' in env)) delete environment.CI;
  if (!('BVE_TEST_PARALLEL_GROUPS' in env)) delete environment.BVE_TEST_PARALLEL_GROUPS;
  const child = spawn(
    process.execPath,
    [runner, '--root', root, ...groups.flatMap((group) => ['--group', group])],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const reports = path.join(root, '.artifacts/tests/source');
  return { exit, output, reports };
}

async function summaries(reports: string) {
  return (await readFile(path.join(reports, 'summary.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Summary);
}

void test('a parallel and a serial invocation produce one merged summary, junit report and inventory', async (t) => {
  const { root, files } = await project(t);
  const { exit, output, reports } = await run(root);
  assert.equal(exit, 0, output);
  const tests = files.length + 1;
  const rows = await summaries(reports);
  assert.equal(rows.filter((row) => row.file === undefined).length, 1);
  assert.equal(rows.at(-1)?.file, undefined);
  assert.equal(rows.at(-1)?.counts.tests, tests);
  assert.equal(rows.at(-1)?.counts.passed, tests);
  assert.equal(rows.at(-1)?.success, true);
  assert.equal(rows.length, files.length + 1);
  const compiled = (file: string) => path.join('.test-dist/test', file);
  const inventory = JSON.parse(await readFile(path.join(reports, 'inventory.json'), 'utf8')) as {
    files: string[];
    summary: Summary;
    invocations: { name: string; concurrency: number; files: string[] }[];
  };
  assert.deepEqual(Object.keys(inventory).slice(0, 6), [
    'packaged',
    'platform',
    'arch',
    'runtime',
    'files',
    'summary',
  ]);
  assert.deepEqual(inventory.files, files.map(compiled).sort());
  assert.deepEqual(inventory.summary, rows.at(-1));
  const parallel = ['engine/a.test.js', 'engine/nested/b.test.js'];
  assert.deepEqual(inventory.invocations, [
    { name: 'parallel', concurrency: 2, files: parallel.map(compiled) },
    {
      name: 'serial',
      concurrency: 1,
      files: files
        .filter((file) => !parallel.includes(file))
        .map(compiled)
        .sort(),
    },
  ]);
  const junit = await readFile(path.join(reports, 'junit.xml'), 'utf8');
  assert.equal(junit.match(/<testsuites>/gu)?.length, 1);
  assert.equal(junit.match(/<\/testsuites>/gu)?.length, 1);
  assert.equal(junit.match(/<testcase /gu)?.length, tests);
  assert.equal(junit.match(/<!-- tests \d+ -->/gu)?.join(), `<!-- tests ${tests} -->`);
  assert.equal(junit.match(/<!-- pass \d+ -->/gu)?.join(), `<!-- pass ${tests} -->`);
});

void test('a failing test in either invocation makes the exit code non-zero', async (t) => {
  const failing = "require('node:test')('fails', () => { throw new Error('expected'); });\n";
  for (const file of ['engine/a.test.js', 'tooling/c.test.js']) {
    const { root } = await project(t, { [file]: failing });
    const { exit, output, reports } = await run(root);
    assert.notEqual(exit, 0, `${file}\n${output}`);
    const total = (await summaries(reports)).at(-1);
    assert.equal(total?.counts.failed, 1, file);
    assert.equal(total?.success, false, file);
  }
});

void test('with CI set, a skipped test makes the exit code non-zero', async (t) => {
  const skipped = "require('node:test')('skipped', { skip: true }, () => {});\n";
  const { root } = await project(t, { 'tooling/c.test.js': skipped });
  assert.equal((await run(root)).exit, 0);
  const { exit, output } = await run(root, { CI: '1' });
  assert.equal(exit, 1, output);
  assert.match(output, /CI requires the entire harness: 1 skipped test\(s\)/u);
});

void test('a subset run reports to a suffixed directory and leaves the full-run reports untouched', async (t) => {
  const { root, files } = await project(t);
  const full = await run(root);
  assert.equal(full.exit, 0, full.output);
  const before = await readFile(path.join(full.reports, 'inventory.json'), 'utf8');
  const subset = await run(root, {}, ['tooling', 'engine']);
  assert.equal(subset.exit, 0, subset.output);
  assert.equal(await readFile(path.join(full.reports, 'inventory.json'), 'utf8'), before);
  const reports = path.join(root, '.artifacts/tests/source--engine+tooling');
  const inventory = JSON.parse(await readFile(path.join(reports, 'inventory.json'), 'utf8')) as {
    files: string[];
  };
  assert.deepEqual(
    inventory.files,
    files
      .filter((file) => file.startsWith('engine/') || file.startsWith('tooling/'))
      .map((file) => path.join('.test-dist/test', file))
      .sort(),
  );
  assert.equal((await summaries(reports)).at(-1)?.counts.tests, inventory.files.length + 1);
  assert.deepEqual((await readdir(reports)).sort(), [
    'inventory.json',
    'junit.xml',
    'summary.jsonl',
  ]);
});

void test('a run that names every group reports to the unsuffixed directory', async (t) => {
  const { root, files } = await project(t);
  const { exit, output, reports } = await run(root, {}, [...GROUPS].reverse());
  assert.equal(exit, 0, output);
  assert.deepEqual(await readdir(path.join(root, '.artifacts/tests')), ['source']);
  const inventory = JSON.parse(await readFile(path.join(reports, 'inventory.json'), 'utf8')) as {
    files: string[];
  };
  assert.equal(inventory.files.length, files.length);
});
