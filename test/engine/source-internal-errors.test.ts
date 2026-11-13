import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { stringify } from 'yaml';
import {
  ContractError,
  createSourceSnapshot,
  createValidationResult,
  loadBackstageAdapter,
  parseContract,
  resultExitCode,
} from '../../src/index.js';
import type { JsonValue } from '../../src/index.js';
import { runBackstageSources } from '../../src/compatibility/sources.js';
import { validateSourceDocument } from '../../src/compatibility/stages/document.js';
import { resolveIdentityConflicts } from '../../src/compatibility/stages/identity-conflicts.js';
import { prepareSourceRun } from '../../src/compatibility/stages/prepare.js';
import { MESSAGES, openSourceRun } from '../../src/compatibility/stages/state.js';
import type { SourceRunState } from '../../src/compatibility/stages/state.js';
import type { SnapshotSourceResolver } from '../../src/compatibility/substitutions.js';
import { SourceResolutionError } from '../../src/compatibility/substitutions.js';
import { BackstageRuntimeError } from '../../src/compatibility/types.js';
import type { BackstageAdapter } from '../../src/compatibility/types.js';
import type { InternalErrorReport } from '../../src/core/internal-errors.js';
import { runPolicySources } from '../../src/pipeline/policy-sources.js';
import { buildProposedCatalog } from '../../src/pipeline/proposed-catalog.js';
import { CelError } from '../../src/runtime/cel/errors.js';
import { RequestBudget } from '../../src/runtime/request-budget.js';
import { policyRun } from '../harness/policy-fixture.js';
import { clock, ROOT, T0 } from '../harness/rule-stage-fixture.js';

const budgets: RequestBudget[] = [];
after(() => {
  for (const budget of budgets) budget[Symbol.dispose]();
});
const MARKER = 'MARKER-entity-content-5e0b';
type Phase = 'substitution' | 'native' | 'references' | 'locations';
const PHASE_TEXT: Record<Phase, string> = {
  substitution: 'substitution',
  native: 'native validation',
  references: 'reference extraction',
  locations: 'Location discovery',
};
const uri = (name: string) => `${ROOT}${name}.yaml`;
const component = (name: string, owner = 'team'): JsonValue => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name },
  spec: { type: 'service', lifecycle: 'production', owner },
});
const location: JsonValue = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Location',
  metadata: { name: 'b' },
  spec: { type: 'file', target: './included.yaml' },
};
const DOCUMENTS = {
  a: component('a'),
  b: component('b'),
  c: component('c', 'component:default/b'),
};

/** A CI run over one file per entry (plus `extra` files), on the fixed clock. */
function sources(
  documents: Readonly<Record<string, JsonValue>> = DOCUMENTS,
  extra: Readonly<Record<string, JsonValue>> = {},
  mode: 'ci' | 'ide' = 'ci',
) {
  const files = [...Object.entries(documents), ...Object.entries(extra)].map(([name, value]) => ({
    uri: uri(name),
    text: stringify(value),
    version: 1,
    origin: 'buffer' as const,
  }));
  const run = policyRun({
    mode,
    rules: [],
    source: createSourceSnapshot({
      repository: 'repository',
      revision: '1',
      rootUri: ROOT,
      entrypoints: Object.keys(documents).map(uri),
      files,
    }),
  });
  const request = parseContract('validation-request', {
    ...run.request,
    execution: { ...run.request.execution, startedAt: T0, deadlineAt: T0 + 5000 },
  });
  return { request, context: run.context };
}

