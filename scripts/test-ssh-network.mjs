import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  authenticateSsh,
  prepareSshConnection,
  selectSshNetwork,
  sshNetworkArgs,
} from './extension-ssh-network.mjs';

const exec = promisify(execFile);
const run = async (file, args, options = {}) =>
  (
    await exec(file, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      ...options,
    })
  ).stdout.trim();
const requested = process.argv.find((value) => value.startsWith('--network='))?.slice(10) ?? 'auto';
const docker = JSON.parse(await run('docker', ['info', '--format', '{{json .OperatingSystem}}']));
const network = selectSshNetwork({
  requested,
  ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
  docker,
  kernel: release(),
});
const out = path.resolve('.artifacts/vscode/ssh-network-preflight', network);
const session = await mkdtemp(path.join(tmpdir(), 'bve-ssh-preflight-'));
const name = 'bve-ssh-preflight-' + randomUUID();
const evidence = {
  scope: 'authenticated-ssh-preflight',
  network,
  docker,
  status: 'running',
  productSessions: 0,
};
let container;
try {
  assert.equal(process.platform, 'linux', 'Container SSH preflight requires Linux.');
  await mkdir(out, { recursive: true });
  await run('docker', ['build', '-t', 'bve-editor-remote-fixture', 'test/fixtures/editor-remote'], {
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  container = await run('docker', [
    'run',
    '-d',
    '--init',
    '--name',
    name,
    '--hostname',
    name,
    ...sshNetworkArgs(network),
    '--mount',
    `type=bind,source=${session},target=${session}`,
    'bve-editor-remote-fixture',
    'sleep',
    'infinity',
  ]);
  const remote = (file, args) => run('docker', ['exec', container, file, ...args]);
  const connection = await prepareSshConnection({ network, container, session, run, remote });
  const hostname = await authenticateSsh({
    config: connection.config,
    expectedHostname: name,
    run,
  });
  Object.assign(evidence, {
    status: 'passed',
    endpoint: { host: connection.host, port: connection.port },
    hostname,
  });
} catch (error) {
  evidence.status = 'failed';
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  if (container) {
    await run('docker', [
      'exec',
      container,
      'chown',
      '-R',
      `${process.getuid()}:${process.getgid()}`,
      session,
    ]).catch((error) => {
      evidence.cleanupError = String(error);
      evidence.status = 'failed';
      process.exitCode = 1;
    });
    await run('docker', ['rm', '-f', container]).catch((error) => {
      evidence.cleanupError = String(error);
      evidence.status = 'failed';
      process.exitCode = 1;
    });
  }
  await rm(session, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}
