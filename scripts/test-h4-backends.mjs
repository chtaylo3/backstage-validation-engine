// Focused H4 controls. This command never launches an editor or release-wide workload.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from '../test/integration/backstage/lib/process.mjs';
import { renderSeed, digest } from '../test/integration/backstage/lib/seed.mjs';
import {
  request,
  converge,
  refresh,
  readEntities,
} from '../test/integration/backstage/lib/catalog.mjs';
import { assertH4CliCase } from '../test/integration/backstage/lib/h4-cli-contracts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const integration = path.join(root, 'test/integration/backstage');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const selected = option('--target');
const archive = path.resolve(
  option('--cli') ?? '.artifacts/cli/chtaylo3-backstage-validation-engine-0.1.0-dev.0.tgz',
);
const evidenceRoot = path.resolve(
  option('--evidence') ?? '.artifacts/harness-remediation/H4/backends',
);
const keep = args.includes('--keep');
if (!selected) {
  assert(!keep, 'Select one target when retaining a backend for independent inspection.');
  for (const target of ['1.55.3', '1.56.3']) {
    const result = await runCommand(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        '--target',
        target,
        '--cli',
        archive,
        '--evidence',
        evidenceRoot,
      ],
      { cwd: root, env: process.env, timeout: 600_000 },
    );
    console.log(result.stdout);
  }
} else {
  assert(['1.55.3', '1.56.3'].includes(selected));
  const runId = 'bve-h4-' + selected.replaceAll('.', '-') + '-' + randomBytes(5).toString('hex');
  const directory = path.join(evidenceRoot, runId);
  const privateDirectory = path.join(directory, 'private');
  const catalogDirectory = path.join(directory, 'catalog');
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(catalogDirectory, { recursive: true, mode: 0o755 });
  const tokens = Object.fromEntries(
    ['reader', 'admin', 'denied', 'filtered'].map((name) => [
      name,
      randomBytes(24).toString('hex'),
    ]),
  );
  const variables = {
    BVE_BACKSTAGE_PUBLIC_URL: 'http://localhost:7007',
    BVE_BACKSTAGE_READER_TOKEN: tokens.reader,
    BVE_BACKSTAGE_ADMIN_TOKEN: tokens.admin,
    BVE_BACKSTAGE_DENIED_TOKEN: tokens.denied,
    BVE_BACKSTAGE_FILTERED_TOKEN: tokens.filtered,
  };
  const envFile = path.join(privateDirectory, 'backend.env');
  await writeFile(
    envFile,
    Object.entries(variables)
      .map(([key, value]) => key + '=' + value)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  const report = { schemaVersion: 1, target: selected, runId, cases: [], status: 'running' };
  const save = async () =>
    writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const docker = async (dockerArgs, options = {}) => {
    const result = await runCommand('docker', dockerArgs, {
      cwd: root,
      env: process.env,
      timeout: 300_000,
      ...options,
    });
    return result.stdout.trim();
  };
  const record = async (id, fn) => {
    const start = performance.now();
    try {
      const observation = await fn();
      report.cases.push({
        id,
        status: 'passed',
        durationMs: performance.now() - start,
        observation,
      });
      await save();
      return observation;
    } catch (error) {
      report.cases.push({
        id,
        status: 'failed',
        message: error.message,
        ...(error.observation ? { observation: error.observation } : {}),
      });
      await save();
      throw error;
    }
  };
  const hash = async (file) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  const app = path.join(integration, 'apps', selected);
  report.revision = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  report.sourceDirty = Boolean(
    (
      await runCommand('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })
    ).stdout.trim(),
  );
  report.runtime = {
    node: process.version,
    docker: await docker(['version', '--format', '{{.Server.Version}}']),
  };
  const files = [
    'package.json',
    'yarn.lock',
    'packages/backend/package.json',
    'packages/backend/src/index.mjs',
    'packages/backend/src/test-permissions.mjs',
  ];
  report.application = {
    files: Object.fromEntries(
      await Promise.all(files.map(async (file) => [file, await hash(path.join(app, file))])),
    ),
    configurationSha256: await hash(path.join(integration, 'app-config.test.yaml')),
    targetsSha256: await hash(path.join(integration, 'targets.json')),
  };
  report.artifact = {
    filename: path.basename(archive),
    sha256: await hash(archive),
    metadata: JSON.parse(await readFile(archive + '.metadata.json', 'utf8')),
  };
  // Artifact metadata contains only portable package inventory and identities.
  const image =
    'bve-h4-backstage:' +
    selected +
    '-' +
    report.application.files['packages/backend/src/test-permissions.mjs'].slice(0, 12) +
    '-' +
    report.application.configurationSha256.slice(0, 8);
  const stateVolume = runId + '-sqlite';
  let started = false;
  let volumeCreated = false;
  const baseSeed = JSON.parse(await readFile(path.join(integration, 'data/baseline.json'), 'utf8'));
  const mutation = JSON.parse(await readFile(path.join(integration, 'data/mutation.json'), 'utf8'));
  const golden = JSON.parse(
    await readFile(path.join(root, 'test/fixtures/backstage-behavior/seed-graphs.json'), 'utf8'),
  );
  try {
    await record('artifact-and-application-identity', async () => {
      assert.equal(report.artifact.metadata.revision, report.revision);
      assert.equal(report.artifact.metadata.sourceDirty, false);
      assert.equal(report.artifact.metadata.sha256, report.artifact.sha256);
      assert.equal(report.sourceDirty, false);
      await docker([
        'build',
        '--file',
        path.join(integration, 'Dockerfile.h4'),
        '--build-arg',
        'BASE_IMAGE=bve-backstage:' + selected,
        '--build-arg',
        'APP_TARGET=' + selected,
        '--tag',
        image,
        integration,
      ]);
      report.application.baseImage = JSON.parse(
        await docker(['image', 'inspect', 'bve-backstage:' + selected]),
      )[0].Id;
      report.application.image = JSON.parse(await docker(['image', 'inspect', image]))[0].Id;
      report.application.installed = JSON.parse(
        await docker([
          'run',
          '--rm',
          '--entrypoint',
          'node',
          image,
          '/app/app-metadata.mjs',
          selected,
        ]),
      );
      const targets = JSON.parse(await readFile(path.join(integration, 'targets.json'), 'utf8'));
      assert.deepEqual(report.application.installed.packages, targets.targets[selected].packages);
      assert.equal(report.application.installed.nodeVersion, 'v' + targets.nodeVersion);
      assert.equal(report.application.installed.sqliteDriverVersion, '12.4.1');
      return { image: report.application.image, baseImage: report.application.baseImage };
    });
    await record('pinned-upstream-substitution-and-reference-tables', async () =>
      JSON.parse(
        await docker([
          'run',
          '--rm',
          '--entrypoint',
          'node',
          '--mount',
          'type=bind,src=' +
            path.join(root, 'test/fixtures/backstage-behavior') +
            ',dst=/h4-fixtures,readonly',
          '--mount',
          'type=bind,src=' +
            path.join(integration, 'lib/h4-upstream.mjs') +
            ',dst=/app/h4-upstream.mjs,readonly',
          image,
          '/app/h4-upstream.mjs',
        ]),
      ),
    );
    await renderSeed(baseSeed, catalogDirectory);
    await docker(['volume', 'create', '--label', 'io.bve.integration.run=' + runId, stateVolume]);
    volumeCreated = true;
    await docker([
      'run',
      '--detach',
      '--init',
      '--name',
      runId,
      '--label',
      'io.bve.integration.run=' + runId,
      '--env-file',
      envFile,
      '--publish',
      '127.0.0.1::7007',
      '--mount',
      'type=volume,src=' + stateVolume + ',dst=/state',
      '--mount',
      'type=bind,src=' + catalogDirectory + ',dst=/catalog,readonly',
      image,
    ]);
    started = true;
    const binding = await docker(['port', runId, '7007/tcp']);
    const base = 'http://' + binding;
    await writeFile(
      path.join(privateDirectory, 'connection.json'),
      JSON.stringify({ container: runId, volume: stateVolume, baseUrl: base, envFile }, null, 2) +
        '\n',
      { mode: 0o600 },
    );
    const readyDeadline = performance.now() + 120_000;
    while (true) {
      try {
        const response = await request(base, '/api/catalog/entities', { token: tokens.admin });
        if (response.status === 200) break;
      } catch {
        /* Startup is observed through the actual endpoint. */
      }
      assert(performance.now() < readyDeadline, 'Backend HTTP startup deadline expired.');
      await delay(200);
    }
    const graph = async (seed, name) => {
      assert.deepEqual(
        seed.expected.relations.map((r) => [r.source, r.type, r.target]).sort(),
        golden[name],
      );
      const barrier = await converge(base, seed, tokens.reader);
      const entities = await readEntities(base, seed.expected.entityRefs, tokens.admin);
      const tuples = entities
        .flatMap((entity) =>
          (entity.relations ?? []).map((relation) => [
            entity.kind.toLowerCase() +
              ':' +
              entity.metadata.namespace +
              '/' +
              entity.metadata.name,
            relation.type,
            relation.targetRef,
          ]),
        )
        .filter(([source, type, target]) =>
          golden[name].some(
            (expected) => expected[0] === source && expected[1] === type && expected[2] === target,
          ),
        )
        .sort();
      assert.deepEqual(tuples, golden[name]);
      return { ...barrier, tuples, seedDigest: digest(seed) };
    };
    await record('baseline-normal-ingestion-complete-declared-graph', () =>
      graph(baseSeed, 'baseline'),
    );
    await record('raw-byrefs-parser-and-database-contract', async () => {
      const canonical = 'group:bve-demo/team-demo';
      const refs = [
        canonical,
        'group:team-demo',
        'team-demo',
        'GROUP:BVE-DEMO/TEAM-DEMO',
        'group:bve-demo/TEAM-DEMO',
        'group:/team-demo',
        'not-a-full-ref',
        '',
        ' ' + canonical,
        canonical,
      ];
      const response = await request(base, '/api/catalog/entities/by-refs', {
        token: tokens.admin,
        method: 'POST',
        body: { entityRefs: refs },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(
        response.body.items.map((entity) => (entity === null ? null : entity.metadata.name)),
        ['team-demo', null, null, null, null, null, null, null, null, 'team-demo'],
      );
      const malformed = await request(base, '/api/catalog/entities/by-refs', {
        token: tokens.admin,
        method: 'POST',
        body: { entityRefs: [42] },
      });
      assert.equal(malformed.status, 400);
      return {
        refs,
        present: response.body.items.map((entity) => entity !== null),
        nonStringStatus: malformed.status,
      };
    });
    await record('permission-service-filtered-absence-and-explicit-plugin-rejection', async () => {
      const endpoint = '/api/catalog/entities/by-name/group/bve-demo/team-demo';
      assert.equal((await request(base, endpoint, { token: tokens.admin })).status, 200);
      assert.equal((await request(base, endpoint, { token: tokens.reader })).status, 200);
      assert.equal((await request(base, endpoint, { token: tokens.denied })).status, 403);
      assert.equal((await request(base, endpoint, { token: tokens.filtered })).status, 404);
      const batch = await request(base, '/api/catalog/entities/by-refs', {
        token: tokens.filtered,
        method: 'POST',
        body: { entityRefs: ['group:bve-demo/team-demo'] },
      });
      assert.equal(batch.status, 200);
      assert.deepEqual(batch.body.items, [null]);
      const query = await request(
        base,
        '/api/catalog/entities/by-query?filter=kind=group&limit=100',
        { token: tokens.filtered },
      );
      assert.equal(query.status, 200);
      assert.deepEqual(query.body.items, []);
      assert.equal(query.body.totalItems, 0);
      assert.equal((await request(base, endpoint, { token: tokens.admin })).status, 200);
      return {
        admin: 200,
        reader: 200,
        pluginDenied: 403,
        filteredByName: 404,
        filteredByRefs: [null],
        filteredByQuery: [],
      };
    });
    await record('native-reader-restriction-with-valid-admin-refresh', async () => {
      const body = { entityRef: 'group:bve-demo/team-demo' };
      const endpoint = '/api/catalog/refresh';
      assert.equal(
        (await request(base, endpoint, { token: tokens.admin, method: 'POST', body })).status,
        200,
      );
      assert.equal(
        (await request(base, endpoint, { token: tokens.reader, method: 'POST', body })).status,
        403,
      );
      assert.equal(
        (
          await request(base, '/api/catalog/entities/by-name/group/bve-demo/team-demo', {
            token: tokens.reader,
          })
        ).status,
        200,
      );
      return { endpoint, adminStatus: 200, readerStatus: 403, readerReadStatus: 200 };
    });
    Object.assign(process.env, variables, {
      BVE_BACKSTAGE_URL: base,
      BVE_BACKSTAGE_WORK_ROOT: privateDirectory,
      BVE_BACKSTAGE_CLI_ARCHIVE: archive,
      BVE_REVISION: report.revision,
      npm_config_offline: 'true',
    });
    const { createClientFixture, runCli, installClient } =
      await import('../test/integration/backstage/lib/clients.mjs');
    const engine = await installClient();
    const fixture = await createClientFixture();
    const cliResults = new Map();
    const cli = async (id, text, expected, options = {}) =>
      record(id, async () => {
        const result = await runCli(fixture, text, {
          expectedOutcome: [
            'cli.invalid-credentials',
            'cli.permission-denied',
            'cli.outage',
          ].includes(id)
            ? 'incomplete'
            : 'completed',
          output: path.join(directory, id + '.json'),
          ...options,
        });
        assert.equal(result.code, expected);
        assertH4CliCase(id, result);
        cliResults.set(id, result);
        return {
          exit: result.code,
          ...(result.report.ruleStates
            ? {
                ruleStates: result.report.ruleStates,
                coverage: result.report.coverage,
                findings: result.report.findings.map(({ ruleId, category }) => ({
                  ruleId,
                  category,
                })),
              }
            : { errorCode: result.report.error.code }),
        };
      });
    const provider = async (token, expected, cause) => {
      const access = {
        installationId: 'h4',
        principalId: 'h4-reader',
        credentialRevision: '1',
        permissionRevision: '1',
        scope: ['catalog:read'],
        policyDigest: fixture.policyDigest,
        profileDigest: engine.digestJson(fixture.profile),
        maxAgeMs: 0,
      };
      const catalog = await engine.createCatalogProvider({
        connectionId: 'h4',
        baseUrl: base + '/api/catalog',
        adapterId: fixture.profile.adapterId,
        limits: { retries: 0 },
        credentials: async () => ({ token, ...access }),
      });
      try {
        const result = await catalog.lookup(['group:bve-demo/team-demo'], access, {
          deadlineAt: Date.now() + 5000,
        });
        assert.equal(result.data.entries[0].status, expected);
        if (cause) {
          assert.equal(result.data.entries[0].reason, cause);
          assert.equal(result.failures[0].code, cause);
        }
        return { status: result.data.entries[0].status, ...(cause ? { cause } : {}) };
      } finally {
        await catalog.close();
      }
    };
    await cli('cli.valid-json', fixture.validText, 0);
    await cli('cli.native-rejection', fixture.validText.replace('  type: service\n', ''), 1);
    await cli('cli.malformed-yaml', 'apiVersion: [\n', 1);
    await cli('cli.missing-credentials', fixture.validText, 2, {
      token: null,
      expectedVariant: 'error',
    });
    await cli('cli.invalid-credentials', fixture.validText, 2, { token: 'invalid-h4-token' });
    await cli('cli.permission-denied', fixture.validText, 2, { token: tokens.denied });
    await record('cli-specific-reason-negative-controls', async () => {
      const mutations = [
        [
          'cli.permission-denied',
          (value) => {
            value.code = 0;
          },
        ],
        [
          'cli.native-rejection',
          (value) => {
            value.report.findings = [{ ruleId: 'yaml/syntax' }];
          },
        ],
        [
          'cli.malformed-yaml',
          (value) => {
            value.report.findings = [];
          },
        ],
        [
          'cli.invalid-credentials',
          (value) => {
            value.report.ruleStates = [];
          },
        ],
        [
          'cli.permission-denied',
          (value) => {
            value.report.coverage = value.report.coverage.map((row) => ({
              ...row,
              reason: 'wrong reason',
            }));
          },
        ],
        [
          'cli.missing-credentials',
          (value) => {
            value.report.error.code = 'wrong_reason';
          },
        ],
      ];
      for (const [id, mutate] of mutations) {
        const value = globalThis.structuredClone(cliResults.get(id));
        mutate(value);
        assert.throws(() => assertH4CliCase(id, value), { name: 'AssertionError' });
      }
      return { rejectedMutations: mutations.length };
    });
    await record('actual-provider-distinct-credential-causes', async () => ({
      reader: await provider(tokens.reader, 'present'),
      filtered: await provider(tokens.filtered, 'missing'),
      invalid: await provider('invalid-h4-token', 'unavailable', 'permission_denied'),
      pluginDenied: await provider(tokens.denied, 'unavailable', 'permission_denied'),
    }));
    await record('mutation-normal-ingestion-absent-obsolete-edges', async () => {
      await renderSeed(mutation, catalogDirectory);
      await refresh(base, tokens.admin);
      return graph(mutation, 'mutation');
    });
    await cli('cli.mutation', fixture.validText.replace('team-demo', 'team-next'), 0);
    await docker(['stop', '--time', '10', runId]);
    await cli('cli.outage', fixture.validText, 2);
    await record('actual-provider-outage-cause', () =>
      provider(tokens.reader, 'unavailable', 'offline'),
    );
    await docker(['start', runId]);
    await record('catalog-recovery-after-outage', () => graph(mutation, 'mutation'));
    await cli('cli.recovery', fixture.validText, 0);
    const log = await docker(['logs', runId]);
    const decisions = log
      .split('\n')
      .filter((line) => line.startsWith('H4_PERMISSION_DECISION '))
      .map((line) => JSON.parse(line.slice('H4_PERMISSION_DECISION '.length)));
    await record('authenticated-native-permission-decisions', async () => {
      assert(
        decisions.some(
          (row) =>
            row.subject === 'bve-filtered' &&
            row.permission === 'catalog.entity.read' &&
            row.nativeResult === 'ALLOW' &&
            row.result === 'DENY' &&
            row.method === 'authorizeConditional',
        ),
      );
      assert(
        decisions.some(
          (row) =>
            row.subject === 'bve-reader' &&
            row.permission === 'catalog.entity.refresh' &&
            row.nativeResult === 'DENY' &&
            row.result === 'DENY',
        ),
      );
      assert(
        decisions.some(
          (row) =>
            row.subject === 'bve-administrator' &&
            row.permission === 'catalog.entity.refresh' &&
            row.nativeResult === 'ALLOW' &&
            row.result === 'ALLOW',
        ),
      );
      return decisions;
    });
    await writeFile(path.join(directory, 'backend.log'), log + '\n');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    if (started) {
      const logs = await docker(['logs', runId], { allowFailure: true }).catch(() => '');
      await writeFile(path.join(directory, 'backend-final.log'), logs + '\n');
    }
    if (!keep || report.status !== 'passed') {
      if (started) await docker(['rm', '--force', runId]);
      if (volumeCreated) await docker(['volume', 'rm', stateVolume]);
      report.cleanup = 'owned container and SQLite volume removed';
    } else
      report.cleanup =
        'retained for parent inspection; private/connection.json records owned resources';
    // Never copy private credentials, signed fixtures or the ingested SQLite database into the report.
    report.privateFiles = (await readdir(privateDirectory)).filter((name) =>
      ['backend.env', 'connection.json'].includes(name),
    );
    await save();
    console.log(
      JSON.stringify({
        target: selected,
        status: report.status,
        cases: report.cases.length,
        directory: path.relative(root, directory),
        cleanup: report.cleanup,
      }),
    );
  }
}
