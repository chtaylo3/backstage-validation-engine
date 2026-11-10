import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';

export function selectSshNetwork({ requested = 'auto', ci = false, docker = '', kernel = '' }) {
  assert(['auto', 'host', 'published'].includes(requested), 'Unknown SSH network strategy.');
  if (requested !== 'auto') return requested;
  return ci && !/docker desktop/iu.test(docker) && !/microsoft|wsl/iu.test(kernel)
    ? 'host'
    : 'published';
}

export function sshNetworkArgs(network) {
  assert(['host', 'published'].includes(network), 'Resolve the SSH network strategy first.');
  return network === 'host'
    ? ['--network', 'host']
    : ['--network', 'bridge', '--publish', '127.0.0.1::22'];
}

export function publishedSshEndpoint(binding) {
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(binding.trim());
  const port = Number(match?.[1]);
  assert(
    match && Number.isInteger(port) && port > 0 && port <= 65535,
    'Expected one loopback SSH port mapping.',
  );
  return { host: '127.0.0.1', port };
}

export async function reserveSshPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Both transports use real key authentication and the same remote workspace. */
export async function prepareSshConnection({
  network,
  container,
  session,
  run,
  remote,
  reservePort = reserveSshPort,
}) {
  sshNetworkArgs(network);
  const key = path.join(session, 'id_ed25519');
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  await remote('cp', [key + '.pub', '/root/.ssh/authorized_keys']);
  await remote('chmod', ['600', '/root/.ssh/authorized_keys']);
  const listener = network === 'host' ? await reservePort() : 22;
  await remote('/usr/sbin/sshd', [
    '-p',
    String(listener),
    '-o',
    'ListenAddress=' + (network === 'host' ? '127.0.0.1' : '0.0.0.0'),
  ]);
  const endpoint =
    network === 'host'
      ? { host: '127.0.0.1', port: listener }
      : publishedSshEndpoint(await run('docker', ['port', container, '22/tcp']));
  const config = path.join(session, 'ssh-config');
  await writeFile(
    config,
    `Host bve\n HostName ${endpoint.host}\n Port ${endpoint.port}\n User root\n IdentityFile ${key}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking no\n UserKnownHostsFile ${path.join(session, 'known_hosts')}\n SendEnv BVE_EDITOR_CATALOG_TOKEN BVE_LSP_CONFIG\n`,
    { mode: 0o600 },
  );
  return { ...endpoint, config, network };
}

/** Retry connection startup only. Authentication and identity failures remain failures. */
export async function authenticateSsh({
  config,
  expectedHostname,
  run,
  timeoutMs = 30_000,
  clock = () => performance.now(),
  wait = pause,
}) {
  const deadline = clock() + timeoutMs;
  let lastError;
  while (clock() < deadline) {
    try {
      const hostname = await run(
        'ssh',
        ['-F', config, '-o', 'ConnectTimeout=2', '-o', 'ConnectionAttempts=1', 'bve', 'hostname'],
        { timeout: Math.max(1, Math.floor(Math.min(5000, deadline - clock()))) },
      );
      assert.equal(hostname, expectedHostname, 'SSH must authenticate to the owned fixture host.');
      return hostname;
    } catch (error) {
      if (!/Connection refused|Connection timed out/iu.test(error.stderr ?? '') && !error.killed)
        throw error;
      lastError = error;
      if (clock() < deadline) await wait(Math.min(200, deadline - clock()));
    }
  }
  throw new Error('Authenticated SSH preflight deadline exceeded.', { cause: lastError });
}
