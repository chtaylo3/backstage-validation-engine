import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { parse, stringify } from 'yaml';
import { compileCatalogContract } from '../harness/catalog-contract.js';
import { loadContractArtifact } from '../harness/contract-artifact.js';
import { startFakeBackstage } from '../harness/fake-backstage.js';
import type { FakeBackstage } from '../harness/fake-backstage.js';
import { startFixtureMatrix } from '../harness/fixture-matrix.js';
import { loadPinnedMatrix } from '../harness/pinned-matrix.js';

const ROOT = path.resolve('test/fixtures/backstage');
const team = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { namespace: 'default', name: 'team' },
  spec: { type: 'team', children: [] },
};
const component = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { namespace: 'default', name: 'service' },
  spec: { type: 'service', lifecycle: 'production', owner: 'team' },
};
const headers = { authorization: 'Bearer test-all', 'content-type': 'application/json' };
const getTeam = (fixture: FakeBackstage, init?: RequestInit) =>
  fetch(`${fixture.baseUrl}/entities/by-name/group/default/team`, { headers, ...init });
const batch = (fixture: FakeBackstage, body: unknown, token = 'test-all') =>
  fetch(`${fixture.baseUrl}/entities/by-refs`, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
async function matrixFor(t: TestContext) {
  const matrix = await startFixtureMatrix(await loadPinnedMatrix(ROOT), ROOT, (artifact) =>
    startFakeBackstage(artifact, {
      entities: [team, component],
      principals: [
        { token: 'test-all', principalId: 'all', canRead: true, visibleRefs: '*' },
        {
          token: 'test-scoped',
          principalId: 'scoped',
          canRead: true,
          visibleRefs: ['group:default/team'],
        },
        {
          token: 'test-denied',
          principalId: 'denied',
          canAccessCatalog: false,
          canRead: true,
          visibleRefs: '*',
        },
      ],
    }),
  );
  t.after(async () => {
    await matrix.close();
    for (const { fixture } of matrix.fixtures) fixture.assertHealthy();
  });
  return matrix;
}

void test('real pinned catalog targets validate envelopes, operation inputs and response shapes', async (t) => {
  for (const target of await loadPinnedMatrix(ROOT)) {
    await t.test(target.backstageVersion, async () => {
      const artifact = await loadContractArtifact(target, ROOT);
      const contract = compileCatalogContract(artifact);
      contract.assertEntity(team);
      contract.assertRequest(
        'byName',
        { kind: 'Group', namespace: 'default', name: 'team' },
        undefined,
      );
      contract.assertRequest('byRefs', {}, { entityRefs: ['group:default/team'] });
      contract.assertResponse('byRefs', 200, { items: [team, null] });
      assert.throws(() => contract.assertEntity({ kind: 'Group' }), /pinned OpenAPI/);
      assert.throws(
        () => contract.assertRequest('byRefs', {}, { entityRefs: [42] }),
        /pinned OpenAPI/,
      );
      assert.throws(() => contract.assertResponse('byName', 200, {}), /pinned OpenAPI/);
      assert.throws(
        () => contract.assertResponse('byRefs', 200, { items: [false] }),
        /pinned OpenAPI/,
      );
      assert.throws(
        () => contract.assertResponse('byName', 503, { message: 'wrong error shape' }),
        /pinned OpenAPI/,
      );
    });
  }
});

void test('contract changes and unsupported OpenAPI dialects fail before a fake starts', async () => {
  const [target] = await loadPinnedMatrix(ROOT);
  assert(target);
  const artifact = await loadContractArtifact(target, ROOT);
  const document = parse(artifact.text) as {
    openapi: string;
    components: {
      schemas: { Entity: { required: string[]; properties: Record<string, unknown> } };
    };
  };
  document.components.schemas.Entity.required.push('newRequiredField');
  document.components.schemas.Entity.properties.newRequiredField = { type: 'string' };
  await assert.rejects(
    startFakeBackstage({ ...artifact, text: stringify(document) }, { entities: [team] }),
    /pinned OpenAPI/,
  );
  document.openapi = '3.0.3';
  assert.throws(
    () => compileCatalogContract({ ...artifact, text: stringify(document) }),
    /OpenAPI 3.1/,
  );
});

void test('catalog fake uses case-insensitive by-name triplets and raw by-refs database keys', async (t) => {
  const matrix = await matrixFor(t);
  assert.equal(
    new Set(matrix.fixtures.map(({ fixture }) => fixture.baseUrl)).size,
    matrix.fixtures.length,
  );
  for (const { target, fixture } of matrix.fixtures) {
    await t.test(target.backstageVersion, async () => {
      const response = await fetch(`${fixture.baseUrl}/entities/by-name/GROUP/DEFAULT/TEAM`, {
        headers,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), team);
      const result = await batch(fixture, {
        entityRefs: [
          'group:team',
          'component:default/service',
          'group:default/missing',
          'GROUP:DEFAULT/TEAM',
        ],
      });
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { items: [null, component, null, null] });
      const raw = await batch(fixture, {
        entityRefs: [
          'group:default/team',
          'group:team',
          'not-a-full-ref',
          'group:/team',
          'GROUP:DEFAULT/TEAM',
          'group:default/team',
        ],
      });
      assert.equal(raw.status, 200);
      assert.deepEqual(await raw.json(), { items: [team, null, null, null, null, team] });
      assert.deepEqual(await (await batch(fixture, { entityRefs: [] })).json(), { items: [] });
    });
  }
});

