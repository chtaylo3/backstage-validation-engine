import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

interface Invocation {
  name: 'parallel' | 'serial';
  concurrency: number;
  files: string[];
}
interface Selection {
  GROUPS: readonly string[];
  PARALLEL_GROUPS: readonly string[];
  SERIAL_FILES: Readonly<Record<string, string>>;
  NAMED_SETS: Readonly<Record<string, readonly string[]>>;
  groupOf(file: string): string | undefined;
  parseTestArguments(argv: readonly string[]): {
    groups: string[];
    root: string | undefined;
    coverage: boolean;
    packaged: boolean;
  };
  discoverTestFiles(directory: string): Promise<string[]>;
  selectTestFiles(files: readonly string[], groups?: readonly string[]): string[];
  resolveConcurrency(override: string | undefined, available: number): number;
  resolveParallelGroups(override: string | undefined): string[];
  reportDirectoryName(mode: string, groups: readonly string[]): string;
  planTestRun(
    all: readonly string[],
    selected: readonly string[],
    options: {
      concurrency: number;
      forceSerial?: boolean;
      parallelGroups?: readonly string[];
      serialFiles?: Readonly<Record<string, string>>;
    },
  ): Invocation[];
  namedTestSet(
    all: readonly string[],
    name: string,
    sets?: Readonly<Record<string, readonly string[]>>,
  ): string[];
}
const selection = (await import(
  pathToFileURL(path.resolve('scripts/test-selection.mjs')).href
)) as Selection;

async function tree(t: TestContext, files: readonly string[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of files) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), '');
  }
  return directory;
}

const sample = [
  'tooling/z.test.js',
  'engine/b.test.js',
  'lsp/c.test.js',
  'engine/a.test.js',
  'cli/d.test.js',
  'extension/e.test.js',
];

void test('recursive discovery finds nested test files and ignores other files', async (t) => {
  const directory = await tree(t, [
    'engine/a.test.js',
    'engine/nested/deep/b.test.js',
    'lsp/c.test.js',
    'lsp/c.test.js.map',
    'lsp/helper.js',
    'lsp/source.test.ts',
    'fixtures/worker.js',
  ]);
  assert.deepEqual(await selection.discoverTestFiles(directory), [
    'engine/a.test.js',
    'engine/nested/deep/b.test.js',
    'lsp/c.test.js',
  ]);
  assert.deepEqual(
    selection.selectTestFiles(await selection.discoverTestFiles(directory), ['engine']),
    ['engine/a.test.js', 'engine/nested/deep/b.test.js'],
  );
});

void test('discovery and selection are sorted and stable across runs', async (t) => {
  const directory = await tree(t, sample);
  const first = await selection.discoverTestFiles(directory);
  assert.deepEqual(first, [...sample].sort());
  assert.deepEqual(await selection.discoverTestFiles(directory), first);
  assert.deepEqual(selection.selectTestFiles([...sample].reverse()), [...sample].sort());
  assert.deepEqual(
    selection.selectTestFiles(sample),
    selection.selectTestFiles([...sample].sort()),
  );
});

void test('one group selects only its directory and two groups select the union', () => {
  assert.deepEqual(selection.selectTestFiles(sample, ['lsp']), ['lsp/c.test.js']);
  assert.deepEqual(selection.selectTestFiles(sample, ['lsp', 'engine']), [
    'engine/a.test.js',
    'engine/b.test.js',
    'lsp/c.test.js',
  ]);
  assert.deepEqual(selection.selectTestFiles(sample, ['lsp', 'lsp']), ['lsp/c.test.js']);
  assert.deepEqual(selection.selectTestFiles(sample, []), [...sample].sort());
  assert.deepEqual(
    selection.parseTestArguments(['--group', 'lsp', '--coverage', '--group', 'cli']),
    {
      groups: ['lsp', 'cli'],
      root: undefined,
      coverage: true,
      packaged: false,
    },
  );
  assert.throws(() => selection.parseTestArguments(['--group']), /--group requires a value/u);
  assert.throws(() => selection.parseTestArguments(['--fast']), /Unknown argument: --fast/u);
});

void test('an unknown group fails with the list of valid groups', () => {
  assert.deepEqual(selection.GROUPS, ['engine', 'lsp', 'cli', 'extension', 'tooling']);
  assert.throws(
    () => selection.selectTestFiles(sample, ['lsp', 'unit']),
    /Unknown test group unit\. Valid groups: engine, lsp, cli, extension, tooling\./u,
  );
});

