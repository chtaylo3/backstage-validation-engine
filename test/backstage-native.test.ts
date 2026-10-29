import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as current from '@backstage/catalog-model';
import * as older from 'backstage-catalog-model-older';
import {
  BACKSTAGE_ADAPTER_IDS,
  DEFAULT_DEPLOYMENT_PROFILE,
  canonicalJson,
  immutableJson,
  loadBackstageAdapter,
  parseContract,
} from '../src/index.js';
import type { BackstageAdapterId, JsonValue } from '../src/index.js';
import type { Entity, EntityPolicy } from '@backstage/catalog-model';

interface Fixture extends Record<string, JsonValue> {
  apiVersion: string;
  kind: string;
  metadata: { name: string; [key: string]: JsonValue };
  spec: Record<string, JsonValue>;
}
const fixtures = JSON.parse(
  await readFile('test/fixtures/backstage-entities.json', 'utf8'),
) as Fixture[];
const execution = () => ({ deadlineAt: Date.now() + 5000 });
const settings = DEFAULT_DEPLOYMENT_PROFILE.nativePolicies;
const copy = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;

function validators(lib: typeof current | typeof older) {
  return new Map([
    ['Component', lib.componentEntityV1alpha1Validator],
    ['API', lib.apiEntityV1alpha1Validator],
    ['Group', lib.groupEntityV1alpha1Validator],
    ['User', lib.userEntityV1alpha1Validator],
    ['Resource', lib.resourceEntityV1alpha1Validator],
    ['System', lib.systemEntityV1alpha1Validator],
    ['Domain', lib.domainEntityV1alpha1Validator],
    ['Location', lib.locationEntityV1alpha1Validator],
  ]);
}

void test('BC-01 both exact adapters match native envelope/kind acceptance on eight kinds', async (t) => {
  for (const id of BACKSTAGE_ADAPTER_IDS) {
    const lib = id.endsWith('1.10.2') ? current : older;
    const adapter = await loadBackstageAdapter(id);
    const schema = lib.entitySchemaValidator();
    const nativeKinds = validators(lib);
    for (const fixture of fixtures) {
      for (const [label, entity] of [
        ['valid', fixture],
        ['empty-spec', { ...fixture, spec: {} }],
        ['bad-metadata', { ...fixture, metadata: { name: 123 } }],
        ['unknown-api', { ...fixture, apiVersion: 'example.com/v999' }],
      ] as const) {
        await t.test(`${id} ${fixture.kind} ${label}`, async () => {
          let expected = false;
          try {
            expected = await nativeKinds.get(fixture.kind)!.check(schema(entity));
          } catch {
            /* Native rejection is the comparison result. */
          }
          const actual = await adapter.checkEntity(immutableJson(entity), execution());
          assert.equal(actual.status === 'valid', expected);
          if (label === 'valid') assert.equal(actual.status, 'valid');
          if (label === 'unknown-api') assert.equal(actual.status, 'unsupported');
        });
      }
    }
  }
});

void test('BC-01 primitives, missing envelopes, unsupported kinds and unknown adapter IDs fail closed', async () => {
  for (const id of BACKSTAGE_ADAPTER_IDS) {
    const adapter = await loadBackstageAdapter(id);
    for (const value of [null, true, 1, 'text', [], {}, { kind: 'Component' }]) {
      const checked = await adapter.checkEntity(immutableJson(value), execution());
      assert.equal(checked.status, 'invalid');
      assert.equal(checked.issues[0]?.stage, 'envelope');
    }
    const custom = await adapter.checkEntity({ ...fixtures[0]!, kind: 'Custom' }, execution());
    assert.equal(custom.status, 'unsupported');
    assert.equal(custom.issues[0]?.path, '/kind');
    assert.equal(await loadBackstageAdapter(id), adapter);
    assert(Object.isFrozen(adapter.kinds));
  }
  await assert.rejects(
    loadBackstageAdapter('latest' as BackstageAdapterId),
    /unknown Backstage adapter/,
  );
});

void test('BC-02 normalized output equals the configured native policy composition on both pins', async (t) => {
  for (const id of BACKSTAGE_ADAPTER_IDS) {
    const lib = id.endsWith('1.10.2') ? current : older;
    const adapter = await loadBackstageAdapter(id);
    for (const fixture of fixtures) {
      await t.test(`${id} ${fixture.kind}`, async () => {
        let expected = lib.entityEnvelopeSchemaValidator()(copy(fixture)) as Entity;
        const policies: EntityPolicy[] = [
          new lib.SchemaValidEntityPolicy(),
          new lib.DefaultNamespaceEntityPolicy(),
          new lib.FieldFormatEntityPolicy(),
          new lib.NoForeignRootFieldsEntityPolicy(),
        ];
        for (const policy of policies) expected = (await policy.enforce(expected))!;
        const result = await adapter.validate(immutableJson(fixture), settings, execution());
        assert.equal(result.status, 'valid');
        assert.deepEqual(result.normalized, expected);
        assert.deepEqual(result.authored, fixture);
        assert.equal(result.changes[0]?.path, '/metadata/namespace');
        assert.equal(result.changes[0]?.policy, 'default_namespace');
        assert.equal(result.changes[0]?.after, 'default');
        assert(!Object.hasOwn(fixture.metadata, 'namespace'));
        assert.equal(result.entityRef, lib.stringifyEntityRef(expected));
        assert(Object.isFrozen(result.normalized));
      });
    }
  }
});

