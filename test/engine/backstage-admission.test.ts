import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'yaml';
import {
  BACKSTAGE_ADAPTER_IDS,
  BUILTIN_KINDS,
  ContractError,
  closeSharedCelRuntime,
  createValidationResult,
  digestJson,
  parseContract,
  resultExitCode,
  validateBackstageSources,
  validatePolicySources,
} from '../../src/index.js';
import type { DeploymentProfile, Immutable, JsonValue, SchemaArtifact } from '../../src/index.js';
import { URI } from '../helpers.js';
import { componentText, ownerRule, policyMatrix, policyRun } from '../harness/policy-fixture.js';
import {
  schemaArtifact,
  widgetArtifact,
  widgetDeclaration,
  widgetProfile,
  widgetSchema,
  widgetText,
  widgetValue,
} from '../harness/custom-kind-fixture.js';

const ROOT = 'file:///workspace/';
const run = (options: Parameters<typeof policyRun>[0] = {}) =>
  policyRun({ mode: 'ci', rules: [], ...options });
const customRun = (options: Parameters<typeof policyRun>[0] = {}) =>
  run({
    text: widgetText(),
    profile: widgetProfile,
    schemaArtifacts: [widgetArtifact],
    ...options,
  });
const validate = (state: ReturnType<typeof run>, signal?: AbortSignal) =>
  validateBackstageSources(state.request, state.context, signal ? { signal } : {});
const exit = (state: ReturnType<typeof run>, report: Awaited<ReturnType<typeof validate>>) =>
  resultExitCode(
    createValidationResult({
      request: state.request,
      ...report,
      completedAt: Date.now(),
      authorityCheckedAt: state.request.execution.startedAt,
    }),
  );
test.after(closeSharedCelRuntime);

void test('BC-05 global admission is enforced after normalization on both native pins', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    for (const allowedKinds of [[], ['Component'], ['component']])
      await t.test(`${adapterId}/${allowedKinds.join(',')}`, async () => {
        const state = run({ profile: { adapterId, admission: { allowedKinds, locations: [] } } });
        const report = await validate(state);
        assert.equal(report.entities.length, allowedKinds.length ? 1 : 0);
        assert(
          report.coverage.some(
            (row) => row.stage === 'admission' && row.required && row.status === 'verified',
          ),
        );
        assert.equal(exit(state, report), allowedKinds.length ? 0 : 1);
        if (!allowedKinds.length) {
          assert.equal(report.findings[0]?.ruleId, 'backstage/admission/disallowed_kind');
          assert.equal(report.findings[0]?.location.path, '/kind');
          assert.deepEqual(report.references, []);
          assert.deepEqual(report.artifacts, []);
          assert.equal(report.sourceClaims[0]?.entityRef, 'component:default/service');
        }
      });
});

void test('BC-05 disallowed undeclared kinds are violations; allowed undeclared kinds remain incomplete', async () => {
  for (const allowedKinds of [[], ['Widget']]) {
    const state = run({
      text: widgetText(),
      profile: { admission: { allowedKinds, locations: [] } },
    });
    const report = await validate(state);
    assert.equal(exit(state, report), allowedKinds.length ? 2 : 1);
    assert.equal(
      report.findings[0]?.category,
      allowedKinds.length ? 'dependency' : 'compatibility',
    );
    assert.equal(report.entities.length, 0);
  }
});

void test('BC-05 source rules add allowances using exact-file or directory boundaries', async (t) => {
  for (const [prefix, allowed] of [
    [ROOT, true],
    [URI, true],
    [ROOT + 'catalog-info', false],
    [ROOT + 'catalog-info.yaml/', false],
    ['file:///work/', false],
    ['https://example.com/workspace/', false],
  ] as const)
    await t.test(prefix, async () => {
      const state = run({
        profile: {
          admission: {
            allowedKinds: [],
            locations: [{ sourcePrefix: prefix, allowedKinds: ['Component'] }],
          },
        },
      });
      assert.equal((await validate(state)).entities.length, allowed ? 1 : 0);
    });
  const state = run({
    profile: {
      admission: {
        allowedKinds: ['Component'],
        locations: [{ sourcePrefix: ROOT, allowedKinds: [] }],
      },
    },
  });
  assert.equal((await validate(state)).entities.length, 1);
});

