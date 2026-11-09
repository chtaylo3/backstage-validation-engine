#!/usr/bin/env node
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, statfs, stat } from 'node:fs/promises';
import { tmpdir, release as kernelRelease } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, validateSeed, loadSeed } from '../test/integration/backstage/lib/seed.mjs';
import {
  openEvidence,
  writeJson,
  counts,
  junit,
  EDITORS,
  verifyReleaseReport,
} from '../test/integration/backstage/lib/evidence.mjs';
import { runCommand } from '../test/integration/backstage/lib/process.mjs';
import { inspectVsix } from '../test/integration/backstage/lib/vsix.mjs';
import { verifyCliArchive } from './cli-candidate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const integration = path.join(root, 'test/integration/backstage');
const artifacts = path.join(root, '.artifacts/backstage');
const registry = path.join(root, '.artifacts/backstage-private');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const targetsFile = await json(path.join(integration, 'targets.json'));
const inventory = await json(path.join(integration, 'cases.json'));
const baseline = validateSeed(await json(path.join(integration, 'data/baseline.json')));
const mutation = validateSeed(await json(path.join(integration, 'data/mutation.json')));
const policy = await json(path.join(integration, 'policy.json'));
const policyDigest = digest(policy.bundle);
const command = process.argv[2];
const options = {};
for (const argument of process.argv.slice(3)) {
  const match = /^--(revision|cli|vsix|target|run|data|editor)=(.+)$/u.exec(argument);
  assert(
    match && !Object.hasOwn(options, match[1]),
    'Use documented, nonduplicate --name=value arguments.',
  );
  options[match[1]] = match[2];
}
const isRelease = command === 'release';
assert(
  [
    'build',
    'up',
    'status',
    'seed',
    'reset',
    'down',
    'clean',
    'release',
    'development',
    'editor',
    'editor-crash',
    'check',
  ].includes(command),
  'Use build, up, status, seed, down, clean, development, release, or check.',
);
if (command === 'check') {
  const upstream = await json(path.join(root, 'test/fixtures/backstage/inventory.json'));
  assert.deepEqual(
    Object.keys(targetsFile.targets).sort(),
    upstream.releases.map((t) => t.backstageVersion).sort(),
  );
  for (const target of upstream.releases) {
    const actual = targetsFile.targets[target.backstageVersion];
    assert.equal(actual.sourceCommit, target.sourceCommit);
    assert.equal(
      actual.packages['@backstage/plugin-catalog-backend'],
      target.catalogBackendVersion,
    );
    assert.equal(actual.packages['@backstage/catalog-model'], target.catalogModelVersion);
    const manifest = await json(
      path.join(integration, 'apps', target.backstageVersion, 'packages/backend/package.json'),
    );
    assert.equal(manifest.dependencies['@backstage/catalog-model'], target.catalogModelVersion);
    assert(
      (
        await readFile(path.join(integration, 'apps', target.backstageVersion, 'yarn.lock'), 'utf8')
      ).includes('__metadata:'),
    );
  }
  console.log('Backstage target inventory, immutable locks, and seed semantics passed.');
  process.exit(0);
}
const runId = options.run ?? `local-${Date.now()}-${randomBytes(3).toString('hex')}`;
assert.match(runId, /^[a-z0-9][a-z0-9-]{0,60}$/u, 'Use a contained run ID.');
const owner = createHash('sha256').update(root).digest('hex').slice(0, 16);
const runDirectory = path.join(artifacts, runId);
const registration = path.join(registry, runId + '.json');
const secretValues = [];
function sanitize(text) {
  for (const value of secretValues) text = text.split(value).join('[redacted]');
  return stripVTControlCharacters(text);
}
const interrupted = new globalThis.AbortController();
const stop = () => interrupted.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
async function docker(
  args,
  { log, allowFailure = false, timeout = 300_000, signal = interrupted.signal } = {},
) {
  try {
    const result = await runCommand('docker', args, { cwd: root, timeout, signal, allowFailure });
    if (log) await writeFile(log, sanitize(result.stdout + result.stderr));
    return result;
  } catch (error) {
    if (log) await writeFile(log, sanitize((error.stdout ?? '') + (error.stderr ?? '')));
    throw error;
  }
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const selected = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return selected;
}
async function preflight() {
  assert.equal(process.version, 'v' + targetsFile.nodeVersion, 'Use the pinned host Node version.');
  const info = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  assert.equal(info.OSType, 'linux');
  assert(['x86_64', 'amd64'].includes(info.Architecture), 'Use native Linux x64 containers.');
  const filesystem = await statfs(root);
  assert(
    filesystem.bavail * filesystem.bsize > 3 * 1024 ** 3,
    'Provide at least 3 GiB of host workspace capacity.',
  );
  return {
    docker: (await docker(['version', '--format', '{{.Server.Version}}'])).stdout.trim(),
    compose: (await docker(['compose', 'version', '--short'])).stdout.trim(),
    hostKernel: kernelRelease(),
    operatingSystem: process.platform,
    architecture: process.arch,
    filesystemType: filesystem.type,
  };
}
function compose(state, args, settings = {}) {
  return docker(
    [
      'compose',
      '--project-name',
      state.project,
      '--env-file',
      state.environment,
      '-f',
      path.join(integration, 'compose.yaml'),
      ...args,
    ],
    settings,
  );
}
async function saveRegistration(state) {
  await mkdir(registry, { recursive: true, mode: 0o700 });
  await writeFile(registration, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
async function existing() {
  const state = await json(registration);
  assert.equal(state.owner, owner);
  assert.equal(state.runId, runId);
  return state;
}
async function owned(state) {
  assert.equal(state.owner, owner);
  assert.match(state.project, new RegExp('^bve-' + runId + '-'));
  const objects = (
    await docker(
      [
        'ps',
        '-a',
        '--filter',
        'label=com.docker.compose.project=' + state.project,
        '--format',
        '{{.ID}}',
      ],
      { signal: null },
    )
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const id of objects) {
    const labels = JSON.parse(
      (await docker(['inspect', '--format', '{{json .Config.Labels}}', id], { signal: null }))
        .stdout,
    );
    assert.equal(labels['io.bve.integration.owner'], owner);
    assert.equal(labels['io.bve.integration.run'], runId);
  }
  for (const kind of ['volume', 'network']) {
    const ids = (
      await docker(
        [
          kind,
          'ls',
          '--filter',
          'label=com.docker.compose.project=' + state.project,
          '--format',
          kind === 'volume' ? '{{.Name}}' : '{{.ID}}',
        ],
        { signal: null },
      )
    ).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const id of ids) {
      const labels = JSON.parse(
        (await docker([kind, 'inspect', '--format', '{{json .Labels}}', id], { signal: null }))
          .stdout,
      );
      assert.equal(labels['io.bve.integration.owner'], owner);
      assert.equal(labels['io.bve.integration.run'], runId);
    }
  }
}
function imageTags(target) {
  return {
    application: `bve-backstage:run-${runId}-${target}`,
    test: `bve-backstage-test:run-${runId}-${target}`,
  };
}
async function cleanup(state, removeVolumes = true, { operation } = {}) {
  await owned(state);
  assert.equal(path.dirname(state.privateDirectory), tmpdir());
  assert(path.basename(state.privateDirectory).startsWith('bve-backstage-'));
  assert.deepEqual(await json(path.join(state.privateDirectory, 'owner.json')), {
    runId,
    owner,
    project: state.project,
  });
  if (operation) await operation();
  const remaining = (
    await docker(
      [
        'ps',
        '-a',
        '--filter',
        'label=com.docker.compose.project=' + state.project,
        '--format',
        '{{.ID}}',
      ],
      { signal: null },
    )
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const id of remaining) {
    const labels = JSON.parse(
      (await docker(['inspect', '--format', '{{json .Config.Labels}}', id], { signal: null }))
        .stdout,
    );
    assert.equal(labels['io.bve.integration.owner'], owner);
    assert.equal(labels['io.bve.integration.run'], runId);
    if (labels['com.docker.compose.oneoff']?.toLowerCase() === 'true')
      await docker(['rm', '--force', id], { signal: null });
  }
  await compose(state, ['down', '--remove-orphans', ...(removeVolumes ? ['--volumes'] : [])], {
    signal: null,
  });
  for (const kind of ['container', 'network', ...(removeVolumes ? ['volume'] : [])]) {
    const args = kind === 'container' ? ['ps', '-a'] : [kind, 'ls'];
    const found = (
      await docker(
        [
          ...args,
          '--filter',
          'label=com.docker.compose.project=' + state.project,
          '--format',
          kind === 'volume' ? '{{.Name}}' : '{{.ID}}',
        ],
        { signal: null },
      )
    ).stdout.trim();
    assert.equal(found, '', 'Cleanup must remove every owned runtime resource.');
  }
  if (removeVolumes) {
    for (const tag of Object.values(imageTags(state.target))) {
      const found = await docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', tag], {
        signal: null,
        allowFailure: true,
      });
      if (found.code !== 0) continue;
      const labels = JSON.parse(found.stdout);
      assert.equal(labels['io.bve.integration.owner'], owner);
      assert.equal(labels['io.bve.integration.run'], runId);
      await docker(['image', 'rm', tag], { signal: null });
    }
    await rm(state.privateDirectory, { recursive: true, force: true });
  }
}
async function stateFor(target, candidates) {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), 'bve-backstage-'));
  const reportDirectory = path.join(runDirectory, target);
  await mkdir(path.join(reportDirectory, 'reports'), { recursive: true });
  const credentials = {
    reader: randomBytes(24).toString('hex'),
    admin: randomBytes(24).toString('hex'),
    denied: randomBytes(24).toString('hex'),
  };
  secretValues.push(...Object.values(credentials));
  const selectedPort = await port();
  const environment = path.join(privateDirectory, 'compose.env');
  const project = `bve-${runId}-${target.replaceAll('.', '-')}`;
  const state = {
    runId,
    target,
    owner,
    project,
    privateDirectory,
    environment,
    reportDirectory,
    publicUrl: `http://localhost:${selectedPort}`,
    revision: candidates.revision,
  };
  await writeJson(path.join(privateDirectory, 'owner.json'), { runId, owner, project });
  const vars = {
    BVE_RUN_ID: runId,
    BVE_TARGET: target,
    BVE_OWNER: owner,
    BVE_REVISION: candidates.revision,
    BVE_BACKSTAGE_IMAGE: imageTags(target).application,
    BVE_TEST_IMAGE: imageTags(target).test,
    BVE_BACKSTAGE_PUBLIC_URL: state.publicUrl,
    BVE_BACKSTAGE_PORT: selectedPort,
    BVE_BACKSTAGE_READER_TOKEN: credentials.reader,
    BVE_BACKSTAGE_ADMIN_TOKEN: credentials.admin,
    BVE_BACKSTAGE_DENIED_TOKEN: credentials.denied,
    BVE_REPORT_DIRECTORY: reportDirectory,
    BVE_CLI_ARCHIVE: candidates.cliPath ?? '/dev/null',
    BVE_VSIX_ARCHIVE: candidates.vsixPath ?? '/dev/null',
    BVE_SEED_FILE: path.resolve(options.data ?? path.join(integration, 'data/baseline.json')),
  };
  for (const value of Object.values(vars))
    assert(!/[\r\n]/u.test(String(value)), 'Environment paths cannot contain line breaks.');
  await writeFile(
    environment,
    Object.entries(vars)
      .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  return state;
}
async function pinImages(state) {
  const application = (
    await docker(['image', 'inspect', '--format', '{{.Id}}', imageTags(state.target).application])
  ).stdout.trim();
  const test = (
    await docker(['image', 'inspect', '--format', '{{.Id}}', imageTags(state.target).test])
  ).stdout.trim();
  const text = await readFile(state.environment, 'utf8');
  await writeFile(
    state.environment,
    text
      .replace(
        /^BVE_BACKSTAGE_IMAGE=.*$/mu,
        'BVE_BACKSTAGE_IMAGE=' + imageTags(state.target).application,
      )
      .replace(/^BVE_TEST_IMAGE=.*$/mu, 'BVE_TEST_IMAGE=' + imageTags(state.target).test),
  );
  return { imageId: application, testImageId: test };
}
async function build(target, reportDirectory) {
  await mkdir(path.join(reportDirectory, 'reports'), { recursive: true });
  await docker(
    [
      'build',
      '--platform=linux/amd64',
      '--build-arg',
      'APP_TARGET=' + target,
      '--tag',
      'bve-backstage:' + target,
      '--tag',
      imageTags(target).application,
      '--label',
      'io.bve.integration.owner=' + owner,
      '--label',
      'io.bve.integration.run=' + runId,
      '--label',
      'io.bve.integration.revision=' +
        (options.revision ??
          (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()),
      '--file',
      path.join(integration, 'Dockerfile'),
      integration,
    ],
    { log: path.join(reportDirectory, 'reports/build-application.log'), timeout: 30 * 60_000 },
  );
  await docker(
    [
      'build',
      '--platform=linux/amd64',
      '--tag',
      'bve-backstage-test:local',
      '--tag',
      imageTags(target).test,
      '--label',
      'io.bve.integration.owner=' + owner,
      '--label',
      'io.bve.integration.run=' + runId,
      '--file',
      path.join(integration, 'test-runner.Dockerfile'),
      root,
    ],
    { log: path.join(reportDirectory, 'reports/build-test-image.log'), timeout: 30 * 60_000 },
  );
}
async function startApplication(state) {
  await compose(state, ['up', '-d', 'backstage']);
  const id = (await compose(state, ['ps', '--quiet', 'backstage'])).stdout.trim();
  assert(id, 'Start one owned Backstage container.');
  const actual = (await docker(['inspect', '--format', '{{.Image}}', id])).stdout.trim();
  const expected = (
    await docker(['image', 'inspect', '--format', '{{.Id}}', imageTags(state.target).application])
  ).stdout.trim();
  assert.equal(actual, expected, 'Run the pinned owned application image.');
}
async function initialize(state) {
  await compose(state, [
    'run',
    '--rm',
    '--no-deps',
    '--user',
    '0:0',
    '--entrypoint',
    'node',
    'test',
    '-e',
    `const fs=require('node:fs');for(const p of ['/catalog','/run/work']){fs.mkdirSync(p,{recursive:true});fs.chownSync(p,${process.getuid()},${process.getgid()})}`,
  ]);
}
async function driver(state, phase, args = [], settings = {}) {
  return compose(
    state,
    [
      'run',
      '--rm',
      '--no-deps',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      'test',
      phase,
      ...args,
    ],
    {
      log: path.join(state.reportDirectory, 'reports', phase + (args[0] ?? '') + '.log'),
      timeout: 20 * 60_000,
      ...settings,
    },
  );
}
async function editor(state, version) {
  const control = path.join(state.reportDirectory, 'control');
  await mkdir(control, { recursive: true });
  await rm(path.join(control, 'request.json'), { force: true });
  await rm(path.join(control, 'acknowledgement.json'), { force: true });
  const cancellation = new globalThis.AbortController();
  let settled = false;
  let executionError;
  const result = driver(state, 'editor', [version], {
    signal: globalThis.AbortSignal.any([interrupted.signal, cancellation.signal]),
  })
    .catch((error) => {
      executionError = error;
    })
    .finally(() => {
      settled = true;
    });
  const observed = new Set();
  try {
    while (!settled) {
      const request = await json(path.join(control, 'request.json')).catch((error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (request && !observed.has(request.id)) {
        assert.match(request.id, /^[a-z0-9-]{1,100}$/u);
        assert(['stop', 'start'].includes(request.action));
        observed.add(request.id);
        try {
          await compose(state, [request.action, 'backstage'], { timeout: 60_000 });
          await writeJson(path.join(control, 'acknowledgement.json'), {
            id: request.id,
            status: 'passed',
          });
        } catch (error) {
          await writeJson(path.join(control, 'acknowledgement.json'), {
            id: request.id,
            status: 'failed',
          });
          throw error;
        }
      }
      await delay(100);
    }
  } catch (error) {
    cancellation.abort();
    await result;
    throw error;
  }
  await result;
  if (executionError) throw executionError;
}

async function candidates() {
  const revision =
    options.revision ??
    (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assert.match(revision, /^[a-f0-9]{40}$/u);
  const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assert.equal(revision, head);
  if (isRelease) {
    assert(!options.target, 'Release runs require every declared target.');
    assert(!options.data && !options.editor, 'Release runs use the fixed seed and editor matrix.');
    assert(options.cli && options.vsix, 'Release runs require explicit packaged clients.');
    const dirty = (
      await runCommand(
        'git',
        [
          'status',
          '--porcelain',
          '--untracked-files=all',
          '--',
          'src',
          'scripts',
          'schemas',
          'test',
          'extensions',
          'package.json',
          'package-lock.json',
          '.nvmrc',
          'tsconfig.json',
          'tsconfig.build.json',
          'tsconfig.test.json',
          '.dockerignore',
          '.npmrc',
          '.gitattributes',
          '.github',
        ],
        { cwd: root },
      )
    ).stdout;
    assert.equal(dirty, '', 'Release sources must be clean.');
  }
  const value = { revision };
  if (options.cli) {
    value.cliPath = path.resolve(options.cli);
    const verified = await verifyCliArchive(value.cliPath, revision, { allowDirty: !isRelease });
    assert(!isRelease || !verified.sourceDirty);
    value.cli = { revision, sha256: verified.sha256 };
  }
  if (options.vsix) {
    value.vsixPath = path.resolve(options.vsix);
    const inspected = await inspectVsix(value.vsixPath, revision, { allowLocal: !isRelease });
    value.vsix = { revision, sha256: inspected.sha256 };
    const sidecar = (await readFile(value.vsixPath + '.sha256', 'utf8')).trim().split(/\s/u)[0];
    assert.equal(sidecar, value.vsix.sha256);
  }
  return value;
}
await mkdir(artifacts, { recursive: true });
if (['status', 'seed', 'reset', 'down', 'clean', 'editor', 'editor-crash'].includes(command)) {
  let state;
  try {
    state = await existing();
  } catch (error) {
    if (command !== 'clean' || error.code !== 'ENOENT') throw error;
    for (const kind of ['container', 'volume', 'network']) {
      const args = kind === 'container' ? ['ps', '-a'] : [kind, 'ls'];
      const found = (
        await docker([
          ...args,
          '--filter',
          'label=io.bve.integration.owner=' + owner,
          '--filter',
          'label=io.bve.integration.run=' + runId,
          '--format',
          kind === 'volume' ? '{{.Name}}' : '{{.ID}}',
        ])
      ).stdout.trim();
      assert.equal(found, '', 'Missing ownership registry for live resources.');
    }
    console.log('No owned resources remain for ' + runId + '.');
    process.exit(0);
  }
  if (state.mode === 'suite') {
    assert(['status', 'clean'].includes(command), 'Use status or clean for a suite run.');
    if (command === 'clean') {
      for (const item of state.states) {
        if (item.cleanupStatus === 'passed') continue;
        await cleanup(item, true);
        item.cleanupStatus = 'passed';
        await saveRegistration(state);
      }
    }
    console.log(
      JSON.stringify({
        runId,
        mode: 'suite',
        states: state.states.map((item) => ({
          target: item.target,
          cleanupStatus: item.cleanupStatus,
        })),
      }),
    );
    process.exit(0);
  }
  if (command === 'status') {
    console.log(
      JSON.stringify({
        runId,
        target: state.target,
        publicUrl: state.publicUrl,
        ...JSON.parse((await compose(state, ['ps', '--format', 'json'])).stdout || '{}'),
      }),
    );
  }
  if (command === 'editor-crash') {
    await driver(state, 'editor-crash');
  }
  if (command === 'editor') {
    assert(EDITORS.includes(options.editor ?? '1.145.2'));
    await editor(state, options.editor ?? '1.145.2');
  }
  if (command === 'seed') {
    assert(options.data, 'Supply --data for seed.');
    await loadSeed(path.resolve(options.data));
    const environment = await readFile(state.environment, 'utf8');
    await writeFile(
      state.environment,
      environment.replace(
        /^BVE_SEED_FILE=.*$/mu,
        'BVE_SEED_FILE=' + JSON.stringify(path.resolve(options.data)),
      ),
    );
    await driver(state, 'seed');
  }
  if (command === 'reset') {
    await cleanup(state, false);
    const volume = state.project + '_sqlite';
    const labels = JSON.parse(
      (await docker(['volume', 'inspect', '--format', '{{json .Labels}}', volume])).stdout,
    );
    assert.equal(labels['io.bve.integration.owner'], owner);
    assert.equal(labels['io.bve.integration.run'], runId);
    await docker(['volume', 'rm', volume]);
    const text = await readFile(state.environment, 'utf8');
    await writeFile(
      state.environment,
      text.replace(
        /^BVE_SEED_FILE=.*$/mu,
        'BVE_SEED_FILE=' + JSON.stringify(path.join(integration, 'data/baseline.json')),
      ),
    );
    await driver(state, 'render');
    await startApplication(state);
    await driver(state, 'ready');
  }
  if (command === 'down') await cleanup(state, false);
  if (command === 'clean') {
    await cleanup(state, true);
    await rm(registration, { force: true });
  }
  process.exit(0);
}
const targetIds = options.target ? [options.target] : Object.keys(targetsFile.targets);
for (const target of targetIds) assert(Object.hasOwn(targetsFile.targets, target));
if (options.data) await loadSeed(path.resolve(options.data));
await preflight();
if (command === 'build') {
  for (const target of targetIds) await build(target, path.join(runDirectory, target));
  process.exit(0);
}
if (command === 'up') {
  if (await stat(registration).catch(() => undefined)) {
    const state = await existing();
    assert(!state.mode, 'A suite run ID cannot become a persistent environment.');
    if (options.target) assert.equal(options.target, state.target);
    await owned(state);
    await startApplication(state);
    await driver(state, 'ready');
    console.log(
      JSON.stringify({ runId, publicUrl: state.publicUrl, reportDirectory: state.reportDirectory }),
    );
    process.exit(0);
  }
  assert(targetIds.length === 1, 'Choose one --target for local up.');
  const state = await stateFor(targetIds[0], await candidates());
  await saveRegistration(state);
  try {
    await build(state.target, state.reportDirectory);
    await pinImages(state);
    await initialize(state);
    await driver(state, 'render');
    await startApplication(state);
    await driver(state, 'ready');
    console.log(
      JSON.stringify({ runId, publicUrl: state.publicUrl, reportDirectory: state.reportDirectory }),
    );
  } catch (error) {
    await cleanup(state, true);
    await rm(registration, { force: true });
    throw error;
  }
  process.exit(0);
}
assert(['release', 'development'].includes(command));
assert(options.cli && options.vsix, 'Client suites require --cli and --vsix.');
assert(!(await stat(runDirectory).catch(() => undefined)), 'Never reuse a suite run ID.');
assert(
  !(await stat(registration).catch(() => undefined)),
  'Do not reuse a persistent environment run ID for a suite.',
);
const candidate = await candidates();
const report = {
  schemaVersion: 1,
  mode: isRelease ? 'release' : 'development',
  status: 'failed',
  revision: candidate.revision,
  candidates: { cli: candidate.cli, vsix: candidate.vsix },
  inventoryDigest: digest(inventory),
  seedDigests: { baseline: digest(baseline), mutation: digest(mutation) },
  policyDigest,
  targets: [],
  counts: {},
  cleanup: { status: 'failed' },
  startedAt: new Date().toISOString(),
  host: await preflight(),
};
await mkdir(runDirectory, { recursive: true });
const suite = { runId, owner, mode: 'suite', states: [] };
await saveRegistration(suite);
if (process.env.GITHUB_ACTIONS === 'true') {
  report.workflow = {
    repository: process.env.GITHUB_REPOSITORY,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    ref: process.env.GITHUB_WORKFLOW_REF,
    sha: process.env.GITHUB_WORKFLOW_SHA,
    event: process.env.GITHUB_EVENT_NAME,
  };
  assert.equal(report.workflow.sha, candidate.revision);
  assert.equal(report.workflow.event, 'workflow_dispatch');
  assert(Number.isSafeInteger(report.workflow.runId) && report.workflow.runId > 0);
  assert(Number.isSafeInteger(report.workflow.runAttempt) && report.workflow.runAttempt > 0);
}
let failure;
for (const target of targetIds) {
  const state = await stateFor(target, candidate);
  suite.states.push(state);
  await saveRegistration(suite);
  const file = path.join(state.reportDirectory, 'target-report.json');
  const initial = {
    target,
    sourceCommit: targetsFile.targets[target].sourceCommit,
    packages: {},
    lockfileDigest:
      'sha256:' +
      createHash('sha256')
        .update(await readFile(path.join(integration, 'apps', target, 'yarn.lock')))
        .digest('hex'),
    baseImage: targetsFile.baseImage,
    editorVersions: [...EDITORS],
    policyDigest,
    cleanup: { status: 'failed' },
  };
  let evidence = await openEvidence(file, inventory.cases, initial);
  await evidence.save();
  try {
    await evidence.run('environment.build', 'build', () => build(target, state.reportDirectory));
    Object.assign(evidence.report, await pinImages(state));
    const installed = JSON.parse(
      (
        await docker([
          'run',
          '--rm',
          '--network=none',
          imageTags(target).application,
          'node',
          'app-metadata.mjs',
          target,
        ])
      ).stdout,
    );
    assert.deepEqual(installed.packages, targetsFile.targets[target].packages);
    Object.assign(evidence.report, installed);
    await evidence.save();
    await initialize(state);
    await driver(state, 'render');
    await startApplication(state);
    await driver(state, 'connected');
    await driver(state, 'runner');
    evidence = await openEvidence(file, inventory.cases);
    await evidence.run('runner.build-failure', 'runner', async () => {
      const directory = path.join(state.privateDirectory, 'failed-build');
      await mkdir(directory);
      await writeFile(
        path.join(directory, 'Dockerfile'),
        'FROM ' + targetsFile.baseImage + '\nRUN exit 23\n',
      );
      const result = await docker(
        ['build', '--file', path.join(directory, 'Dockerfile'), directory],
        {
          allowFailure: true,
          log: path.join(state.reportDirectory, 'reports/expected-build-failure.log'),
        },
      );
      assert.notEqual(result.code, 0);
    });
    await evidence.run('runner.cleanup-accounting', 'runner', async () => {
      const proof = await openEvidence(
        path.join(state.reportDirectory, 'reports/expected-cleanup-failure.json'),
        [{ id: 'expected-cleanup-failure', scope: 'runner' }],
      );
      await assert.rejects(
        proof.run('expected-cleanup-failure', 'cleanup', () =>
          cleanup(state, false, { operation: () => compose(state, ['down', '--timeout=invalid']) }),
        ),
      );
      assert.equal(proof.report.cases[0].status, 'failed');
    });
    await driver(state, 'mutation');
    await compose(state, ['stop', 'backstage']);
    await driver(state, 'outage');
    await compose(state, ['start', 'backstage']);
    await driver(state, 'recovery');
    // Recreate only this run's persistent state before the reset assertion.
    await cleanup(state, false);
    const volume = state.project + '_sqlite';
    const labels = JSON.parse(
      (await docker(['volume', 'inspect', '--format', '{{json .Labels}}', volume])).stdout,
    );
    assert.equal(labels['io.bve.integration.owner'], owner);
    assert.equal(labels['io.bve.integration.run'], runId);
    await docker(['volume', 'rm', volume]);
    await driver(state, 'render');
    await startApplication(state);
    await driver(state, 'reset');
    for (const version of EDITORS) await editor(state, version);
    await driver(state, 'editor-crash');
  } catch (error) {
    failure ??= error;
  } finally {
    evidence = await openEvidence(file, inventory.cases);
    try {
      const logs = await compose(state, ['logs', '--no-color', 'backstage'], {
        allowFailure: true,
        signal: null,
      });
      await writeFile(
        path.join(state.reportDirectory, 'reports/backstage.log'),
        sanitize(logs.stdout + logs.stderr),
      );
      await evidence.run('environment.cleanup', 'cleanup', () => cleanup(state, true));
      evidence.report.cleanup = { status: 'passed' };
    } catch (error) {
      failure ??= error;
      evidence.report.cleanup = { status: 'failed' };
    }
    state.cleanupStatus = evidence.report.cleanup.status;
    await saveRegistration(suite);
    await evidence.save();
    report.targets.push(evidence.report);
    report.counts = counts(report.targets.flatMap((t) => t.cases));
    await writeJson(path.join(runDirectory, 'results.json'), report);
  }
}
if (isRelease && !failure) {
  try {
    const after = await candidates();
    assert.deepEqual(after.cli, candidate.cli);
    assert.deepEqual(after.vsix, candidate.vsix);
  } catch (error) {
    failure = error;
  }
}
report.completedAt = new Date().toISOString();
report.cleanup.status = report.targets.every((t) => t.cleanup.status === 'passed')
  ? 'passed'
  : 'failed';
report.status =
  !failure && report.counts.unexecuted === 0 && report.counts.failed === 0 ? 'passed' : 'failed';
if (isRelease && report.status === 'passed')
  verifyReleaseReport(report, {
    revision: candidate.revision,
    cliSha256: candidate.cli.sha256,
    vsixSha256: candidate.vsix.sha256,
    inventoryDigest: report.inventoryDigest,
    seedDigests: report.seedDigests,
    policyDigest,
    targets: Object.keys(targetsFile.targets),
    cases: inventory.cases,
  });
await writeJson(path.join(runDirectory, 'results.json'), report);
await writeFile(path.join(runDirectory, 'junit.xml'), junit(report));
await writeJson(path.join(artifacts, 'latest-release.json'), {
  runId,
  report: path.join(runDirectory, 'results.json'),
  status: report.status,
});
console.log(
  JSON.stringify({
    runId,
    status: report.status,
    report: path.join(runDirectory, 'results.json'),
    counts: report.counts,
  }),
);
if (failure) throw failure;
if (report.status !== 'passed') process.exitCode = 1;
