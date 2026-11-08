import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'yaml';
import {
  BACKSTAGE_ADAPTER_IDS,
  PROPOSED_CATALOG_PROVIDER,
  ContractError,
  closeSharedCelRuntime,
  createDataSnapshot,
  createSourceSnapshot,
  createValidationResult,
  digestJson,
  executePolicyRules,
  overlaySourceSnapshot,
  parseContract,
  proposedCatalogEntityKey,
  resultExitCode,
  validateBackstageSources,
  validatePolicySources,
} from '../src/index.js';
import type {
  DeploymentProfile,
  Immutable,
  JsonValue,
  SourceInput,
  SourceSnapshot,
} from '../src/index.js';
import { URI } from './helpers.js';
import { componentText, ownerRule, policyMatrix, policyRun } from './harness/policy-fixture.js';
import { widgetArtifact, widgetProfile, widgetText } from './harness/custom-kind-fixture.js';

const ROOT = 'file:///workspace/';
const TEAM_URI = ROOT + 'team.yaml';
const TEAM = 'group:default/team';
const group = (name = 'team', namespace?: string, children: JsonValue = []) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name, ...(namespace ? { namespace } : {}) },
  spec: { type: 'team', children },
});
const source = (
  files: readonly SourceInput[] = [],
  options: { text?: string; entrypoints?: readonly string[] } = {},
) =>
  createSourceSnapshot({
    repository: 'repository',
    revision: 'base',
    rootUri: ROOT,
    ...(options.entrypoints ? { entrypoints: options.entrypoints } : {}),
    files: [{ uri: URI, text: options.text ?? componentText() }, ...files],
  });
const run = (
  baseline: Immutable<SourceSnapshot>,
  changes: Parameters<typeof overlaySourceSnapshot>[1],
  options: Parameters<typeof policyRun>[0] = {},
) =>
  policyRun({
    mode: 'ci',
    baseline,
    source: overlaySourceSnapshot(baseline, changes),
    ...options,
  });
const evaluate = (state: ReturnType<typeof policyRun>) =>
  validatePolicySources(state.request, state.context);
const componentRule = (report: Awaited<ReturnType<typeof evaluate>>) =>
  report.ruleStates.find((row) => row.subjectId === JSON.stringify([URI, 0]));
const verdict = (report: Awaited<ReturnType<typeof evaluate>>) =>
  createValidationResult({
    ...report,
    artifacts: report.compatibility.artifacts,
    completedAt: Date.now(),
    authorityCheckedAt: report.request.execution.startedAt,
  });
test.after(closeSharedCelRuntime);

void test('BC-06 same-change additions qualify before catalog I/O on every model and API pin', async (t) => {
  const matrix = await policyMatrix(t);
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    for (const [index, entry] of matrix.fixtures.entries())
      await t.test(`${adapterId}/${entry.target.backstageVersion}`, async () => {
        const baseline = source();
        const state = run(
          baseline,
          [{ uri: TEAM_URI, text: stringify(group()), origin: 'buffer', version: 8 }],
          { profile: { adapterId } },
        );
        const report = await validatePolicySources(state.request, state.context, {
          catalog: await matrix.catalog(state, index),
        });
        assert.equal(componentRule(report)?.status, 'passed');
        assert.equal(report.compatibility.entities.length, 2);
        assert.equal(entry.fixture.requests().length, 0);
        const fact = report.request.data.entries[0]!;
        assert.equal(fact.status, 'present');
        assert.equal(fact.key, proposedCatalogEntityKey(TEAM));
        assert.equal(fact.provenance.providerId, PROPOSED_CATALOG_PROVIDER);
        assert.equal(
          fact.provenance.revision,
          digestJson({
            source: state.request.source.digest,
            baseline: baseline.digest,
            profile: state.request.profile.digest,
          }),
        );
        assert.equal(report.preparation?.baseline?.sourceDigest, baseline.digest);
        assert.equal(report.request.execution.deadlineAt, state.request.execution.deadlineAt);
        const result = verdict(report);
        assert.equal(result.provenance.baselineDigest, baseline.digest);
        assert.equal(resultExitCode(result), 0);
        assert(Object.isFrozen(fact));
      });
});

