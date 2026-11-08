import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVSCodeCommand, VSCodeCliError } from './extension-test-cli.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.artifacts/vscode/cli-results');
await mkdir(out, { recursive: true });
const info = JSON.parse(
  await readFile(path.join(root, '.artifacts/vscode/package-info.json'), 'utf8'),
);
const build = JSON.parse(await readFile(path.join(info.stage, 'build-info.json'), 'utf8'));
const checksum = createHash('sha256')
  .update(await readFile(info.vsix))
  .digest('hex');
assert.equal(checksum, (await readFile(info.vsix + '.sha256', 'utf8')).split(/\s/u)[0]);
if (process.env.GITHUB_SHA) assert.equal(build.revision, process.env.GITHUB_SHA);
const directory = await mkdtemp(path.join(tmpdir(), 'bve CLI & %BVE_CLI_LITERAL% ^ (é) '));
const installed = path.join(directory, 'extensions & (é)');
const profile = path.join(directory, 'profile %BVE_CLI_LITERAL%');
const shared = path.join(directory, 'shared ^ (é)');
const vsix = path.join(directory, 'candidate & %BVE_CLI_LITERAL% (é).vsix');
const id = 'chtaylo3.backstage-validation-engine';
const common = [
  '--extensions-dir',
  installed,
  '--user-data-dir',
  profile,
  '--shared-data-dir=' + shared,
  '--no-sandbox',
];
const warnings = [];
const onWarning = (warning) => warnings.push(warning.code ?? warning.name);
process.on('warning', onWarning);
const report = {
  revision: build.revision,
  target: info.target,
  vsixSha256: checksum,
  installerVersion: '1.145.2',
  platform: process.platform,
  status: 'running',
  warnings,
  cases: [
    'version',
    'install',
    'list',
    'invalid-vsix',
    'uninstall',
    'list-after-uninstall',
    'reinstall',
    'list-after-reinstall',
    'literal-paths-and-payload',
  ].map((id) => ({ id, status: 'unexecuted' })),
};
const save = () =>
  writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
async function check(id, run) {
  const row = report.cases.find((row) => row.id === id);
  row.status = 'running';
  const start = Date.now();
  await save();
  try {
    await run();
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed';
    row.error = error.stack ?? String(error);
    throw error;
  } finally {
    row.durationMs = Date.now() - start;
    await save();
  }
}
const options = {
  version: report.installerVersion,
  env: {
    BVE_CLI_LITERAL: 'must-not-expand',
    VSCODE_DEV: 'must-clear',
    VSCODE_IPC_HOOK_CLI: 'must-clear',
    ELECTRON_RUN_AS_NODE: '0',
  },
};
async function cli(args) {
  const result = await runVSCodeCommand([...args, ...common], options);
  assert.doesNotMatch(result.stdout + result.stderr, /DEP0190/u);
  return result;
}
async function listing(present) {
  const result = await cli(['--list-extensions', '--show-versions']);
  const actual = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith(id + '@'));
  assert.deepEqual(actual, present ? [id + '@' + info.version] : []);
}
let failure;
try {
  await copyFile(info.vsix, vsix);
  await check('version', async () => {
    const result = await cli(['--version']);
    assert.equal(result.stdout.trim().split(/\r?\n/u)[0], report.installerVersion);
  });
  await check('install', () => cli(['--install-extension', vsix, '--force']));
  await check('list', () => listing(true));
  await check('invalid-vsix', async () => {
    await assert.rejects(
      cli(['--install-extension', path.join(directory, 'missing & (é).vsix')]),
      (error) => {
        assert(error instanceof VSCodeCliError);
        assert.equal(error.reason, 'exit');
        assert(Number.isInteger(error.exitCode) && error.exitCode !== 0);
        assert((error.stdout + error.stderr).trim().length > 0);
        assert.doesNotMatch(error.stdout + error.stderr, /DEP0190/u);
        return true;
      },
    );
    await listing(true);
  });
  await check('uninstall', () => cli(['--uninstall-extension', id]));
  await check('list-after-uninstall', () => listing(false));
  await check('reinstall', () => cli(['--install-extension', vsix, '--force']));
  await check('list-after-reinstall', () => listing(true));
  await check('literal-paths-and-payload', async () => {
    assert((await stat(installed)).isDirectory());
    assert((await stat(profile)).isDirectory());
    const extensions = (await readdir(installed)).filter((name) => name.startsWith(id + '-'));
    assert.equal(extensions.length, 1);
    const payload = JSON.parse(
      await readFile(path.join(installed, extensions[0], 'build-info.json'), 'utf8'),
    );
    assert.deepEqual(payload, build);
    assert(!warnings.includes('DEP0190'));
  });
} catch (error) {
  failure = error;
} finally {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    failure ??= error;
  }
  process.removeListener('warning', onWarning);
  if (warnings.includes('DEP0190')) failure ??= new Error('The CLI emitted DEP0190.');
  report.status = failure ? 'failed' : 'passed';
  report.counts = {
    discovered: report.cases.length,
    executed: report.cases.filter((row) => row.status !== 'unexecuted').length,
    passed: report.cases.filter((row) => row.status === 'passed').length,
    failed: report.cases.filter((row) => row.status === 'failed').length,
    unexecuted: report.cases.filter((row) => row.status === 'unexecuted').length,
  };
  if (failure) report.error = failure.stack ?? String(failure);
  await save();
}
if (failure) throw failure;
console.log(
  'Native CLI qualification passed: nine checks, exact VSIX, literal paths and no DEP0190.',
);
