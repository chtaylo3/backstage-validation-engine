import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  catalogEntityKey,
  createCatalogProvider,
  digestJson,
  loadBackstageAdapter,
  parseContract,
} from '../src/index.js';
import type {
  CatalogAccessContext,
  CatalogCredentials,
  CatalogLookupReport,
  CatalogProvider,
  CatalogProviderOptions,
} from '../src/index.js';
import { makeContext, makeRequest } from './helpers.js';
import { startFakeBackstage } from './harness/fake-backstage.js';
import type { FakeBackstage } from './harness/fake-backstage.js';
import { startFixtureMatrix } from './harness/fixture-matrix.js';
import { loadPinnedMatrix } from './harness/pinned-matrix.js';

const ROOT = path.resolve('test/fixtures/backstage');
const TEAM = 'group:default/team';
const SERVICE = 'component:default/service';
const MISSING = 'group:default/missing';
const team = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { namespace: 'default', name: 'team' },
  spec: { type: 'team', children: [] },
};
const service = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { namespace: 'default', name: 'service' },
  spec: { type: 'service', lifecycle: 'production', owner: 'team' },
};
function access(overrides: Partial<CatalogAccessContext> = {}): CatalogAccessContext {
  const context = makeContext();
  return {
    installationId: 'installation-1',
    principalId: 'all',
    permissionRevision: 'permissions-1',
    credentialRevision: 'credentials-1',
    scope: ['catalog:read'],
    policyDigest: digestJson(context.policy),
    profileDigest: digestJson(context.profile),
    maxAgeMs: 30_000,
    ...overrides,
  };
}
function credentials(context: CatalogAccessContext, token = 'test-all'): CatalogCredentials {
  return {
    token,
    installationId: context.installationId,
    principalId: context.principalId,
    permissionRevision: context.permissionRevision,
    credentialRevision: context.credentialRevision,
    scope: context.scope,
  };
}
const run = (
  provider: CatalogProvider,
  refs: readonly string[] = [TEAM],
  context = access(),
  execution = { deadlineAt: Date.now() + 5000 },
) => provider.lookup(refs, context, execution);
function observation(report: CatalogLookupReport, ref = TEAM) {
  const result = report.data.entries.find(
    (entry) => entry.key === catalogEntityKey('primary', ref),
  );
  assert(result);
  return result;
}
function unavailable(report: CatalogLookupReport, reason: string, ref = TEAM) {
  const entry = observation(report, ref);
  assert.equal(entry.status, 'unavailable');
  if (entry.status === 'unavailable') assert.equal(entry.reason, reason);
}
async function setup(t: TestContext) {
  const matrix = await startFixtureMatrix(await loadPinnedMatrix(ROOT), ROOT, (artifact) =>
    startFakeBackstage(artifact, {
      entities: [team, service],
      principals: [
        { token: 'test-all', principalId: 'all', canRead: true, visibleRefs: '*' },
        { token: 'test-scoped', principalId: 'scoped', canRead: true, visibleRefs: [TEAM] },
        { token: 'test-denied', principalId: 'denied', canRead: false, visibleRefs: '*' },
      ],
    }),
  );
  const providers: CatalogProvider[] = [];
  t.after(async () => {
    try {
      await Promise.all(providers.map((provider) => provider.close()));
    } finally {
      await matrix.close();
      for (const { fixture } of matrix.fixtures) fixture.assertHealthy();
    }
  });
  return {
    fixtures: matrix.fixtures,
    async provider(fixture: FakeBackstage, overrides: Partial<CatalogProviderOptions> = {}) {
      const provider = await createCatalogProvider({
        connectionId: 'primary',
        baseUrl: fixture.baseUrl,
        adapterId: '@backstage/catalog-model@1.10.2',
        credentials: (context) => Promise.resolve(credentials(context)),
        ...overrides,
        limits: { retries: 0, ...overrides.limits },
      });
      providers.push(provider);
      return provider;
    },
  };
}