void test('BC-06 qualified local references require no configured catalog connection', async () => {
  const state = run(source(), [{ uri: TEAM_URI, text: stringify(group()) }]);
  const report = await evaluate(state);
  assert.equal(componentRule(report)?.status, 'passed');
  assert.deepEqual(report.findings, []);
  assert.equal(report.preparation?.catalog, undefined);
  assert.equal(resultExitCode(verdict(report)), 0);
});

void test('BC-06 current local entities and source versions supersede old live/cache content', async (t) => {
  const matrix = await policyMatrix(t);
  const baseline = source([{ uri: TEAM_URI, text: stringify(group()) }]);
  const state = run(baseline, [
    {
      uri: TEAM_URI,
      text: stringify({ ...group(), spec: { type: 'new-team-type', children: [] } }),
      origin: 'buffer',
      version: 10,
    },
  ]);
  const report = await validatePolicySources(state.request, state.context, {
    catalog: await matrix.catalog(state),
  });
  const fact = report.request.data.entries.find(
    (row) => row.key === proposedCatalogEntityKey(TEAM),
  );
  assert(fact?.status === 'present');
  assert.deepEqual(fact.value, {
    ...group(),
    metadata: { name: 'team', namespace: 'default' },
    spec: { type: 'new-team-type', children: [] },
  });
  assert.equal(
    report.compatibility.entities.find((entity) => entity.entityRef === TEAM)?.document.version,
    10,
  );
  assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
});

void test('BC-06 invalid, denied and schema-invalid replacements never use old catalog values', async (t) => {
  const matrix = await policyMatrix(t);
  const baseline = source([{ uri: TEAM_URI, text: stringify(group()) }]);
  for (const [name, text, profile] of [
    ['kind-invalid', stringify(group('team', undefined, 'invalid')), undefined],
    ['denied', stringify(group()), { admission: { allowedKinds: ['Component'], locations: [] } }],
    ['syntax', 'metadata: [broken', undefined],
  ] as const)
    await t.test(name, async () => {
      const state = run(
        baseline,
        [{ uri: TEAM_URI, text }],
        profile
          ? {
              profile: {
                admission: { allowedKinds: [...profile.admission.allowedKinds], locations: [] },
              },
            }
          : {},
      );
      const report = await validatePolicySources(state.request, state.context, {
        catalog: await matrix.catalog(state),
      });
      assert.equal(componentRule(report)?.status, 'incomplete');
      assert.equal(report.preparation?.observations[0]?.status, 'blocked');
      assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
      assert(
        !report.findings.some(
          (finding) => finding.ruleId === ownerRule.id && finding.category === 'policy',
        ),
      );
    });
  const customBase = source([{ uri: ROOT + 'widget.yaml', text: widgetText() }], {
    text: componentText('widget:default/custom'),
  });
  const state = run(
    customBase,
    [{ uri: ROOT + 'widget.yaml', text: widgetText({ owner: 'team', tier: 0 }) }],
    { profile: widgetProfile, schemaArtifacts: [widgetArtifact] },
  );
  assert.equal(componentRule(await evaluate(state))?.status, 'incomplete');
});

void test('BC-06 a baseline identifies old identities even when a replacement claims a different invalid name', async (t) => {
  const matrix = await policyMatrix(t);
  const baseline = source([{ uri: TEAM_URI, text: stringify(group()) }]);
  const state = run(baseline, [
    { uri: TEAM_URI, text: stringify(group('other', undefined, 'invalid')) },
  ]);
  const report = await validatePolicySources(state.request, state.context, {
    catalog: await matrix.catalog(state),
  });
  assert.equal(report.preparation?.observations[0]?.status, 'blocked');
  const row = report.preparation?.observations[0];
  assert(row?.status === 'blocked');
  assert.equal(row.reason, 'invalid_replacement');
  assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
});