/** Fails `phase` for the document `target` with `error()`; everything else runs normally. */
interface Fault {
  readonly phase: Phase;
  readonly target: string;
  readonly error: () => Error;
}
function stub(adapter: BackstageAdapter, fault: Fault | undefined): BackstageAdapter {
  if (!fault || (fault.phase !== 'native' && fault.phase !== 'references')) return adapter;
  const named = (value: unknown) => (value as { metadata?: { name?: string } }).metadata?.name;
  return fault.phase === 'native'
    ? {
        ...adapter,
        normalizeEntity: (value, settings, context) =>
          named(value) === fault.target
            ? Promise.reject(fault.error())
            : adapter.normalizeEntity(value, settings, context),
      }
    : {
        ...adapter,
        resolveReference: (reference, context) => {
          // The first call of reference extraction resolves the document's own identity.
          if (reference === `component:default/${fault.target}` && !context) throw fault.error();
          return adapter.resolveReference(reference, context);
        },
      };
}
function resolver(state: SourceRunState, fault: Fault | undefined): SnapshotSourceResolver {
  if (fault?.phase !== 'substitution' && fault?.phase !== 'locations') return state.resolver;
  const base = state.resolver;
  const patched = Object.create(base) as SnapshotSourceResolver;
  const hit = (document: { uri: string }) => document.uri === uri(fault.target);
  return Object.assign(
    patched,
    fault.phase === 'substitution'
      ? {
          resolve: (document: Parameters<SnapshotSourceResolver['resolve']>[0]) =>
            hit(document) ? Promise.reject(fault.error()) : base.resolve(document),
        }
      : {
          discover: (...args: Parameters<SnapshotSourceResolver['discover']>) =>
            hit(args[0]) ? Promise.reject(fault.error()) : base.discover(...args),
        },
  );
}

/** The source stage through its stage functions, with the fault injected. */
async function stageRun(
  run: ReturnType<typeof sources>,
  fault?: Fault,
  observed: InternalErrorReport[] = [],
  wrap: (adapter: BackstageAdapter) => BackstageAdapter = (adapter) => adapter,
) {
  const profile = parseContract('deployment-profile', run.context.profile);
  const budget = new RequestBudget(run.request.execution.deadlineAt, undefined, clock());
  budgets.push(budget);
  const opened = await openSourceRun(run.request, profile, budget, undefined, (report) =>
    observed.push(report),
  );
  const adapter = await loadBackstageAdapter(profile.adapterId);
  await prepareSourceRun(opened, [], () => Promise.resolve(wrap(stub(adapter, fault))));
  const state: SourceRunState = { ...opened, resolver: resolver(opened, fault) };
  const before = { blockedReason: state.blockedReason };
  for (const document of state.documents) await validateSourceDocument(state, document);
  const accepted = resolveIdentityConflicts(state);
  return {
    state,
    before,
    budget,
    report: {
      adapterId: profile.adapterId,
      sourceDigest: run.request.source.digest,
      profileDigest: run.request.profile.digest,
      entities: accepted.entities,
      references: accepted.references,
      sourceClaims: state.sourceClaims,
      unresolvedSourceIdentities:
        state.parsed.files.some((file) => file.status !== 'parsed') ||
        state.unresolvedIncludes ||
        state.sourceClaims.some((claim) => claim.entityRef === undefined),
      findings: state.findings,
      coverage: state.coverage,
      artifacts: accepted.artifacts,
      interrupted: state.interrupted,
    },
  };
}
const of = (name: string) => (row: { subject?: string; uri?: string; subjectId?: string }) =>
  JSON.stringify(row).includes(JSON.stringify(uri(name)).slice(1, -1));
const typeError = () => new TypeError(MARKER);

void test('an internal error in native validation is a backstage/internal_error finding, not an unavailable adapter', async () => {
  const { state } = await stageRun(sources(), { phase: 'native', target: 'b', error: typeError });
  const findings = state.findings.filter(of('b'));
  assert.deepEqual(
    findings.map((finding) => [finding.ruleId, finding.category, finding.severity]),
    [['backstage/internal_error', 'execution', 'error']],
  );
  assert.equal(findings[0]?.enforcement, 'blocking');
  assert.match(findings[0].message, /native validation/u);
  assert.match(findings[0].message, /\bTypeError\b/u);
  assert.match(findings[0].message, /fault in the validation engine/u);
  assert.deepEqual(findings[0]?.location.path, '');
  assert(!state.findings.some((finding) => finding.ruleId === 'backstage/adapter_unavailable'));
});