void test('native provider reference helpers honor both exact pins and preserve contextual defaults', async () => {
  for (const id of ['@backstage/catalog-model@1.10.2', '@backstage/catalog-model@1.7.5'] as const) {
    const adapter = await loadBackstageAdapter(id);
    assert.equal(
      adapter.resolveReference('TEAM', { defaultKind: 'Group', defaultNamespace: 'Org' }).entityRef,
      'group:org/team',
    );
    assert.equal(
      adapter.resolveReference('user:other/Alice', {
        defaultKind: 'Group',
        defaultNamespace: 'Org',
      }).entityRef,
      'user:other/alice',
    );
    assert.equal(adapter.entityReference(team), TEAM);
    assert.throws(() => adapter.resolveReference('team'), /native entity reference/);
    assert.throws(() => adapter.entityReference({ kind: 'Group' }), /native entity envelope/);
  }
});

void test('production provider reads both real fixture contracts and produces immutable pinned data', async (t) => {
  const state = await setup(t);
  for (const { target, fixture } of state.fixtures) {
    await t.test(target.backstageVersion, async () => {
      const provider = await state.provider(fixture);
      const report = await run(provider, ['GROUP:TEAM', SERVICE, MISSING, TEAM]);
      assert.equal(report.interrupted, 'none');
      assert.equal(report.failures.length, 0);
      assert.equal(report.data.entries.length, 3);
      assert.equal(observation(report).status, 'present');
      assert.equal(observation(report, MISSING).status, 'missing');
      assert(Object.isFrozen(report.data.entries[0]?.provenance.scope));
      assert.equal(fixture.requests().length, 1);
      assert.equal(fixture.requests()[0]?.operation, 'byRefs');
      const request = makeRequest();
      const deadlineAt = Date.now() + 4000;
      parseContract('validation-request', {
        ...request,
        execution: { mode: 'ci', startedAt: Date.now(), deadlineAt },
        data: report.data,
      });
    });
  }
});

void test('provider deduplicates canonical refs and splits uncached observations into bounded batches', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture, { limits: { batchSize: 2 } });
  const report = await run(provider, [TEAM, 'GROUP:TEAM', SERVICE, MISSING]);
  assert.equal(report.data.entries.length, 3);
  assert.deepEqual(
    fixture.requests().map((entry) => entry.operation),
    ['byRefs', 'byName'],
  );
  const again = await run(provider);
  assert.equal(observation(again).status, 'present');
  assert.equal(fixture.requests().length, 2);
});

void test('only authorized-view 404/null is missing; authentication and batch route failures stay unavailable', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const scoped = await state.provider(fixture, {
    credentials: (context) => Promise.resolve(credentials(context, 'test-scoped')),
  });
  assert.equal(
    observation(await run(scoped, [SERVICE], access({ principalId: 'scoped' })), SERVICE).status,
    'missing',
  );
  const invalid = await state.provider(fixture, {
    credentials: (context) => Promise.resolve(credentials(context, 'invalid')),
  });
  unavailable(await run(invalid), 'permission_denied');
  const denied = await state.provider(fixture, {
    credentials: (context) => Promise.resolve(credentials(context, 'test-denied')),
  });
  unavailable(await run(denied, [TEAM], access({ principalId: 'denied' })), 'permission_denied');
  const provider = await state.provider(fixture);
  fixture.failNext({ operation: 'byRefs' }, { kind: 'status', status: 404 });
  const report = await run(provider, [TEAM, SERVICE]);
  unavailable(report, 'provider_error');
  unavailable(report, 'provider_error', SERVICE);
});

void test('credential binding failures never reach the server or reuse a prior authorized result', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  let mismatch = false;
  const provider = await state.provider(fixture, {
    credentials: (context) =>
      Promise.resolve({
        ...credentials(context),
        ...(mismatch ? { principalId: 'someone-else' } : {}),
      }),
  });
  await run(provider);
  mismatch = true;
  const report = await run(provider);
  unavailable(report, 'permission_denied');
  assert.equal(report.failures[0]?.code, 'credential_binding');
  assert.equal(report.failures[0]?.evidence?.cause, 'credential_binding');
  assert.equal(report.failures[0]?.evidence?.stage, 'catalog_credentials');
  assert.equal(fixture.requests().length, 1);
  assert(!JSON.stringify(report).includes('test-all'));
});

