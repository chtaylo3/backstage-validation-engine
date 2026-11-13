import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { stringify } from 'yaml';
import {
  BACKSTAGE_ADAPTER_IDS,
  catalogEntityKey,
  createCatalogProvider,
  createDataSnapshot,
  createSourceSnapshot,
  createValidationResult,
  digestJson,
  loadBackstageAdapter,
  parseContract,
  prepareBackstageReferenceData,
  resultExitCode,
  validateBackstageSources,
} from '../../src/index.js';
import type {
  CatalogAccessContext,
  CatalogProvider,
  DataSnapshot,
  DeploymentProfile,
  Immutable,
  SourceInput,
} from '../../src/index.js';
import { URI, makeContext, makeRequest } from '../helpers.js';
import { startFakeBackstage } from '../harness/fake-backstage.js';
import { startFixtureMatrix } from '../harness/fixture-matrix.js';
import { loadPinnedMatrix } from '../harness/pinned-matrix.js';

const component = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'service', namespace: 'payments' },
  spec: { type: 'service', lifecycle: 'production', owner: 'Team' },
};
const team = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name: 'team', namespace: 'payments' },
  spec: { type: 'team', children: [] },
};
const system = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'System',
  metadata: { name: 'ledger', namespace: 'payments' },
  spec: { owner: 'team' },
};
const alice = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'User',
  metadata: { name: 'alice', namespace: 'default' },
  spec: {},
};
const TEAM = 'group:payments/team';
const SYSTEM = 'system:payments/ledger';
function setupSource(
  text = stringify(component),
  profilePatch: Partial<DeploymentProfile> = {},
  mode: 'ci' | 'ide' = 'ci',
  extras: {
    files?: readonly SourceInput[];
    deleted?: string;
    data?: Immutable<DataSnapshot>;
    milliseconds?: number;
    version?: number;
  } = {},
) {
  const base = makeContext();
  const profile = parseContract('deployment-profile', { ...base.profile, ...profilePatch });
  const activation = parseContract('activation-manifest', {
    ...base.activation,
    profileDigest: digestJson(profile),
  });
  const source = createSourceSnapshot({
    repository: 'repository',
    revision: 'source-1',
    files: [
      { uri: URI, text, origin: 'buffer', version: extras.version ?? 7 },
      ...(extras.files ?? []),
    ],
    ...(extras.deleted ? { changes: [{ uri: extras.deleted, kind: 'deleted' }] } : {}),
  });
  const now = Date.now();
  const request = parseContract('validation-request', {
    ...makeRequest(mode),
    source,
    execution: { mode, startedAt: now, deadlineAt: now + (extras.milliseconds ?? 5000) },
    profile: { id: profile.id, digest: digestJson(profile) },
    activation: { generation: activation.generation, digest: digestJson(activation) },
    ...(extras.data ? { data: extras.data } : {}),
  });
  return { request, context: { ...base, profile, activation } };
}
type Run = ReturnType<typeof setupSource>;
function access(run: Run): CatalogAccessContext {
  return {
    installationId: run.request.identity.installationId,
    principalId: 'all',
    permissionRevision: run.request.identity.permissionRevision,
    credentialRevision: 'credentials-1',
    scope: ['catalog:read'],
    policyDigest: run.request.policy.digest,
    profileDigest: run.request.profile.digest,
    maxAgeMs: 30_000,
  };
}
async function live(t: TestContext) {
  const root = path.resolve('test/fixtures/backstage');
  const matrix = await startFixtureMatrix(await loadPinnedMatrix(root), root, (artifact) =>
    startFakeBackstage(artifact, {
      entities: [team, system, alice],
      principals: [{ token: 'test-all', principalId: 'all', canRead: true, visibleRefs: '*' }],
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
    async provider(run: Run, index = 0) {
      const provider = await createCatalogProvider({
        connectionId: 'primary',
        baseUrl: matrix.fixtures[index]!.fixture.baseUrl,
        adapterId: run.context.profile.adapterId,
        limits: { retries: 0 },
        credentials: (context) =>
          Promise.resolve({
            token: 'test-all',
            installationId: context.installationId,
            principalId: context.principalId,
            permissionRevision: context.permissionRevision,
            credentialRevision: context.credentialRevision,
            scope: context.scope,
          }),
      });
      providers.push(provider);
      return provider;
    },
  };
}
const collect = (run: Run, provider: CatalogProvider, signal?: AbortSignal) =>
  prepareBackstageReferenceData(run.request, run.context, {
    provider,
    access: access(run),
    ...(signal ? { signal } : {}),
  });

void test('BC-03 resolves owner/API/system defaults, explicit namespaces and case on both native pins', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS) {
    await t.test(adapterId, async () => {
      const input = {
        ...component,
        spec: {
          ...component.spec,
          owner: 'User:Other/Alice',
          providesApis: ['Catalog', 'Shared/Reports'],
          consumesApis: ['API:Ops/Events'],
          system: 'Ledger',
        },
      };
      const run = setupSource(stringify(input), { adapterId });
      const report = await validateBackstageSources(run.request, run.context);
      assert.equal(report.findings.length, 0);
      assert.deepEqual(
        report.references.map((ref) => [ref.location.path, ref.targetRef]),
        [
          ['/spec/owner', 'user:other/alice'],
          ['/spec/providesApis/0', 'api:payments/catalog'],
          ['/spec/providesApis/1', 'api:shared/reports'],
          ['/spec/consumesApis/0', 'api:ops/events'],
          ['/spec/system', SYSTEM],
        ],
      );
      assert.equal(report.references[0]?.value, input.spec.owner);
      assert.deepEqual(report.entities[0]?.authored, input);
      assert.equal(report.references[0]?.version, 7);
      assert.equal(report.references[0]?.sourceDigest, run.request.source.files[0]?.digest);
      assert.equal(report.sourceClaims[0]?.entityRef, 'component:payments/service');
      assert(Object.isFrozen(report.references[0]?.location.range));
    });
  }
});