void test('the run continues: the other documents equal a run without the error', async () => {
  const plain = await stageRun(sources());
  const { report } = await stageRun(sources(), {
    phase: 'native',
    target: 'b',
    error: typeError,
  });
  for (const name of ['a', 'c']) {
    assert.deepEqual(
      report.coverage.filter(of(name)),
      plain.report.coverage.filter(of(name)),
      name,
    );
    assert.deepEqual(report.findings.filter(of(name)), plain.report.findings.filter(of(name)));
    assert.deepEqual(
      report.entities.filter((entity) => entity.document.uri === uri(name)),
      plain.report.entities.filter((entity) => entity.document.uri === uri(name)),
    );
    assert.deepEqual(
      report.references.filter((row) => row.location.uri === uri(name)),
      plain.report.references.filter((row) => row.location.uri === uri(name)),
    );
  }
  assert.deepEqual(
    report.entities.map((entity) => entity.entityRef),
    ['component:default/a', 'component:default/c'],
  );
});

void test('each phase reports the phase and blocks the coverage row the handler blocks for it', async (t) => {
  const expected: Record<Phase, readonly [string, string]> = {
    substitution: ['substitution', JSON.stringify([uri('b'), 0])],
    native: ['compatibility', JSON.stringify([uri('b'), 0])],
    references: ['compatibility', JSON.stringify(['references', uri('b'), 0])],
    locations: ['substitution', JSON.stringify(['locations', uri('b'), 0])],
  };
  for (const phase of Object.keys(expected) as Phase[])
    await t.test(phase, async () => {
      const run =
        phase === 'locations'
          ? sources({ ...DOCUMENTS, b: location }, { included: component('included') })
          : sources();
      const { state, before } = await stageRun(run, { phase, target: 'b', error: typeError });
      const [stage, subject] = expected[phase];
      const blocked = state.coverage.filter((row) => row.subject === subject).at(-1);
      assert.deepEqual(
        [blocked?.stage, blocked?.status, blocked?.required, blocked?.reason],
        [stage, 'blocked', true, MESSAGES.internal_error],
      );
      const internal = state.findings.filter(
        (finding) => finding.ruleId === 'backstage/internal_error',
      );
      assert.equal(internal.length, 1);
      assert(internal[0]!.message.includes(PHASE_TEXT[phase]), internal[0]!.message);
      assert.equal(state.unavailable, false);
      assert.equal(state.interrupted, 'none');
      assert.equal(state.blockedReason, before.blockedReason);
      assert.equal(state.unresolvedIncludes, phase === 'locations');
      // The document after the faulty one is still validated.
      assert(
        state.entities.some((entity) => entity.document.uri === uri('c')),
        phase,
      );
    });
});

void test('the run state is untouched by an internal error', async () => {
  const { state, before } = await stageRun(sources(), {
    phase: 'native',
    target: 'b',
    error: typeError,
  });
  assert.deepEqual(
    [state.unavailable, state.interrupted, state.blockedReason],
    [false, 'none', before.blockedReason],
  );
});

