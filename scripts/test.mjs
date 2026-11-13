// Runs the compiled tests in `.test-dist/test/<group>/` and writes junit.xml, summary.jsonl and
// inventory.json (and lcov.info with --coverage) to `.artifacts/tests/<mode>/`. A run of a strict
// subset of the groups writes to `.artifacts/tests/<mode>--<group>+<group>/` instead, so it never
// replaces the full-run reports.
//
//   node scripts/test.mjs [--group <name>]... [--coverage | --packaged] [--root <directory>]
//
// Parallel groups (PARALLEL_GROUPS, or BVE_TEST_PARALLEL_GROUPS) run in one `node --test`
// invocation with --test-concurrency set to min(4, available parallelism); everything else runs in
// a second invocation with --test-concurrency=1. The reports of both invocations are merged.
// BVE_TEST_CONCURRENCY=1 runs everything in one serial invocation, and --coverage always does, so
// that lcov.info comes from a single run. --root points the runner at another project tree (used by
// the runner's own tests).
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  discoverTestFiles,
  parseTestArguments,
  planTestRun,
  reportDirectoryName,
  resolveConcurrency,
  resolveParallelGroups,
  selectTestFiles,
} from './test-selection.mjs';

/**
 * @typedef {{
 *   success?: boolean,
 *   counts: Record<string, number>,
 *   duration_ms?: number,
 *   file?: string,
 * }} Summary
 */

const options = parseTestArguments(process.argv.slice(2));
const root = options.root
  ? path.resolve(options.root)
  : fileURLToPath(new URL('../', import.meta.url));
const { packaged, coverage } = options;
const compiled = path.join(root, '.test-dist/test');
const discovered = await discoverTestFiles(compiled);
const selected = selectTestFiles(discovered, options.groups);
const invocations = planTestRun(discovered, selected, {
  concurrency: resolveConcurrency(process.env.BVE_TEST_CONCURRENCY, availableParallelism()),
  forceSerial: coverage,
  parallelGroups: resolveParallelGroups(process.env.BVE_TEST_PARALLEL_GROUPS),
});
const reports = path.join(
  root,
  '.artifacts/tests',
  reportDirectoryName(coverage ? 'coverage' : packaged ? 'packaged' : 'source', options.groups),
);
await mkdir(reports, { recursive: true });
const runtime = packaged
  ? path.join(
      root,
      '.artifacts/vscode/stage/runtime',
      process.platform === 'win32' ? 'node.exe' : 'node',
    )
  : process.execPath;
const reporter = pathToFileURL(
  fileURLToPath(new URL('./ci-test-reporter.mjs', import.meta.url)),
).href;
const env = {
  ...process.env,
  ...(packaged
    ? {
        BVE_TEST_LSP_ENTRY: path.join(root, '.artifacts/vscode/stage/server/dist/lsp/stdio.js'),
        BVE_TEST_CLI_ENTRY: path.join(root, '.artifacts/vscode/stage/server/dist/cli/main.js'),
      }
    : {}),
};
const parts = path.join(reports, 'parts');
await rm(parts, { recursive: true, force: true });

