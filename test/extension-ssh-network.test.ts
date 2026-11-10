import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';

type Network = 'host' | 'published';
type Run = (file: string, args: string[], options?: { timeout: number }) => Promise<string>;
const {
  selectSshNetwork,
  sshNetworkArgs,
  publishedSshEndpoint,
  prepareSshConnection,
  authenticateSsh,
} = (await import(pathToFileURL(path.resolve('scripts/extension-ssh-network.mjs')).href)) as {
  selectSshNetwork: (input: {
    requested?: string;
    ci?: boolean;
    docker?: string;
    kernel?: string;
  }) => Network;
  sshNetworkArgs: (network: string) => string[];
  publishedSshEndpoint: (binding: string) => { host: string; port: number };
  prepareSshConnection: (options: {
    network: Network;
    container: string;
    session: string;
    run: Run;
    remote: Run;
    reservePort: () => Promise<number>;
  }) => Promise<{ config: string; network: Network; host: string; port: number }>;
  authenticateSsh: (options: {
    config: string;
    expectedHostname: string;
    run: Run;
    timeoutMs?: number;
    clock?: () => number;
    wait?: (ms: number) => Promise<void>;
  }) => Promise<string>;
};

void test('SSH networking preserves native CI host mode and chooses published ports for Docker Desktop or WSL2', () => {
  assert.equal(selectSshNetwork({ ci: true, docker: 'Ubuntu 24.04', kernel: '6.8.0' }), 'host');
  assert.equal(
    selectSshNetwork({ ci: true, docker: 'Docker Desktop', kernel: '6.8.0' }),
    'published',
  );
  assert.equal(
    selectSshNetwork({ ci: true, docker: 'Ubuntu', kernel: '6.6.87-microsoft-standard-WSL2' }),
    'published',
  );
  assert.equal(selectSshNetwork({ ci: false, docker: 'Ubuntu', kernel: '6.8.0' }), 'published');
  assert.equal(selectSshNetwork({ requested: 'host', docker: 'Docker Desktop' }), 'host');
  assert.equal(selectSshNetwork({ requested: 'published', ci: true }), 'published');
  assert.throws(() => selectSshNetwork({ requested: 'other' }), /Unknown SSH network/u);
});

void test('SSH container arguments publish only loopback in development and never combine publishing with host networking', () => {
  assert.deepEqual(sshNetworkArgs('host'), ['--network', 'host']);
  assert.deepEqual(sshNetworkArgs('published'), [
    '--network',
    'bridge',
    '--publish',
    '127.0.0.1::22',
  ]);
  assert.throws(() => sshNetworkArgs('auto'), /Resolve/u);
});

void test('Docker-assigned SSH endpoints reject missing, wildcard, multiple and invalid port mappings', () => {
  assert.deepEqual(publishedSshEndpoint('127.0.0.1:43123\r\n'), { host: '127.0.0.1', port: 43123 });
  for (const value of [
    '',
    '0.0.0.0:43123',
    '[::]:43123',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:43123\n127.0.0.1:43124',
  ])
    assert.throws(() => publishedSshEndpoint(value), /loopback SSH/u);
});

async function preparation(t: TestContext, network: Network) {
  const session = await mkdtemp(path.join(tmpdir(), 'bve-ssh-unit-'));
  t.after(() => rm(session, { recursive: true, force: true }));
  const local: { file: string; args: string[] }[] = [];
  const remote: { file: string; args: string[] }[] = [];
  const connection = await prepareSshConnection({
    network,
    container: 'owned-fixture',
    session,
    reservePort: () => {
      assert.equal(network, 'host', 'Published mode must let Docker allocate the host port.');
      return Promise.resolve(43123);
    },
    run: (file, args) => {
      local.push({ file, args });
      return Promise.resolve(file === 'docker' ? '127.0.0.1:49152' : '');
    },
    remote: (file, args) => {
      remote.push({ file, args });
      return Promise.resolve('');
    },
  });
  return { connection, local, remote, config: await readFile(connection.config, 'utf8') };
}

