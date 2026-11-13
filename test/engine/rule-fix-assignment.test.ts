import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalJson,
  ContractError,
  createValidationResult,
  digestJson,
  resultExitCode,
  validateBackstageSources,
  validatePolicySources,
} from '../../src/index.js';
import type { Finding, Immutable, PolicyBundle } from '../../src/index.js';
import type { InternalErrorReport } from '../../src/core/internal-errors.js';
import { mergeCoverage } from '../../src/core/stage-report.js';
import { runPolicyRules } from '../../src/pipeline/cel-rules.js';
import { scalarConstEdit } from '../../src/pipeline/scalar-fixes.js';
import {
  clock,
  componentDocument,
  componentName,
  controlledRuntime,
  findingName,
  namedArtifact,
  ORDERS,
  schemaRule,
  sourceRun,
  T0,
} from '../harness/rule-stage-fixture.js';
import type { SettleOrder } from '../harness/rule-stage-fixture.js';

const lifecycle = namedArtifact('example/lifecycle', {
  type: 'object',
  properties: { spec: { type: 'object', properties: { lifecycle: { const: 'production' } } } },
});
const type = namedArtifact('example/type', {
  type: 'object',
  properties: { spec: { type: 'object', properties: { type: { const: 'website' } } } },
});
const selected = schemaRule('a-lifecycle', lifecycle, { selector: 'applies' });
const texts = (count: number) =>
  Array.from({ length: count }, (_, index) => componentDocument(index));
const names = (count: number) => Array.from({ length: count }, (_, index) => componentName(index));
const edited = (findings: readonly Immutable<Finding>[]) =>
  findings.filter((finding) => finding.edits.length).map(findingName);
const order = (value: SettleOrder) => (typeof value === 'object' ? `seed ${value.seed}` : value);

/** Runs the composition with every selector applying, settled in `settle` order. */
async function selectedRun(
  run: ReturnType<typeof sourceRun>,
  settle: SettleOrder = 'descending',
  extra: Partial<Parameters<typeof validatePolicySources>[2]> = {},
) {
  const { runtime } = controlledRuntime(() => true, settle);
  return validatePolicySources(run.request, run.context, { runtime, clock: clock(), ...extra });
}

/** The parts of a report that do not depend on the profile's digest. */
const portable = (report: Awaited<ReturnType<typeof validatePolicySources>>) =>
  canonicalJson({
    findings: report.findings.map((finding) =>
      Object.fromEntries(Object.entries(finding).filter(([key]) => key !== 'id')),
    ),
    ruleStates: report.ruleStates,
    coverage: report.coverage,
    failures: report.rules.failures,
    interrupted: report.interrupted,
  });

void test('adversarial completion order: the same 64 findings receive fixes in every order', async () => {
  const run = sourceRun(texts(70), [selected], [lifecycle], { lanes: 2 });
  const reports = [];
  for (const settle of ORDERS) {
    const report = await selectedRun(run, settle);
    assert.equal(report.findings.length, 70, order(settle));
    assert.deepEqual(edited(report.findings), names(64), order(settle));
    reports.push(canonicalJson(report));
  }
  assert.equal(reports[1], reports[0]);
  assert.equal(reports[2], reports[0]);
});

void test('two rules per subject: fixes follow subject order first, then rule order', async () => {
  const rules = [selected, schemaRule('b-type', type, { selector: 'applies' })];
  const run = sourceRun(texts(40), rules, [lifecycle, type], { lanes: 2 });
  const expected = names(32).flatMap((name) => [
    [name, 'a-lifecycle'],
    [name, 'b-type'],
  ]);
  for (const settle of ORDERS) {
    const report = await selectedRun(run, settle);
    assert.equal(report.findings.length, 80);
    assert.deepEqual(
      report.findings
        .filter((finding) => finding.edits.length)
        .map((finding) => [findingName(finding), finding.ruleId]),
      expected,
      order(settle),
    );
  }
});

void test('limit boundaries: 63, 64 and 65 eligible findings give 63, 64 and 64 fixes', async () => {
  for (const [count, fixes] of [
    [63, 63],
    [64, 64],
    [65, 64],
  ] as const) {
    const report = await selectedRun(
      sourceRun(texts(count), [selected], [lifecycle], { lanes: 2 }),
    );
    assert.deepEqual(edited(report.findings), names(fixes), String(count));
  }
});