/** @type {{ name: string, exit: number, junit: string, summary: string }[]} */
const results = [];
for (const invocation of invocations) {
  const directory = path.join(parts, invocation.name);
  await mkdir(directory, { recursive: true });
  const junit = path.join(directory, 'junit.xml');
  const summary = path.join(directory, 'summary.jsonl');
  const args = [
    '--test',
    `--test-concurrency=${invocation.concurrency}`,
    '--test-timeout=30000',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=junit',
    `--test-reporter-destination=${junit}`,
    `--test-reporter=${reporter}`,
    `--test-reporter-destination=${summary}`,
    ...(coverage
      ? [
          '--experimental-test-coverage',
          '--test-reporter=lcov',
          `--test-reporter-destination=${path.join(reports, 'lcov.info')}`,
        ]
      : []),
    ...invocation.files.map((file) => path.join(compiled, file)),
  ];
  if (invocations.length > 1)
    console.log(
      `# ${invocation.name}: ${invocation.files.length} file(s), concurrency ${invocation.concurrency}`,
    );
  /** @type {number} */
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(runtime, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  results.push({ name: invocation.name, exit, junit, summary });
}

/** @type {Summary[]} */
const rows = [];
/** @type {Summary[]} */
const totals = [];
for (const result of results) {
  /** @type {Summary[]} */
  const summaries = (await readFile(result.summary, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const total = summaries.findLast((row) => row.file === undefined) ?? summaries.at(-1);
  if (!total?.counts)
    throw new Error(`The ${result.name} test run did not produce a complete summary.`);
  rows.push(...summaries.filter((row) => row !== total));
  totals.push(total);
}
/** @type {Summary} */
const summary =
  totals.length === 1
    ? /** @type {Summary} */ (totals[0])
    : {
        success: totals.every((total) => total.success !== false),
        counts: totals.reduce((sum, total) => {
          for (const [key, value] of Object.entries(total.counts))
            sum[key] = (sum[key] ?? 0) + value;
          return sum;
        }, /** @type {Record<string, number>} */ ({})),
        duration_ms: totals.reduce((sum, total) => sum + (total.duration_ms ?? 0), 0),
      };
await writeFile(
  path.join(reports, 'summary.jsonl'),
  [...rows, summary].map((row) => JSON.stringify(row) + '\n').join(''),
);
await writeFile(
  path.join(reports, 'junit.xml'),
  mergeJunit(await Promise.all(results.map((result) => readFile(result.junit, 'utf8'))), summary),
);
await writeFile(
  path.join(reports, 'inventory.json'),
  JSON.stringify(
    {
      packaged,
      platform: process.platform,
      arch: process.arch,
      runtime,
      files: selected.map((file) => path.relative(root, path.join(compiled, file))),
      summary,
      invocations: invocations.map((invocation) => ({
        name: invocation.name,
        concurrency: invocation.concurrency,
        files: invocation.files.map((file) => path.relative(root, path.join(compiled, file))),
      })),
    },
    null,
    2,
  ) + '\n',
);
await rm(parts, { recursive: true, force: true });
const skipped = summary.counts.skipped ?? 0;
const exit = results.find((result) => result.exit !== 0)?.exit ?? 0;
if (process.env.CI && skipped) {
  console.error(`CI requires the entire harness: ${skipped} skipped test(s) must be investigated.`);
  process.exitCode = 1;
} else process.exitCode = exit;

/**
 * Merges the junit reports of the invocations into one `<testsuites>` document whose trailing
 * count comments describe the merged summary. A single report is returned unchanged.
 *
 * @param {string[]} documents
 * @param {Summary} merged
 */
function mergeJunit(documents, merged) {
  if (documents.length === 1) return /** @type {string} */ (documents[0]);
  const counters = /^\t<!-- (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) .* -->$/u;
  const bodies = documents.map((document) => {
    const start = document.indexOf('<testsuites>');
    const end = document.lastIndexOf('</testsuites>');
    if (start < 0 || end < start) throw new Error('A test run wrote an incomplete junit report.');
    const lines = document.slice(start + '<testsuites>'.length, end).split('\n');
    while (
      lines.length &&
      (lines.at(-1) === '' || counters.test(/** @type {string} */ (lines.at(-1))))
    )
      lines.pop();
    return lines.filter((line) => line !== '').join('\n');
  });
  const counts = merged.counts;
  const trailer = [
    ['tests', counts.tests],
    ['suites', counts.suites],
    ['pass', counts.passed],
    ['fail', counts.failed],
    ['cancelled', counts.cancelled],
    ['skipped', counts.skipped],
    ['todo', counts.todo],
    ['duration_ms', merged.duration_ms],
  ].map(([name, value]) => `\t<!-- ${name} ${value ?? 0} -->`);
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n' +
    [...bodies.filter(Boolean), ...trailer].join('\n') +
    '\n</testsuites>\n'
  );
}