void test('BC-06 deletions and empty-file replacements mask live presence with confirmed missing facts', async (t) => {
  const matrix = await policyMatrix(t);
  for (const change of [{ uri: TEAM_URI, deleted: true } as const, { uri: TEAM_URI, text: '' }]) {
    const baseline = source([{ uri: TEAM_URI, text: stringify(group()) }]);
    const state = run(baseline, [change]);
    const report = await validatePolicySources(state.request, state.context, {
      catalog: await matrix.catalog(state),
    });
    assert.equal(componentRule(report)?.status, 'failed');
    assert.equal(report.request.data.entries[0]?.status, 'missing');
    assert.equal(report.request.data.entries[0]?.provenance.providerId, PROPOSED_CATALOG_PROVIDER);
    assert.equal(report.findings.find((row) => row.ruleId === ownerRule.id)?.category, 'policy');
    assert.equal(resultExitCode(verdict(report)), 1);
    assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
  }
});

void test('BC-06 file and identity renames give current additions precedence and mask removed identities', async (t) => {
  const matrix = await policyMatrix(t);
  const baseline = source([{ uri: TEAM_URI, text: stringify(group()) }]);
  const moved = run(baseline, [
    { uri: TEAM_URI, deleted: true },
    { uri: ROOT + 'moved.yaml', text: stringify(group()) },
  ]);
  assert.equal(componentRule(await evaluate(moved))?.status, 'passed');
  for (const owner of ['team', 'platform']) {
    const state = run(baseline, [
      { uri: TEAM_URI, deleted: true },
      { uri: ROOT + 'platform.yaml', text: stringify(group('platform')) },
      { uri: URI, text: componentText(owner) },
    ]);
    const report = await validatePolicySources(state.request, state.context, {
      catalog: await matrix.catalog(state),
    });
    assert.equal(componentRule(report)?.status, owner === 'team' ? 'failed' : 'passed');
    assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
  }
  const sameFile = run(baseline, [{ uri: TEAM_URI, text: stringify(group('platform')) }]);
  assert.equal(componentRule(await evaluate(sameFile))?.status, 'failed');
});

void test('BC-06 multi-document reordering preserves identities and masks only removed documents', async () => {
  const baseline = source([
    {
      uri: TEAM_URI,
      text: [group(), group('other')].map((value) => stringify(value)).join('---\n'),
    },
  ]);
  const reordered = run(baseline, [
    {
      uri: TEAM_URI,
      text: [group('other'), group()].map((value) => stringify(value)).join('---\n'),
    },
  ]);
  assert.equal(componentRule(await evaluate(reordered))?.status, 'passed');
  const removed = run(baseline, [{ uri: TEAM_URI, text: stringify(group('other')) }]);
  assert.equal(componentRule(await evaluate(removed))?.status, 'failed');
});

void test('BC-06 duplicate canonical identities conflict even without an existence policy or catalog', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    for (const sameFile of [false, true])
      await t.test(`${adapterId}/${sameFile}`, async () => {
        const state = policyRun({
          mode: 'ci',
          rules: [],
          profile: { adapterId },
          files: sameFile
            ? [
                {
                  uri: TEAM_URI,
                  text: [group(), group('TEAM')].map((value) => stringify(value)).join('---\n'),
                },
              ]
            : [
                { uri: TEAM_URI, text: stringify(group()) },
                { uri: ROOT + 'other.yaml', text: stringify(group('TEAM')) },
              ],
        });
        const report = await evaluate(state);
        const conflicts = report.findings.filter(
          (finding) => finding.ruleId === 'backstage/overlay/competing_claims',
        );
        assert.equal(conflicts.length, 2);
        assert.notEqual(conflicts[0]?.id, conflicts[1]?.id);
        assert(conflicts.every((row) => row.relatedLocations.length > 0));
        assert(!report.compatibility.entities.some((entity) => entity.entityRef === TEAM));
        assert(!report.compatibility.artifacts.some((artifact) => artifact.entityRef === TEAM));
        assert.equal(resultExitCode(verdict(report)), 1);
      });
});

