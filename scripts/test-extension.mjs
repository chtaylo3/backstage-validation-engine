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
import { readable } from './extension-test-permissions.mjs';
import { debugPort, controlTrust } from './extension-test-ui.mjs';
import { setTimeout as pause } from 'node:timers/promises';

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
const focused = process.argv.find((value) => value.startsWith('--case='))?.slice(7);
const racesOnly = process.argv.includes('--races');
const trustOnly = process.argv.includes('--trust');
const repeat = Number(
  process.argv.find((value) => value.startsWith('--repeat='))?.slice(9) ??
    process.env.BVE_RACE_REPETITIONS ??
    1,
);
assert(
  Number.isInteger(repeat) && repeat >= 1 && repeat <= 20 && (repeat === 1 || racesOnly),
  'Only the race suite can request 1–20 independent repetitions.',
);
assert(!focused || !process.env.CI, 'CI must run the complete installed-extension inventory.');
const selectedModules = focused
  ? modules.filter((name) => name === focused + '.case.cjs')
  : racesOnly
    ? modules.filter((name) => name.startsWith('race-') || name.startsWith('workspace-'))
    : trustOnly
      ? modules.filter((name) => name.startsWith('trust-'))
      : modules;
assert(selectedModules.length > 0, 'Requested editor case was not discovered.');
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
  focused: focused ?? null,
  scope: racesOnly ? 'races' : trustOnly ? 'trust' : 'portable',
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

