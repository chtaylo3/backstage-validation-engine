// Test selection for scripts/test.mjs. Every function here is pure apart from the directory walk
// in `discoverTestFiles`, so test/tooling/test-selection.test.ts can exercise them directly. Run
// directly, the module prints a named set (see NAMED_SETS) for workflows.
//
// Paths are relative to the compiled test root (`.test-dist/test`) and use forward slashes, for
// example `engine/cel-runtime.test.js`. The first path segment is the group.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The group directories under `test/`. Every `*.test.ts` file lives in exactly one of them. */
export const GROUPS = Object.freeze(['engine', 'lsp', 'cli', 'extension', 'tooling']);

/**
 * Groups whose files run concurrently by default. `BVE_TEST_PARALLEL_GROUPS` replaces this list
 * (see resolveParallelGroups). The proofs are recorded in docs/testing-harness.md.
 */
export const PARALLEL_GROUPS = Object.freeze(['engine']);

/** The upper bound for `--test-concurrency` in the parallel invocation. */
export const MAX_CONCURRENCY = 4;

/**
 * Files that must run one at a time even when their group runs in parallel, each with its reason.
 * An entry that names a missing file or has no reason is an error, so the list cannot go stale. An
 * entry whose group is not parallel in the current run changes nothing, so entries for the opt-in
 * `lsp` group are valid in the default configuration.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SERIAL_FILES = Object.freeze({
  'engine/cel-rules.test.js':
    'A 90 ms request deadline must still admit a 55 ms evaluation on a real CEL worker.',
  'engine/cel-runtime.test.js':
    'Real CEL workers with 20-60 ms queue and request windows and a 30 ms startup deadline.',
  'engine/default-boundaries.test.js':
    'The largest admitted documents must parse inside the 5 s default request deadline; failed on Windows under concurrent activity.',
  'engine/rule-contributions.test.js':
    'Saturates the shared production CEL workers and asserts on their queue pressure; failed on macOS under concurrent activity.',
  'lsp/lsp-catalog-refresh.test.js':
    'Single-shot suggestion assertions inside a 250 ms catalog freshness window; failed once under concurrent activity.',
  'lsp/lsp-rule-contributions.test.js':
    'An early repair must still be offered inside a 250 ms approved freshness window.',
});

/**
 * Named file sets that workflows run outside scripts/test.mjs. Print one with
 * `node scripts/test-selection.mjs --set <name>`; a missing file is an error.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const NAMED_SETS = Object.freeze({
  // .github/workflows/ci.yml repeats these with the packaged Windows runtime.
  'worker-lifecycle': Object.freeze(['engine/cel-runtime.test.js', 'lsp/lsp-completion.test.js']),
});

/** @typedef {{ name: 'parallel' | 'serial', concurrency: number, files: string[] }} Invocation */

/**
 * Normalizes a relative test path to forward slashes.
 *
 * @param {string} file
 */
export function normalizeTestPath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//u, '');
}

/**
 * The group of a relative test path, or undefined when the file is not inside a group directory.
 *
 * @param {string} file
 */
export function groupOf(file) {
  const [first, ...rest] = normalizeTestPath(file).split('/');
  return first !== undefined && rest.length > 0 && GROUPS.includes(first) ? first : undefined;
}

/**
 * Parses the arguments of scripts/test.mjs.
 *
 * @param {readonly string[]} argv
 */
export function parseTestArguments(argv) {
  /** @type {string[]} */
  const groups = [];
  /** @type {string | undefined} */
  let root;
  let coverage = false;
  let packaged = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--coverage') coverage = true;
    else if (argument === '--packaged') packaged = true;
    else if (argument === '--group' || argument === '--root') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`${argument} requires a value.`);
      if (argument === '--group') groups.push(value);
      else root = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { groups, root, coverage, packaged };
}

/**
 * Lists every `*.test.js` file below `directory`, recursively, as sorted relative paths with
 * forward slashes.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
export async function discoverTestFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) =>
      normalizeTestPath(path.relative(directory, path.join(entry.parentPath, entry.name))),
    )
    .sort();
}

/**
 * Selects the files of the named groups, or of every group when none is named. Fails on an empty
 * tree, on a test file outside the group directories, on an unknown group, and on a selected group
 * without test files.
 *
 * @param {readonly string[]} files All discovered files.
 * @param {readonly string[]} [groups] The requested groups; empty or omitted means all.
 */
export function selectTestFiles(files, groups = []) {
  const normalized = [...new Set(files.map(normalizeTestPath))].sort();
  if (!normalized.length) throw new Error('No compiled test files were discovered.');
  const outside = normalized.filter((file) => groupOf(file) === undefined);
  if (outside.length)
    throw new Error(
      `Test files must live in one of the group directories (${GROUPS.join(', ')}): ` +
        outside.join(', '),
    );
  const unknown = groups.filter((group) => !GROUPS.includes(group));
  if (unknown.length)
    throw new Error(
      `Unknown test group ${unknown.join(', ')}. Valid groups: ${GROUPS.join(', ')}.`,
    );
  const selected = groups.length ? [...new Set(groups)] : [...GROUPS];
  const empty = selected.filter((group) => !normalized.some((file) => groupOf(file) === group));
  if (empty.length) throw new Error(`Test group without test files: ${empty.join(', ')}.`);
  return normalized.filter((file) => selected.includes(/** @type {string} */ (groupOf(file))));
}

