#!/usr/bin/env node
// Runs the sign-in flow against a persistent Backstage test environment that
// `npm run backstage:test:up -- --target=<release> --run=<id>` started. From the repository root:
//
//   node test/integration/backstage/oidc/run.mjs --run=<id>
//
// It generates a one-day certificate authority and a certificate for `client-document`, starts the
// client-document service, restarts Backstage with that authority and a sign-in overlay, runs
// `flow.mjs` in the test container, and restores the environment as it found it. The sanitized
// report is `<reportDirectory>/oidc/flow-<release>.json`.
//
// `--serve` sets up the same sign-in configuration and leaves it running, for runs by hand with a
// browser and VS Code; `--restore` removes it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { unmetHostExpectations } from './expectations.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const integration = path.join(root, 'test/integration/backstage');
const runId = process.argv.find((value) => value.startsWith('--run='))?.slice(6);
assert.match(
  runId ?? '',
  /^[a-z0-9][a-z0-9-]{0,60}$/u,
  'Supply --run=<id> of a running environment.',
);
const state = JSON.parse(
  await readFile(path.join(root, '.artifacts/backstage-private', runId + '.json'), 'utf8'),
);
assert(!state.mode, 'Use a persistent environment, not a suite run.');
const CLIENT_ORIGIN = 'https://client-document:8443';
const SECOND_USER = 'user:bve-demo/bve-denied-user';
const FIRST_USER = 'user:bve-demo/alice';
const LIFETIME_MINUTES = 15;
const oidc = path.join(state.privateDirectory, 'oidc');
const override = path.join(oidc, 'compose.oidc.json');
const out = path.join(state.reportDirectory, 'oidc');
const controlDirectory = path.join(out, 'control');
const uid = `${process.getuid()}:${process.getgid()}`;

const labels = { 'io.bve.integration.run': state.runId, 'io.bve.integration.owner': state.owner };
const run = async (file, args, options = {}) =>
  exec(file, args, { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 600_000, ...options });
const compose = (args, withOverride = true, options = {}) =>
  run(
    'docker',
    [
      'compose',
      '--project-name',
      state.project,
      '--env-file',
      state.environment,
      '-f',
      path.join(integration, 'compose.yaml'),
      ...(withOverride ? ['-f', override] : []),
      ...args,
    ],
    options,
  );

async function certificates() {
  await mkdir(oidc, { recursive: true, mode: 0o755 });
  await chmod(oidc, 0o755);
  const file = (name) => path.join(oidc, name);
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=bve-oidc-test-authority',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    file('authority.key'),
    '-out',
    file('ca.pem'),
  ]);
  await writeFile(
    file('server.ext'),
    'subjectAltName=DNS:client-document\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n',
  );
  await run('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=client-document',
    '-keyout',
    file('client-document.key'),
    '-out',
    file('client-document.csr'),
  ]);
  await run('openssl', [
    'x509',
    '-req',
    '-in',
    file('client-document.csr'),
    '-CA',
    file('ca.pem'),
    '-CAkey',
    file('authority.key'),
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    file('server.ext'),
    '-out',
    file('client-document.pem'),
  ]);
  for (const name of ['authority.key', 'client-document.csr', 'server.ext', 'ca.srl'])
    await rm(file(name), { force: true });
  for (const name of ['ca.pem', 'client-document.pem']) await chmod(file(name), 0o644);
  await chmod(file('client-document.key'), 0o600);
}

/** The sign-in overlay that Backstage reads after `app-config.test.yaml`. JSON is YAML. */
async function overlay(user) {
  await writeFile(
    path.join(oidc, 'active.yaml'),
    JSON.stringify({
      auth: {
        backstageTokenExpiration: { minutes: LIFETIME_MINUTES },
        providers: { guest: { userEntityRef: user } },
      },
    }) + '\n',
    { mode: 0o644 },
  );
}

