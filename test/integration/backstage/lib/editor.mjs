import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { build } from 'esbuild';
import { launchEditor, readProgress } from '../../../../scripts/extension-test-process.mjs';
import {
  resolveVSCodeCli,
  runCli as runNativeCli,
} from '../../../../scripts/extension-test-cli.mjs';
import { debugPort, screenshot } from '../editor/cdp.mjs';
import { EDITORS, writeJson } from './evidence.mjs';
import { createClientFixture, installClient, runCli } from './clients.mjs';

const integrationRoot = fileURLToPath(new URL('../', import.meta.url));
const productId = 'chtaylo3.backstage-validation-engine';
const installerVersion = '1.145.2';
const workRoot = '/run/work/editor';
const provisions = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function alive(pid) {
  try {
    process.kill(pid, 0);
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    return !!status && !/^State:\s+Z/mu.test(status);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function until(check, description, timeout = 20_000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    assert(performance.now() < deadline, 'Timed out: ' + description);
    await delay(30);
  }
}
async function display() {
  assert(process.env.DISPLAY, 'Run the editor driver through the test image virtual display.');
  return { value: process.env.DISPLAY, close: async () => {} };
}

async function provision(version, vsix) {
  assert(EDITORS.includes(version), 'Use a declared pinned editor.');
  const digest = hash(await readFile(vsix));
  const key = version + '/' + digest;
  if (!provisions.has(key))
    provisions.set(
      key,
      (async () => {
        await mkdir(workRoot, { recursive: true, mode: 0o700 });
        const session = await mkdtemp(path.join(workRoot, 'install-'));
        const installed = path.join(session, 'installed');
        const profile = path.join(session, 'profile');
        const cachePath = path.join(workRoot, 'downloads');
        const executable = await downloadAndUnzipVSCode({
          version,
          platform: 'linux-x64',
          cachePath,
        });
        const installer =
          version === installerVersion
            ? executable
            : await downloadAndUnzipVSCode({
                version: installerVersion,
                platform: 'linux-x64',
                cachePath,
              });
        const { cli } = await resolveVSCodeCli(installer);
        const common = [
          '--extensions-dir',
          installed,
          '--user-data-dir',
          profile,
          '--shared-data-dir=' + path.join(session, 'shared-data'),
          '--no-sandbox',
        ];
        await runNativeCli(installer, cli, ['--install-extension', vsix, '--force', ...common], {
          env: { DONT_PROMPT_WSL_INSTALL: '1' },
        });
        const listing = await runNativeCli(installer, cli, ['--list-extensions', ...common]);
        assert(
          listing.stdout.split(/\r?\n/u).includes(productId),
          'Install the actual VSIX candidate.',
        );
        const directories = (await readdir(installed, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(productId + '-'),
        );
        assert.equal(directories.length, 1);
        const installedPath = path.join(installed, directories[0].name);
        const buildInfo = JSON.parse(
          await readFile(path.join(installedPath, 'build-info.json'), 'utf8'),
        );
        assert.equal(buildInfo.target, 'linux-x64');
        const node = path.join(installedPath, 'runtime/node');
        assert.equal(
          hash(await readFile(node)),
          buildInfo.nodeSha256,
          'Verify the bundled runtime.',
        );
        return {
          installed,
          executable,
          revision: buildInfo.revision,
          vsixSha256: digest,
          installerVersion,
          editorVersion: version,
        };
      })(),
    );
  return provisions.get(key);
}

async function copyLogs(source, destination, secrets) {
  let count = 0;
  async function copy(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const local = path.join(directory, entry.name);
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await copy(local, name);
      else if (entry.isFile() && entry.name.endsWith('.log') && count++ < 200) {
        let text = await readFile(local, 'utf8');
        for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
        text = text.slice(0, 2 * 1024 * 1024);
        const target = path.join(destination, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text);
      }
    }
  }
  await copy(source);
}

async function singleSession(options, id, provisioned, visual, fault) {
  const directory = path.join(options.reportDirectory, fault ? 'fault-' + fault : id);
  await mkdir(directory, { recursive: true });
  await mkdir(options.controlDirectory, { recursive: true });
  const session = await mkdtemp(path.join(workRoot, 'session-'));
  try {
    const profile = path.join(session, 'profile');
    const driver = path.join(session, 'driver');
    const workspace = path.join(session, 'workspace');
    const fixture = await createClientFixture({
      directory: path.join(session, 'trusted'),
      workspace,
      baseUrl: options.base,
      profile: options.fixture?.profile,
    });
    await mkdir(path.join(profile, 'User'), { recursive: true });
    await mkdir(driver, { recursive: true });
    await writeJson(path.join(profile, 'User/settings.json'), {
      'backstageValidation.configPath': fixture.configPath,
      'telemetry.telemetryLevel': 'off',
      'workbench.enableExperiments': false,
      'extensions.autoUpdate': false,
      'extensions.ignoreRecommendations': true,
      'chat.disableAIFeatures': true,
      'workbench.startupEditor': 'none',
      'update.mode': 'none',
      'files.autoSave': 'off',
      'files.saveConflictResolution': 'askUser',
    });
    await mkdir(path.join(workspace, '.vscode'), { recursive: true });
    await writeJson(path.join(workspace, '.vscode/settings.json'), {
      'backstageValidation.configPath': path.join(workspace, 'untrusted-launcher.json'),
    });
    await writeJson(path.join(driver, 'package.json'), {
      name: 'backstage-real-test-driver',
      publisher: 'local',
      version: '0.0.1',
      engines: { vscode: '^1.106.0' },
      main: 'index.cjs',
      activationEvents: [],
    });
    await writeFile(path.join(driver, 'index.cjs'), 'exports.activate = () => {};\n');
    const suite = path.join(driver, 'suite.cjs');
    await build({
      entryPoints: [path.join(integrationRoot, 'editor/suite.mjs')],
      outfile: suite,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['vscode'],
    });
    const progressFile = path.join(directory, 'progress.json');
    const screenshotAcknowledgement = path.join(session, 'screenshot-ack.json');
    const input = {
      id,
      version: options.version,
      revision: provisioned.revision,
      configPath: fixture.configPath,
      sourceFile: fixture.sourceFile,
      validText: fixture.validText,
      invalidText: fixture.invalidText,
      installed: provisioned.installed,
      base: options.base,
      controlDirectory: options.controlDirectory,
      integrationRoot,
      progressFile,
      screenshotAcknowledgement,
      ...(fault ? { fault } : {}),
    };
    if (id === 'editor.watcher') {
      const engine = await installClient();
      input.watchedFile = path.join(workspace, 'watched.yaml');
      input.groupText =
        'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: watched-team, namespace: bve-demo}\nspec: {type: team, children: []}\n';
      input.invalidGroupText = input.groupText.replace(
        'spec: {type: team, children: []}',
        'spec: {}',
      );
      input.validText = fixture.validText.replace(
        'group:bve-demo/team-demo',
        'group:bve-demo/watched-team',
      );
      input.invalidText = input.validText.replace(
        'lifecycle: production',
        'lifecycle: experimental',
      );
      await writeFile(fixture.sourceFile, input.invalidText);
      await writeFile(input.watchedFile, input.groupText);
      const launcher = JSON.parse(await readFile(fixture.configPath, 'utf8'));
      const files = [
        { uri: pathToFileURL(fixture.sourceFile).href, text: input.invalidText },
        { uri: pathToFileURL(input.watchedFile).href, text: input.groupText },
      ];
      launcher.source = engine.createSourceSnapshot({
        repository: fixture.source.repository,
        revision: fixture.source.revision,
        rootUri: pathToFileURL(workspace + path.sep).href,
        files,
        entrypoints: files.map((row) => row.uri),
      });
      launcher.filesystem = {
        files: files.map((row) => row.uri),
        entrypoints: files.map((row) => row.uri),
      };
      await writeJson(fixture.configPath, launcher);
    }
    const inputFile = path.join(session, 'input.json');
    await writeFile(inputFile, JSON.stringify(input, null, 2) + '\n', { mode: 0o600 });
    const port = await debugPort();
    const args = [
      workspace,
      '--extensions-dir',
      provisioned.installed,
      '--user-data-dir',
      profile,
      '--shared-data-dir=' + path.join(session, 'shared-data'),
      '--extensionDevelopmentPath=' + driver,
      '--extensionTestsPath=' + suite,
      '--disable-workspace-trust',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--no-cached-data',
      '--remote-debugging-port=' + port,
      '--remote-debugging-address=127.0.0.1',
    ];
    await writeJson(path.join(directory, 'launch.json'), {
      id,
      editorVersion: options.version,
      installerVersion,
      revision: provisioned.revision,
      vsixSha256: provisioned.vsixSha256,
      installedPayload: true,
      freshProfile: true,
      freshWorkspace: true,
      developmentExtension: 'test driver only',
    });
    const env = {
      DISPLAY: visual.value,
      BVE_LSP_CONFIG: fixture.configPath,
      BVE_BACKSTAGE_EDITOR_INPUT: inputFile,
      BVE_BACKSTAGE_READER_TOKEN: options.readerToken ?? process.env.BVE_BACKSTAGE_READER_TOKEN,
      BVE_BACKSTAGE_ADMIN_TOKEN: options.adminToken ?? process.env.BVE_BACKSTAGE_ADMIN_TOKEN,
      BVE_BACKSTAGE_DENIED_TOKEN: options.deniedToken ?? process.env.BVE_BACKSTAGE_DENIED_TOKEN,
      BVE_EXTENSION_TEST_CASE: 'real-backstage-editor',
      BVE_EXTENSION_TEST_PROGRESS: progressFile,
      DONT_PROMPT_WSL_INSTALL: '1',
      VSCODE_IPC_HOOK_CLI: '',
      NODE_PATH: '',
    };
    const secrets = [
      env.BVE_BACKSTAGE_READER_TOKEN,
      env.BVE_BACKSTAGE_ADMIN_TOKEN,
      env.BVE_BACKSTAGE_DENIED_TOKEN,
    ];
    let finished = false;
    const monitor = (async () => {
      while (!finished) {
        const progress = await readProgress(progressFile).catch(() => null);
        if (progress?.screenshotRequested) {
          await screenshot(port, path.join(directory, 'failure.png')).catch(async (error) =>
            writeJson(path.join(directory, 'screenshot-failure.json'), { name: error.name }),
          );
          await writeJson(screenshotAcknowledgement, { complete: true });
          break;
        }
        await delay(50);
      }
    })();
    let launched;
    try {
      launched = await launchEditor(
        provisioned.executable,
        args,
        env,
        directory,
        fault === 'crash',
        async () => {
          const progress = await readProgress(progressFile);
          assert.equal(progress?.status, 'passed');
          assert.equal(progress?.cleanup?.status, 'passed');
          assert(progress.serverPids.length > 0);
          for (const pid of progress.serverPids)
            assert.equal(await alive(pid), false, 'The server must exit before parent cleanup.');
        },
      );
    } finally {
      finished = true;
      await monitor;
      await copyLogs(path.join(profile, 'logs'), path.join(directory, 'editor-logs'), secrets);
      const log = path.join(directory, 'editor-process.log');
      let text = await readFile(log, 'utf8').catch(() => '');
      for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
      await writeFile(log, text);
    }
    let progress = await readProgress(progressFile);
    if (fault === 'crash') {
      assert(
        launched.error?.includes('Injected editor crash'),
        'Terminate an actual entered editor case.',
      );
      assert(progress?.phase === 'run' && progress.status === 'running');
      assert(progress.serverPids.length > 0);
      for (const pid of progress.serverPids)
        await until(async () => !(await alive(pid)), 'crashed editor server cleanup');
      progress = {
        ...progress,
        status: 'failed',
        failure: {
          name: 'InjectedEditorCrash',
          message: 'The owned editor process was deliberately terminated.',
        },
        parentObservedCleanup: 'passed',
      };
      await writeJson(progressFile, progress);
      return { progress, launched };
    }
    assert.equal(launched.exitCode, 0, 'The native editor must exit successfully.');
    assert(!launched.error, launched.error);
    assert.equal(progress?.status, 'passed', 'The child must report an actual completed case.');
    assert.equal(progress?.phase, 'complete');
    assert.equal(progress?.cleanup?.status, 'passed');
    let parity;
    if (id === 'editor.parity') {
      const cli = await runCli(fixture, progress.result.text, { token: options.readerToken });
      assert.equal(cli.code, 1);
      assert.equal(cli.report.outcome, 'completed');
      assert(cli.report.coverage.filter((row) => row.required).length > 0);
      assert(cli.report.coverage.every((row) => !row.required || row.status === 'verified'));
      assert.equal(progress.result.requiredCoverageVerified, true);
      assert.equal(progress.result.coverageEvidence, 'guarded-fix-eligibility');
      const cliFindings = cli.report.findings.map((row) => ({
        ruleId: row.ruleId,
        category: row.category,
        findingId: row.id,
        uri: row.location.uri,
        range: row.location.range,
      }));
      const order = (rows) => [...rows].sort((a, b) => a.findingId.localeCompare(b.findingId));
      assert.deepEqual(
        order(progress.result.findings),
        order(cliFindings),
        'Both installed clients must agree on stable IDs, source locations, categories and rules.',
      );
      parity = {
        findings: cliFindings,
        cliCoverage: cli.report.coverage,
        editorCoverageEvidence: progress.result.coverageEvidence,
        sourceUri: progress.result.sourceUri,
        sourceTextSha256: hash(progress.result.text),
        cliEnforcement: cli.report.enforcement,
        editorEnforcement: 'advisory',
      };
      await writeJson(path.join(directory, 'parity.json'), parity);
    }
    return { progress, launched, ...(parity ? { parity } : {}) };
  } finally {
    await rm(session, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export async function runEditor(options) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  const vsix = options.config?.vsix ?? process.env.BVE_BACKSTAGE_VSIX ?? '/candidate/product.vsix';
  const provisioned = await provision(options.version, vsix);
  const visual = await display();
  const inventory = JSON.parse(await readFile(path.join(integrationRoot, 'cases.json'), 'utf8'));
  const ids = inventory.cases.filter((row) => row.scope === 'editor').map((row) => row.id);
  assert.equal(ids.length, 12);
  let failure;
  let parity;
  try {
    for (const id of ids) {
      try {
        const result = await options.evidence.run(
          id,
          'editor',
          () => singleSession(options, id, provisioned, visual),
          options.version,
        );
        if (result.parity) parity = result.parity;
      } catch (error) {
        failure ??= error;
      }
    }
  } finally {
    await visual.close();
  }
  if (failure) throw failure;
  assert(parity, 'Require actual installed-client parity evidence.');
  return parity;
}

export async function verifyEditorCrash(options) {
  const version = options.version ?? installerVersion;
  const normalized = { ...options, version };
  const vsix = options.config?.vsix ?? process.env.BVE_BACKSTAGE_VSIX ?? '/candidate/product.vsix';
  const provisioned = await provision(version, vsix);
  const visual = await display();
  try {
    const crash = await singleSession(
      normalized,
      'editor.installation',
      provisioned,
      visual,
      'crash',
    );
    assert.equal(crash.progress.status, 'failed');
    const next = await singleSession(normalized, 'editor.installation', provisioned, visual);
    assert.equal(next.progress.status, 'passed');
    const result = {
      crash: {
        status: crash.progress.status,
        phase: crash.progress.phase,
        parentObservedCleanup: crash.progress.parentObservedCleanup,
      },
      next: { status: next.progress.status, phase: next.progress.phase },
    };
    await writeJson(path.join(options.reportDirectory, 'failure-accounting.json'), result);
    return result;
  } finally {
    await visual.close();
  }
}