/**
 * The groups that run in parallel: `BVE_TEST_PARALLEL_GROUPS` (comma-separated group names) when
 * set and not empty, otherwise PARALLEL_GROUPS. Unknown or empty names are an error. The result
 * follows GROUPS order.
 *
 * @param {string | undefined} override The value of `BVE_TEST_PARALLEL_GROUPS`.
 * @returns {string[]}
 */
export function resolveParallelGroups(override) {
  if (override === undefined || override.trim() === '') return [...PARALLEL_GROUPS];
  const names = override.split(',').map((name) => name.trim());
  const invalid = names.filter((name) => !GROUPS.includes(name));
  if (invalid.length)
    throw new Error(
      `BVE_TEST_PARALLEL_GROUPS names unknown groups ${invalid.map((name) => JSON.stringify(name)).join(', ')}. ` +
        `Valid groups: ${GROUPS.join(', ')}.`,
    );
  return GROUPS.filter((group) => names.includes(group));
}

/**
 * The report directory name under `.artifacts/tests/`: the mode for a run of every group, and the
 * mode followed by `--` and the selected groups in GROUPS order (for example `source--engine+lsp`)
 * for a run of a strict subset, so that a partial run never replaces the full-run reports.
 *
 * @param {string} mode `source`, `packaged` or `coverage`.
 * @param {readonly string[]} groups The requested groups; empty means all.
 */
export function reportDirectoryName(mode, groups) {
  const selected = GROUPS.filter((group) => groups.includes(group));
  return groups.length === 0 || selected.length === GROUPS.length
    ? mode
    : `${mode}--${selected.join('+')}`;
}

/**
 * The parallel concurrency: `BVE_TEST_CONCURRENCY` when set, otherwise the smaller of
 * MAX_CONCURRENCY and the available parallelism.
 *
 * @param {string | undefined} override The value of `BVE_TEST_CONCURRENCY`.
 * @param {number} available The available parallelism of the host.
 */
export function resolveConcurrency(override, available) {
  if (override === undefined || override === '')
    return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(available)));
  if (!/^[1-9]\d*$/u.test(override))
    throw new Error(`BVE_TEST_CONCURRENCY must be a positive integer, not ${override}.`);
  return Number(override);
}

/**
 * Splits the selected files into a parallel and a serial invocation. Invocations without files are
 * left out. `forceSerial` (`BVE_TEST_CONCURRENCY=1`, or coverage) yields one serial invocation.
 *
 * @param {readonly string[]} all Every discovered file; the serial list is checked against these.
 * @param {readonly string[]} selected The files to run.
 * @param {{
 *   concurrency: number,
 *   forceSerial?: boolean,
 *   parallelGroups?: readonly string[],
 *   serialFiles?: Readonly<Record<string, string>>,
 * }} options
 * @returns {Invocation[]}
 */
export function planTestRun(all, selected, options) {
  const parallelGroups = options.parallelGroups ?? PARALLEL_GROUPS;
  const serialFiles = options.serialFiles ?? SERIAL_FILES;
  const known = new Set(all.map(normalizeTestPath));
  for (const [file, reason] of Object.entries(serialFiles)) {
    if (!known.has(file)) throw new Error(`The serial list names a missing test file: ${file}`);
    if (!reason.trim()) throw new Error(`The serial list entry ${file} needs a reason.`);
  }
  const files = [...new Set(selected.map(normalizeTestPath))].sort();
  const concurrent =
    options.forceSerial || options.concurrency <= 1
      ? []
      : files.filter(
          (file) =>
            parallelGroups.includes(/** @type {string} */ (groupOf(file))) &&
            !(file in serialFiles),
        );
  const serial = files.filter((file) => !concurrent.includes(file));
  /** @type {Invocation[]} */
  const invocations = [
    { name: 'parallel', concurrency: options.concurrency, files: concurrent },
    { name: 'serial', concurrency: 1, files: serial },
  ];
  return invocations.filter((invocation) => invocation.files.length > 0);
}

/**
 * The files of a named set, checked against the discovered files.
 *
 * @param {readonly string[]} all Every discovered file.
 * @param {string} name
 * @param {Readonly<Record<string, readonly string[]>>} [sets]
 */
export function namedTestSet(all, name, sets = NAMED_SETS) {
  const files = Object.hasOwn(sets, name) ? sets[name] : undefined;
  if (!files)
    throw new Error(`Unknown test set ${name}. Valid sets: ${Object.keys(sets).join(', ')}.`);
  const known = new Set(all.map(normalizeTestPath));
  const missing = files.filter((file) => !known.has(file));
  if (missing.length)
    throw new Error(`The test set ${name} names missing test files: ${missing.join(', ')}`);
  return [...files];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [flag, name, ...rest] = process.argv.slice(2);
  if (flag !== '--set' || name === undefined || rest.length)
    throw new Error('Usage: node scripts/test-selection.mjs --set <name>');
  const compiled = fileURLToPath(new URL('../.test-dist/test/', import.meta.url));
  for (const file of namedTestSet(await discoverTestFiles(compiled), name))
    console.log(`.test-dist/test/${file}`);
}