void test('cache partitions every authority/policy/freshness dimension and keeps original observation timestamps', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture);
  const initial = await run(provider);
  const cached = await run(provider);
  assert.equal(cached.data.digest, initial.data.digest);
  assert.equal(fixture.requests().length, 1);
  const variations: Partial<CatalogAccessContext>[] = [
    { installationId: 'installation-2' },
    { principalId: 'principal-2' },
    { permissionRevision: 'permissions-2' },
    { credentialRevision: 'credentials-2' },
    { scope: ['catalog:read', 'extra'] },
    { policyDigest: `sha256:${'a'.repeat(64)}` },
    { profileDigest: `sha256:${'b'.repeat(64)}` },
    { maxAgeMs: 1000 },
  ];
  for (const variation of variations)
    assert.equal(observation(await run(provider, [TEAM], access(variation))).status, 'present');
  assert.equal(fixture.requests().length, variations.length + 1);
  const context = access({ scope: ['second', 'first'] });
  await run(provider, [TEAM], context);
  const before = fixture.requests().length;
  await run(provider, [TEAM], { ...context, scope: ['first', 'second'] });
  assert.equal(fixture.requests().length, before);
});

void test('token rotation and permission changes cannot reuse cached visibility', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  let token = 'test-all';
  const provider = await state.provider(fixture, {
    credentials: (context) => Promise.resolve(credentials(context, token)),
  });
  assert.equal(observation(await run(provider, [SERVICE]), SERVICE).status, 'present');
  fixture.setPrincipal({ token: 'rotated', principalId: 'all', canRead: true, visibleRefs: [] });
  token = 'rotated';
  assert.equal(observation(await run(provider, [SERVICE]), SERVICE).status, 'missing');
  fixture.setPrincipal({ token, principalId: 'all', canRead: true, visibleRefs: '*' });
  assert.equal(
    observation(
      await run(provider, [SERVICE], access({ permissionRevision: 'permissions-2' })),
      SERVICE,
    ).status,
    'present',
  );
});

void test('positive and negative TTLs expire without extending cached provenance', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const initial = await run(provider, [TEAM, MISSING]);
  const missingAt = observation(initial, MISSING).provenance.fetchedAt;
  fixture.upsert({ ...team, metadata: { ...team.metadata, name: 'missing' } });
  assert.equal(observation(await run(provider, [MISSING]), MISSING).status, 'missing');
  t.mock.timers.tick(5001);
  const found = await run(provider, [MISSING]);
  assert.equal(observation(found, MISSING).status, 'present');
  assert(observation(found, MISSING).provenance.fetchedAt > missingAt);
  fixture.remove(TEAM);
  t.mock.timers.tick(30_001);
  assert.equal(observation(await run(provider)).status, 'missing');
});

void test('fresh-only access and bounded cache bytes/entries never grow without limit', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture, { limits: { cacheEntries: 1, cacheBytes: 4096 } });
  await run(provider);
  await run(provider, [SERVICE]);
  assert.equal(provider.stats().cacheEntries, 1);
  assert(provider.stats().cacheBytes <= 4096);
  await run(provider, [TEAM], access({ maxAgeMs: 0 }));
  await run(provider, [TEAM], access({ maxAgeMs: 0 }));
  assert.equal(fixture.requests().length, 4);
});