void test('fixed namespace contexts and escaped pointer keys are explicit profile settings', async () => {
  const run = setupSource(
    stringify({ ...component, spec: { ...component.spec, 'a/b': { '~target': 'Alice' } } }),
    {
      referenceContexts: [
        { path: '/spec/a~1b/~0target', defaultKind: 'User', namespace: 'shared' },
      ],
    },
  );
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.references[0]?.targetRef, 'user:shared/alice');
  assert.equal(report.references[0]?.location.path, '/spec/a~1b/~0target');
});

void test('missing optional fields and empty reference arrays are completed work', async () => {
  const run = setupSource(stringify({ ...team, spec: { ...team.spec, members: [] } }), {
    referenceContexts: [
      { path: '/spec/members/*', defaultKind: 'User', namespace: 'entity' },
      { path: '/spec/optional', defaultKind: 'Group', namespace: 'entity' },
    ],
  });
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.entities.length, 1);
  assert.equal(report.references.length, 0);
  assert.equal(report.findings.length, 0);
});

void test('invalid native references withhold the subject and retain precise stable findings', async () => {
  const input = { ...component, spec: { ...component.spec, owner: 'group:/private-value' } };
  const run = setupSource(stringify(input));
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.entities.length, 0);
  assert.equal(report.references.length, 0);
  assert.equal(report.findings[0]?.ruleId, 'backstage/references/invalid_reference');
  assert.equal(report.findings[0]?.location.path, '/spec/owner');
  assert(!JSON.stringify(report.findings).includes('private-value'));
  const shifted = setupSource('\n' + stringify(input));
  assert.equal(
    (await validateBackstageSources(shifted.request, shifted.context)).findings[0]?.id,
    report.findings[0]?.id,
  );
  const result = createValidationResult({
    request: run.request,
    ...report,
    completedAt: Date.now(),
    authorityCheckedAt: run.request.execution.startedAt,
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(resultExitCode(result), 1);
});

void test('array wildcard shape and scalar value failures point to their authored locations', async () => {
  for (const [details, expected] of [
    [{ target: 'team' }, '/spec/details'],
    [[{ target: 'team' }, { target: 9 }], '/spec/details/1/target'],
  ] as const) {
    const run = setupSource(stringify({ ...component, spec: { ...component.spec, details } }), {
      referenceContexts: [
        { path: '/spec/details/*/target', defaultKind: 'Group', namespace: 'entity' },
      ],
    });
    const report = await validateBackstageSources(run.request, run.context);
    assert.equal(report.entities.length, 0);
    assert.equal(report.findings[0]?.location.path, expected);
  }
});

void test('alias reference locations retain the alias use and anchor provenance', async () => {
  const text =
    'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service, namespace: payments, description: "😀"}\nspec:\n  type: service\n  lifecycle: production\n  declared: &team Team\n  owner: *team\n';
  const run = setupSource(text);
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.references[0]?.targetRef, TEAM);
  assert.equal(report.references[0]?.location.range.start.line, 7);
  assert.equal(report.references[0]?.location.range.start.character, 9);
  assert.equal(report.references[0]?.relatedLocations.length, 1);
});

