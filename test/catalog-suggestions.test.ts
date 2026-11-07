import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyMatrix, policyRun, team } from './harness/policy-fixture.js';
import { createCatalogProvider } from '../src/index.js';

const query = { kind: 'group', namespace: 'default', prefix: 'te' };
void test('identity search follows projected cursor pages on both pinned API contracts', async (t) => {
  const matrix = await policyMatrix(t),
    run = policyRun();
  for (const [i, { fixture, target }] of matrix.fixtures.entries())
    await t.test(target.backstageVersion, async () => {
      for (let n = 0; n < 104; n++)
        fixture.upsert({
          ...team,
          metadata: { name: 'team-' + String(n).padStart(3, '0') },
          spec: { type: 'team', children: [], private: 'never projected' },
        });
      const catalog = await matrix.catalog(run, i);
      const report = await catalog.provider.suggest!(query, catalog.access, {
        deadlineAt: Date.now() + 5000,
      });
      assert.equal(report.status, 'ready');
      assert.equal(report.refs.length, 105);
      assert.equal(report.truncated, false);
      assert.equal(fixture.requests().filter((row) => row.operation === 'byQuery').length, 2);
      assert.equal(report.refs[0], 'group:default/team');
      assert(report.expiresAt > report.fetchedAt);
      assert(!JSON.stringify(report).includes('never projected'));
      const capped = await catalog.provider.suggest!({ ...query, prefix: 'team' }, catalog.access, {
        deadlineAt: Date.now() + 5000,
      });
      assert.equal(capped.status, 'ready');
    });
});