void test('identity guard: the faulty document produces no entity and a reference to it is not qualified', async () => {
  const run = sources();
  const fault: Fault = { phase: 'native', target: 'b', error: typeError };
  // b's identity was resolved before the fault: its claim keeps it, and c's reference to it is
  // blocked as a local source without an entity.
  const resolved = await stageRun(run, fault);
  assert(!resolved.report.entities.some((entity) => entity.document.uri === uri('b')));
  assert.equal(
    resolved.report.sourceClaims.find((row) => row.uri === uri('b'))?.entityRef,
    'component:default/b',
  );
  assert(
    resolved.report.references.some(
      (row) => row.location.uri === uri('c') && row.targetRef === 'component:default/b',
    ),
  );
  const local = await buildProposedCatalog(
    run.request,
    resolved.report,
    undefined,
    resolved.budget,
  );
  assert.deepEqual(local.get('component:default/b'), { status: 'blocked', reason: 'local_source' });
  // b's identity was not resolved before the fault: the claim has none, so every local
  // reference is blocked as unresolved.
  const unresolved = await stageRun(run, fault, [], (adapter) => ({
    ...adapter,
    entityReference: (value) => {
      if ((value as { metadata: { name: string } }).metadata.name === 'b') throw typeError();
      return adapter.entityReference(value);
    },
  }));
  assert.equal(
    unresolved.report.sourceClaims.find((row) => row.uri === uri('b'))?.entityRef,
    undefined,
  );
  assert.equal(unresolved.report.unresolvedSourceIdentities, true);
  const blocked = await buildProposedCatalog(
    run.request,
    unresolved.report,
    undefined,
    unresolved.budget,
  );
  assert.deepEqual(blocked.get('component:default/b'), {
    status: 'blocked',
    reason: 'unresolved_sources',
  });
});

void test('an internal error during Location discovery marks the includes unresolved', async () => {
  const { state } = await stageRun(
    sources({ ...DOCUMENTS, b: location }, { included: component('included') }),
    { phase: 'locations', target: 'b', error: typeError },
  );
  assert.equal(state.unresolvedIncludes, true);
  assert.equal(state.unavailable, false);
});

void test('redaction: the thrown message appears nowhere; the observer receives the error', async () => {
  const failure = typeError();
  const observed: InternalErrorReport[] = [];
  const { report } = await stageRun(
    sources(),
    { phase: 'native', target: 'b', error: () => failure },
    observed,
  );
  assert(!JSON.stringify(report).includes(MARKER));
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.error, failure);
  assert.deepEqual(
    { ...observed[0], error: undefined },
    { stage: 'sources', phase: 'native', uri: uri('b'), document: 0, error: undefined },
  );
});

void test('the limit: 70 faulty documents give 64 findings for the first 64 and 70 blocked rows', async () => {
  const names = Array.from({ length: 70 }, (_, index) => `d${String(index).padStart(3, '0')}`);
  const run = sources(Object.fromEntries(names.map((name) => [name, component(name)])));
  const profile = parseContract('deployment-profile', run.context.profile);
  const budget = new RequestBudget(run.request.execution.deadlineAt, undefined, clock());
  budgets.push(budget);
  const observed: InternalErrorReport[] = [];
  const state = await openSourceRun(run.request, profile, budget, undefined, (row) =>
    observed.push(row),
  );
  const adapter = await loadBackstageAdapter(profile.adapterId);
  await prepareSourceRun(state, [], () =>
    Promise.resolve({ ...adapter, normalizeEntity: () => Promise.reject(typeError()) }),
  );
  for (const document of state.documents) await validateSourceDocument(state, document);
  const internal = state.findings.filter(
    (finding) => finding.ruleId === 'backstage/internal_error',
  );
  assert.deepEqual(
    internal.map((finding) => (JSON.parse(finding.subjectId) as [string])[0]),
    names.slice(0, 64).map(uri),
  );
  assert.equal(
    state.coverage.filter(
      (row) => row.status === 'blocked' && row.reason === MESSAGES.internal_error,
    ).length,
    70,
  );
  assert.equal(observed.length, 64);
});