void test('defaulted reference values retain the nearest authored source and native mutation', async () => {
  const original = makeContext();
  const run = setupSource(stringify({ ...team, metadata: { name: 'child' } }), {
    nativePolicies: {
      ...original.profile.nativePolicies,
      groupDefaultParent: true,
      groupDefaultParentRef: 'group:default/root',
    },
    referenceContexts: [{ path: '/spec/parent', defaultKind: 'Group', namespace: 'entity' }],
  });
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.references[0]?.targetRef, 'group:default/root');
  assert.equal(report.references[0]?.location.path, '/spec/parent');
  assert(report.entities[0]?.changes.some((change) => change.path === '/spec/parent'));
});

void test('context registries reject malformed, overlapping and over-deep pointer patterns', async () => {
  for (const paths of [
    ['spec/owner'],
    ['/spec/a~2b'],
    ['/spec/list/*', '/spec/list/0'],
    ['/spec/list', '/spec/list/*'],
    ['/' + Array.from({ length: 65 }, () => 'a').join('/')],
  ]) {
    assert.throws(() =>
      setupSource(undefined, {
        referenceContexts: paths.map((path) => ({
          path,
          defaultKind: 'Group',
          namespace: 'entity',
        })),
      }),
    );
  }
  const run = setupSource(undefined, {
    referenceContexts: [{ path: '/spec/owner', defaultKind: 'Group', namespace: 'ambiguous/ns' }],
  });
  await assert.rejects(
    validateBackstageSources(run.request, run.context),
    /unambiguous native reference/,
  );
});

void test('reference occurrence admission is bounded and reports incomplete coverage', async () => {
  const run = setupSource(
    stringify({
      ...component,
      spec: { ...component.spec, consumesApis: Array.from({ length: 1000 }, () => 'api') },
    }),
  );
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.interrupted, 'resource_limit');
  assert.equal(report.entities.length, 0);
  assert(
    report.coverage.some((row) => row.subject.includes('references') && row.status === 'blocked'),
  );
  const result = createValidationResult({
    request: run.request,
    ...report,
    completedAt: Date.now(),
    authorityCheckedAt: run.request.execution.startedAt,
  });
  assert.equal(result.outcome, 'incomplete');
});

void test('ambiguous compound identities are rejected on both pins before cross-entity attribution', async () => {
  for (const id of BACKSTAGE_ADAPTER_IDS) {
    const adapter = await loadBackstageAdapter(id);
    assert.throws(
      () =>
        adapter.entityReference({
          ...team,
          metadata: { name: 'team', namespace: 'payments/other' },
        }),
      /native entity envelope/,
    );
    assert.throws(
      () =>
        adapter.resolveReference('team', {
          defaultKind: 'Group',
          defaultNamespace: 'payments/other',
        }),
      /native entity reference/,
    );
  }
});