void test('an empty group and an empty tree each fail', async (t) => {
  const withoutCli = sample.filter((file) => !file.startsWith('cli/'));
  assert.throws(() => selection.selectTestFiles(withoutCli, ['cli']), /without test files: cli/u);
  assert.throws(() => selection.selectTestFiles(withoutCli), /without test files: cli/u);
  assert.deepEqual(selection.selectTestFiles(withoutCli, ['lsp']), ['lsp/c.test.js']);
  const empty = await tree(t, ['engine/helper.js']);
  assert.deepEqual(await selection.discoverTestFiles(empty), []);
  assert.throws(() => selection.selectTestFiles([]), /No compiled test files were discovered/u);
  assert.throws(
    () => selection.selectTestFiles([...sample, 'loose.test.js', 'harness/x.test.js']),
    /must live in one of the group directories .*: harness\/x\.test\.js, loose\.test\.js/u,
  );
});

void test('the serial list moves files from the parallel set and cannot name a missing file', () => {
  const serialFiles = { 'engine/b.test.js': 'Timing-sensitive.' };
  assert.deepEqual(
    selection.planTestRun(sample, sample, {
      concurrency: 4,
      parallelGroups: ['engine'],
      serialFiles,
    }),
    [
      { name: 'parallel', concurrency: 4, files: ['engine/a.test.js'] },
      {
        name: 'serial',
        concurrency: 1,
        files: [
          'cli/d.test.js',
          'engine/b.test.js',
          'extension/e.test.js',
          'lsp/c.test.js',
          'tooling/z.test.js',
        ],
      },
    ],
  );
  // The list is checked against every discovered file, so a narrower selection still validates it.
  assert.deepEqual(
    selection.planTestRun(sample, ['lsp/c.test.js'], {
      concurrency: 4,
      parallelGroups: ['engine'],
      serialFiles,
    }),
    [{ name: 'serial', concurrency: 1, files: ['lsp/c.test.js'] }],
  );
  assert.throws(
    () =>
      selection.planTestRun(sample, sample, {
        concurrency: 4,
        parallelGroups: ['engine'],
        serialFiles: { 'engine/gone.test.js': 'Stale.' },
      }),
    /serial list names a missing test file: engine\/gone\.test\.js/u,
  );
  // An entry in a group that is not parallel in this run is valid and changes nothing; it applies
  // once its group runs in parallel.
  const optIn = { 'lsp/c.test.js': 'Timing-sensitive when lsp is parallel.' };
  assert.deepEqual(
    selection.planTestRun(sample, sample, {
      concurrency: 4,
      parallelGroups: ['engine'],
      serialFiles: optIn,
    }),
    selection.planTestRun(sample, sample, {
      concurrency: 4,
      parallelGroups: ['engine'],
      serialFiles: {},
    }),
  );
  assert.deepEqual(
    selection.planTestRun(sample, sample, {
      concurrency: 4,
      parallelGroups: ['engine', 'lsp'],
      serialFiles: optIn,
    })[0],
    { name: 'parallel', concurrency: 4, files: ['engine/a.test.js', 'engine/b.test.js'] },
  );
  assert.throws(
    () =>
      selection.planTestRun(sample, sample, {
        concurrency: 4,
        parallelGroups: ['engine'],
        serialFiles: { 'engine/a.test.js': ' ' },
      }),
    /needs a reason/u,
  );
});

void test('BVE_TEST_CONCURRENCY=1 yields one serial set', () => {
  const plan = (override: string | undefined, available: number, forceSerial = false) =>
    selection.planTestRun(sample, sample, {
      concurrency: selection.resolveConcurrency(override, available),
      forceSerial,
      parallelGroups: ['engine'],
      serialFiles: {},
    });
  assert.deepEqual(plan('1', 20), [{ name: 'serial', concurrency: 1, files: [...sample].sort() }]);
  assert.deepEqual(plan(undefined, 20, true), [
    { name: 'serial', concurrency: 1, files: [...sample].sort() },
  ]);
  assert.deepEqual(
    plan(undefined, 20).map((invocation) => [invocation.name, invocation.concurrency]),
    [
      ['parallel', 4],
      ['serial', 1],
    ],
  );
  assert.equal(selection.resolveConcurrency(undefined, 20), 4);
  assert.equal(selection.resolveConcurrency('', 3), 3);
  assert.equal(selection.resolveConcurrency(undefined, 1), 1);
  assert.equal(selection.resolveConcurrency('6', 2), 6);
  for (const invalid of ['0', '-1', '1.5', 'two'])
    assert.throws(() => selection.resolveConcurrency(invalid, 20), /positive integer/u);
});

