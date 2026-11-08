import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode, runTests, runVSCodeCommand } from '@vscode/test-electron';
import {
  CONTRACT_VERSION,
  DEFAULT_DEPLOYMENT_PROFILE,
  createSourceSnapshot,
  digestJson,
} from '../dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const info = JSON.parse(
  await readFile(path.join(root, '.artifacts/vscode/package-info.json'), 'utf8'),
);
const versions = process.env.BVE_VSCODE_VERSIONS?.split(',') ?? ['1.106.3', '1.145.2'];
for (const version of versions) {
  const base = path.join(root, '.artifacts/vscode', `editor-${version}`);
  await rm(base, { recursive: true, force: true });
  const workspace = await mkdtemp(path.join(tmpdir(), 'bve editor workspace-'));
  const installed = path.join(base, 'installed');
  const profile = path.join(base, 'profile');
  const driver = path.join(base, 'driver');
  await Promise.all(
    [workspace, installed, profile, driver].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await mkdir(path.join(profile, 'User'), { recursive: true });
  await writeFile(
    path.join(profile, 'User/settings.json'),
    JSON.stringify({
      'telemetry.telemetryLevel': 'off',
      'workbench.enableExperiments': false,
      'extensions.autoUpdate': false,
      'extensions.ignoreRecommendations': true,
      'chat.disableAIFeatures': true,
      'workbench.startupEditor': 'none',
      'update.mode': 'none',
    }),
  );
  await mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await writeFile(
    path.join(workspace, '.vscode/settings.json'),
    JSON.stringify({
      'backstageValidation.configPath': path.join(workspace, 'untrusted-selection.json'),
    }),
  );
  await writeFile(
    path.join(driver, 'package.json'),
    JSON.stringify({
      name: 'bve-test-driver',
      publisher: 'local',
      version: '0.0.1',
      engines: { vscode: '^1.106.0' },
      main: 'index.cjs',
    }),
  );
  await writeFile(path.join(driver, 'index.cjs'), 'exports.activate = () => {};\n');
  const component =
    'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service}\nspec:\n  type: service\n  lifecycle: experimental\n  owner: team\n';
  const team =
    'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {type: team, children: []}\n';
  await writeFile(path.join(workspace, 'catalog.yaml'), component);
  await writeFile(path.join(workspace, 'team.yaml'), team);
  const uri = (name) => pathToFileURL(path.join(workspace, name)).href;
  const schema = {
    type: 'object',
    properties: { spec: { type: 'object', properties: { lifecycle: { const: 'production' } } } },
  };
  const artifact = {
    contractVersion: CONTRACT_VERSION,
    id: 'editor/production',
    version: '1',
    schema,
    digest: digestJson(schema),
  };
  const policy = {
    contractVersion: CONTRACT_VERSION,
    id: 'editor-test',
    revision: '1',
    extends: [],
    schemas: [],
    plugins: [],
    rules: [
      {
        id: 'production-only',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: [],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
      {
        id: 'owner-exists',
        version: '1',
        kind: 'catalog',
        mandatory: true,
        severity: 'error',
        requires: [],
        referencePath: '/spec/owner',
        check: 'exists',
        selector: 'entity.kind == "Component"',
      },
    ],
  };
  const source = createSourceSnapshot({
    repository: 'editor-fixture',
    revision: '1',
    rootUri: pathToFileURL(workspace + path.sep).href,
    entrypoints: [uri('catalog.yaml'), uri('team.yaml')],
    files: [
      { uri: uri('catalog.yaml'), text: component },
      { uri: uri('team.yaml'), text: team },
    ],
  });
  const config = path.join(base, 'trusted-launcher.json');
  await writeFile(
    config,
    JSON.stringify({
      profile: DEFAULT_DEPLOYMENT_PROFILE,
      policy,
      schemaArtifacts: [artifact],
      source,
      identity: {
        installationId: 'editor-test',
        repositoryId: 'editor-test',
        authorityRef: 'synthetic-editor-test',
        permissionRevision: '1',
      },
      activation: {
        contractVersion: CONTRACT_VERSION,
        generation: 1,
        installationId: 'editor-test',
        repositoryId: 'editor-test',
        policyDigest: digestJson(policy),
        profileDigest: digestJson(DEFAULT_DEPLOYMENT_PROFILE),
        bypassDigest: digestJson([]),
        activatedAt: Date.now() - 1000,
        authority: {
          repository: 'synthetic-editor-test',
          revision: '1',
          verifierId: 'synthetic-editor-test',
          evidenceDigest: digestJson({ fixture: true }),
        },
      },
      filesystem: {
        files: [uri('catalog.yaml'), uri('team.yaml')],
        entrypoints: [uri('catalog.yaml'), uri('team.yaml')],
      },
      debounceMs: 0,
    }),
    { mode: 0o600 },
  );
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version });
  await runVSCodeCommand(
    [
      '--install-extension',
      info.vsix,
      '--force',
      '--extensions-dir',
      installed,
      '--user-data-dir',
      profile,
      '--no-sandbox',
    ],
    {
      version,
      reuseMachineInstall: true,
      spawn: { env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1', VSCODE_IPC_HOOK_CLI: '' } },
    },
  );
  const listing = await runVSCodeCommand(
    [
      '--list-extensions',
      '--extensions-dir',
      installed,
      '--user-data-dir',
      profile,
      '--no-sandbox',
    ],
    {
      version,
      reuseMachineInstall: true,
      spawn: { env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1', VSCODE_IPC_HOOK_CLI: '' } },
    },
  );
  assert(listing.stdout.includes('chtaylo3.backstage-validation-engine'));
  try {
    const exit = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: driver,
      extensionTestsPath: path.join(root, '.artifacts/vscode/test/suite.cjs'),
      reuseMachineInstall: true,
      launchArgs: [
        workspace,
        '--extensions-dir',
        installed,
        '--user-data-dir',
        profile,
        '--disable-gpu',
        '--no-sandbox',
      ],
      extensionTestsEnv: {
        BVE_LSP_CONFIG: config,
        BVE_EXTENSION_TEST_WORKSPACE: workspace,
        BVE_EXTENSION_TEST_INSTALL: installed,
        NODE_PATH: '',
      },
    });
    assert.equal(exit, 0);
    await writeFile(
      path.join(base, 'results.json'),
      JSON.stringify(
        {
          version,
          target: info.target,
          vsix: path.basename(info.vsix),
          installedPayload: true,
          conclusion: 'success',
          cases: [
            'startup',
            'diagnostics',
            'reference-completion',
            'versioned-fix',
            'stale-fix-replay',
            'save',
            'watch-refresh',
            'watch-repair',
            'restart',
            'shutdown',
          ],
        },
        null,
        2,
      ) + '\n',
    );
  } catch (error) {
    await writeFile(
      path.join(base, 'results.json'),
      JSON.stringify({ version, target: info.target, conclusion: 'failure' }, null, 2) + '\n',
    );
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