async function execute(spec, output, fault, peer) {
  if (spec.id === 'workspace-two-windows' && !peer) return executePeers(spec, output);
  const base = path.join(output, spec.version, spec.id, peer?.id ?? '');
  await mkdir(base, { recursive: true });
  const { installed, executable } = await provision(spec.version);
  const session = await nativeSession('bve-editor-');
  const workspace =
    peer?.workspace ?? (await mkdtemp(path.join(tmpdir(), 'bve editor workspace-')));
  const profile = path.join(session, 'profile');
  const driver = path.join(session, 'driver');
  const progressFile = path.join(base, 'progress.json');
  const closeMarker = path.join(base, 'native-window-state.json');
  let outcome;
  let closedCleanly = false;
  const trust = spec.id.startsWith('trust-');
  const autonomous = trust || ['workspace-close-live', 'workspace-reload-live'].includes(spec.id);
  const additionalWorkspaces = [];
  let denied;
  let catalog;
  try {
    await Promise.all([profile, driver].map((directory) => mkdir(directory, { recursive: true })));
    const multi = spec.id === 'workspace-multi-root';
    const extraFiles = multi
      ? [
          { name: 'other/catalog.yaml', entity: 'other' },
          { name: 'other/catalog [a]{b}.yaml', entity: 'escaped' },
        ]
      : [];
    const config = await prepareFixture({
      session,
      workspace,
      profile,
      driver,
      extraFiles,
      expectedLifecycle: peer?.id === 'b' ? 'stable' : 'production',
      authorityId: peer ? 'window-' + peer.id : 'editor-test',
      autonomousSuite: autonomous ? path.join(testRoot, 'suite.cjs') : undefined,
    });
    let workspaceArgument = workspace;
    if (multi) {
      workspaceArgument = path.join(session, 'multi.code-workspace');
      await writeFile(
        workspaceArgument,
        JSON.stringify({
          folders: [{ path: workspace }, { path: path.join(workspace, 'other') }],
          settings: { 'backstageValidation.configPath': 'workspace-cannot-select-authority' },
        }),
      );
      await mkdir(path.join(workspace, 'unapproved'), { recursive: true });
      await cp(
        path.join(workspace, 'catalog.yaml'),
        path.join(workspace, 'unapproved/catalog.yaml'),
      );
    }
    if (
      [
        'race-delayed-validation',
        'race-delayed-completion',
        'race-shutdown-validation',
        'workspace-close-live',
        'workspace-reload-live',
      ].includes(spec.id)
    ) {
      const { createEditorCatalog } = await import(
        pathToFileURL(path.join(testRoot, 'catalog-fixture.cjs')).href
      );
      catalog = await createEditorCatalog(root);
      const value = JSON.parse(await readFile(config, 'utf8'));
      value.catalog = {
        connectionId: 'editor-primary',
        baseUrl: catalog.catalogs[0].baseUrl,
        principalId: 'editor-reader',
        credentialRevision: '1',
        scope: ['catalog:read'],
        maxAgeMs: 5000,
        tokenEnv: 'BVE_EDITOR_CATALOG_TOKEN',
      };
      await writeFile(config, JSON.stringify(value));
    }
    let launchConfig = config;
    const mode = spec.id.startsWith('config-') ? spec.id.slice('config-'.length) : undefined;
    if (mode) {
      const bad = path.join(session, 'invalid-launcher.json');
      const valid = JSON.parse(await readFile(config, 'utf8'));
      if (mode === 'absent') launchConfig = '';
      else if (mode === 'relative') launchConfig = 'relative.json';
      else if (mode === 'missing') launchConfig = bad;
      else {
        let text;
        if (mode === 'unreadable') text = JSON.stringify(valid);
        else if (mode === 'malformed') text = '{';
        else if (mode === 'structure') text = '{}';
        else if (mode === 'server-init') text = JSON.stringify({ source: valid.source });
        else if (mode === 'non-file')
          text = JSON.stringify({ source: { files: [{ uri: 'untitled:blocked' }] } });
        else if (mode === 'file-limit')
          text = JSON.stringify({
            source: {
              files: Array.from({ length: 1001 }, () => ({ uri: valid.source.files[0].uri })),
            },
          });
        else if (mode === 'byte-limit') text = JSON.stringify(valid) + ' '.repeat(32 * 1024 * 1024);
        else throw new Error('Unknown configuration fault: ' + mode);
        await writeFile(bad, text);
        if (mode === 'unreadable') {
          await readable(bad, false);
          denied = bad;
          await assert.rejects(
            readFile(bad),
            (error) => error.code === 'EACCES' || error.code === 'EPERM',
            'Native file permissions must actually deny access.',
          );
        }
        launchConfig = bad;
      }
    }
    const args = [
      workspaceArgument,
      '--extensions-dir',
      installed,
      '--user-data-dir',
      profile,
      '--extensionDevelopmentPath=' + driver,
      ...(autonomous ? [] : ['--extensionTestsPath=' + path.join(testRoot, 'suite.cjs')]),
      ...(trust ? ['--locale', 'en'] : ['--disable-workspace-trust']),
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--no-cached-data',
    ];
    if (spec.id === 'race-apply-delivery') {
      args.push('--log', 'chtaylo3.backstage-validation-engine:trace');
      const settings = path.join(profile, 'User/settings.json');
      const value = JSON.parse(await readFile(settings, 'utf8'));
      value['backstageValidation.trace.server'] = 'verbose';
      await writeFile(settings, JSON.stringify(value));
    }
    const closePort =
      spec.id === 'workspace-close-live' && process.platform === 'darwin'
        ? await debugPort()
        : undefined;
    if (closePort)
      args.push('--remote-debugging-port=' + closePort, '--remote-debugging-address=127.0.0.1');
    let seenCloseWindow = false;
    await atomic(
      path.join(base, 'launch.json'),
      JSON.stringify(
        {
          editorVersion: spec.version,
          installerVersion,
          args,
          freshProfile: true,
          freshWorkspace: true,
          driverMode: autonomous ? 'normal-workbench' : 'extension-tests',
        },
        null,
        2,
      ) + '\n',
    );
    const launch = async (sessionArgs, env, directory, signal) =>
      launchEditor(
        executable,
        sessionArgs,
        {
          BVE_LSP_CONFIG: launchConfig,
          BVE_EXTENSION_TEST_CONFIG: config,
          BVE_EXTENSION_TEST_WORKSPACE: workspace,
          BVE_EXTENSION_TEST_INSTALL: installed,
          BVE_EXTENSION_TEST_CASE: spec.id,
          BVE_EXTENSION_TEST_VERSION: spec.version,
          BVE_EXTENSION_TEST_MODULE: path.join(testRoot, 'cases', spec.id + '.case.cjs'),
          BVE_EXTENSION_TEST_PROGRESS: progressFile,
          BVE_EXTENSION_TEST_PROFILE: profile,
          BVE_EXTENSION_TEST_CLOSE_MARKER: closeMarker,
          BVE_EXTENSION_TEST_FAULT: fault ?? '',
          BVE_EXTENSION_TEST_PEER: peer?.id ?? '',
          BVE_EXTENSION_TEST_PEER_CONTROL: peer?.control ?? '',
          BVE_EXTENSION_TEST_CONTROL_URL: catalog?.controlUrl ?? '',
          BVE_EXTENSION_TEST_CONTROL_TOKEN: catalog?.controlToken ?? '',
          BVE_EXTENSION_TEST_CATALOGS: JSON.stringify(catalog?.catalogs ?? []),
          BVE_EDITOR_CATALOG_TOKEN: catalog?.token ?? '',
          DONT_PROMPT_WSL_INSTALL: '1',
          VSCODE_IPC_HOOK_CLI: '',
          NODE_PATH: '',
          ...env,
        },
        directory,
        fault === 'crash',
        spec.id !== 'workspace-close-live'
          ? undefined
          : async () => {
              const marker = JSON.parse(await readFile(closeMarker, 'utf8'));
              assert.equal(marker.id, spec.id);
              assert.equal(marker.command, 'workbench.action.closeWindow');
              const state = await readProgress(progressFile);
              assert(
                state?.serverPids.includes(marker.pid),
                'Observe only the owned packaged server.',
              );
              assert(
                catalog &&
                  catalog
                    .evidence()
                    .events.some(
                      (event) => event.id === marker.gateId && event.event === 'entered',
                    ),
                'Close must interrupt an actually held validation request.',
              );
              const end = Date.now() + 20_000;
              while (true) {
                try {
                  process.kill(marker.pid, 0);
                } catch (error) {
                  if (error.code === 'ESRCH') break;
                  throw error;
                }
                if (Date.now() >= end)
                  throw new Error(
                    'Window close left the packaged server alive before parent cleanup.',
                  );
                await pause(30);
              }
              assert(
                catalog
                  .evidence()
                  .events.some(
                    (event) => event.id === marker.gateId && event.event === 'cancelled',
                  ),
                'Close cancels validation before fixture cleanup.',
              );
              await atomic(
                path.join(base, 'parent-observation.json'),
                JSON.stringify(
                  {
                    editorExited: !closePort,
                    windowClosed: true,
                    serverExitedBeforeParentCleanup: true,
                    pid: marker.pid,
                  },
                  null,
                  2,
                ) + '\n',
              );
              closedCleanly = true;
            },
        signal,
        closePort
          ? async () => {
              const targets = await globalThis
                .fetch(`http://127.0.0.1:${closePort}/json/list`)
                .then((response) => response.json())
                .catch(() => null);
              if (!targets) return false;
              const visible = targets.some(
                (target) => target.type === 'page' && target.url.includes('workbench'),
              );
              if (visible) seenCloseWindow = true;
              return seenCloseWindow && !visible && !!(await readProgress(closeMarker));
            }
          : undefined,
      );
    let result;
    if (trust) {
      const settings = path.join(profile, 'User/settings.json');
      const value = JSON.parse(await readFile(settings, 'utf8'));
      value['security.workspace.trust.enabled'] = true;
      value['security.workspace.trust.startupPrompt'] = 'never';
      await writeFile(settings, JSON.stringify(value));
      const sessions = [];
      const count = ['trust-persisted', 'trust-unrelated'].includes(spec.id) ? 2 : 1;
      let currentWorkspace = workspace;
      for (let stage = 0; stage < count; stage++) {
        if (stage === 1) {
          await atomic(
            path.join(base, 'session-0-progress.json'),
            await readFile(progressFile, 'utf8'),
          );
          await rm(progressFile, { force: true });
          if (spec.id === 'trust-unrelated') {
            currentWorkspace = await nativeSession('bve-unrelated-');
            additionalWorkspaces.push(currentWorkspace);
            await Promise.all(
              ['catalog.yaml', 'team.yaml'].map((name) =>
                cp(path.join(workspace, name), path.join(currentWorkspace, name)),
              ),
            );
          }
        }
        const port = await debugPort();
        const sessionArgs = [
          currentWorkspace,
          ...args.slice(1),
          '--remote-debugging-port=' + port,
          '--remote-debugging-address=127.0.0.1',
        ];
        const directory = path.join(base, 'session-' + stage);
        await mkdir(directory, { recursive: true });
        const abort = new globalThis.AbortController();
        let exited = false;
        const editor = launch(
          sessionArgs,
          {
            BVE_EXTENSION_TEST_CONTROL_DIRECTORY: base,
            BVE_EXTENSION_TEST_TRUST_STAGE: String(stage),
            BVE_EXTENSION_TEST_WORKSPACE: currentWorkspace,
          },
          directory,
          abort.signal,
        ).finally(() => {
          exited = true;
        });
        const ui = controlTrust({ port, base, stage, isExited: () => exited }).catch((error) => {
          abort.abort();
          throw error;
        });
        const completed = await Promise.allSettled([editor, ui]);
        const failed = completed.find((entry) => entry.status === 'rejected');
        if (failed) throw failed.reason;
        result = completed[0].value;
        const progress = await readProgress(progressFile);
        sessions.push({ stage, workspace: currentWorkspace, result, progress });
        await atomic(
          path.join(base, 'native-sessions.json'),
          JSON.stringify(sessions, null, 2) + '\n',
        );
        if (result.exitCode !== 0 || result.error || progress?.status !== 'passed') break;
      }
    } else result = await launch(args, {}, base);
    const progress = await readProgress(progressFile);
    if (closedCleanly && !result.error && progress) {
      progress.status = 'passed';
      progress.phase = 'complete';
      progress.parentObservedWindowClose = true;
      await atomic(progressFile, JSON.stringify(progress, null, 2) + '\n');
    }
    outcome = { ...result, ...(progress ? { progress } : {}) };
  } catch (error) {
    const progress = await readProgress(progressFile).catch(() => undefined);
    outcome = {
      exitCode: 1,
      error: error.stack ?? String(error),
      ...(progress ? { progress } : {}),
    };
  } finally {
    const cleanups = await Promise.allSettled([
      (async () => {
        if (catalog) {
          try {
            await catalog.close();
          } finally {
            await atomic(
              path.join(base, 'catalog-events.json'),
              JSON.stringify(catalog.evidence(), null, 2) + '\n',
            );
          }
        }
      })(),
      denied ? readable(denied, true) : Promise.resolve(),
    ]);
    // Keep editor logs for every outcome, including injected failures. Fixtures
    // and profiles contain only synthetic authority and are removed afterwards.
    await cp(path.join(profile, 'logs'), path.join(base, 'editor-logs'), { recursive: true }).catch(
      () => {},
    );
    const removed = await Promise.allSettled(
      [...(peer ? [session] : [workspace, session]), ...additionalWorkspaces].map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      ),
    );
    const errors = [...cleanups, ...removed].flatMap((value) =>
      value.status === 'rejected' ? [String(value.reason)] : [],
    );
    if (errors.length) {
      outcome ??= { exitCode: 1 };
      outcome.exitCode = 1;
      outcome.error = [outcome.error, ...errors].filter(Boolean).join('\n');
      outcome.progress = {
        ...outcome.progress,
        id: spec.id,
        phase: 'cleanup',
        status: 'failed',
        serverPids: outcome.progress?.serverPids ?? [],
      };
    }
  }
  console.log(
    `VS Code ${spec.version} / ${spec.id}: exit ${outcome.exitCode}${outcome.error ? ' (' + outcome.error + ')' : ''}`,
  );
  if (outcome.progress?.error)
    console.error(`${spec.id} / ${outcome.progress.phase}: ${outcome.progress.error}`);
  return outcome;
}