void test('BC-02 native field formats and root policy preserve configured behavior', async (t) => {
  for (const id of BACKSTAGE_ADAPTER_IDS) {
    const adapter = await loadBackstageAdapter(id);
    for (const [entity, path] of [
      [{ ...fixtures[0]!, metadata: { name: 'bad name' } }, '/metadata/name'],
      [
        { ...fixtures[0]!, metadata: { name: 'service', namespace: 'BAD_NAMESPACE' } },
        '/metadata/namespace',
      ],
      [{ ...fixtures[0]!, metadata: { name: 'service', tags: ['UPPERCASE'] } }, '/metadata/tags/0'],
      [
        { ...fixtures[0]!, metadata: { name: 'service', labels: { 'bad key': 'TOP_SECRET' } } },
        '/metadata/labels/bad key',
      ],
      [{ ...fixtures[0]!, relations: [] }, '/relations'],
    ] as const) {
      await t.test(`${id} ${path}`, async () => {
        const result = await adapter.validate(immutableJson(entity), settings, execution());
        assert.equal(result.status, 'invalid');
        assert.equal(result.issues[0]?.path, path);
        assert(!JSON.stringify(result.issues).includes('TOP_SECRET'));
      });
    }
    const authored = { ...fixtures[0]!, metadata: { name: 'bad name' }, relations: [] };
    const relaxed = await adapter.validate(
      immutableJson(authored),
      { ...settings, fieldFormat: false, noForeignRootFields: false, defaultNamespace: false },
      execution(),
    );
    assert.equal(relaxed.status, 'valid');
    assert.deepEqual(relaxed.normalized, authored);
    assert.equal(relaxed.changes.length, 0);
    const explicit = await adapter.validate(
      { ...fixtures[0]!, metadata: { name: 'Payments', namespace: 'platform' } },
      settings,
      execution(),
    );
    assert.equal(explicit.status, 'valid');
    assert.equal(explicit.changes.length, 0);
    assert.equal(explicit.entityRef, 'component:platform/payments');
    const stockSchema = await adapter.validate(
      { ...fixtures[0]!, foreign: true },
      { ...settings, schema: false, noForeignRootFields: false },
      execution(),
    );
    assert.equal(stockSchema.status, 'invalid');
    assert.equal(stockSchema.issues[0]?.stage, 'kind');
  }
});

void test('BC-02 group-parent defaulting is opt-in, pinned, root-aware and version native', async (t) => {
  const group = fixtures.find((fixture) => fixture.kind === 'Group')!;
  for (const id of BACKSTAGE_ADAPTER_IDS) {
    const lib = id.endsWith('1.10.2') ? current : older;
    const adapter = await loadBackstageAdapter(id);
    const enabled = {
      ...settings,
      groupDefaultParent: true,
      groupDefaultParentRef: 'group:default/root',
    };
    for (const [label, entity] of [
      ['child', group],
      ['root', { ...group, metadata: { name: 'root' } }],
      ['existing-parent', { ...group, spec: { ...group.spec, parent: 'existing' } }],
      ['empty-parent', { ...group, spec: { ...group.spec, parent: '' } }],
    ] as const) {
      await t.test(`${id} ${label}`, async () => {
        let expected = lib.entityEnvelopeSchemaValidator()(copy(entity)) as Entity;
        const policies: EntityPolicy[] = [
          new lib.SchemaValidEntityPolicy(),
          new lib.DefaultNamespaceEntityPolicy(),
          new lib.FieldFormatEntityPolicy(),
          new lib.NoForeignRootFieldsEntityPolicy(),
          new lib.GroupDefaultParentEntityPolicy('group:default/root'),
        ];
        for (const policy of policies) expected = (await policy.enforce(expected))!;
        assert.equal(await lib.groupEntityV1alpha1Validator.check(expected), true);
        const actual = await adapter.validate(immutableJson(entity), enabled, execution());
        assert.equal(actual.status, 'valid');
        assert.deepEqual(actual.normalized, expected);
        assert.equal(
          actual.changes.some((change) => change.path === '/spec/parent'),
          label === 'child' || label === 'empty-parent',
        );
      });
    }
    await assert.rejects(
      adapter.validate(
        group,
        { ...enabled, groupDefaultParentRef: 'user:default/person' },
        execution(),
      ),
      /valid native Group/,
    );
  }
  assert.throws(
    () =>
      parseContract('deployment-profile', {
        ...DEFAULT_DEPLOYMENT_PROFILE,
        nativePolicies: { ...settings, groupDefaultParent: true },
      }),
    /pinned parent reference/,
  );
});

void test('native policy calls retain deadlines, cancellation and JSON admission limits', async () => {
  const adapter = await loadBackstageAdapter(BACKSTAGE_ADAPTER_IDS[0]);
  await assert.rejects(
    adapter.validate(fixtures[0]!, settings, { deadlineAt: Date.now() - 1 }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'request_timeout',
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    adapter.validate(fixtures[0]!, settings, { ...execution(), signal: abort.signal }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'cancelled',
  );
  await assert.rejects(
    adapter.checkEntity({ large: 'x'.repeat(1024 * 1024) }, execution()),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'resource_limit',
  );
});
