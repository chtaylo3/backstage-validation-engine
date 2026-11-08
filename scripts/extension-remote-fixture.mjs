import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareFixture } from './extension-test-fixture.mjs';

// Runs with the packaged Linux Node inside the actual workspace host.
const [session, testBundle, version, mode, revision, repositoryRoot] = process.argv.slice(2);
if (!session || !testBundle || !version || !['ssh-remote', 'dev-container', 'wsl'].includes(mode))
  throw new Error('Remote fixture arguments are required.');
const workspace = path.join(session, 'workspace');
const driver = '/root/.vscode-server/extensions/local.bve-remote-driver-0.0.1';
await mkdir(workspace, { recursive: true });
await mkdir(driver, { recursive: true });
const config = await prepareFixture({
  session,
  workspace,
  profile: path.join(session, 'unused-profile'),
  driver,
});
await cp(testBundle, path.join(session, 'test'), { recursive: true });
if (!process.env.BVE_EDITOR_CATALOG_TOKEN || !repositoryRoot)
  throw new Error('Remote fixture requires native host credentials and contract artifacts.');
const daemon = spawn(
  '/opt/bve-node',
  [path.join(session, 'test/remote-catalog.cjs'), repositoryRoot, session],
  {
    env: { ...process.env, NODE_PATH: path.join(repositoryRoot, 'node_modules') },
    detached: true,
    stdio: 'ignore',
  },
);
daemon.unref();
let catalog;
const deadline = Date.now() + 20_000;
while (!catalog) {
  catalog = await readFile(path.join(session, 'catalog.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => undefined);
  if (Date.now() > deadline) throw new Error('Remote pinned catalog did not start.');
  if (!catalog) await pause(30);
}
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
const env = {
  BVE_EXTENSION_TEST_CASE: 'remote-session',
  BVE_EXTENSION_TEST_VERSION: version,
  BVE_EXTENSION_TEST_CONFIG: config,
  BVE_EXTENSION_TEST_WORKSPACE: workspace,
  BVE_EXTENSION_TEST_INSTALL: '/root/.vscode-server/extensions',
  BVE_EXTENSION_TEST_MODULE: path.join(session, 'test/cases/remote-session.case.cjs'),
  BVE_EXTENSION_TEST_PROGRESS: path.join(session, 'progress.json'),
  BVE_EXTENSION_TEST_CLOSE_MARKER: path.join(session, 'close.json'),
  BVE_EXTENSION_TEST_REMOTE_NAME: mode === 'dev-container' ? 'attached-container' : mode,
  BVE_EXTENSION_TEST_REMOTE_HOSTNAME: os.hostname(),
  BVE_EXTENSION_TEST_REVISION: revision,
  BVE_EXTENSION_TEST_CREDENTIAL_SHA: createHash('sha256')
    .update(process.env.BVE_EDITOR_CATALOG_TOKEN)
    .digest('hex'),
  BVE_EXTENSION_TEST_CONTROL_URL: catalog.controlUrl,
  BVE_EXTENSION_TEST_CONTROL_TOKEN: catalog.controlToken,
  BVE_EXTENSION_TEST_CATALOGS: JSON.stringify(catalog.catalogs),
};
await writeFile(
  path.join(driver, 'package.json'),
  JSON.stringify({
    name: 'bve-remote-driver',
    publisher: 'local',
    version: '0.0.1',
    engines: { vscode: '^1.106.0' },
    extensionKind: ['workspace'],
    main: 'index.cjs',
    activationEvents: ['onStartupFinished'],
    capabilities: { untrustedWorkspaces: { supported: true } },
  }),
);
await writeFile(
  path.join(driver, 'index.cjs'),
  `exports.activate=()=>{Object.assign(process.env,${JSON.stringify(env)});const vscode=require('vscode');void require(${JSON.stringify(path.join(session, 'test/suite.cjs'))}).run().then(()=>vscode.commands.executeCommand('workbench.action.quit'),e=>{console.error(e);return vscode.commands.executeCommand('workbench.action.quit')}).catch(console.error)};\n`,
);
await writeFile(
  path.join(session, 'fixture.json'),
  JSON.stringify({
    config,
    workspace,
    driver,
    hostname: os.hostname(),
    mode,
    version,
    catalogPid: catalog.pid,
  }),
);
