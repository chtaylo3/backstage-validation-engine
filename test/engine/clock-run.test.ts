import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CelError,
  createCatalogProvider,
  digestJson,
  parseContract,
  validateBackstageSources,
  validatePolicySources,
} from '../../src/index.js';
import type { CatalogAccessContext, CatalogProvider, Clock } from '../../src/index.js';
import { schemaArtifact } from '../harness/custom-kind-fixture.js';
import { createHostCatalog, parseCatalogSettings } from '../../src/host/catalog-config.js';
import { createFilesystemSource } from '../../src/lsp/filesystem.js';
import { filesystemFixture } from '../harness/filesystem-fixture.js';
import { ManualClock } from '../harness/manual-clock.js';
import { componentText, policyRun, team } from '../harness/policy-fixture.js';

/** Years before real time: every real-time admission of a deadline this old rejects it. */
const PAST = Date.UTC(2019, 0, 1);
const artifact = schemaArtifact({
  type: 'object',
  properties: { spec: { type: 'object', properties: { lifecycle: { const: 'production' } } } },
});
const schemaRule = {
  id: 'production-only',
  version: '1',
  kind: 'schema',
  mandatory: true,
  severity: 'error',
  requires: [] as string[],
  schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
} as const;
/** A catalog rule without a selector, so that the run evaluates no CEL in real-time workers. */
const ownerExists = {
  id: 'owner-exists',
  version: '1',
  kind: 'catalog',
  check: 'exists',
  referencePath: '/spec/owner',
  mandatory: true,
  severity: 'error',
  requires: [] as string[],
} as const;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const transport = (() =>
  Promise.resolve(
    json({ ...team, metadata: { namespace: 'default', name: 'team' } }),
  )) as typeof fetch;
type Run = ReturnType<typeof policyRun>;
function access(run: Run): CatalogAccessContext {
  return {
    installationId: run.request.identity.installationId,
    principalId: 'reader',
    permissionRevision: run.request.identity.permissionRevision,
    credentialRevision: 'credentials-1',
    scope: ['catalog:read'],
    policyDigest: run.request.policy.digest,
    profileDigest: run.request.profile.digest,
    maxAgeMs: 30_000,
  };
}
async function catalog(t: TestContext, run: Run, clock?: Clock) {
  const provider: CatalogProvider = await createCatalogProvider({
    connectionId: 'primary',
    baseUrl: 'https://catalog.example/api/catalog',
    adapterId: run.context.profile.adapterId,
    limits: { retries: 0 },
    transport,
    ...(clock ? { clock } : {}),
    credentials: (context) =>
      Promise.resolve({
        token: 'reader-token',
        installationId: context.installationId,
        principalId: context.principalId,
        permissionRevision: context.permissionRevision,
        credentialRevision: context.credentialRevision,
        scope: context.scope,
      }),
  });
  t.after(() => provider.close());
  return { provider, access: access(run) };
}
/** The time-free verdict of a run: findings, coverage, rule states and failures. */
const verdict = (report: Awaited<ReturnType<typeof validatePolicySources>>) => ({
  interrupted: report.interrupted,
  findings: report.findings,
  coverage: report.coverage,
  ruleStates: report.ruleStates,
  failures: report.rules.failures,
});

void test('a full policy run driven by a manual clock years from real time matches the same run on the system clock', async (t) => {
  const run = policyRun({
    text: componentText().replace('production', 'experimental'),
    rules: [schemaRule, ownerExists],
    schemaArtifacts: [artifact],
  });
  const reference = await validatePolicySources(run.request, run.context, {
    catalog: await catalog(t, run),
  });
  const clock = new ManualClock(PAST, 1000);
  const past = parseContract('validation-request', {
    ...run.request,
    execution: { ...run.request.execution, startedAt: PAST, deadlineAt: PAST + 5000 },
  });
  const report = await validatePolicySources(past, run.context, {
    clock,
    catalog: await catalog(t, run, clock),
  });
  assert.equal(report.interrupted, 'none');
  assert.deepEqual(verdict(report), verdict(reference));
  // The run did evaluate both rules: one schema finding, and a passed catalog rule.
  assert.deepEqual(
    report.ruleStates.map((row) => [row.ruleId, row.status]),
    [
      ['owner-exists', 'passed'],
      ['production-only', 'failed'],
    ],
  );
  assert.equal(report.findings.length, 1);
  // Reference data was observed and pinned by the manual clock.
  assert.equal(report.request.execution.startedAt, PAST);
  assert(report.request.data.entries.every((entry) => entry.provenance.fetchedAt === PAST));
});