void test('cache entries expiring while other reads wait become unavailable before snapshot delivery', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture, { limits: { presentTtlMs: 10 } });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await run(provider);
  const gate = fixture.holdNext({ operation: 'byName', entityRef: MISSING });
  const pending = run(provider, [TEAM, MISSING]);
  await gate.entered;
  t.mock.timers.tick(11);
  gate.release();
  const report = await pending;
  unavailable(report, 'timeout');
  assert.equal(observation(report, MISSING).status, 'missing');
  assert.equal(report.interrupted, 'timeout');
  assert(report.data.entries.every((entry) => entry.provenance.expiresAt > Date.now()));
});

void test('older delayed observations cannot overwrite the cache after a newer lookup', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture);
  const gate = fixture.holdNext({ operation: 'byName' });
  const older = run(provider);
  await gate.entered;
  const updated = { ...team, spec: { type: 'updated', children: [] } };
  fixture.upsert(updated);
  const newer = await run(provider);
  gate.release();
  const oldEntry = observation(await older);
  const newEntry = observation(newer);
  assert(oldEntry.status === 'present' && newEntry.status === 'present');
  assert.deepEqual(oldEntry.value, team);
  assert.deepEqual(newEntry.value, updated);
  const cached = observation(await run(provider));
  assert(cached.status === 'present');
  assert.deepEqual(cached.value, updated);
  assert.equal(fixture.requests().length, 2);
});

void test('outages, invalid responses and authentication failures are never cached as absence', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture);
  for (const fault of [
    { kind: 'status', status: 503 },
    { kind: 'status', status: 401 },
    { kind: 'malformed-json' },
  ] as const) {
    fixture.failNext({ operation: 'byName' }, fault);
    const report = await run(provider);
    assert.equal(observation(report).status, 'unavailable');
    assert.equal(provider.stats().cacheEntries, 0);
  }
  assert.equal(observation(await run(provider)).status, 'present');
});

void test('a known authorization failure clears cached observations across freshness partitions', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture);
  await run(provider);
  assert.equal(provider.stats().cacheEntries, 1);
  fixture.revokeToken('test-all');
  unavailable(await run(provider, [TEAM], access({ maxAgeMs: 0 })), 'permission_denied');
  assert.equal(provider.stats().cacheEntries, 0);
  unavailable(await run(provider), 'permission_denied');
  assert.equal(fixture.requests().length, 3);
});

void test('retries are bounded, honor Retry-After limits and stop on authorization failure', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture, { limits: { retries: 1, retryDelayMs: 0 } });
  fixture.failNext({ operation: 'byName' }, { kind: 'status', status: 503 });
  assert.equal(observation(await run(provider)).status, 'present');
  assert.equal(fixture.requests().length, 2);
  fixture.failNext({ operation: 'byName' }, { kind: 'status', status: 429, retryAfter: '0' });
  assert.equal(observation(await run(provider, [TEAM], access({ maxAgeMs: 0 }))).status, 'present');
  const before = fixture.requests().length;
  fixture.failNext({ operation: 'byName' }, { kind: 'status', status: 403 });
  unavailable(await run(provider, [TEAM], access({ maxAgeMs: 0 })), 'permission_denied');
  assert.equal(fixture.requests().length, before + 1);
  fixture.failNext({ operation: 'byName' }, { kind: 'status', status: 503 });
  fixture.failNext({ operation: 'byName' }, { kind: 'status', status: 503 });
  unavailable(await run(provider, [TEAM], access({ maxAgeMs: 0 })), 'provider_error');
  assert.equal(fixture.requests().length, before + 3);
});

void test('new lookups cannot bypass a connection-wide Retry-After cooldown', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture, { limits: { retries: 1 } });
  fixture.failNext({ operation: 'byName' }, { kind: 'status', status: 429, retryAfter: '60' });
  const first = await run(provider);
  unavailable(first, 'provider_error');
  assert.equal(first.failures[0]?.code, 'rate_limited');
  unavailable(await run(provider), 'provider_error');
  assert.equal(fixture.requests().length, 1);
  assert.equal(provider.stats().cacheEntries, 0);
});