void test('a real unavailable adapter still blocks every document as unavailable', async () => {
  const run = sources();
  const profile = parseContract('deployment-profile', run.context.profile);
  const budget = new RequestBudget(run.request.execution.deadlineAt, undefined, clock());
  budgets.push(budget);
  const failed = await openSourceRun(run.request, profile, budget, undefined);
  await prepareSourceRun(failed, [], () =>
    Promise.reject(new BackstageRuntimeError('adapter_unavailable')),
  );
  for (const document of failed.documents) await validateSourceDocument(failed, document);
  assert.equal(failed.unavailable, true);
  assert.deepEqual(
    failed.coverage
      .filter((row) => row.stage === 'compatibility')
      .map((row) => [row.subject, row.status]),
    [
      ['adapter', 'unavailable'],
      ...['a', 'b', 'c'].map((name) => [JSON.stringify([uri(name), 0]), 'blocked']),
    ],
  );
  // A document-level BackstageRuntimeError('adapter_unavailable') keeps today's mapping.
  const { state } = await stageRun(run, {
    phase: 'native',
    target: 'b',
    error: () => new BackstageRuntimeError('adapter_unavailable'),
  });
  const finding = state.findings.find(of('b'));
  assert.deepEqual(
    [finding?.ruleId, finding?.category],
    ['backstage/adapter_unavailable', 'dependency'],
  );
  assert.equal(state.unavailable, true);
  assert.equal(state.blockedReason, MESSAGES.adapter_unavailable);
  assert(!state.entities.some((entity) => entity.document.uri === uri('c')));
});

void test('typed errors keep their mappings', async (t) => {
  const location0 = {
    uri: uri('b'),
    document: 0,
    path: '',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  };
  const cases = {
    timeout: [() => new CelError('request_timeout'), 'native', 'timeout', 'backstage/timeout'],
    cancelled: [() => new CelError('cancelled'), 'native', 'cancelled', 'backstage/cancelled'],
    resource: [
      () => new BackstageRuntimeError('resource_limit'),
      'native',
      'resource_limit',
      'backstage/resource_limit',
    ],
    resolution: [
      () => new SourceResolutionError('missing_inclusion', '/spec', location0),
      'substitution',
      'none',
      'backstage/substitution/missing_inclusion',
    ],
  } as const;
  for (const [name, [error, phase, interrupted, ruleId]] of Object.entries(cases))
    await t.test(name, async () => {
      const { state } = await stageRun(sources(), { phase, target: 'b', error });
      assert.equal(state.findings.find(of('b'))?.ruleId, ruleId);
      assert.equal(state.interrupted, interrupted);
      assert.equal(state.unavailable, interrupted !== 'none');
      assert(!state.findings.some((finding) => finding.ruleId === 'backstage/internal_error'));
    });
});

void test('a contract error from a stage still propagates', async () => {
  const failure = new ContractError('invalid_contract', [{ path: '/x', message: 'stub' }]);
  await assert.rejects(
    stageRun(sources(), { phase: 'native', target: 'b', error: () => failure }),
    (error) => error === failure,
  );
});

void test('end to end: outcome error, exit 2, the other documents, and one sources evidence row', async () => {
  const run = sources();
  const adapter = await loadBackstageAdapter(run.context.profile.adapterId);
  const fault: Fault = { phase: 'native', target: 'b', error: typeError };
  const observed: InternalErrorReport[] = [];
  const report = await runPolicySources(
    run.request,
    run.context,
    { clock: clock(), onInternalError: (row) => observed.push(row) },
    (request, context, options) =>
      runBackstageSources(request, context, options ?? {}, () =>
        Promise.resolve(stub(adapter, fault)),
      ),
  );
  const result = createValidationResult({
    request: report.request,
    coverage: report.coverage,
    findings: report.findings,
    ruleStates: report.ruleStates,
    interrupted: report.interrupted,
    completedAt: T0,
    authorityCheckedAt: T0,
  });
  assert.deepEqual([result.outcome, resultExitCode(result)], ['error', 2]);
  assert.deepEqual(
    report.compatibility.entities.map((entity) => entity.entityRef),
    ['component:default/a', 'component:default/c'],
  );
  assert.deepEqual(
    report.failureEvidence.filter((row) => row.stage === 'sources').map((row) => row.cause),
    ['unknown'],
  );
  assert.equal(observed.length, 1);
  assert(!JSON.stringify(report).includes(MARKER));
});
