import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { stringify } from 'yaml';
import {
  ContractError,
  closeSharedCelRuntime,
  loadBackstageAdapter,
  locateParsedPath,
  parseContract,
} from '../../src/index.js';
import type { Coverage, DeploymentProfile, JsonValue } from '../../src/index.js';
import { createCustomKindRegistry } from '../../src/compatibility/custom-schemas.js';
import { admitEntity } from '../../src/compatibility/stages/admission.js';
import { validateSourceDocument } from '../../src/compatibility/stages/document.js';
import { resolveIdentityConflicts } from '../../src/compatibility/stages/identity-conflicts.js';
import { prepareSourceRun } from '../../src/compatibility/stages/prepare.js';
import { blockedProcessingReport } from '../../src/compatibility/stages/processing-gate.js';
import { MESSAGES, openSourceRun } from '../../src/compatibility/stages/state.js';
import type { DocumentProgress, SourceRunState } from '../../src/compatibility/stages/state.js';
import type { SnapshotSourceResolver } from '../../src/compatibility/substitutions.js';
import { BackstageRuntimeError } from '../../src/compatibility/types.js';
import type { BackstageAdapter, SourceIdentityClaim } from '../../src/compatibility/types.js';
import {
  INTERRUPTION_PRIORITY,
  mergeCoverage,
  mergeInterruption,
} from '../../src/core/stage-report.js';
import type { Interruption } from '../../src/core/stage-report.js';
import { CelError } from '../../src/runtime/cel/errors.js';
import { RequestBudget } from '../../src/runtime/request-budget.js';
import { componentText, policyRun } from '../harness/policy-fixture.js';
import { URI } from '../helpers.js';

const ROOT = 'file:///workspace/';
const budgets: RequestBudget[] = [];
after(() => {
  for (const budget of budgets) budget[Symbol.dispose]();
  return closeSharedCelRuntime();
});

async function openRun(options: Parameters<typeof policyRun>[0] = {}, uris?: readonly string[]) {
  const state = policyRun({ mode: 'ci', rules: [], ...options });
  const profile = parseContract('deployment-profile', state.context.profile);
  const budget = new RequestBudget(state.request.execution.deadlineAt);
  budgets.push(budget);
  return {
    ...state,
    profile,
    budget,
    source: await openSourceRun(state.request, profile, budget, uris),
  };
}
function progressFor(
  source: SourceRunState,
  adapter: BackstageAdapter,
  index = 0,
): DocumentProgress {
  const document = source.documents[index]!;
  return {
    phase: 'substitution',
    document,
    claim: {
      uri: document.uri,
      document: document.document,
      location: locateParsedPath(document, '/metadata'),
      relatedLocations: [],
    },
    subject: JSON.stringify([document.uri, document.document]),
    claimIndex: 0,
    adapter,
    customKinds: createCustomKindRegistry(source.profile),
  };
}

void test('mergeInterruption returns the higher-priority value for every ordered pair', () => {
  const ordered: Interruption[] = [
    'none',
    'resource_limit',
    'worker_failure',
    'cancelled',
    'timeout',
  ];
  assert.deepEqual(Object.keys(INTERRUPTION_PRIORITY).sort(), [...ordered].sort());
  for (const [i, current] of ordered.entries())
    for (const [j, next] of ordered.entries())
      assert.equal(
        mergeInterruption(current, next),
        ordered[Math.max(i, j)],
        `${current}, ${next}`,
      );
});

void test('mergeCoverage collapses identical duplicates in first-seen order and rejects conflicts', () => {
  const row = (
    stage: Coverage['stage'],
    subject: string,
    status: Coverage['status'] = 'verified',
  ) => ({ stage, subject, required: true, status }) as const;
  assert.deepEqual(
    mergeCoverage([row('rules', 'b'), row('parse', 'a'), row('rules', 'b'), row('rules', 'a')]),
    [row('rules', 'b'), row('parse', 'a'), row('rules', 'a')],
  );
  assert.throws(
    () => mergeCoverage([row('rules', 'b'), row('rules', 'b', 'blocked')]),
    (error: unknown) => error instanceof ContractError && error.code === 'integrity',
  );
});