void test('redirect responses are not followed to another endpoint', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const other = state.fixtures[1]!.fixture;
  const provider = await state.provider(fixture);
  fixture.failNext(
    { operation: 'byName' },
    {
      kind: 'status',
      status: 302,
      location: `${other.baseUrl}/entities/by-name/group/default/team`,
    },
  );
  unavailable(await run(provider), 'provider_error');
  assert.equal(other.requests().length, 0);
});

void test('wire validation rejects swapped, truncated and malformed entity responses', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture);
  for (const body of [
    { items: [service, team] },
    { items: [team] },
    { items: [{ kind: 'Group' }, service] },
    { items: [] },
  ]) {
    fixture.failNext({ operation: 'byRefs' }, { kind: 'invalid-body', body });
    const report = await run(provider, [TEAM, SERVICE]);
    unavailable(report, 'provider_error');
    assert.equal(report.failures[0]?.code, 'invalid_response');
    assert.equal(report.failures[0]?.evidence?.cause, 'invalid_response');
    assert.equal(report.failures[0]?.evidence?.stage, 'catalog_response');
    assert.equal(provider.stats().cacheEntries, 0);
  }
  fixture.failNext({ operation: 'byName' }, { kind: 'invalid-body', body: null });
  unavailable(await run(provider), 'provider_error');
});

void test('response bytes, aggregate bytes and structured-value budgets fail with incomplete resource coverage', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  for (const limits of [{ responseBytes: 32 }, { totalResponseBytes: 32 }, { responseValues: 2 }]) {
    const provider = await state.provider(fixture, { limits });
    const report = await run(provider);
    unavailable(report, 'provider_error');
    assert.equal(report.interrupted, 'resource_limit');
  }
});

void test('aggregate response limits preserve earlier observations and block remaining work', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const totalResponseBytes =
    Math.max(Buffer.byteLength(JSON.stringify(team)), Buffer.byteLength(JSON.stringify(service))) +
    10;
  const provider = await state.provider(fixture, { limits: { batchSize: 1, totalResponseBytes } });
  const report = await run(provider, [TEAM, SERVICE]);
  assert.equal(observation(report).status, 'present');
  unavailable(report, 'provider_error', SERVICE);
  assert.equal(report.interrupted, 'resource_limit');
});

void test('cached observations cannot bypass the combined snapshot value budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const entities = new Map<string, object>();
  let calls = 0;
  const provider = await createCatalogProvider({
    connectionId: 'primary',
    baseUrl: 'https://catalog.invalid/api/catalog',
    adapterId: '@backstage/catalog-model@1.10.2',
    credentials: (context) => Promise.resolve(credentials(context)),
    limits: { retries: 0 },
    transport: (input) => {
      calls++;
      const url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const name = url.pathname.split('/').at(-1)!;
      return Promise.resolve(Response.json(entities.get(name)));
    },
  });
  t.after(() => provider.close());
  const refs: string[] = [];
  for (let index = 0; index < 6; index++) {
    const name = `large-${index}`;
    entities.set(name, {
      ...team,
      metadata: { ...team.metadata, name },
      spec: { ...team.spec, payload: Array.from({ length: 20_000 }, () => 0) },
    });
    const ref = `group:default/${name}`;
    refs.push(ref);
    const seeded = await run(provider, [ref]);
    assert.equal(observation(seeded, ref).status, 'present', JSON.stringify(seeded.failures));
  }
  assert.equal(provider.stats().cacheEntries, 6);
  const report = await run(provider, refs);
  assert.equal(report.interrupted, 'resource_limit');
  assert(report.data.entries.every((entry) => entry.status === 'unavailable'));
  assert.equal(report.failures.at(-1)?.evidence?.stage, 'catalog_snapshot');
  assert.equal(report.failures.at(-1)?.evidence?.cause, 'aggregate_limit');
  assert.equal(calls, 6, 'aggregate rejection must use cached entries without transport');
});