async function writeOverride() {
  const mounts = [`${oidc}:/oidc:ro`];
  const harness = `${integration}:/harness:ro`;
  await writeFile(
    override,
    JSON.stringify(
      {
        services: {
          backstage: {
            environment: { NODE_EXTRA_CA_CERTS: '/oidc/ca.pem' },
            volumes: mounts,
            command: [
              'node',
              'packages/backend/src/index.mjs',
              '--config',
              'app-config.test.yaml',
              '--config',
              '/oidc/active.yaml',
            ],
          },
          'client-document': {
            image: '${BVE_TEST_IMAGE}',
            init: true,
            user: uid,
            labels,
            entrypoint: ['node'],
            command: [
              '/harness/oidc/client-document.mjs',
              '--directory=/oidc',
              `--origin=${CLIENT_ORIGIN}`,
            ],
            volumes: [...mounts, harness],
          },
          test: {
            environment: { NODE_EXTRA_CA_CERTS: '/oidc/ca.pem' },
            volumes: [...mounts, harness],
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
}

async function ready() {
  const until = Date.now() + 180_000;
  for (;;) {
    const status = await globalThis
      .fetch(`${state.publicUrl}/api/auth/.well-known/openid-configuration`, {
        signal: globalThis.AbortSignal.timeout(3000),
      })
      .then((response) => response.status)
      .catch(() => 0);
    const health = await globalThis
      .fetch(`${state.publicUrl}/.backstage/health/v1/readiness`, {
        signal: globalThis.AbortSignal.timeout(3000),
      })
      .then((response) => response.status)
      .catch(() => 0);
    if (status === 200 && health === 200) return;
    assert(Date.now() < until, 'Backstage did not become ready.');
    await pause(1000);
  }
}

async function restartBackstage(user) {
  await overlay(user);
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'backstage']);
  await ready();
}

async function serveControl(flow) {
  const seen = new Set();
  let settled = false;
  void flow.finally(() => {
    settled = true;
  });
  while (!settled) {
    const request = await readFile(path.join(controlDirectory, 'request.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (request && !seen.has(request.id)) {
      seen.add(request.id);
      let status = 'passed';
      try {
        assert.equal(request.action, 'variant');
        assert.equal(request.variant, 'second-user');
        await restartBackstage(SECOND_USER);
      } catch (error) {
        status = 'failed';
        console.error(error);
      }
      await writeFile(
        path.join(controlDirectory, 'acknowledgement.json'),
        JSON.stringify({ id: request.id, status }),
      );
    }
    await pause(200);
  }
}

async function backstageLogFacts() {
  const logs = await compose(['logs', '--no-color', 'backstage'], false).catch((error) => error);
  const text = (logs.stdout ?? '') + (logs.stderr ?? '');
  return {
    sqliteRotationWarning: text.includes(
      'Refresh tokens are enabled with SQLite, which does not support row-level locking',
    ),
    userPermissionDecisions: text
      .split('\n')
      .filter((line) => line.includes('BVE_USER_PERMISSION_DECISION'))
      .map((line) => line.slice(line.indexOf('{')))
      .filter((line, index, all) => all.indexOf(line) === index),
  };
}

/** Restore the environment that `backstage:test:up` created. */
async function restore() {
  await compose(['rm', '--stop', '--force', 'client-document']).catch(() => undefined);
  await run('docker', [
    'compose',
    '--project-name',
    state.project,
    '--env-file',
    state.environment,
    '-f',
    path.join(integration, 'compose.yaml'),
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    '--remove-orphans',
    'backstage',
  ]);
  await ready();
  await rm(oidc, { recursive: true, force: true });
  await rm(controlDirectory, { recursive: true, force: true });
}

// --serve leaves the sign-in configuration running for a person's browser and VS Code, and
// --restore removes it again. Neither runs the flow.
if (process.argv.includes('--restore')) {
  await restore();
  console.log(JSON.stringify({ runId, restored: true }));
  process.exit(0);
}
if (process.argv.includes('--serve')) {
  await certificates();
  await writeOverride();
  await overlay(FIRST_USER);
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'backstage', 'client-document']);
  await ready();
  console.log(
    JSON.stringify(
      {
        runId,
        browserUrl: state.publicUrl,
        authorizationServer: `${state.publicUrl}/api/auth`,
        clientId: `${CLIENT_ORIGIN}/vscode-client.json`,
        redirectUri: 'vscode://chtaylo3.backstage-validation-engine/sign-in',
        guestUser: FIRST_USER,
        restore: `node test/integration/backstage/oidc/run.mjs --run=${runId} --restore`,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

await rm(out, { recursive: true, force: true });
await mkdir(controlDirectory, { recursive: true });
let failure;
try {
  await certificates();
  await writeOverride();
  await overlay(FIRST_USER);
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'backstage', 'client-document']);
  await ready();
  const flow = compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '--user',
      uid,
      '--entrypoint',
      'node',
      'test',
      '/harness/oidc/flow.mjs',
      `--release=${state.target}`,
      `--public-url=${state.publicUrl}`,
      '--backend=http://backstage:7007',
      `--client-origin=${CLIENT_ORIGIN}`,
      `--expected-lifetime=${LIFETIME_MINUTES * 60}`,
      `--second-user=${SECOND_USER}`,
      '--out=/reports/oidc',
    ],
    true,
    { timeout: 900_000 },
  );
  await serveControl(flow);
  const result = await flow.catch((error) => error);
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result instanceof Error) failure = result;
  const documentLog = await compose(['logs', '--no-color', 'client-document']).catch(
    (error) => error,
  );
  const facts = {
    ...(await backstageLogFacts()),
    clientDocumentFetches: ((documentLog.stdout ?? '') + (documentLog.stderr ?? ''))
      .split('\n')
      .filter((line) => line.includes('client-document fetch')).length,
  };
  facts.unmetExpectations = unmetHostExpectations(facts, {
    firstUser: FIRST_USER,
    secondUser: SECOND_USER,
  });
  await writeFile(
    path.join(out, `host-${state.target}.json`),
    JSON.stringify(facts, null, 2) + '\n',
  );
  console.log(`[${state.target}] host facts: ${JSON.stringify(facts)}`);
  if (facts.unmetExpectations.length)
    failure ??= new Error('Unmet host expectations: ' + facts.unmetExpectations.join(', '));
} catch (error) {
  failure = error;
} finally {
  await restore();
}
if (failure) {
  console.error(failure.message ?? failure);
  process.exitCode = 1;
}