void test('ineligible candidates do not consume the fix budget', async () => {
  const titled = namedArtifact('example/titled', {
    type: 'object',
    properties: {
      metadata: { type: 'object', required: ['title'] },
      spec: { type: 'object', properties: { lifecycle: { const: 'production' } } },
    },
  });
  // Every third subject is ineligible: a required-property issue, or an aliased (not authored) value.
  const documents = Array.from({ length: 96 }, (_, index) =>
    index % 3 !== 2
      ? componentDocument(index, {}, { title: 'Service' })
      : index % 2
        ? componentDocument(index, { lifecycle: 'production' })
        : [
            'apiVersion: backstage.io/v1alpha1',
            'kind: Component',
            'metadata:',
            `  name: ${componentName(index)}`,
            '  title: &value experimental',
            'spec:',
            '  type: service',
            '  lifecycle: *value',
            '  owner: team',
            '',
          ].join('\n'),
  );
  const rule = schemaRule('a-titled', titled, { selector: 'applies' });
  const report = await selectedRun(sourceRun(documents, [rule], [titled], { lanes: 2 }));
  assert.equal(report.findings.length, 96);
  assert.deepEqual(
    edited(report.findings),
    names(96).filter((_, index) => index % 3 !== 2),
  );
});

void test('without CEL the report equals the one the lane-time budget produced', async () => {
  const rule = schemaRule('a-lifecycle', lifecycle);
  const run = sourceRun(texts(70), [rule], [lifecycle], { lanes: 2 });
  const report = await validatePolicySources(run.request, run.context, { clock: clock() });
  assert.deepEqual(edited(report.findings), names(64));
  // Captured from the implementation before fixes were assigned after the lanes.
  assert.equal(digestJson(report), NO_CEL_DIGEST);
});
const NO_CEL_DIGEST = 'sha256:5eee4541fb3bad8f885e7e952d2d4e613be25e826f11790cade1c0514fc01ffb';

void test('a budget interrupted after the lanes and before assignment leaves every finding without a fix', async () => {
  const tail: PolicyBundle['rules'][number] = {
    id: 'z-tail',
    version: '1',
    kind: 'cel',
    mandatory: true,
    severity: 'error',
    requires: [],
    expression: 'tail',
  };
  const rules = [schemaRule('a-lifecycle', lifecycle), tail];
  const run = sourceRun(texts(70), rules, [lifecycle], { lanes: 1 });
  const complete = await selectedRun(run, 'ascending');
  assert.equal(complete.interrupted, 'none');
  assert.equal(edited(complete.findings).length, 64);
  const controller = new AbortController();
  const last = componentName(69);
  const { runtime } = controlledRuntime(({ expression, name }) => {
    // The final evaluation of the run; the rule stage then has no evaluation left to interrupt.
    if (expression === 'tail' && name === last) controller.abort();
    return true;
  }, 'ascending');
  const interrupted = await validatePolicySources(run.request, run.context, {
    runtime,
    clock: clock(),
    signal: controller.signal,
  });
  assert.equal(interrupted.interrupted, 'cancelled');
  assert.deepEqual(edited(interrupted.findings), []);
  assert.deepEqual(
    interrupted.findings,
    complete.findings.map((finding) => ({ ...finding, edits: [] })),
  );
  assert.deepEqual(interrupted.ruleStates, complete.ruleStates);
});

/** The source stage, then the rule stage with an injected fix builder, as the composition runs it. */
async function injected(
  run: ReturnType<typeof sourceRun>,
  build: typeof scalarConstEdit,
  observed: InternalErrorReport[] = [],
) {
  const compatibility = await validateBackstageSources(run.request, run.context, {
    clock: clock(),
  });
  const { runtime } = controlledRuntime(() => true, 'descending');
  const rules = await runPolicyRules(
    run.request,
    run.context,
    compatibility.entities.map((entity) => ({
      id: JSON.stringify([entity.document.uri, entity.document.document]),
      value: entity.normalized,
      location: {
        uri: entity.document.uri,
        document: entity.document.document,
        path: '',
        range: entity.document.range,
      },
    })),
    {
      runtime,
      clock: clock(),
      sourceDocuments: compatibility.entities.map((entity) => entity.document),
      sourceSubstitutions: compatibility.entities.map((entity) => ({
        subjectId: JSON.stringify([entity.document.uri, entity.document.document]),
        substitutions: entity.substitutions,
      })),
      onInternalError: (report) => observed.push(report),
    },
    build,
  );
  const result = createValidationResult({
    request: run.request,
    coverage: mergeCoverage([...compatibility.coverage, ...rules.coverage]),
    findings: [...compatibility.findings, ...rules.findings],
    ruleStates: rules.ruleStates,
    interrupted: rules.interrupted,
    completedAt: T0,
    authorityCheckedAt: T0,
  });
  return { rules, result };
}
const throwingFor =
  (failing: (name: string) => boolean, error: () => unknown): typeof scalarConstEdit =>
  (request, document, value, issue, substitutions, indexes) => {
    const name = (value as { metadata: { name: string } }).metadata.name;
    if (failing(name)) throw error();
    return scalarConstEdit(request, document, value, issue, substitutions, indexes);
  };
const MARKER = 'MARKER-entity-content-7f3a';

