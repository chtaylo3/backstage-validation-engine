import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import Ajv from 'ajv';
import { openEvidence, writeJson } from './evidence.mjs';
import { validateSeed, renderSeed, digest, loadSeed } from './seed.mjs';
import { request, converge, refresh, readEntities } from './catalog.mjs';
import { createClientFixture, runCli, installClient, sourceFor } from './clients.mjs';
import { assertH4CliCase } from './h4-cli-contracts.mjs';
import { verifyHostControl } from './host-controls.mjs';

await mkdir('/run/work/home', { recursive: true });
const root = new URL('../', import.meta.url);
const read = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const inventory = await read('cases.json');
const baseline = await read('data/baseline.json');
const mutation = await read('data/mutation.json');
const schema = await read('catalog-seed.schema.json');
const schemaCheck = new Ajv({ strict: true, allErrors: true }).compile(schema);
function seedCheck(seed) {
  assert(schemaCheck(seed), 'Require the project-owned seed schema.');
  return validateSeed(seed);
}
const base = process.env.BVE_BACKSTAGE_URL;
const reader = process.env.BVE_BACKSTAGE_READER_TOKEN;
const admin = process.env.BVE_BACKSTAGE_ADMIN_TOKEN;
const denied = process.env.BVE_BACKSTAGE_DENIED_TOKEN;
const reportFile = '/reports/target-report.json';
const evidence = await openEvidence(reportFile, inventory.cases);
await mkdir('/reports/reports/cli', { recursive: true });
const phase = process.argv[2];
const run = (id, fn) => evidence.run(id, phase, fn);
async function apply(seed) {
  seedCheck(seed);
  await renderSeed(seed, '/catalog');
  await refresh(base, admin);
  return converge(base, seed, reader);
}
async function cliCase(id, fixture, text, expected, options) {
  return run(id, async () => {
    const value = await runCli(fixture, text, {
      output: '/reports/reports/cli/' + id + '.json',
      expectedOutcome: [
        'cli.required-processor',
        'cli.invalid-credentials',
        'cli.permission-denied',
        'cli.outage',
      ].includes(id)
        ? 'incomplete'
        : 'completed',
      ...options,
    });
    assert.equal(value.code, expected, 'Require the documented CLI exit.');
    if ((options?.format ?? 'json') === 'json') assertH4CliCase(id, value);
    if (expected === 0 && (options?.format ?? 'json') === 'json')
      assert.equal(value.report.outcome, 'completed');
    if (
      [
        'cli.required-processor',
        'cli.invalid-credentials',
        'cli.permission-denied',
        'cli.outage',
      ].includes(id)
    )
      assert.equal(value.report.outcome, 'incomplete');
    return value;
  });
}
async function connected() {
  await run('environment.startup', () => converge(base, baseline, reader));
  await run('environment.web', async () => {
    const response = await globalThis.fetch(base, { signal: globalThis.AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /<div id="root"><\/div>/u);
    assert.match(body, /<script/u);
  });
  await run('environment.authentication', async () => {
    const endpoints = [
      { path: '/api/catalog/entities/by-name/group/bve-demo/team-demo' },
      {
        path: '/api/catalog/entities/by-refs',
        method: 'POST',
        body: { entityRefs: ['group:bve-demo/team-demo'] },
      },
      {
        path: '/api/catalog/entities/by-query?filter=kind=group,metadata.namespace=bve-demo&fields=kind,metadata.name,metadata.namespace&fullTextFilterTerm=team&fullTextFilterFields=metadata.name&orderField=metadata.name,asc&limit=100',
      },
    ];
    const statuses = [];
    for (const endpoint of endpoints) {
      const row = { endpoint: endpoint.path.split('?')[0] };
      for (const [label, token, expected] of [
        ['missing', undefined, 401],
        ['invalid', 'invalid-release-token', 401],
        ['denied', denied, 403],
        ['reader', reader, 200],
      ]) {
        row[label] = (
          await request(base, endpoint.path, {
            token,
            method: endpoint.method,
            body: endpoint.body,
          })
        ).status;
        assert.equal(row[label], expected);
      }
      statuses.push(row);
    }
    await writeJson('/reports/reports/authentication.json', {
      authorizationScope: 'plugin-service',
      statuses,
    });
  });
  await run('environment.repeat-seed', async () => {
    const before = await readEntities(base, baseline.expected.entityRefs, reader);
    await apply(baseline);
    await apply(baseline);
    const after = await readEntities(base, baseline.expected.entityRefs, reader);
    const state = (items) =>
      items.map((entity) => ({
        spec: entity.spec,
        relations: entity.relations,
        uid: entity.metadata.uid,
      }));
    assert.deepEqual(state(after), state(before));
  });
  const fixture = await createClientFixture({
    authorityReport: '/reports/reports/authority/' + phase + '.json',
  });
  const good = await cliCase('cli.valid-json', fixture, fixture.validText, 0);
  await cliCase('cli.valid-sarif', fixture, fixture.validText, 0, { format: 'sarif' });
  await cliCase(
    'cli.native-rejection',
    fixture,
    fixture.validText.replace('  type: service\n', ''),
    1,
  );
  const violation = await cliCase('cli.policy-violation', fixture, fixture.invalidText, 1);
  assert(violation.report.findings.some((f) => f.ruleId === 'production-only'));
  await cliCase('cli.malformed-yaml', fixture, 'apiVersion: [\n', 1);
  const missing = await cliCase(
    'cli.missing-reference',
    fixture,
    fixture.validText.replace('team-demo', 'missing-team'),
    1,
  );
  assert(missing.report.findings.some((f) => f.ruleId === 'owner-exists'));
  const engine = await installClient();
  const processor = await createClientFixture({
    directory: '/run/work/processor',
    authorityReport: '/reports/reports/authority/' + phase + '-processor.json',
    profile: {
      ...engine.DEFAULT_DEPLOYMENT_PROFILE,
      requiredProcessors: [{ id: 'unavailable-release-processor', stage: 'before-native' }],
    },
  });
  await cliCase('cli.required-processor', processor, processor.validText, 2);
  await cliCase('cli.missing-credentials', fixture, fixture.validText, 2, {
    token: null,
    expectedVariant: 'error',
  });
  await cliCase('cli.invalid-credentials', fixture, fixture.validText, 2, {
    token: 'invalid-release-token',
  });
  await cliCase('cli.permission-denied', fixture, fixture.validText, 2, { token: denied });
  const invalidSnapshot = {
    ...(await sourceFor(fixture, fixture.validText)),
    digest: 'sha256:' + '0'.repeat(64),
  };
  const invocation = await cliCase('cli.invalid-snapshot', fixture, fixture.validText, 2, {
    sourceOverride: invalidSnapshot,
    expectedVariant: 'error',
  });
  assert.equal(invocation.report.outcome, 'error');
  const incompleteSarif = await cliCase('cli.incomplete-sarif', fixture, fixture.validText, 2, {
    token: denied,
    format: 'sarif',
  });
  assert.equal(incompleteSarif.report.runs[0].invocations[0].executionSuccessful, false);
  await run('cli.parity', async () => {
    const sarif = await runCli(fixture, fixture.invalidText, { format: 'sarif' });
    assert.equal(sarif.code, 1);
    assert.deepEqual(
      sarif.report.runs[0].results.map((r) => r.ruleId).sort(),
      violation.report.findings.map((r) => r.ruleId).sort(),
    );
    assert.equal(good.report.findings.length, 0);
    await writeJson('/reports/reports/cli-parity.json', {
      policyDigest: fixture.policyDigest,
      source: 'same input bytes',
      rules: violation.report.findings.map((f) => f.ruleId),
    });
  });
}
async function runnerCases() {
  await run('runner.invalid-seed', () =>
    assert.throws(() => seedCheck({ ...baseline, schemaVersion: 99 })),
  );
  await run('runner.malformed-json', async () => {
    const file = '/run/work/malformed-seed.json';
    await writeFile(file, '{"schemaVersion":');
    await assert.rejects(loadSeed(file), /Seed JSON could not be parsed/u);
    await rm(file, { force: true });
  });
  await run('runner.duplicate-seed', () =>
    assert.throws(() =>
      seedCheck({
        ...baseline,
        entities: [...baseline.entities, globalThis.structuredClone(baseline.entities[0])],
      }),
    ),
  );
  await run('runner.missing-report', () =>
    verifyHostControl('/reports/reports/runner/host-missing-report', 'missing-report'),
  );
  await run('runner.failure-accounting', () =>
    verifyHostControl('/reports/reports/runner/host-failed-child', 'failed-child'),
  );
  await run('runner.ingestion-failure', async () => {
    // A deliberate ingestion fault bypasses the valid renderer and exercises Backstage's parser.
    await writeFile('/catalog/child.yaml', 'apiVersion: [\n');
    try {
      const refreshResult = await request(base, '/api/catalog/refresh', {
        token: admin,
        method: 'POST',
        body: { entityRef: 'location:bve-demo/demo-location' },
      });
      assert.equal(refreshResult.status, 200);
      let observed = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const result = await request(
          base,
          '/api/catalog/entities/by-name/location/bve-demo/demo-location',
          {
            token: admin,
          },
        );
        if (
          result.status === 200 &&
          result.body.status?.items?.some((item) => item.level === 'error')
        ) {
          observed = true;
          break;
        }
        await delay(250);
      }
      assert(observed, 'Observe actual catalog processing failure.');
      await assert.rejects(
        converge(base, baseline, reader, 2000),
        (error) => error.observation.processingErrors.length > 0,
      );
    } finally {
      await apply(baseline);
    }
  });
  await run('runner.interrupted-run', () =>
    verifyHostControl('/reports/reports/runner/host-interrupted', 'interrupted-child'),
  );
}
try {
  if (phase === 'render') {
    const seed = seedCheck(await loadSeed('/run/input/seed.json'));
    await writeJson('/reports/reports/seed.json', await renderSeed(seed, '/catalog'));
  } else if (phase === 'seed') {
    const seed = seedCheck(await loadSeed('/run/input/seed.json'));
    await apply(seed);
  } else if (phase === 'ready') {
    const seed = seedCheck(await loadSeed('/run/input/seed.json'));
    console.log(JSON.stringify(await converge(base, seed, reader)));
  } else if (phase === 'connected') await connected();
  else if (phase === 'runner') await runnerCases();
  else if (phase === 'mutation') {
    await run('environment.mutation', async () => {
      await apply(mutation);
      const entities = await readEntities(base, mutation.expected.entityRefs, reader);
      await writeJson(
        '/run/work/persistence-before.json',
        Object.fromEntries(
          entities.map((e) => [
            e.kind.toLowerCase() + ':' + e.metadata.namespace + '/' + e.metadata.name,
            e.metadata.uid,
          ]),
        ),
      );
    });
    const fixture = await createClientFixture({
      authorityReport: '/reports/reports/authority/' + phase + '.json',
    });
    await cliCase('cli.mutation', fixture, fixture.validText.replace('team-demo', 'team-next'), 0);
  } else if (phase === 'outage') {
    const fixture = await createClientFixture({
      authorityReport: '/reports/reports/authority/' + phase + '.json',
    });
    await cliCase('cli.outage', fixture, fixture.validText, 2);
  } else if (phase === 'recovery') {
    await run('environment.persistence', async () => {
      await converge(base, mutation, reader);
      const before = JSON.parse(await readFile('/run/work/persistence-before.json', 'utf8'));
      const entities = await readEntities(base, mutation.expected.entityRefs, reader);
      const after = Object.fromEntries(
        entities.map((e) => [
          e.kind.toLowerCase() + ':' + e.metadata.namespace + '/' + e.metadata.name,
          e.metadata.uid,
        ]),
      );
      assert.deepEqual(after, before, 'Persist entity UIDs across the same-container restart.');
      await writeJson('/reports/reports/persistence.json', {
        unchangedEntityUids: true,
        entityCount: entities.length,
      });
    });
    const fixture = await createClientFixture({
      authorityReport: '/reports/reports/authority/' + phase + '.json',
    });
    await cliCase('cli.recovery', fixture, fixture.validText, 0);
  } else if (phase === 'reset')
    await run('environment.reset', async () => {
      await converge(base, baseline, reader);
      const before = JSON.parse(await readFile('/run/work/persistence-before.json', 'utf8'));
      const entities = await readEntities(base, baseline.expected.entityRefs, reader);
      assert(
        entities
          .filter(
            (e) =>
              before[e.kind.toLowerCase() + ':' + e.metadata.namespace + '/' + e.metadata.name],
          )
          .every(
            (e) =>
              before[e.kind.toLowerCase() + ':' + e.metadata.namespace + '/' + e.metadata.name] !==
              e.metadata.uid,
          ),
        'Reset must create fresh database entity UIDs.',
      );
      await writeJson('/reports/reports/reset.json', {
        baselineRestored: true,
        freshEntityUids: true,
      });
    });
  else if (phase === 'editor') {
    const { runEditor } = await import('./editor.mjs');
    await apply(baseline);
    const version = process.argv[3];
    await runEditor({
      version,
      evidence,
      base,
      readerToken: reader,
      adminToken: admin,
      deniedToken: denied,
      reportDirectory: '/reports/reports/editor/' + version,
      controlDirectory: '/reports/control',
    });
  } else if (phase === 'editor-crash') {
    const { verifyEditorCrash } = await import('./editor.mjs');
    await run('runner.editor-crash', () =>
      verifyEditorCrash({
        version: '1.145.2',
        evidence,
        base,
        readerToken: reader,
        adminToken: admin,
        deniedToken: denied,
        reportDirectory: '/reports/reports/runner/editor-crash',
        controlDirectory: '/reports/control',
      }),
    );
  } else throw new Error('Unknown driver phase.');
} catch (error) {
  if (error.observation)
    await writeJson('/reports/reports/last-catalog-observation.json', error.observation);
  await evidence.save();
  throw error;
}
await evidence.save();
console.log(
  JSON.stringify({ phase, seedDigest: digest(baseline), counts: evidence.report.counts }),
);
