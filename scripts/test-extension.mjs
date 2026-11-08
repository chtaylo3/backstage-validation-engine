import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode, runVSCodeCommand } from '@vscode/test-electron';
import { prepareFixture } from './extension-test-fixture.mjs';
import { launchEditor, readProgress } from './extension-test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifactRoot = path.join(root, '.artifacts/vscode');
const testRoot = path.join(artifactRoot, 'test');
const { runCases, junit } = await import(pathToFileURL(path.join(testRoot, 'reporting.mjs')).href);
const info = JSON.parse(await readFile(path.join(artifactRoot, 'package-info.json'), 'utf8'));
const build = JSON.parse(await readFile(path.join(info.stage, 'build-info.json'), 'utf8'));
const inventory = JSON.parse(await readFile(path.join(testRoot, 'inventory.json'), 'utf8'));
const modules = (await readdir(path.join(testRoot, 'cases')))
  .filter((name) => name.endsWith('.case.cjs'))
  .sort();
assert(modules.length > 0, 'No installed-extension cases discovered.');
assert.deepEqual(modules, inventory, 'Compiled case inventory must match the package build.');
const verify = process.argv.includes('--verify-failures');
const versions = process.env.BVE_VSCODE_VERSIONS?.split(',') ?? ['1.106.3', '1.145.2'];
// Older Electron CLIs can abort during shutdown after a successful install
// (microsoft/vscode#279806). Use one pinned installer; execute every scenario
// with the requested editor's unmodified executable and a fresh profile.
const installerVersion = '1.145.2';
assert(
  versions.length && versions.every((value) => /^\d+\.\d+\.\d+$/u.test(value)),
  'Pin exact editor versions.',
);
assert.equal(new Set(versions).size, versions.length, 'Duplicate editor versions.');
const checksum = createHash('sha256')
  .update(await readFile(info.vsix))
  .digest('hex');
const metadata = {
  platform: process.platform,
  arch: process.arch,
  target: info.target,
  revision: build.revision,
  vsix: path.basename(info.vsix),
  vsixSha256: checksum,
  installedPayload: true,
  verification: verify,
  installerVersion,
};