void test('the source stage decides its deadline by the injected clock, years from real time', async () => {
  const run = policyRun({ rules: [] });
  const request = parseContract('validation-request', {
    ...run.request,
    execution: { ...run.request.execution, startedAt: PAST, deadlineAt: PAST + 5000 },
  });
  // Real time is years after this deadline: only the manual clock can admit the stage.
  const admitted = await validateBackstageSources(request, run.context, {
    clock: new ManualClock(PAST, 1000),
  });
  assert.equal(admitted.interrupted, 'none');
  assert.equal(admitted.entities.length, 1);
  assert(
    admitted.coverage.every((row) => row.status === 'verified'),
    JSON.stringify(admitted),
  );
  const expired = await validateBackstageSources(request, run.context, {
    clock: new ManualClock(PAST + 5000, 1000),
  });
  assert.equal(expired.interrupted, 'timeout');
  assert(expired.coverage.some((row) => row.required && row.status === 'blocked'));
  assert.equal(expired.entities.length, 0);
});

void test('the host filesystem reader decides each capture deadline by the injected clock', async (t) => {
  const f = await filesystemFixture(t);
  const clock = new ManualClock(PAST, 1000);
  const filesystem = await createFilesystemSource(f.config, clock);
  t.after(() => filesystem.close());
  // A deadline years in the past by real time is still ahead by the manual clock.
  const captured = await filesystem.capture(f.config.source, { deadlineAt: PAST + 1000 });
  assert.deepEqual(
    captured.files.map((file) => file.uri),
    f.source.files.map((file) => file.uri),
  );
  await assert.rejects(
    filesystem.capture(f.config.source, { deadlineAt: PAST }),
    (error: unknown) => error instanceof CelError && error.code === 'request_timeout',
  );
});

void test('a catalog built by the host factory stamps observations with the injected clock', async (t) => {
  const server = createServer((request, response) => {
    const found = request.url === '/api/catalog/entities/by-name/group/default/team';
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        found
          ? { ...team, metadata: { namespace: 'default', name: 'team' } }
          : { error: { name: 'NotFoundError', message: 'absent' }, response: { statusCode: 404 } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const run = policyRun();
  const clock = new ManualClock(PAST, 1000);
  const host = await createHostCatalog(
    parseCatalogSettings({
      connectionId: 'primary',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/catalog`,
      principalId: 'reader',
      credentialRevision: '1',
      scope: ['catalog:read'],
      maxAgeMs: 30_000,
      tokenEnv: 'BVE_CLOCK_TOKEN',
    }),
    {
      adapterId: run.context.profile.adapterId,
      identity: run.request.identity,
      policyDigest: digestJson(run.context.policy),
      profileDigest: digestJson(run.context.profile),
    },
    { BVE_CLOCK_TOKEN: 'reader-token' },
    clock,
  );
  assert(host);
  t.after(() => host.provider.close());
  const report = await host.provider.lookup(['group:default/team'], host.access, {
    deadlineAt: PAST + 1000,
  });
  assert.equal(report.interrupted, 'none');
  const entry = report.data.entries[0]!;
  assert.equal(entry.status, 'present');
  assert.equal(entry.provenance.fetchedAt, PAST);
  assert.equal(entry.provenance.expiresAt, PAST + 30_000);
});