void test('BC-06 a valid source competing with an invalid claim remains blocked and namespaces stay distinct', async () => {
  const baseline = source();
  const duplicate = run(baseline, [
    { uri: TEAM_URI, text: stringify(group()) },
    { uri: ROOT + 'other.yaml', text: stringify(group('team', undefined, 'invalid')) },
  ]);
  const report = await evaluate(duplicate);
  assert.equal(componentRule(report)?.status, 'incomplete');
  assert(report.findings.some((row) => row.ruleId === 'backstage/overlay/competing_claims'));
  const distinct = run(baseline, [
    { uri: TEAM_URI, text: stringify(group()) },
    { uri: ROOT + 'other.yaml', text: stringify(group('team', 'payments')) },
  ]);
  assert.equal(componentRule(await evaluate(distinct))?.status, 'passed');
});

void test('BC-06 an admitted custom target participates in the qualified overlay', async () => {
  const baseline = source([], { text: componentText('widget:default/custom') });
  const state = run(
    baseline,
    [
      { uri: ROOT + 'widget.yaml', text: widgetText() },
      { uri: TEAM_URI, text: stringify(group()) },
    ],
    { profile: widgetProfile, schemaArtifacts: [widgetArtifact] },
  );
  const report = await evaluate(state);
  assert.equal(componentRule(report)?.status, 'passed');
  assert.equal(report.request.data.entries[0]?.status, 'present');
});

void test('BC-06 baseline omissions and unsafe changes remain explicit rather than guessing removed identities', async (t) => {
  const matrix = await policyMatrix(t);
  const baseline = source([{ uri: TEAM_URI, text: stringify(group()) }]);
  const proposed = overlaySourceSnapshot(baseline, [{ uri: TEAM_URI, deleted: true }]);
  const state = policyRun({ mode: 'ci', source: proposed });
  const report = await validatePolicySources(state.request, state.context, {
    catalog: await matrix.catalog(state),
  });
  assert.equal(componentRule(report)?.status, 'incomplete');
  assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
  const local = policyRun({
    mode: 'ci',
    source: overlaySourceSnapshot(baseline, [
      { uri: TEAM_URI, text: stringify(group('platform')) },
      { uri: URI, text: componentText('platform') },
    ]),
  });
  assert.equal(componentRule(await evaluate(local))?.status, 'passed');
});

void test('BC-06 unknown current/baseline identities and unsupported discovery prevent unqualified fallback', async (t) => {
  const matrix = await policyMatrix(t);
  const malformedBase = source([{ uri: TEAM_URI, text: 'metadata: [broken' }]);
  const state = run(malformedBase, [{ uri: TEAM_URI, deleted: true }]);
  const report = await validatePolicySources(state.request, state.context, {
    catalog: await matrix.catalog(state),
  });
  assert.equal(componentRule(report)?.status, 'incomplete');
  assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
  const missing = policyRun({
    mode: 'ci',
    rootUri: ROOT,
    entrypoints: [URI],
    text:
      componentText() +
      '---\napiVersion: backstage.io/v1alpha1\nkind: Location\nmetadata: {name: remote}\nspec: {type: url, target: https://untrusted.invalid/entity}\n',
  });
  assert.equal(componentRule(await evaluate(missing))?.status, 'incomplete');
});

void test('BC-06 removing a valid Location target masks previously discovered entities', async () => {
  const descriptor = (targets: string[]) =>
    stringify({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Location',
      metadata: { name: 'sources' },
      spec: { type: 'file', targets },
    });
  const baseline = source(
    [
      { uri: ROOT + 'location.yaml', text: descriptor(['./team.yaml']) },
      { uri: TEAM_URI, text: stringify(group()) },
    ],
    { entrypoints: [URI, ROOT + 'location.yaml'] },
  );
  const state = run(baseline, [{ uri: ROOT + 'location.yaml', text: descriptor([]) }]);
  const report = await evaluate(state);
  assert.equal(componentRule(report)?.status, 'failed');
  assert.equal(report.preparation?.observations[0]?.status, 'missing');
});