void test('processing gate rejects bad selections, blocks five stages and truncates to the entity limit', () => {
  const base = policyRun();
  const state = policyRun({
    mode: 'ci',
    rules: [],
    profile: {
      requiredProcessors: [{ id: 'processor', stage: 'before-native' }],
      limits: { ...base.context.profile.limits, entities: 2 },
    },
    files: [
      { uri: ROOT + 'b.yaml', text: componentText() },
      { uri: ROOT + 'c.yaml', text: componentText() },
    ],
  });
  const profile = parseContract('deployment-profile', state.context.profile);
  using budget = new RequestBudget(state.request.execution.deadlineAt);
  for (const uris of [[URI, URI], [ROOT + 'unknown.yaml']])
    assert.throws(
      () => blockedProcessingReport(state.request, profile, budget, uris),
      (error: unknown) => error instanceof ContractError && error.code === 'invalid_contract',
    );
  const report = blockedProcessingReport(state.request, profile, budget, undefined);
  assert.deepEqual(
    report.coverage
      .filter((row) => row.subject === 'processing')
      .map((row) => [row.stage, row.status]),
    ['parse', 'substitution', 'compatibility', 'admission', 'overlay'].map((stage) => [
      stage,
      'blocked',
    ]),
  );
  assert.deepEqual(
    report.findings.map((finding) => finding.subjectId),
    // Snapshot files are ordered by URI; the first two are selected.
    [JSON.stringify([ROOT + 'b.yaml', 0]), JSON.stringify([ROOT + 'c.yaml', 0])],
  );
  assert.equal(report.interrupted, 'none');
  const selected = blockedProcessingReport(state.request, profile, budget, [ROOT + 'c.yaml']);
  assert.deepEqual(
    selected.findings.map((finding) => finding.subjectId),
    [JSON.stringify([ROOT + 'c.yaml', 0])],
  );
});

void test('preparation maps an unavailable adapter to one unavailable row and rejects ambiguous contexts', async () => {
  const { source } = await openRun();
  const before = source.coverage.length;
  await prepareSourceRun(source, [], () =>
    Promise.reject(new BackstageRuntimeError('adapter_unavailable')),
  );
  assert.deepEqual(source.coverage.slice(before), [
    {
      stage: 'compatibility',
      subject: 'adapter',
      required: true,
      status: 'unavailable',
      reason: MESSAGES.adapter_unavailable,
    },
  ]);
  assert.equal(source.unavailable, true);
  assert.equal(source.blockedReason, MESSAGES.adapter_unavailable);
  assert.equal(source.interrupted, 'none');
  const ambiguous = await openRun({
    profile: {
      referenceContexts: [{ path: '/spec/owner', defaultKind: 'Group', namespace: 'a/b' }],
    },
  });
  await assert.rejects(
    prepareSourceRun(ambiguous.source, []),
    (error: unknown) =>
      error instanceof ContractError && error.issues[0]?.path === '/referenceContexts',
  );
});

void test('admission honours global, location-prefix, exact-URI and case-insensitive allowances', async () => {
  const profile: Partial<DeploymentProfile> = {
    admission: {
      allowedKinds: ['Component'],
      locations: [
        { sourcePrefix: ROOT + 'templates/', allowedKinds: ['Template'] },
        { sourcePrefix: ROOT + 'exact.yaml', allowedKinds: ['Template'] },
      ],
    },
  };
  const files = ['templates/a.yaml', 'exact.yaml', 'exact.yaml.d/b.yaml', 'other.yaml'].map(
    (name) => ({ uri: ROOT + name, text: componentText() }),
  );
  const { source } = await openRun({ profile, files });
  const adapter = await loadBackstageAdapter(source.profile.adapterId);
  const value: JsonValue = { kind: 'Template' };
  const admitted = (uri: string, kind: string) => {
    const index = source.documents.findIndex((document) => document.uri === uri);
    const findings = source.findings.length;
    const result = admitEntity(source, progressFor(source, adapter, index), value, kind, 'v1');
    return { result, findings: source.findings.slice(findings).map((row) => row.ruleId) };
  };
  assert.deepEqual(admitted(URI, 'Component'), { result: {}, findings: [] });
  assert.deepEqual(admitted(URI, 'cOMPONENT'), { result: {}, findings: [] });
  assert.deepEqual(admitted(ROOT + 'templates/a.yaml', 'template'), { result: {}, findings: [] });
  assert.deepEqual(admitted(ROOT + 'exact.yaml', 'Template'), { result: {}, findings: [] });
  for (const uri of [ROOT + 'exact.yaml.d/b.yaml', ROOT + 'other.yaml', URI])
    assert.deepEqual(admitted(uri, 'Template'), {
      result: undefined,
      findings: ['backstage/admission/disallowed_kind'],
    });
});