void test('fixture credentials distinguish authentication, denial and authorized-view absence without token logs', async (t) => {
  const matrix = await matrixFor(t);
  for (const { target, fixture } of matrix.fixtures) {
    await t.test(target.backstageVersion, async () => {
      assert.equal((await getTeam(fixture, { headers: {} })).status, 401);
      assert.equal(
        (await getTeam(fixture, { headers: { authorization: 'Bearer invalid' } })).status,
        401,
      );
      assert.equal(
        (await getTeam(fixture, { headers: { authorization: 'Bearer test-denied' } })).status,
        403,
      );
      const scoped = await batch(
        fixture,
        { entityRefs: ['group:default/team', 'component:default/service'] },
        'test-scoped',
      );
      assert.deepEqual(await scoped.json(), { items: [team, null] });
      assert.equal(
        (
          await fetch(`${fixture.baseUrl}/entities/by-name/component/default/service`, {
            headers: { authorization: 'Bearer test-scoped' },
          })
        ).status,
        404,
      );
      fixture.setPrincipal({
        token: 'test-filtered',
        principalId: 'filtered',
        canRead: false,
        visibleRefs: '*',
      });
      assert.equal(
        (await getTeam(fixture, { headers: { authorization: 'Bearer test-filtered' } })).status,
        404,
      );
      assert.deepEqual(
        await (
          await batch(fixture, { entityRefs: ['group:default/team'] }, 'test-filtered')
        ).json(),
        { items: [null] },
      );
      fixture.setPrincipal({
        token: 'test-scoped',
        principalId: 'scoped',
        canRead: true,
        visibleRefs: '*',
      });
      assert.deepEqual(
        await (
          await batch(fixture, { entityRefs: ['component:default/service'] }, 'test-scoped')
        ).json(),
        { items: [component] },
      );
      fixture.revokeToken('test-scoped');
      assert.equal((await batch(fixture, { entityRefs: [] }, 'test-scoped')).status, 401);
      const logs = fixture.requests();
      assert(logs.some((entry) => entry.principalId === 'scoped'));
      assert(!JSON.stringify(logs).includes('test-scoped'));
      assert(Object.isFrozen(logs[0]));
    });
  }
});

void test('invalid bodies, references and unsupported fake capabilities return explicit errors', async (t) => {
  const matrix = await matrixFor(t);
  for (const { target, fixture } of matrix.fixtures) {
    await t.test(target.backstageVersion, async () => {
      for (const body of [{ entityRefs: [1] }, {}, null]) {
        assert.equal((await batch(fixture, body)).status, 400);
      }
      assert.equal(
        (await fetch(`${fixture.baseUrl}/entities/by-refs`, { method: 'POST', headers, body: '{' }))
          .status,
        400,
      );
      assert.equal(
        (
          await fetch(`${fixture.baseUrl}/entities/by-refs`, {
            method: 'POST',
            headers: { authorization: 'Bearer test-all' },
            body: '{}',
          })
        ).status,
        415,
      );
      assert.equal((await batch(fixture, { entityRefs: [], fields: ['kind'] })).status, 501);
      assert.equal((await batch(fixture, { entityRefs: [], query: {} })).status, 501);
      assert.equal((await fetch(`${fixture.baseUrl}/entities/by-query`, { headers })).status, 501);
      assert.equal(
        (await batch(fixture, { entityRefs: ['group:default/' + 'a'.repeat(70_000)] })).status,
        413,
      );
    });
  }
});