void test('native CI prepares the SSH listener and configuration on the same reserved loopback port', async (t) => {
  const f = await preparation(t, 'host');
  assert.deepEqual(f.remote.at(-1), {
    file: '/usr/sbin/sshd',
    args: ['-p', '43123', '-o', 'ListenAddress=127.0.0.1'],
  });
  assert.equal(f.connection.port, 43123);
  assert.match(f.config, /HostName 127\.0\.0\.1\n Port 43123\n/u);
  assert.match(f.config, /IdentitiesOnly yes\n BatchMode yes/u);
  assert(!f.local.some((call) => call.file === 'docker'));
});

void test('development prepares container port 22 but connects through the actual Docker-assigned host port', async (t) => {
  const f = await preparation(t, 'published');
  assert.deepEqual(f.remote.at(-1), {
    file: '/usr/sbin/sshd',
    args: ['-p', '22', '-o', 'ListenAddress=0.0.0.0'],
  });
  assert.deepEqual(f.local.at(-1), { file: 'docker', args: ['port', 'owned-fixture', '22/tcp'] });
  assert.equal(f.connection.port, 49152);
  assert.match(f.config, /HostName 127\.0\.0\.1\n Port 49152\n/u);
  assert(f.local.some((call) => call.file === 'ssh-keygen'));
  assert(
    f.remote.some((call) => call.file === 'cp' && call.args[1] === '/root/.ssh/authorized_keys'),
  );
});

void test('authenticated SSH readiness retries connection startup and verifies the owned remote hostname', async () => {
  let now = 0;
  let attempts = 0;
  assert.equal(
    await authenticateSsh({
      config: '/tmp/ssh fixture/config',
      expectedHostname: 'owned-fixture',
      clock: () => now,
      wait: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      run: (file, args, options) => {
        assert.equal(file, 'ssh');
        assert.deepEqual(args.slice(0, 2), ['-F', '/tmp/ssh fixture/config']);
        assert(options && options.timeout <= 5000);
        if (++attempts === 1)
          return Promise.reject(
            Object.assign(new Error('starting'), { stderr: 'Connection refused' }),
          );
        return Promise.resolve('owned-fixture');
      },
    }),
    'owned-fixture',
  );
  assert.equal(attempts, 2);
});

void test('SSH authentication or remote identity failure cannot trigger retries or a weaker transport', async () => {
  const refusal = Object.assign(new Error('authentication failed'), {
    stderr: 'Permission denied (publickey).',
  });
  const wait = () => {
    assert.fail('Authentication failure must not retry.');
  };
  await assert.rejects(
    authenticateSsh({
      config: '/tmp/config',
      expectedHostname: 'owned',
      wait,
      run: () => Promise.reject(refusal),
    }),
    (error: unknown) => error === refusal,
  );
  await assert.rejects(
    authenticateSsh({
      config: '/tmp/config',
      expectedHostname: 'owned',
      wait,
      run: () => Promise.resolve('another-host'),
    }),
    /owned fixture host/u,
  );
});

void test('an unreachable SSH fixture fails within its readiness deadline rather than skipping qualification', async () => {
  let now = 0;
  let attempts = 0;
  await assert.rejects(
    authenticateSsh({
      config: '/tmp/config',
      expectedHostname: 'owned',
      timeoutMs: 1000,
      clock: () => now,
      wait: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      run: () => {
        attempts++;
        return Promise.reject(
          Object.assign(new Error('unreachable'), { stderr: 'Connection refused' }),
        );
      },
    }),
    /preflight deadline exceeded/u,
  );
  assert(attempts > 0);
  assert.equal(now, 1000);
});

void test('SSH subprocess timeouts stay valid when the remaining monotonic budget is fractional', async () => {
  let ticks = 0;
  const hostname = await authenticateSsh({
    config: '/tmp/config',
    expectedHostname: 'owned',
    timeoutMs: 1000,
    clock: () => ++ticks * 0.25,
    run: (_file, _args, options) => {
      assert(options && Number.isInteger(options.timeout));
      assert(options.timeout > 0 && options.timeout <= 1000);
      return Promise.resolve('owned');
    },
  });
  assert.equal(hostname, 'owned');
});