void test('source references collect pinned data on both backend contracts and native pins', async (t) => {
  const state = await live(t);
  for (const [index, target] of state.fixtures.entries())
    for (const adapterId of BACKSTAGE_ADAPTER_IDS) {
      await t.test(`${target.target.backstageVersion}/${adapterId}`, async () => {
        const run = setupSource(
          stringify({
            ...component,
            spec: { ...component.spec, providesApis: ['Missing'], system: 'Ledger' },
          }),
          { adapterId },
        );
        const provider = await state.provider(run, index);
        const report = await collect(run, provider);
        assert.equal(report.compatibility.findings.length, 0);
        assert.deepEqual(
          report.observations.map((row) => [row.targetRef, row.status]),
          [
            ['api:payments/missing', 'missing'],
            [TEAM, 'present'],
            [SYSTEM, 'present'],
          ],
        );
        assert(report.evaluationRequest);
        assert.equal(
          report.evaluationRequest.execution.deadlineAt,
          run.request.execution.deadlineAt,
        );
        assert(report.evaluationRequest.execution.startedAt >= run.request.execution.startedAt);
        assert.equal(report.evaluationRequest.source.digest, run.request.source.digest);
        assert.equal(report.evaluationRequest.data.digest, report.data.digest);
        assert.equal(run.request.data.entries.length, 0);
        assert(
          report.data.entries.every(
            (entry) => entry.provenance.fetchedAt <= report.evaluationRequest!.execution.startedAt,
          ),
        );
        assert(Object.isFrozen(report.observations[0]));
      });
    }
});

void test('qualified local proposed targets precede old catalog observations', async (t) => {
  const state = await live(t);
  const run = setupSource(undefined, {}, 'ci', {
    files: [{ uri: 'file:///workspace/team.yaml', text: stringify(team) }],
  });
  const provider = await state.provider(run);
  const report = await collect(run, provider);
  assert.equal(report.observations[0]?.status, 'present');
  assert.equal(report.observations[0]?.targetRef, TEAM);
  assert.equal(report.data.entries[0]?.provenance.providerId, 'backstage-proposed-catalog');
  assert.equal(report.data.entries.length, 1);
  assert.equal(state.fixtures[0]!.fixture.requests().length, 0);
});

void test('an invalid replacement masks its identity while unrelated external targets remain available', async (t) => {
  const state = await live(t);
  const run = setupSource(
    stringify({ ...component, spec: { ...component.spec, system: 'Ledger' } }),
    {},
    'ci',
    {
      files: [
        {
          uri: 'file:///workspace/team.yaml',
          text: stringify({ ...team, spec: { type: 'team', children: 'invalid' } }),
        },
      ],
    },
  );
  const report = await collect(run, await state.provider(run));
  assert.equal(report.observations.find((row) => row.targetRef === TEAM)?.status, 'blocked');
  assert.equal(report.observations.find((row) => row.targetRef === SYSTEM)?.status, 'present');
  assert.equal(state.fixtures[0]!.fixture.requests().length, 1);
  assert.equal(report.compatibility.unresolvedSourceIdentities, false);
});

void test('duplicate local claims produce conflict findings and block fallback', async (t) => {
  const state = await live(t);
  const run = setupSource(undefined, {}, 'ci', {
    files: ['a', 'b'].map((name) => ({
      uri: `file:///workspace/${name}.yaml`,
      text: stringify(team),
    })),
  });
  const report = await collect(run, await state.provider(run));
  assert.deepEqual(report.observations, [
    { targetRef: TEAM, status: 'blocked', reason: 'competing_claims' },
  ]);
  assert.equal(state.fixtures[0]!.fixture.requests().length, 0);
});

void test('unresolved source identities and deletions conservatively block external fallback', async (t) => {
  const state = await live(t);
  for (const extras of [
    { files: [{ uri: 'file:///workspace/bad.yaml', text: 'metadata: [broken' }] },
    { deleted: 'file:///workspace/old.yaml' },
  ]) {
    const run = setupSource(undefined, {}, 'ide', extras);
    const report = await collect(run, await state.provider(run));
    assert.equal(report.observations[0]?.status, 'blocked');
    assert.equal(state.fixtures[0]!.fixture.requests().length, 0);
  }
});

void test('catalog outages and denials stay unavailable and never become missing-reference findings', async (t) => {
  const state = await live(t);
  for (const status of [401, 403, 503] as const) {
    const run = setupSource();
    const provider = await state.provider(run);
    state.fixtures[0]!.fixture.failNext({ operation: 'byName' }, { kind: 'status', status });
    const report = await collect(run, provider);
    assert.equal(report.observations[0]?.status, 'unavailable');
    assert.equal(report.compatibility.findings.length, 0);
    assert(report.evaluationRequest);
  }
});