void test('BC-06 remaining external facts retain denial/outage semantics while local facts stay qualified', async (t) => {
  const matrix = await policyMatrix(t);
  for (const status of [403, 503] as const) {
    const baseline = source([], { text: componentText('team', '  system: remote\n') });
    const state = run(baseline, [{ uri: TEAM_URI, text: stringify(group()) }], {
      rules: [ownerRule, { ...ownerRule, id: 'system-exists', referencePath: '/spec/system' }],
    });
    const fixture = matrix.fixtures[0]!.fixture;
    fixture.failNext({ operation: 'byName' }, { kind: 'status', status });
    const report = await validatePolicySources(state.request, state.context, {
      catalog: await matrix.catalog(state),
    });
    assert.equal(
      report.ruleStates.find(
        (row) => row.ruleId === ownerRule.id && row.subjectId === JSON.stringify([URI, 0]),
      )?.status,
      'passed',
    );
    assert.equal(
      report.ruleStates.find(
        (row) => row.ruleId === 'system-exists' && row.subjectId === JSON.stringify([URI, 0]),
      )?.status,
      'incomplete',
    );
    assert(!report.findings.some((row) => row.category === 'policy'));
  }
});

void test('BC-06 baseline and explicit change records are integrity-checked before collection', () => {
  const baseline = source([{ uri: TEAM_URI, text: stringify(group()) }]);
  const state = run(baseline, [{ uri: TEAM_URI, deleted: true }]);
  const wrongRepo = createSourceSnapshot({ ...baseline, repository: 'other' });
  assert.throws(
    () => parseContract('validation-request', { ...state.request, baseline: wrongRepo }),
    /same repository/,
  );
  assert.throws(
    () =>
      parseContract('validation-request', {
        ...state.request,
        baseline: {
          ...baseline,
          files: baseline.files.map((file) => ({ ...file, text: 'tampered' })),
        },
      }),
    /digest mismatch/,
  );
  const withoutTombstone = createSourceSnapshot({ ...state.request.source, changes: [] });
  assert.throws(
    () => parseContract('validation-request', { ...state.request, source: withoutTombstone }),
    /explicit/,
  );
  const mislabeled = createSourceSnapshot({
    ...state.request.source,
    changes: [
      { uri: TEAM_URI, kind: 'deleted' },
      { uri: URI, kind: 'added' },
    ],
  });
  assert.throws(
    () => parseContract('validation-request', { ...state.request, source: mislabeled }),
    /baseline source membership/,
  );
  const profile = state.context.profile;
  assert.throws(
    () =>
      run(baseline, [], {
        profile: { limits: { ...profile.limits, fileBytes: 1024, requestBytes: 512 } },
      }),
    /file budget/,
  );
});

void test('BC-06 policy bindings reject a repinned counterfeit local fact and a different baseline', async () => {
  const baseline = source();
  const state = run(baseline, [{ uri: TEAM_URI, text: stringify(group()) }]);
  const report = await evaluate(state);
  const preparation = report.preparation!;
  const entity = report.compatibility.entities.find((entity) => entity.document.uri === URI)!;
  const subjects = [
    {
      id: JSON.stringify([URI, 0]),
      value: entity.normalized,
      location: { uri: URI, document: 0, path: '', range: entity.document.range },
    },
  ];
  const original = preparation.observations[0]!;
  assert(original.status === 'present');
  const { value: omitted, ...missing } = original;
  assert(omitted);
  const observation = { ...missing, status: 'missing' as const };
  const { targetRef: removed, ...entry } = observation;
  assert.equal(removed, TEAM);
  const pinned = parseContract('validation-request', {
    ...report.request,
    data: createDataSnapshot([entry]),
  });
  await assert.rejects(
    executePolicyRules(pinned, state.context, subjects, {
      referenceData: {
        ...preparation,
        evaluationRequest: pinned,
        data: pinned.data,
        observations: [observation],
      },
    }),
    /qualified source state/,
  );
  const different = createSourceSnapshot({ ...baseline, revision: 'different-base' });
  const changed = parseContract('validation-request', { ...report.request, baseline: different });
  await assert.rejects(
    executePolicyRules(changed, state.context, subjects, { referenceData: preparation }),
    /does not bind/,
  );
});