void test('real HTTP large observations are cached and reused without further wire requests', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const provider = await state.provider(fixture);
  const refs: string[] = [];
  for (let index = 0; index < 2; index++) {
    const name = `wire-large-${index}`;
    fixture.upsert({
      ...team,
      metadata: { ...team.metadata, name },
      spec: { ...team.spec, payload: Array.from({ length: 20_000 }, () => 0) },
    });
    const ref = `group:default/${name}`;
    refs.push(ref);
    const seeded = await run(provider, [ref]);
    assert.equal(observation(seeded, ref).status, 'present', JSON.stringify(seeded.failures));
  }
  const cached = await run(provider, refs);
  assert.equal(cached.interrupted, 'none');
  assert(cached.data.entries.every((entry) => entry.status === 'present'));
  assert.equal(fixture.requests().length, 2);
});

void test('backward wall time rejects future catalog observations with safe freshness evidence and recovers', async (t) => {
  let wall = Date.now();
  const initial = wall;
  t.mock.method(Date, 'now', () => wall);
  let calls = 0;
  const provider = await createCatalogProvider({
    connectionId: 'primary',
    baseUrl: 'https://catalog.invalid/api/catalog',
    adapterId: '@backstage/catalog-model@1.10.2',
    credentials: (context) => Promise.resolve(credentials(context)),
    limits: { retries: 0 },
    transport: () => {
      if (++calls === 1) wall -= 20;
      return Promise.resolve(Response.json(team));
    },
  });
  t.after(() => provider.close());
  const report = await run(provider);
  unavailable(report, 'timeout');
  assert.equal(report.failures[0]?.evidence?.cause, 'future_observation');
  assert.equal(report.failures[0]?.evidence?.stage, 'catalog_freshness');
  assert.equal(report.failures[0]?.evidence?.wallElapsedMs, -20);
  assert.equal(report.interrupted, 'timeout');
  assert.equal(provider.stats().cacheEntries, 0);
  assert(!JSON.stringify(report.failures).includes('test-all'));
  wall = initial + 1;
  assert.equal(observation(await run(provider)).status, 'present');
  assert.equal(calls, 2);
});

void test('streaming responses with invalid encoding or content type remain unavailable', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  for (const response of [
    new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const provider = await state.provider(fixture, { transport: () => Promise.resolve(response) });
    const report = await run(provider);
    unavailable(report, 'provider_error');
    assert.equal(report.failures[0]?.code, 'invalid_response');
    assert.equal(report.failures[0]?.evidence?.cause, 'invalid_response');
    assert.equal(report.failures[0]?.evidence?.stage, 'catalog_response');
  }
});

void test('a stalled response body is cancelled at the attempt deadline', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  let cancelled = false;
  const provider = await state.provider(fixture, {
    limits: { attemptMs: 100 },
    transport: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
  });
  const report = await run(provider);
  unavailable(report, 'timeout');
  assert.equal(report.interrupted, 'timeout');
  assert.equal(report.failures[0]?.evidence?.cause, 'attempt_timeout');
  assert.equal(report.failures[0]?.evidence?.stage, 'catalog_response');
  assert(cancelled);
  assert.equal(provider.stats().active, 0);
});

void test('a transport completing after timeout has its unused response body cancelled', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  let finish!: (response: Response) => void;
  let cancelled = false;
  const provider = await state.provider(fixture, {
    limits: { attemptMs: 100 },
    transport: () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  });
  unavailable(await run(provider), 'timeout');
  finish(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await Promise.resolve();
  assert(cancelled);
});

void test('original request deadline aborts the HTTP request and later lookups recover', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture);
  const gate = fixture.holdNext({ operation: 'byName' });
  const pending = run(provider, [TEAM], access(), { deadlineAt: Date.now() + 200 });
  await gate.entered;
  const report = await pending;
  await gate.cancelled;
  unavailable(report, 'timeout');
  assert.equal(report.interrupted, 'timeout');
  assert.equal(report.failures[0]?.evidence?.cause, 'request_timeout');
  assert.equal(observation(await run(provider)).status, 'present');
});

