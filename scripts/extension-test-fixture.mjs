import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTRACT_VERSION,
  DEFAULT_DEPLOYMENT_PROFILE,
  createSourceSnapshot,
  digestJson,
} from '../dist/index.js';

export async function prepareFixture({ session, workspace, profile, driver }) {
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
  const config = path.join(session, 'trusted-launcher.json');
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
  return config;
}