void test('BC-05 malformed prefixes, case-ambiguous allowances, duplicate declarations and stock overrides are configuration errors', async (t) => {
  for (const sourcePrefix of [
    ROOT + '../private/',
    ROOT + '%2e%2e/private/',
    ROOT + '%2fprivate/',
    ROOT + '%252fprivate/',
    ROOT + 'x#fragment',
    ROOT + 'x?query',
    'https://user:secret@example.com/',
    'https://EXAMPLE.com/',
    'custom:///workspace/',
  ])
    await t.test(sourcePrefix, () =>
      assert.throws(
        () =>
          run({
            profile: {
              admission: {
                allowedKinds: [],
                locations: [{ sourcePrefix, allowedKinds: ['Widget'] }],
              },
            },
          }),
        ContractError,
      ),
    );
  const profiles: Partial<DeploymentProfile>[] = [
    { admission: { allowedKinds: ['Widget', 'widget'], locations: [] } },
    {
      admission: {
        allowedKinds: [],
        locations: [
          { sourcePrefix: ROOT, allowedKinds: [] },
          { sourcePrefix: ROOT, allowedKinds: [] },
        ],
      },
    },
    { customKinds: [widgetDeclaration, { ...widgetDeclaration, kind: 'widget' }] },
    {
      customKinds: [
        widgetDeclaration,
        {
          ...widgetDeclaration,
          apiVersion: 'example.com/v2',
          schema: { ...widgetDeclaration.schema, digest: digestJson(true) },
        },
      ],
    },
    ...BUILTIN_KINDS.map((kind) => ({ customKinds: [{ ...widgetDeclaration, kind }] })),
  ];
  for (const profile of profiles) assert.throws(() => run({ profile }), ContractError);
});

void test('BC-05 included payload locations do not grant admission to their containing entity', async () => {
  const state = run({
    rootUri: ROOT,
    entrypoints: [URI],
    text: '"$yaml": ./trusted/entity.yaml\n',
    files: [{ uri: ROOT + 'trusted/entity.yaml', text: componentText() }],
    profile: {
      admission: {
        allowedKinds: [],
        locations: [{ sourcePrefix: ROOT + 'trusted/', allowedKinds: ['Component'] }],
      },
    },
  });
  const report = await validate(state);
  assert.equal(report.entities.length, 0);
  assert.equal(report.findings[0]?.ruleId, 'backstage/admission/disallowed_kind');
  assert.equal(report.findings[0]?.location.uri, ROOT + 'trusted/entity.yaml');
  assert.equal(report.findings[0]?.relatedLocations[0]?.uri, URI);
  assert.equal(exit(state, report), 1);
});

void test('BC-05 discovered entities use their own source rules and rejected Locations do not discover children', async () => {
  const text = stringify({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Location',
    metadata: { name: 'root' },
    spec: { type: 'file', target: './trusted/child.yaml' },
  });
  for (const allowLocation of [false, true]) {
    const state = run({
      rootUri: ROOT,
      entrypoints: [URI],
      text,
      files: [{ uri: ROOT + 'trusted/child.yaml', text: componentText() }],
      profile: {
        admission: {
          allowedKinds: allowLocation ? ['Location'] : [],
          locations: [{ sourcePrefix: ROOT + 'trusted/', allowedKinds: ['Component'] }],
        },
      },
    });
    const report = await validate(state);
    assert.equal(report.entities.length, allowLocation ? 2 : 0);
    assert.equal(report.sourceClaims.length, allowLocation ? 2 : 1);
  }
});

void test('BC-05 pinned custom schemas run after native defaults without mutating the entity on both pins', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    await t.test(adapterId, async () => {
      const state = customRun({ profile: { ...widgetProfile, adapterId } });
      const report = await validate(state);
      assert.equal(report.findings.length, 0);
      const accepted = report.entities[0]!;
      assert.equal(accepted.entityRef, 'widget:default/custom');
      assert.deepEqual(accepted.authored, widgetValue());
      assert.deepEqual(accepted.normalized, {
        ...widgetValue(),
        metadata: { name: 'custom', namespace: 'default' },
      });
      assert.deepEqual(accepted.customSchema, widgetDeclaration.schema);
      assert(
        report.artifacts[0]?.provenance.some(
          (item) => item.transformation === `custom-schema/${widgetArtifact.digest}`,
        ),
      );
      assert(Object.isFrozen(accepted.normalized));
      assert.equal(exit(state, report), 0);
    });
});

void test('BC-05 custom-schema pinning never grants admission and wrong API versions never use a declared schema', async () => {
  const denied = customRun({
    profile: { ...widgetProfile, admission: { allowedKinds: [], locations: [] } },
  });
  assert.equal(exit(denied, await validate(denied)), 1);
  const wrong = customRun({ text: stringify({ ...widgetValue(), apiVersion: 'example.com/v2' }) });
  const report = await validate(wrong);
  assert.equal(report.findings[0]?.ruleId, 'backstage/kind/unsupported_api_version');
  assert.equal(exit(wrong, report), 2);
});