void test('collector validates authority and native adapter binding before any HTTP', async (t) => {
  const state = await live(t);
  const run = setupSource();
  const provider = await state.provider(run);
  for (const patch of [
    { installationId: 'wrong' },
    { permissionRevision: 'wrong' },
    { policyDigest: `sha256:${'a'.repeat(64)}` },
    { profileDigest: `sha256:${'b'.repeat(64)}` },
  ]) {
    await assert.rejects(
      prepareBackstageReferenceData(run.request, run.context, {
        provider,
        access: { ...access(run), ...patch },
      }),
      /catalog context/,
    );
  }
  const wrong = await state.provider(
    setupSource(undefined, { adapterId: '@backstage/catalog-model@1.7.5' }),
  );
  await assert.rejects(collect(run, wrong), /catalog context/);
  assert.equal(state.fixtures[0]!.fixture.requests().length, 0);
});

void test('provider observations with mismatched principal provenance cannot be pinned', async (t) => {
  const state = await live(t);
  const run = setupSource();
  const original = await state.provider(run);
  const wrong: CatalogProvider = {
    ...original,
    lookup: async (refs, context, execution) => {
      const report = await original.lookup(refs, context, execution);
      return {
        ...report,
        data: createDataSnapshot(
          report.data.entries.map((entry) => ({
            ...entry,
            provenance: { ...entry.provenance, principalId: 'wrong' },
          })),
        ),
      };
    },
  };
  await assert.rejects(collect(run, wrong), /observation authority/);
});

void test('cancellation during HTTP preserves source provenance and prevents evaluation pinning', async (t) => {
  const state = await live(t);
  const run = setupSource();
  const provider = await state.provider(run);
  const gate = state.fixtures[0]!.fixture.holdNext({ operation: 'byName' });
  const controller = new AbortController();
  const pending = collect(run, provider, controller.signal);
  await gate.entered;
  controller.abort();
  const report = await pending;
  await gate.cancelled;
  assert.equal(report.interrupted, 'cancelled');
  assert.equal(report.evaluationRequest, undefined);
  assert.equal(report.pinFailure, 'interrupted');
  assert.equal(report.compatibility.references[0]?.version, 7);
});

void test('overlapping editor runs retain their own source versions when an old response arrives late', async (t) => {
  const state = await live(t);
  const older = setupSource(undefined, {}, 'ide', { version: 7 });
  const provider = await state.provider(older);
  const gate = state.fixtures[0]!.fixture.holdNext({ operation: 'byName', entityRef: TEAM });
  const pending = collect(older, provider);
  await gate.entered;
  const newer = setupSource(
    stringify({ ...component, spec: { ...component.spec, owner: 'user:default/alice' } }),
    {},
    'ide',
    { version: 8 },
  );
  const latest = await collect(newer, provider);
  gate.release();
  const previous = await pending;
  assert.equal(latest.compatibility.references[0]?.version, 8);
  assert.equal(previous.compatibility.references[0]?.version, 7);
  assert.notEqual(latest.compatibility.sourceDigest, previous.compatibility.sourceDigest);
  assert.equal(previous.evaluationRequest?.source.digest, older.request.source.digest);
});

void test('a collector never starts HTTP for required unavailable processors or substitutions', async (t) => {
  const state = await live(t);
  const runs = [
    setupSource(undefined, { requiredProcessors: [{ id: 'custom', stage: 'preprocess' }] }),
    setupSource(
      stringify({ ...component, spec: { ...component.spec, owner: { $text: './owner.txt' } } }),
    ),
  ];
  for (const run of runs) {
    const report = await collect(run, await state.provider(run));
    assert.equal(report.catalog, undefined);
    assert.equal(state.fixtures[0]!.fixture.requests().length, 0);
  }
});