void test('search never equates denied, invalid or rate-limited responses with an empty authorized result', async (t) => {
  const matrix = await policyMatrix(t),
    catalog = await matrix.catalog(policyRun()),
    fixture = matrix.fixtures[0]!.fixture;
  for (const [status, failure] of [
    [403, 'permission_denied'],
    [429, 'rate_limited'],
    [302, 'provider_error'],
  ] as const) {
    fixture.failNext(
      { operation: 'byQuery' },
      { kind: 'status', status, ...(status === 429 ? { retryAfter: '0' } : {}) },
    );
    const report = await catalog.provider.suggest!(query, catalog.access, {
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(report.status, 'unavailable');
    if (report.status === 'unavailable') assert.equal(report.failure, failure);
    assert.deepEqual(report.refs, []);
  }
  fixture.failNext(
    { operation: 'byQuery' },
    { kind: 'invalid-body', body: { items: [false], totalItems: 1, pageInfo: {} } },
  );
  assert.equal(
    (await catalog.provider.suggest!(query, catalog.access, { deadlineAt: Date.now() + 5000 }))
      .status,
    'unavailable',
  );
  const empty = await catalog.provider.suggest!({ ...query, prefix: 'missing' }, catalog.access, {
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(empty.status, 'ready');
  assert.deepEqual(empty.refs, []);
});

void test('search enforces authorized visibility and shared queue/deadline cancellation', async (t) => {
  const matrix = await policyMatrix(t),
    run = policyRun(),
    fixture = matrix.fixtures[0]!.fixture;
  fixture.upsert({ ...team, metadata: { name: 'team-private' } });
  fixture.setPrincipal({
    token: 'policy-test-secret',
    principalId: 'reader',
    canRead: true,
    visibleRefs: ['group:default/team'],
  });
  const catalog = await matrix.catalog(run);
  assert.deepEqual(
    (await catalog.provider.suggest!(query, catalog.access, { deadlineAt: Date.now() + 5000 }))
      .refs,
    ['group:default/team'],
  );
  const gate = fixture.holdNext({ operation: 'byQuery' }),
    abort = new AbortController();
  const pending = catalog.provider.suggest!(query, catalog.access, {
    deadlineAt: Date.now() + 5000,
    signal: abort.signal,
  });
  await gate.entered;
  abort.abort();
  const report = await pending;
  assert.equal(report.status, 'unavailable');
  if (report.status === 'unavailable') assert.equal(report.failure, 'cancelled');
  await gate.cancelled;
  assert.equal(catalog.provider.stats().active, 0);
  assert.equal(catalog.provider.stats().queued, 0);
  const timeoutGate = fixture.holdNext({ operation: 'byQuery' });
  const timed = catalog.provider.suggest!(query, catalog.access, { deadlineAt: Date.now() + 250 });
  await timeoutGate.entered;
  const result = await timed;
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') assert.equal(result.failure, 'timeout');
  await timeoutGate.cancelled;
});

void test('search rejects query injection and bounds results and cursor work', async (t) => {
  const matrix = await policyMatrix(t),
    catalog = await matrix.catalog(policyRun()),
    fixture = matrix.fixtures[0]!.fixture;
  for (const invalid of [
    { ...query, kind: 'group,kind=user' },
    { ...query, namespace: '../other' },
    { ...query, prefix: 'x' },
    { ...query, prefix: 'te&filter=kind=user' },
    { ...query, cursor: 'client-selected' },
  ])
    await assert.rejects(
      catalog.provider.suggest!(invalid, catalog.access, {
        deadlineAt: Date.now() + 5000,
      }),
    );
  assert.equal(fixture.requests().length, 0);
  for (let n = 0; n < 250; n++)
    fixture.upsert({ ...team, metadata: { name: 'team-' + String(n).padStart(3, '0') } });
  const capped = await catalog.provider.suggest!(query, catalog.access, {
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(capped.refs.length, 200);
  assert.equal(capped.truncated, true);
  assert.equal(fixture.requests().length, 2);
});

void test('search response bounds, identity validation, cursor cycles and redirects fail closed', async (t) => {
  const matrix = await policyMatrix(t),
    run = policyRun(),
    fixture = matrix.fixtures[0]!.fixture;
  const catalog = await matrix.catalog(run);
  const reports = [
    { items: [{ ...team, kind: 'User' }], totalItems: 1, pageInfo: {} },
    { items: [team], totalItems: -1, pageInfo: {} },
    { items: Array.from({ length: 101 }, () => team), totalItems: 101, pageInfo: {} },
    { items: [team], totalItems: 1, pageInfo: { nextCursor: 'x'.repeat(4097) } },
  ];
  for (const body of reports) {
    fixture.failNext({ operation: 'byQuery' }, { kind: 'invalid-body', body });
    const report = await catalog.provider.suggest!(query, catalog.access, {
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(report.status, 'unavailable');
    if (report.status === 'unavailable') assert.equal(report.failure, 'invalid_response');
  }
  for (let i = 0; i < 2; i++)
    fixture.failNext(
      { operation: 'byQuery' },
      {
        kind: 'invalid-body',
        body: { items: [team], totalItems: 3, pageInfo: { nextCursor: 'repeat' } },
      },
    );
  const cycle = await catalog.provider.suggest!(query, catalog.access, {
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(cycle.status, 'unavailable');
  const small = await createCatalogProvider({
    connectionId: 'small',
    baseUrl: fixture.baseUrl,
    adapterId: run.context.profile.adapterId,
    limits: { responseBytes: 16 },
    credentials: (access) => Promise.resolve({ ...access, token: 'policy-test-secret' }),
  });
  t.after(() => small.close());
  const limited = await small.suggest!(query, catalog.access, { deadlineAt: Date.now() + 5000 });
  assert.equal(limited.status, 'unavailable');
  if (limited.status === 'unavailable') assert.equal(limited.failure, 'resource_limit');
});

void test('search and validation share admission, credential binding and shutdown ownership', async (t) => {
  const matrix = await policyMatrix(t),
    run = policyRun(),
    fixture = matrix.fixtures[0]!.fixture;
  const access = (await matrix.catalog(run)).access;
  const provider = await createCatalogProvider({
    connectionId: 'shared',
    baseUrl: fixture.baseUrl,
    adapterId: run.context.profile.adapterId,
    limits: { concurrency: 1, outstanding: 1 },
    credentials: (context) => Promise.resolve({ ...context, token: 'policy-test-secret' }),
  });
  t.after(() => provider.close());
  const lookupGate = fixture.holdNext({ operation: 'byName' });
  const lookup = provider.lookup(['group:default/team'], access, { deadlineAt: Date.now() + 5000 });
  await lookupGate.entered;
  const rejected = await provider.suggest!(query, access, { deadlineAt: Date.now() + 5000 });
  assert.equal(rejected.status, 'unavailable');
  if (rejected.status === 'unavailable') assert.equal(rejected.failure, 'queue_limit');
  lookupGate.release();
  await lookup;
  const searchGate = fixture.holdNext({ operation: 'byQuery' });
  const pending = provider.suggest!(query, access, { deadlineAt: Date.now() + 5000 });
  await searchGate.entered;
  await provider.close();
  await searchGate.cancelled;
  const cancelled = await pending;
  assert.equal(cancelled.status, 'unavailable');
  if (cancelled.status === 'unavailable') assert.equal(cancelled.failure, 'cancelled');
  assert.deepEqual(provider.stats(), { active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 });
  await assert.rejects(provider.suggest!(query, access, { deadlineAt: Date.now() + 5000 }));
  const broken = await createCatalogProvider({
    connectionId: 'broken',
    baseUrl: fixture.baseUrl,
    adapterId: run.context.profile.adapterId,
    credentials: (context) =>
      Promise.resolve({ ...context, principalId: 'different', token: 'policy-test-secret' }),
  });
  t.after(() => broken.close());
  const count = fixture.requests().length;
  const denied = await broken.suggest!(query, access, { deadlineAt: Date.now() + 5000 });
  assert.equal(denied.status, 'unavailable');
  if (denied.status === 'unavailable') assert.equal(denied.failure, 'credential_binding');
  assert.equal(fixture.requests().length, count);
});

void test('search stops at four pages even when backend text matches yield no prefix candidates', async (t) => {
  const matrix = await policyMatrix(t),
    catalog = await matrix.catalog(policyRun()),
    fixture = matrix.fixtures[0]!.fixture;
  fixture.remove('group:default/team');
  for (let n = 0; n < 450; n++)
    fixture.upsert({ ...team, metadata: { name: 'xteam-' + String(n).padStart(3, '0') } });
  const report = await catalog.provider.suggest!(query, catalog.access, {
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.refs, []);
  assert.equal(report.truncated, true);
  assert.equal(fixture.requests().length, 4);
});