void test('BC-05 custom schemas reject coercion, missing fields and unknown properties with precise redacted pointers', async (t) => {
  for (const [spec, pointer] of [
    [{ owner: 'team', tier: '1' }, '/spec/tier'],
    [{ owner: 'team' }, '/spec/tier'],
    [{ owner: 'team', tier: 0 }, '/spec/tier'],
    [{ owner: 'bad owner', tier: 1 }, '/spec/owner'],
    [{ owner: 'team', tier: 1, private: 'sensitive-value' }, '/spec'],
  ] as const)
    await t.test(pointer, async () => {
      const state = customRun({ text: widgetText(spec) });
      const report = await validate(state);
      assert.equal(report.entities.length, 0);
      assert.equal(report.findings[0]?.ruleId, 'backstage/custom_schema/invalid_custom_kind');
      assert.equal(report.findings[0]?.location.path, pointer);
      assert(!JSON.stringify(report.findings).includes('sensitive-value'));
      assert.equal(exit(state, report), 1);
    });
});

void test('BC-05 custom errors inside substituted YAML retain payload pointers and buffer versions', async () => {
  const state = customRun({
    rootUri: ROOT,
    entrypoints: [URI],
    text: widgetText({ $yaml: './spec.yaml' }),
    files: [
      {
        uri: ROOT + 'spec.yaml',
        text: 'owner: team\ntier: invalid\n',
        origin: 'buffer',
        version: 4,
      },
    ],
  });
  const report = await validate(state);
  assert.equal(report.findings[0]?.location.uri, ROOT + 'spec.yaml');
  assert.equal(report.findings[0]?.location.path, '/tier');
  assert.equal(report.findings[0]?.location.range.start.line, 1);
  assert.equal(report.findings[0]?.relatedLocations[0]?.uri, URI);
  assert.equal(report.entities.length, 0);
});

void test('BC-05 missing custom artifacts remain incomplete while tampered, duplicate and mismatched artifacts fail integrity', async () => {
  const missing = customRun({ schemaArtifacts: [] });
  const report = await validate(missing);
  assert.equal(report.findings[0]?.ruleId, 'backstage/custom_schema/unsupported_custom_schema');
  assert.equal(exit(missing, report), 2);
  for (const artifacts of [
    [{ ...widgetArtifact, schema: true }],
    [widgetArtifact, widgetArtifact],
    [schemaArtifact(true)],
  ] as readonly (readonly Immutable<SchemaArtifact>[])[]) {
    const state = customRun({ schemaArtifacts: artifacts });
    await assert.rejects(validate(state), ContractError);
  }
});

void test('BC-05 custom schema configuration rejects non-draft-07, network/missing/cyclic refs, formats and unsupported regex features', async (t) => {
  for (const schema of [
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    { $ref: 'https://untrusted.invalid/schema.json' },
    { $ref: '#/definitions/missing' },
    { $ref: '#' },
    { type: 'object', properties: { recursive: { $ref: '#' } } },
    { type: 'string', format: 'unknown' },
    { $async: true, type: 'object' },
    { type: 'string', pattern: '(?<=private)value' },
    { type: 'object', properties: { child: { $id: 'nested', type: 'object' } } },
    { type: 'object', unknownKeyword: true },
  ] as JsonValue[])
    await t.test(JSON.stringify(schema).slice(0, 75), async () => {
      const artifact = schemaArtifact(schema);
      const state = customRun({
        schemaArtifacts: [artifact],
        profile: {
          ...widgetProfile,
          customKinds: [
            {
              ...widgetDeclaration,
              schema: { ...widgetDeclaration.schema, digest: artifact.digest },
            },
          ],
        },
      });
      await assert.rejects(
        validate(state),
        (error: unknown) =>
          error instanceof ContractError &&
          !error.message.includes('private') &&
          !error.message.includes('untrusted.invalid'),
      );
    });
});