void test('an individual HTTP attempt timeout is bounded separately from the request deadline', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture, { limits: { attemptMs: 200 } });
  const gate = fixture.holdNext({ operation: 'byName' });
  const pending = run(provider);
  await gate.entered;
  const report = await pending;
  await gate.cancelled;
  unavailable(report, 'timeout');
  assert.equal(report.interrupted, 'timeout');
  assert.equal(report.failures[0]?.evidence?.cause, 'attempt_timeout');
});

void test('queue admission is bounded and cancelling a queued caller does not cancel an active lookup', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture, { limits: { concurrency: 1, outstanding: 2 } });
  const gate = fixture.holdNext({ operation: 'byName' });
  const first = run(provider);
  await gate.entered;
  const controller = new AbortController();
  const second = provider.lookup([TEAM], access(), {
    deadlineAt: Date.now() + 5000,
    signal: controller.signal,
  });
  assert.equal(provider.stats().queued, 1);
  const rejected = await run(provider);
  assert.equal(rejected.failures[0]?.code, 'queue_limit');
  assert.equal(rejected.interrupted, 'resource_limit');
  controller.abort();
  const cancelled = await second;
  assert.equal(cancelled.interrupted, 'cancelled');
  assert.equal(cancelled.failures[0]?.evidence?.cause, 'cancelled');
  assert.equal(cancelled.failures[0]?.evidence?.stage, 'catalog_admission');
  assert.equal(provider.stats().queued, 0);
  gate.release();
  assert.equal(observation(await first).status, 'present');
  assert.equal(provider.stats().active, 0);
});

void test('shutdown cancels active and queued lookups, clears caches and rejects new work', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  const provider = await state.provider(fixture, { limits: { concurrency: 1 } });
  const gate = fixture.holdNext({ operation: 'byName' });
  const first = run(provider);
  await gate.entered;
  const second = run(provider);
  await Promise.all([provider.close(), provider.close()]);
  assert.equal((await first).interrupted, 'cancelled');
  assert.equal((await second).interrupted, 'cancelled');
  assert.deepEqual(provider.stats(), { active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 });
  await assert.rejects(run(provider), /closed/);
});

void test('trusted credential callbacks that ignore cancellation cannot hold a provider permit forever', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = await state.provider(fixture, {
    credentials: () => {
      entered();
      return new Promise<CatalogCredentials>(() => {});
    },
  });
  const work = run(provider);
  await ready;
  await provider.close();
  assert.equal((await work).interrupted, 'cancelled');
  assert.equal(provider.stats().active, 0);
  assert.equal(fixture.requests().length, 0);
});

void test('provider configuration rejects unsafe endpoints, raised limits and malformed inputs before HTTP', async (t) => {
  const state = await setup(t);
  const fixture = state.fixtures[0]!.fixture;
  for (const baseUrl of [
    'http://remote.example/api/catalog',
    'https://token@example.test/api/catalog',
    'https://example.test/api/catalog?token=secret',
    'file:///tmp/catalog',
  ]) {
    await assert.rejects(
      state.provider(fixture, { baseUrl }),
      /trusted catalog provider configuration/,
    );
  }
  await assert.rejects(state.provider(fixture, { limits: { concurrency: 5 } }), /configuration/);
  const provider = await state.provider(fixture);
  await assert.rejects(run(provider, ['team']), /kind-qualified/);
  await assert.rejects(
    run(
      provider,
      Array.from({ length: 1001 }, () => TEAM),
    ),
    /input limits/,
  );
  await assert.rejects(
    run(provider, [TEAM], access({ profileDigest: 'invalid' })),
    /configuration/,
  );
  const invalidContext = {
    ...access(),
    authorized: true,
    baseUrl: 'https://caller.example/catalog',
  };
  await assert.rejects(run(provider, [TEAM], invalidContext), /configuration/);
  const report = await run(provider, []);
  assert.equal(report.data.entries.length, 0);
  assert.equal(fixture.requests().length, 0);
});