void test('paths with Windows separators normalize to the same groups', () => {
  const windows = sample.map((file) => file.replaceAll('/', '\\'));
  assert.equal(selection.groupOf('engine\\nested\\x.test.js'), 'engine');
  assert.equal(selection.groupOf('.\\lsp\\x.test.js'), 'lsp');
  assert.equal(selection.groupOf('x.test.js'), undefined);
  assert.deepEqual(selection.selectTestFiles(windows, ['lsp', 'engine']), [
    'engine/a.test.js',
    'engine/b.test.js',
    'lsp/c.test.js',
  ]);
  assert.deepEqual(
    selection.planTestRun(windows, windows, {
      concurrency: 2,
      parallelGroups: ['engine'],
      serialFiles: { 'engine/b.test.js': 'Timing-sensitive.' },
    })[0],
    { name: 'parallel', concurrency: 2, files: ['engine/a.test.js'] },
  );
});

void test('named sets resolve to existing files and reject unknown names and missing files', () => {
  const sets = { pair: ['engine/a.test.js', 'lsp/c.test.js'] };
  assert.deepEqual(selection.namedTestSet(sample, 'pair', sets), sets.pair);
  assert.throws(() => selection.namedTestSet(sample, 'other', sets), /Valid sets: pair/u);
  assert.throws(
    () => selection.namedTestSet(['engine/a.test.js'], 'pair', sets),
    /missing test files: lsp\/c\.test\.js/u,
  );
});

void test('BVE_TEST_PARALLEL_GROUPS selects the parallel groups and is validated', () => {
  assert.deepEqual(selection.PARALLEL_GROUPS, ['engine']);
  assert.deepEqual(selection.resolveParallelGroups(undefined), ['engine']);
  assert.deepEqual(selection.resolveParallelGroups(''), ['engine']);
  assert.deepEqual(selection.resolveParallelGroups('  '), ['engine']);
  assert.deepEqual(selection.resolveParallelGroups('lsp,engine'), ['engine', 'lsp']);
  assert.deepEqual(selection.resolveParallelGroups(' lsp , lsp '), ['lsp']);
  assert.throws(
    () => selection.resolveParallelGroups('engine,unit'),
    /unknown groups "unit"\. Valid groups: engine, lsp, cli, extension, tooling\./u,
  );
  assert.throws(() => selection.resolveParallelGroups('engine,'), /unknown groups ""/u);
  const plan = (groups: string | undefined, concurrency: string | undefined) =>
    selection.planTestRun(sample, sample, {
      concurrency: selection.resolveConcurrency(concurrency, 20),
      parallelGroups: selection.resolveParallelGroups(groups),
      serialFiles: {},
    });
  assert.deepEqual(plan('engine,lsp', undefined)[0], {
    name: 'parallel',
    concurrency: 4,
    files: ['engine/a.test.js', 'engine/b.test.js', 'lsp/c.test.js'],
  });
  assert.deepEqual(plan('', undefined)[0], {
    name: 'parallel',
    concurrency: 4,
    files: ['engine/a.test.js', 'engine/b.test.js'],
  });
  // BVE_TEST_CONCURRENCY=1 still forces every file into one serial invocation.
  assert.deepEqual(plan('engine,lsp', '1'), [
    { name: 'serial', concurrency: 1, files: [...sample].sort() },
  ]);
});

void test('a strict subset of the groups reports to a directory named after the mode and groups', () => {
  assert.equal(selection.reportDirectoryName('source', []), 'source');
  assert.equal(selection.reportDirectoryName('packaged', []), 'packaged');
  assert.equal(selection.reportDirectoryName('source', [...selection.GROUPS].reverse()), 'source');
  assert.equal(selection.reportDirectoryName('source', ['lsp', 'engine']), 'source--engine+lsp');
  assert.equal(
    selection.reportDirectoryName('packaged', ['tooling', 'lsp', 'engine', 'lsp']),
    'packaged--engine+lsp+tooling',
  );
  assert.equal(selection.reportDirectoryName('coverage', ['cli']), 'coverage--cli');
});

void test('the repository serial list and named sets name existing test sources', () => {
  for (const file of Object.keys(selection.SERIAL_FILES)) {
    assert(selection.groupOf(file), file);
    assert(existsSync(path.join('test', file.replace(/\.js$/u, '.ts'))), file);
  }
  for (const files of Object.values(selection.NAMED_SETS))
    for (const file of files)
      assert(existsSync(path.join('test', file.replace(/\.js$/u, '.ts'))), file);
});