async function executePeers(spec, output) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'bve shared workspace-'));
  const control = await nativeSession('bve-peers-');
  let outcomes;
  try {
    const results = await Promise.allSettled(
      ['a', 'b'].map((id) => execute(spec, output, undefined, { id, workspace, control })),
    );
    outcomes = results.map((value) =>
      value.status === 'fulfilled' ? value.value : { exitCode: 1, error: String(value.reason) },
    );
    const failed = outcomes.find(
      (value) => value.exitCode !== 0 || value.error || value.progress?.status !== 'passed',
    );
    const base = path.join(output, spec.version, spec.id);
    await atomic(path.join(base, 'peer-results.json'), JSON.stringify(outcomes, null, 2) + '\n');
    await cp(control, path.join(base, 'peer-observations'), { recursive: true });
    return (
      failed ?? {
        exitCode: 0,
        progress: {
          id: spec.id,
          editorVersion: spec.version,
          phase: 'complete',
          status: 'passed',
          serverPids: outcomes.flatMap((value) => value.progress.serverPids),
        },
      }
    );
  } finally {
    await Promise.all(
      [workspace, control].map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      ),
    );
  }
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
      selectedModules.map((name) => ({ id: name.replace(/\.case\.cjs$/u, ''), version })),
    );
    const repetitions = [];
    for (let iteration = 1; iteration <= repeat; iteration++) {
      const name = focused
        ? 'editor-focused'
        : racesOnly
          ? `race-results-${iteration}`
          : 'editor-results';
      const report = await runGroup(name, specs);
      console.log(JSON.stringify(report.counts));
      repetitions.push({ iteration, conclusion: report.conclusion, counts: report.counts });
      if (report.conclusion !== 'success') process.exitCode = 1;
    }
    if (racesOnly)
      await atomic(
        path.join(artifactRoot, 'race-summary.json'),
        JSON.stringify({ metadata, repetitions }, null, 2) + '\n',
      );
  }
} finally {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