void test('identity conflicts: none, one pair, the 64-finding cap and 16 related locations', async () => {
  const conflicts = async (claims: readonly SourceIdentityClaim[]) => {
    const { source } = await openRun();
    source.sourceClaims.push(...claims);
    resolveIdentityConflicts(source);
    return source;
  };
  const claim = (index: number, entityRef = 'component:default/same'): SourceIdentityClaim => ({
    uri: `${ROOT}${index}.yaml`,
    document: 0,
    entityRef,
    location: {
      uri: `${ROOT}${index}.yaml`,
      document: 0,
      path: '/metadata',
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
    },
    relatedLocations: [],
  });
  const overlay = (source: SourceRunState) =>
    source.coverage.find((row) => row.stage === 'overlay')?.status;
  const none = await conflicts([claim(0, 'component:default/a'), claim(1, 'component:default/b')]);
  assert.equal(none.findings.length, 0);
  assert.equal(overlay(none), 'verified');
  const pair = await conflicts([claim(0), claim(1), claim(2, 'component:default/other')]);
  assert.deepEqual(
    pair.findings.map((row) => [
      row.subjectId,
      row.relatedLocations.map((location) => location.uri),
    ]),
    [
      [JSON.stringify([ROOT + '0.yaml', 0]), [ROOT + '1.yaml']],
      [JSON.stringify([ROOT + '1.yaml', 0]), [ROOT + '0.yaml']],
    ],
  );
  assert.equal(pair.interrupted, 'none');
  const dense = await conflicts(Array.from({ length: 70 }, (_, index) => claim(index)));
  assert.equal(dense.findings.length, 64);
  assert.equal(dense.interrupted, 'resource_limit');
  assert.equal(overlay(dense), 'blocked');
  assert.deepEqual(
    dense.findings.map((row) => row.relatedLocations.length),
    Array.from({ length: 64 }, () => 16),
  );
  assert.deepEqual(
    dense.findings[20]?.relatedLocations.map((location) => location.uri),
    Array.from({ length: 16 }, (_, index) => `${ROOT}${index}.yaml`),
  );
});

void test('the document driver maps each phase failure to its coverage stage, subject and interruption', async (t) => {
  const errors = {
    timeout: [() => new CelError('request_timeout'), 'timeout', 'resource'],
    cancellation: [() => new CelError('cancelled'), 'cancelled', 'resource'],
    resource: [() => new BackstageRuntimeError('resource_limit'), 'resource_limit', 'resource'],
    unknown: [() => new Error('unexpected'), 'none', 'dependency'],
  } as const;
  const location = stringify({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Location',
    metadata: { name: 'sources' },
    spec: { type: 'file', target: './service.yaml' },
  });
  for (const phase of ['substitution', 'native', 'references', 'locations'] as const)
    for (const [name, [error, interrupted, category]] of Object.entries(errors))
      await t.test(`${phase}/${name}`, async () => {
        const { source } = await openRun(
          {
            rootUri: ROOT,
            text: phase === 'locations' ? location : componentText(),
            files: [{ uri: ROOT + 'service.yaml', text: componentText() }],
          },
          [URI],
        );
        await prepareSourceRun(source, []);
        const adapter = source.adapter!;
        const fail = () => Promise.reject(error());
        const resolver =
          phase === 'substitution'
            ? Object.assign(Object.create(source.resolver) as SnapshotSourceResolver, {
                resolve: fail,
              })
            : phase === 'locations'
              ? Object.assign(Object.create(source.resolver) as SnapshotSourceResolver, {
                  discover: fail,
                })
              : source.resolver;
        const stub: BackstageAdapter =
          phase === 'native'
            ? { ...adapter, normalizeEntity: fail }
            : phase === 'references'
              ? {
                  ...adapter,
                  resolveReference: () => {
                    throw error();
                  },
                }
              : adapter;
        const state: SourceRunState = { ...source, resolver, adapter: stub };
        const coverage = state.coverage.length;
        await validateSourceDocument(state, state.documents[0]!);
        const subject =
          phase === 'locations' || phase === 'references'
            ? JSON.stringify([phase, URI, 0])
            : JSON.stringify([URI, 0]);
        const blocked = state.coverage.slice(coverage).at(-1);
        assert.deepEqual(
          [blocked?.stage, blocked?.subject, blocked?.status],
          [
            phase === 'substitution' || phase === 'locations' ? 'substitution' : 'compatibility',
            subject,
            'blocked',
          ],
        );
        assert.equal(state.interrupted, interrupted);
        assert.equal(state.unavailable, true);
        assert.equal(state.unresolvedIncludes, phase === 'locations');
        assert.equal(state.findings.at(-1)?.category, category);
        assert.equal(state.blockedReason, blocked?.reason);
      });
});

void test('a contract error from any stage propagates out of the document driver', async () => {
  const { source } = await openRun();
  await prepareSourceRun(source, []);
  const failure = new ContractError('invalid_contract', [{ path: '/x', message: 'stub' }]);
  const state: SourceRunState = {
    ...source,
    adapter: { ...source.adapter!, normalizeEntity: () => Promise.reject(failure) },
  };
  await assert.rejects(
    validateSourceDocument(state, state.documents[0]!),
    (error) => error === failure,
  );
});