void test('selected connection data is replaced so a blocked local claim cannot reuse old live data', async (t) => {
  const state = await live(t);
  const now = Date.now();
  const provenance = {
    installationId: 'installation-1',
    principalId: 'all',
    permissionRevision: 'permissions-1',
    scope: ['catalog:read'],
    revision: 'previous-observation',
    fetchedAt: now - 1,
    expiresAt: now + 60_000,
  };
  const data = createDataSnapshot([
    {
      key: catalogEntityKey('primary', TEAM),
      status: 'present',
      value: team,
      provenance: { ...provenance, providerId: 'backstage-catalog', connectionId: 'primary' },
    },
    {
      key: 'other/value',
      status: 'present',
      value: 42,
      provenance: { ...provenance, providerId: 'other-provider', connectionId: 'secondary' },
    },
  ]);
  const run = setupSource(undefined, {}, 'ci', {
    data,
    files: [
      {
        uri: 'file:///workspace/team.yaml',
        text: stringify({ ...team, spec: { type: 'team', children: 'invalid' } }),
      },
    ],
  });
  const report = await collect(run, await state.provider(run));
  assert.equal(report.observations[0]?.status, 'blocked');
  assert.deepEqual(
    report.data.entries.map((entry) => entry.key),
    ['other/value'],
  );
  assert.equal(report.evaluationRequest?.data.digest, report.data.digest);
});

void test('a retained observation expiring during collection prevents a fresh evaluation pin', async (t) => {
  const state = await live(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const now = Date.now();
  const data = createDataSnapshot([
    {
      key: 'other/value',
      status: 'present',
      value: 42,
      provenance: {
        providerId: 'other',
        connectionId: 'other',
        installationId: 'installation-1',
        principalId: 'all',
        permissionRevision: 'permissions-1',
        scope: [],
        revision: 'old',
        fetchedAt: now - 1,
        expiresAt: now + 10,
      },
    },
  ]);
  const run = setupSource(undefined, {}, 'ci', { data });
  const provider = await state.provider(run);
  const gate = state.fixtures[0]!.fixture.holdNext({ operation: 'byName' });
  const pending = collect(run, provider);
  await gate.entered;
  t.mock.timers.tick(11);
  gate.release();
  const report = await pending;
  assert.equal(report.pinFailure, 'stale_data');
  assert.equal(report.evaluationRequest, undefined);
  assert.equal(report.interrupted, 'timeout');
});

void test('the original collection deadline is never reset after source parsing or HTTP', async (t) => {
  const state = await live(t);
  const run = setupSource(undefined, {}, 'ci', { milliseconds: 500 });
  const provider = await state.provider(run);
  const gate = state.fixtures[0]!.fixture.holdNext({ operation: 'byName' });
  const pending = collect(run, provider);
  await gate.entered;
  const report = await pending;
  await gate.cancelled;
  assert.equal(report.interrupted, 'timeout');
  assert.equal(report.evaluationRequest, undefined);
  assert.equal(report.pinFailure, 'interrupted');
  assert.equal(report.collectionStartedAt, run.request.execution.startedAt);
});

void test('combined request admission remains bounded when the data snapshot alone still fits', async (t) => {
  const state = await live(t);
  const now = Date.now();
  const provenance = {
    providerId: 'other',
    connectionId: 'other',
    installationId: 'installation-1',
    principalId: 'all',
    permissionRevision: 'permissions-1',
    scope: [],
    revision: 'existing',
    fetchedAt: now - 1,
    expiresAt: now + 60_000,
  };
  const original = setupSource();
  const empty = createDataSnapshot([
    { key: 'other/value', status: 'present', value: [], provenance },
  ]);
  const stack: unknown[] = [{ ...original.request, data: empty }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    count++;
    if (current !== null && typeof current === 'object')
      for (const value of Object.values(current as Record<string, unknown>)) stack.push(value);
  }
  const data = createDataSnapshot([
    {
      key: 'other/value',
      status: 'present',
      value: Array.from({ length: 100_000 - count - 10 }, () => 0),
      provenance,
    },
  ]);
  const run = setupSource(undefined, {}, 'ci', { data });
  const report = await collect(run, await state.provider(run));
  assert.equal(report.pinFailure, 'resource_limit');
  assert.equal(report.evaluationRequest, undefined);
  assert.equal(report.interrupted, 'resource_limit');
  assert.equal(report.data.entries.length, 2);
});