void test('an unknown error while building a fix keeps the verdict and reports an internal error', async () => {
  const run = sourceRun(texts(8), [selected], [lifecycle], { lanes: 2 });
  const plain = await injected(run, scalarConstEdit);
  const failure = new Error(MARKER);
  const observed: InternalErrorReport[] = [];
  const crashed = componentName(3);
  const { rules, result } = await injected(
    run,
    throwingFor(
      (name) => name === crashed,
      () => failure,
    ),
    observed,
  );
  const original = rules.findings.find(
    (finding) => finding.ruleId === 'a-lifecycle' && findingName(finding) === crashed,
  );
  assert(original);
  assert.deepEqual(original.edits, []);
  assert.deepEqual(rules.ruleStates, plain.rules.ruleStates);
  assert(rules.ruleStates.every((state) => state.status === 'failed'));
  assert.deepEqual(rules.coverage, plain.rules.coverage);
  assert.deepEqual(
    edited(rules.findings.filter((finding) => finding.ruleId === 'a-lifecycle')),
    names(8).filter((name) => name !== crashed),
  );
  const internal = rules.findings.filter((finding) => finding.ruleId === 'engine/internal_error');
  assert.equal(internal.length, 1);
  assert.deepEqual(internal[0]?.location, original.location);
  assert.equal(internal[0]?.subjectId, original.subjectId);
  assert.equal(internal[0]?.ruleVersion, 'a-lifecycle@1');
  assert.equal(internal[0]?.category, 'execution');
  assert.equal(internal[0]?.severity, 'error');
  assert.equal(internal[0]?.enforcement, 'blocking');
  assert.deepEqual(internal[0]?.edits, []);
  assert.match(internal[0].message, /a-lifecycle/u);
  assert.match(internal[0].message, /suggested fix/u);
  assert.match(internal[0].message, /\bError\b/u);
  // The internal-error finding follows the finding whose fix failed.
  assert.equal(rules.findings.indexOf(internal[0]), rules.findings.indexOf(original) + 1);
  assert.deepEqual(
    rules.failures.filter((row) => row.code === 'internal_error'),
    [{ subjectId: original.subjectId, ruleId: 'a-lifecycle', code: 'internal_error' }],
  );
  assert.equal(result.outcome, 'error');
  assert.equal(resultExitCode(result), 2);
  assert(!JSON.stringify(rules).includes(MARKER));
  assert(!JSON.stringify(result).includes(MARKER));
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.error, failure);
  assert.deepEqual(
    observed.map((report) => ({ ...report, error: undefined })),
    [
      {
        stage: 'rules',
        activity: 'fix_generation',
        ruleId: 'a-lifecycle',
        subjectId: original.subjectId,
        location: original.location,
        error: undefined,
      },
    ],
  );
});

void test('contract errors while building a fix: a limit drops the fix, other codes reject the run', async () => {
  const run = sourceRun(texts(4), [selected], [lifecycle], { lanes: 2 });
  const plain = await injected(run, scalarConstEdit);
  const limited = componentName(1);
  const limit = await injected(
    run,
    throwingFor(
      (name) => name === limited,
      () => new ContractError('limit', [{ path: '', message: MARKER }]),
    ),
  );
  assert.deepEqual(
    limit.rules.findings,
    plain.rules.findings.map((finding) =>
      findingName(finding) === limited ? { ...finding, edits: [] } : finding,
    ),
  );
  assert.deepEqual(limit.rules.failures, plain.rules.failures);
  assert.deepEqual(limit.rules.ruleStates, plain.rules.ruleStates);
  const integrity = new ContractError('integrity', [{ path: '', message: 'stub' }]);
  await assert.rejects(
    injected(
      run,
      throwingFor(
        () => true,
        () => integrity,
      ),
    ),
    (error) => error === integrity,
  );
});

void test('concurrency: one and two lanes (the profile maximum) give the same report', async () => {
  const reports = [];
  for (const lanes of [1, 2]) {
    const report = await selectedRun(sourceRun(texts(70), [selected], [lifecycle], { lanes }));
    assert.deepEqual(edited(report.findings), names(64), String(lanes));
    reports.push(portable(report));
  }
  assert.equal(reports[1], reports[0]);
});

void test('internal errors while building fixes share the limit of 64 findings per run', async () => {
  const run = sourceRun(texts(70), [selected], [lifecycle], { lanes: 2 });
  const observed: InternalErrorReport[] = [];
  const { rules } = await injected(
    run,
    throwingFor(
      () => true,
      () => new TypeError(MARKER),
    ),
    observed,
  );
  assert.deepEqual(edited(rules.findings), []);
  const internal = rules.findings.filter((finding) => finding.ruleId === 'engine/internal_error');
  assert.deepEqual(internal.map(findingName), names(64));
  assert.equal(rules.findings.filter((finding) => finding.ruleId === 'a-lifecycle').length, 70);
  assert.equal(rules.failures.filter((row) => row.code === 'internal_error').length, 70);
  assert.equal(observed.length, 64);
  assert(!JSON.stringify(rules).includes(MARKER));
});