void test('seed/control state is copied and isolated between concurrent version fixtures', async (t) => {
  const matrix = await matrixFor(t);
  const first = matrix.fixtures[0]!.fixture;
  const second = matrix.fixtures[1]!.fixture;
  const changed = { ...team, spec: { type: 'updated', children: [] } };
  first.upsert(changed);
  changed.spec.type = 'mutated-after-insertion';
  assert.deepEqual(await (await getTeam(first)).json(), {
    ...team,
    spec: { type: 'updated', children: [] },
  });
  assert.deepEqual(await (await getTeam(second)).json(), team);
  first.remove('group:default/team');
  assert.equal((await getTeam(first)).status, 404);
  assert.equal((await getTeam(second)).status, 200);
  assert.throws(() => first.upsert({ kind: 'Group' }), /pinned OpenAPI/);
});

void test('one-shot status, malformed JSON and disconnect faults are explicit and recoverable', async (t) => {
  const matrix = await matrixFor(t);
  for (const { target, fixture } of matrix.fixtures) {
    await t.test(target.backstageVersion, async () => {
      for (const status of [401, 403, 429, 503] as const) {
        fixture.failNext(
          { operation: 'byName', entityRef: 'group:team' },
          { kind: 'status', status },
        );
        assert.equal((await getTeam(fixture)).status, status);
        assert.equal((await getTeam(fixture)).status, 200);
      }
      fixture.failNext({ operation: 'byRefs' }, { kind: 'malformed-json' });
      await assert.rejects((await batch(fixture, { entityRefs: [] })).json());
      fixture.failNext({ operation: 'byRefs' }, { kind: 'disconnect' });
      await assert.rejects(batch(fixture, { entityRefs: [] }));
      assert.equal((await batch(fixture, { entityRefs: [] })).status, 200);
    });
  }
});

void test('response gates deterministically deliver an older snapshot after newer catalog data', async (t) => {
  const matrix = await matrixFor(t);
  for (const { target, fixture } of matrix.fixtures) {
    await t.test(target.backstageVersion, async () => {
      const gate = fixture.holdNext({ operation: 'byName', entityRef: 'group:team' });
      const older = getTeam(fixture).then((response) => response.json());
      await gate.entered;
      const newer = { ...team, spec: { type: 'newer', children: [] } };
      fixture.upsert(newer);
      assert.deepEqual(await (await getTeam(fixture)).json(), newer);
      gate.release();
      assert.deepEqual(await older, team);
    });
  }
});

void test('client cancellation releases a held request and records cancellation without sleeps', async (t) => {
  const matrix = await matrixFor(t);
  for (const { target, fixture } of matrix.fixtures) {
    await t.test(target.backstageVersion, async () => {
      const gate = fixture.holdNext({ operation: 'byName' });
      const controller = new AbortController();
      const result = getTeam(fixture, { signal: controller.signal }).catch(
        (error: unknown) => error,
      );
      await gate.entered;
      controller.abort();
      await gate.cancelled;
      assert((await result) instanceof Error);
      assert(fixture.requests().some((entry) => entry.cancelled));
      assert.equal((await getTeam(fixture)).status, 200);
    });
  }
});

void test('shutdown closes held requests and all version listeners idempotently', async (t) => {
  const matrix = await matrixFor(t);
  const requests: Promise<unknown>[] = [];
  for (const { fixture } of matrix.fixtures) {
    const gate = fixture.holdNext({ operation: 'byName' });
    requests.push(getTeam(fixture).catch((error: unknown) => error));
    await gate.entered;
  }
  await Promise.all([matrix.close(), matrix.close()]);
  assert((await Promise.all(requests)).every((result) => result instanceof Error));
});