async function atomic(file, contents) {
  await writeFile(file + '.tmp', contents);
  await rename(file + '.tmp', file);
}
async function nativeSession(prefix) {
  return realpath(
    await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), prefix)),
  );
}
const provisions = new Map();
const directories = [];
async function provision(version) {
  if (!provisions.has(version))
    provisions.set(
      version,
      (async () => {
        const session = await nativeSession('bve-install-');
        directories.push(session);
        const installed = path.join(session, 'installed');
        const profile = path.join(session, 'profile');
        const executable = await downloadAndUnzipVSCode({ version });
        const common = ['--extensions-dir', installed, '--user-data-dir', profile, '--no-sandbox'];
        const options = {
          version: installerVersion,
          reuseMachineInstall: true,
          spawn: { env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1', VSCODE_IPC_HOOK_CLI: '' } },
        };
        await runVSCodeCommand(['--install-extension', info.vsix, '--force', ...common], options);
        const listing = await runVSCodeCommand(['--list-extensions', ...common], options);
        assert(listing.stdout.includes('chtaylo3.backstage-validation-engine'));
        return { installed, executable };
      })(),
    );
  return provisions.get(version);
}

async function execute(spec, output, fault) {
  const base = path.join(output, spec.version, spec.id);
  await mkdir(base, { recursive: true });
  const { installed, executable } = await provision(spec.version);
  const session = await nativeSession('bve-editor-');
  const workspace = await mkdtemp(path.join(tmpdir(), 'bve editor workspace-'));
  const profile = path.join(session, 'profile');
  const driver = path.join(session, 'driver');
  const progressFile = path.join(base, 'progress.json');
  let outcome;
  try {
    await Promise.all([profile, driver].map((directory) => mkdir(directory, { recursive: true })));
    const config = await prepareFixture({ session, workspace, profile, driver });
    const args = [
      workspace,
      '--extensions-dir',
      installed,
      '--user-data-dir',
      profile,
      '--extensionDevelopmentPath=' + driver,
      '--extensionTestsPath=' + path.join(testRoot, 'suite.cjs'),
      '--disable-workspace-trust',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--no-cached-data',
    ];
    await atomic(
      path.join(base, 'launch.json'),
      JSON.stringify(
        {
          editorVersion: spec.version,
          installerVersion,
          args,
          freshProfile: true,
          freshWorkspace: true,
        },
        null,
        2,
      ) + '\n',
    );
    const result = await launchEditor(
      executable,
      args,
      {
        BVE_LSP_CONFIG: config,
        BVE_EXTENSION_TEST_WORKSPACE: workspace,
        BVE_EXTENSION_TEST_INSTALL: installed,
        BVE_EXTENSION_TEST_CASE: spec.id,
        BVE_EXTENSION_TEST_VERSION: spec.version,
        BVE_EXTENSION_TEST_MODULE: path.join(testRoot, 'cases', spec.id + '.case.cjs'),
        BVE_EXTENSION_TEST_PROGRESS: progressFile,
        BVE_EXTENSION_TEST_FAULT: fault ?? '',
        DONT_PROMPT_WSL_INSTALL: '1',
        VSCODE_IPC_HOOK_CLI: '',
        NODE_PATH: '',
      },
      base,
      fault === 'crash',
    );
    const progress = await readProgress(progressFile);
    outcome = { ...result, ...(progress ? { progress } : {}) };
  } finally {
    // Keep editor logs for every outcome, including injected failures. Fixtures
    // and profiles contain only synthetic authority and are removed afterwards.
    await cp(path.join(profile, 'logs'), path.join(base, 'editor-logs'), { recursive: true }).catch(
      () => {},
    );
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(session, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(
    `VS Code ${spec.version} / ${spec.id}: exit ${outcome.exitCode}${outcome.error ? ' (' + outcome.error + ')' : ''}`,
  );
  return outcome;
}

async function runGroup(name, specs, fault) {
  const directory = path.join(artifactRoot, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return runCases(
    specs,
    { ...metadata, fault: fault ?? null },
    (spec) => execute(spec, directory, spec.id === 'startup' ? fault : undefined),
    async (report) => {
      await atomic(path.join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
      await atomic(path.join(directory, 'junit.xml'), junit(report));
    },
  );
}
try {
  if (verify) {
    const version = versions.at(-1);
    const checks = [];
    for (const fault of ['assertion', 'crash', 'cleanup']) {
      const report = await runGroup(
        'verification-' + fault,
        [
          { id: 'startup', version },
          { id: 'diagnostics', version },
        ],
        fault,
      );
      const [failed, later] = report.cases;
      checks.push({
        fault,
        passed:
          report.conclusion === 'failure' &&
          report.counts.failed === 1 &&
          report.counts.passed === 1 &&
          failed.status === 'failed' &&
          failed.phase === (fault === 'cleanup' ? 'cleanup' : 'run') &&
          later.status === 'passed' &&
          (fault !== 'crash' || failed.error.includes('Injected editor crash')),
      });
    }
    await atomic(
      path.join(artifactRoot, 'verification-summary.json'),
      JSON.stringify({ metadata, checks }, null, 2) + '\n',
    );
    assert(
      checks.every((row) => row.passed),
      'Runner must report each injected fault and execute the next independent case.',
    );
    console.log(
      'Installed-editor runner verification passed: early assertion, editor crash, cleanup failure and later-case execution.',
    );
  } else {
    const specs = versions.flatMap((version) =>
      modules.map((name) => ({ id: name.replace(/\.case\.cjs$/u, ''), version })),
    );
    const report = await runGroup('editor-results', specs);
    console.log(JSON.stringify(report.counts));
    if (report.conclusion !== 'success') process.exitCode = 1;
  }
} finally {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