void test('BC-05 schema annotations are data, boolean schemas work, and artifact admission is bounded', async () => {
  const annotated = schemaArtifact({
    ...(widgetSchema as object),
    default: { $async: true, format: 'ordinary-data' },
  });
  const state = customRun({
    schemaArtifacts: [annotated],
    profile: {
      ...widgetProfile,
      customKinds: [
        { ...widgetDeclaration, schema: { ...widgetDeclaration.schema, digest: annotated.digest } },
      ],
    },
  });
  assert.equal((await validate(state)).entities.length, 1);
  for (const schema of [true, false]) {
    const artifact = schemaArtifact(schema);
    const state = customRun({
      schemaArtifacts: [artifact],
      profile: {
        ...widgetProfile,
        customKinds: [
          {
            ...widgetDeclaration,
            schema: { ...widgetDeclaration.schema, digest: artifact.digest },
          },
        ],
      },
    });
    assert.equal((await validate(state)).entities.length, schema ? 1 : 0);
  }
  const oversized = { ...widgetArtifact, schema: { description: 'x'.repeat(64 * 1024) } };
  assert.throws(
    () => parseContract('schema-artifact', { ...oversized, digest: digestJson(oversized.schema) }),
    /budget/,
  );
  await assert.rejects(
    validate(customRun({ schemaArtifacts: Array.from({ length: 65 }, () => widgetArtifact) })),
    /too many/,
  );
});

void test('BC-05 shared local references cannot expand a compact schema into excessive validation work', async () => {
  const definitions: Record<string, JsonValue> = { n0: true };
  for (let level = 1; level <= 5; level++)
    definitions[`n${level}`] = {
      allOf: Array.from({ length: 8 }, () => ({ $ref: `#/definitions/n${level - 1}` })),
    };
  const artifact = schemaArtifact({ $ref: '#/definitions/n5', definitions });
  const state = customRun({
    schemaArtifacts: [artifact],
    profile: {
      ...widgetProfile,
      customKinds: [
        { ...widgetDeclaration, schema: { ...widgetDeclaration.schema, digest: artifact.digest } },
      ],
    },
  });
  await assert.rejects(validate(state), /supported synchronous draft-07 profile/);
});

void test('BC-05 required unavailable processors suppress admission and custom-schema speculation', async () => {
  const state = customRun({
    text: widgetText({}),
    profile: {
      ...widgetProfile,
      admission: { allowedKinds: [], locations: [] },
      requiredProcessors: [{ id: 'required', stage: 'pre-validation' }],
    },
  });
  const report = await validate(state);
  assert(report.findings.every((finding) => finding.category === 'dependency'));
  assert.equal(exit(state, report), 2);
  assert(!report.coverage.some((row) => row.stage === 'admission' && row.status === 'verified'));
});

void test('BC-05 admission and custom kinds propagate through catalog policies on both native pins and both fake APIs', async (t) => {
  const matrix = await policyMatrix(t);
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    for (const [index, fixture] of matrix.fixtures.entries())
      await t.test(`${adapterId}/${fixture.target.backstageVersion}`, async () => {
        const state = customRun({
          profile: { ...widgetProfile, adapterId },
          rules: [{ ...ownerRule, selector: 'entity.kind == "Widget"' }],
        });
        const report = await validatePolicySources(state.request, state.context, {
          catalog: await matrix.catalog(state, index),
        });
        assert.equal(report.compatibility.entities.length, 1);
        assert.equal(report.ruleStates[0]?.status, 'passed');
        assert.deepEqual(report.findings, []);
      });
});

void test('BC-05 denied and schema-invalid local replacements block external catalog fallback', async (t) => {
  const matrix = await policyMatrix(t);
  for (const invalid of [false, true]) {
    const state = customRun({
      text: componentText('widget:default/custom'),
      files: [
        {
          uri: ROOT + 'widget.yaml',
          text: widgetText(invalid ? { owner: 'team', tier: 0 } : undefined),
        },
      ],
      rules: [ownerRule],
      profile: {
        ...widgetProfile,
        admission: {
          allowedKinds: invalid ? ['Component', 'Widget'] : ['Component'],
          locations: [],
        },
      },
    });
    const report = await validatePolicySources(state.request, state.context, {
      catalog: await matrix.catalog(state),
    });
    assert.equal(report.ruleStates[0]?.status, 'incomplete');
    assert.equal(report.preparation?.observations[0]?.status, 'blocked');
    assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
  }
});

void test('BC-05 preserves the original deadline and cancellation before custom checks', async () => {
  const state = customRun();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await validate(state, controller.signal)).interrupted, 'cancelled');
  const expiredAt = Date.now() - 1;
  const expired = parseContract('validation-request', {
    ...state.request,
    execution: { mode: 'ci', startedAt: expiredAt - 5000, deadlineAt: expiredAt },
  });
  assert.equal((await validate({ ...state, request: expired })).interrupted, 'timeout');
});