void test('BC-06 backend observations cannot be repinned to bypass a source tombstone', async (t) => {
  const matrix = await policyMatrix(t);
  const external = policyRun({ mode: 'ci' });
  const fetched = await validatePolicySources(external.request, external.context, {
    catalog: await matrix.catalog(external),
  });
  const baseline = source([{ uri: TEAM_URI, text: stringify(group()) }]);
  const state = run(baseline, [{ uri: TEAM_URI, deleted: true }]);
  const report = await evaluate(state);
  const preparation = report.preparation!;
  const remote = fetched.preparation!.observations[0]!;
  assert(remote.status === 'present');
  const { targetRef: ignored, ...entry } = remote;
  assert.equal(ignored, TEAM);
  const data = createDataSnapshot([entry]);
  const pinned = parseContract('validation-request', { ...report.request, data });
  const entity = report.compatibility.entities[0]!;
  await assert.rejects(
    executePolicyRules(
      pinned,
      state.context,
      [
        {
          id: JSON.stringify([URI, 0]),
          value: entity.normalized,
          location: { uri: URI, document: 0, path: '', range: entity.document.range },
        },
      ],
      {
        referenceData: { ...preparation, evaluationRequest: pinned, data, observations: [remote] },
      },
    ),
    /proposed source precedence/,
  );
});

void test('BC-06 conflicting Locations withhold discovered child artifacts', async () => {
  const descriptor = (target: string) =>
    stringify({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Location',
      metadata: { name: 'same' },
      spec: { type: 'file', target },
    });
  const state = policyRun({
    mode: 'ci',
    rootUri: ROOT,
    entrypoints: [URI, ROOT + 'a.yaml', ROOT + 'b.yaml'],
    rules: [],
    files: [
      { uri: ROOT + 'a.yaml', text: descriptor('./team.yaml') },
      { uri: ROOT + 'b.yaml', text: descriptor('./other.yaml') },
      { uri: TEAM_URI, text: stringify(group()) },
      { uri: ROOT + 'other.yaml', text: stringify(group('other')) },
    ],
  });
  const report = await evaluate(state);
  assert.equal(report.compatibility.entities.length, 1);
  assert.equal(report.compatibility.artifacts.length, 1);
  assert.equal(
    report.findings.filter((row) => row.ruleId === 'backstage/overlay/competing_claims').length,
    2,
  );
});

void test('BC-06 dense conflicts have an explicit diagnostic/resource bound', async () => {
  const state = policyRun({
    mode: 'ci',
    rules: [],
    files: [
      { uri: TEAM_URI, text: Array.from({ length: 100 }, () => stringify(group())).join('---\n') },
    ],
  });
  const report = await evaluate(state);
  assert.equal(report.interrupted, 'resource_limit');
  assert.equal(
    report.findings.filter((row) => row.ruleId === 'backstage/overlay/competing_claims').length,
    64,
  );
  assert.equal(resultExitCode(verdict(report)), 2);
});

void test('BC-06 source/overlay budgets and cancellation retain the original request deadline', async () => {
  const baseline = source();
  const state = run(baseline, [{ uri: TEAM_URI, text: stringify(group()) }]);
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    (await validatePolicySources(state.request, state.context, { signal: abort.signal }))
      .interrupted,
    'cancelled',
  );
  const expiredAt = Date.now() - 1;
  const expired = parseContract('validation-request', {
    ...state.request,
    execution: { mode: 'ci', startedAt: expiredAt - 5000, deadlineAt: expiredAt },
  });
  assert.equal((await validatePolicySources(expired, state.context)).interrupted, 'timeout');
  const profile: Partial<DeploymentProfile> = {
    limits: { ...state.context.profile.limits, fileBytes: 512, requestBytes: 512 },
  };
  const large = source([{ uri: ROOT + 'payload.txt', text: '#'.repeat(300) }]);
  const limited = run(large, [], { profile });
  await assert.rejects(validateBackstageSources(limited.request, limited.context), ContractError);
});
