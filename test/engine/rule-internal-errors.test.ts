import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { test } from 'node:test';
import {
  canonicalJson,
  ContractError,
  createValidationResult,
  executePolicyRules,
  formatSarif,
  parseContract,
  resultExitCode,
  validatePolicySources,
} from '../../src/index.js';
import type { CelRuntime, Immutable, PolicyBundle, RuleExecutionReport } from '../../src/index.js';
import type { InternalErrorReport } from '../../src/core/internal-errors.js';
import { CelError } from '../../src/runtime/cel/errors.js';
import type { CelErrorCode } from '../../src/runtime/cel/errors.js';
import type { FailureEvidence } from '../../src/runtime/failure-evidence.js';
import { policyRun } from '../harness/policy-fixture.js';
import {
  clock,
  componentDocument,
  componentName,
  controlledRuntime,
  directSubjects,
  findingName,
  ORDERS,
  sourceRun,
  T0,
  until,
} from '../harness/rule-stage-fixture.js';
import type { Answer, SettleOrder } from '../harness/rule-stage-fixture.js';

type Rule = PolicyBundle['rules'][number];
const cel = (id: string, patch: Partial<Rule> = {}): Rule =>
  ({
    id,
    version: '1',
    kind: 'cel',
    mandatory: true,
    severity: 'error',
    requires: [],
    expression: id,
    ...patch,
  }) as Rule;
const RULES = [cel('r1'), cel('r2'), cel('r3')];
const MARKER = 'MARKER-entity-content-91c2';
const integrity = () => new ContractError('integrity', [{ path: '/x', message: MARKER }]);

/** A direct rule-stage run on the fixed clock over `count` subjects named `s-000`, ... */
function directRun(
  rules: readonly Rule[],
  options: { readonly mode?: 'ci' | 'ide'; readonly lanes?: number } = {},
) {
  const base = policyRun();
  const run = policyRun({
    mode: options.mode ?? 'ci',
    rules,
    profile: {
      limits: { ...base.context.profile.limits, celWorkers: options.lanes ?? 2 },
    },
  });
  const request = parseContract('validation-request', {
    ...run.request,
    execution: { ...run.request.execution, startedAt: T0, deadlineAt: T0 + 5000 },
  });
  return { request, context: run.context };
}
async function execute(
  run: ReturnType<typeof directRun>,
  count: number,
  answer: Answer,
  settle: SettleOrder = 'descending',
  observed?: InternalErrorReport[],
) {
  const { runtime, calls } = controlledRuntime(answer, settle);
  const report = await executePolicyRules(run.request, run.context, directSubjects(count), {
    runtime,
    clock: clock(),
    ...(observed ? { onInternalError: (report) => observed.push(report) } : {}),
  });
  return { report, calls };
}
/** The outcome and exit code of a rule-stage report on its own. */
function outcome(run: ReturnType<typeof directRun>, report: RuleExecutionReport) {
  const result = createValidationResult({
    request: run.request,
    coverage: report.coverage,
    findings: report.findings,
    ruleStates: report.ruleStates,
    interrupted: report.interrupted,
    completedAt: T0,
    authorityCheckedAt: T0,
  });
  return { result, exit: resultExitCode(result) };
}
const throwsAt =
  (name: string, expression: string, error: () => Error, otherwise: Answer = () => true): Answer =>
  (evaluation) =>
    evaluation.name === name && evaluation.expression === expression
      ? { throws: error() }
      : otherwise(evaluation);
const pair = (report: RuleExecutionReport, name: string, ruleId: string) => ({
  state: report.ruleStates.find((state) => state.ruleId === ruleId && findingName(state) === name),
  coverage: report.coverage.find((row) => row.subject === JSON.stringify([idOf(name), ruleId])),
  findings: report.findings.filter(
    (finding) => finding.ruleId === ruleId && findingName(finding) === name,
  ),
});
const idOf = (name: string) =>
  directSubjects(100).find((subject) => findingName({ subjectId: subject.id }) === name)!.id;

// Contract errors

void test('a contract error from rule evaluation rejects the run with that error', async () => {
  for (const code of ['integrity', 'invalid_contract', 'invalid_policy'] as const) {
    const failure = new ContractError(code, [{ path: '/x', message: 'stub' }]);
    await assert.rejects(
      execute(
        directRun(RULES),
        3,
        throwsAt(componentName(1), 'r2', () => failure),
      ),
      (error) => error === failure,
      code,
    );
  }
});

void test('a limit contract error is contained as a resource limit, exactly like a CEL input limit', async () => {
  const run = directRun(RULES);
  const plain = await execute(run, 3, () => true);
  const limited = await execute(
    run,
    3,
    throwsAt(
      componentName(1),
      'r2',
      () => new ContractError('limit', [{ path: '', message: MARKER }]),
    ),
  );
  const input = await execute(
    run,
    3,
    throwsAt(componentName(1), 'r2', () => new CelError('input_limit')),
  );
  const crashed = pair(limited.report, componentName(1), 'r2');
  assert.deepEqual(
    [crashed.state?.status, crashed.state?.reason, crashed.coverage?.status],
    ['incomplete', 'resource_limit', 'blocked'],
  );
  assert.equal(limited.report.interrupted, 'resource_limit');
  assert.deepEqual(limited.report, input.report);
  for (const name of [componentName(0), componentName(2)])
    for (const rule of RULES)
      assert.deepEqual(pair(limited.report, name, rule.id), pair(plain.report, name, rule.id));
  assert(!JSON.stringify(limited.report).includes(MARKER));
});

void test('through the composition a contract error reaches onFailure once with the rules stage', async () => {
  const run = sourceRun([componentDocument(0), componentDocument(1)], [cel('r1')], []);
  const { runtime } = controlledRuntime(throwsAt(componentName(1), 'r1', integrity));
  const evidence: FailureEvidence[] = [];
  await assert.rejects(
    validatePolicySources(run.request, run.context, {
      runtime,
      clock: clock(),
      onFailure: (row) => evidence.push(row),
    }),
    (error) => error instanceof ContractError && error.code === 'integrity',
  );
  assert.deepEqual(
    evidence.map((row) => [row.stage, row.cause]),
    [['rules', 'integrity']],
  );
});

/** A runtime whose evaluations wait until the test settles each one by hand. */
function manualRuntime() {
  const waiting: {
    readonly name: string;
    readonly expression: string;
    readonly resolve: (value: boolean) => void;
    readonly reject: (error: Error) => void;
  }[] = [];
  const calls: string[] = [];
  const runtime = {
    evaluate: (expression: string, entity: unknown) =>
      new Promise<boolean>((resolve, reject) => {
        const name = (entity as { metadata: { name: string } }).metadata.name;
        calls.push(`${name}/${expression}`);
        waiting.push({ name, expression, resolve, reject });
      }),
    warm: () => Promise.resolve(),
    close: () => Promise.resolve(),
    stats: () => ({ workers: 0, active: 0, queued: 0, pending: 0, workerStarts: 0, closed: false }),
  } satisfies CelRuntime;
  const take = (name: string) => {
    const index = waiting.findIndex((row) => row.name === name);
    assert.notEqual(index, -1, name);
    return waiting.splice(index, 1)[0]!;
  };
  return { runtime, calls, waiting, take };
}

void test('lanes stop: in-flight work settles, no further rule or subject starts, then the run rejects', async () => {
  const run = directRun([cel('r1'), cel('r2')], { lanes: 2 });
  const manual = manualRuntime();
  let settled = false;
  const pending = executePolicyRules(run.request, run.context, directSubjects(4), {
    runtime: manual.runtime,
    clock: clock(),
  }).finally(() => {
    settled = true;
  });
  pending.catch(() => undefined);
  await until(() => manual.waiting.length === 2);
  const failure = integrity();
  manual.take(componentName(0)).reject(failure);
  for (let index = 0; index < 20; index++) await turn();
  assert.equal(settled, false, 'the run waits for the evaluation in flight');
  assert.deepEqual(manual.calls, ['s-000/r1', 's-001/r1']);
  manual.take(componentName(1)).resolve(true);
  for (let index = 0; index < 20 && !settled; index++) await turn();
  // No evaluation is left waiting: no rule of B and no later subject started.
  assert.deepEqual(manual.calls, ['s-000/r1', 's-001/r1']);
  assert.equal(manual.waiting.length, 0);
  assert.equal(settled, true);
  await assert.rejects(pending, (error) => error === failure);
});

void test('the first propagating error wins', async () => {
  const run = directRun([cel('r1')], { lanes: 2 });
  const manual = manualRuntime();
  let settled = false;
  const pending = executePolicyRules(run.request, run.context, directSubjects(4), {
    runtime: manual.runtime,
    clock: clock(),
  }).finally(() => {
    settled = true;
  });
  pending.catch(() => undefined);
  await until(() => manual.waiting.length === 2);
  const first = new ContractError('invalid_policy', [{ path: '/a', message: 'first' }]);
  const second = new ContractError('integrity', [{ path: '/b', message: 'second' }]);
  manual.take(componentName(1)).reject(first);
  for (let index = 0; index < 5; index++) await turn();
  manual.take(componentName(0)).reject(second);
  for (let index = 0; index < 20 && !settled; index++) await turn();
  assert.equal(settled, true);
  await assert.rejects(pending, (error) => error === first);
});

// Unknown errors

void test('an unknown error gives the rule the state error, blocked coverage and an internal_error failure', async () => {
  const { report } = await execute(
    directRun(RULES),
    3,
    throwsAt(componentName(1), 'r2', () => new TypeError(MARKER)),
  );
  const crashed = pair(report, componentName(1), 'r2');
  assert.deepEqual(crashed.state, {
    ruleId: 'r2',
    subjectId: idOf(componentName(1)),
    required: true,
    status: 'error',
  });
  assert.equal(crashed.coverage?.status, 'blocked');
  assert.equal(crashed.coverage?.reason, 'An internal error occurred while evaluating this rule.');
  assert.deepEqual(report.failures, [
    { subjectId: idOf(componentName(1)), ruleId: 'r2', code: 'internal_error' },
  ]);
  assert(!JSON.stringify(report).includes('worker_failure'));
  assert.equal(report.interrupted, 'none');
});

void test('an unknown error adds one engine/internal_error finding with the fixed fields', async () => {
  for (const mode of ['ci', 'ide'] as const) {
    const { report } = await execute(
      directRun(RULES, { mode }),
      3,
      throwsAt(componentName(1), 'r2', () => new TypeError(MARKER)),
    );
    const subject = directSubjects(3)[1]!;
    assert.equal(report.findings.length, 1, mode);
    const finding = report.findings[0]!;
    assert.deepEqual(
      [
        finding.ruleId,
        finding.ruleVersion,
        finding.subjectId,
        finding.category,
        finding.severity,
        finding.enforcement,
        finding.relatedLocations,
        finding.edits,
      ],
      [
        'engine/internal_error',
        'r2@1',
        subject.id,
        'execution',
        'error',
        mode === 'ci' ? 'blocking' : 'advisory',
        [],
        [],
      ],
      mode,
    );
    assert.deepEqual(finding.location, subject.location);
    assert.match(finding.message, /evaluating rule `r2`/u);
    assert.match(finding.message, /\bTypeError\b/u);
    assert.match(finding.message, /fault in the validation engine/u);
  }
});

void test('redaction: the thrown message appears in no result, SARIF or evidence; the observer gets the error', async () => {
  const run = sourceRun(
    [componentDocument(0), componentDocument(1)],
    [cel('r1'), cel('r2', { mandatory: false, severity: 'warning' })],
    [],
  );
  const failure = new TypeError(MARKER);
  const { runtime } = controlledRuntime(throwsAt(componentName(1), 'r2', () => failure));
  const observed: InternalErrorReport[] = [];
  const evidence: FailureEvidence[] = [];
  const report = await validatePolicySources(run.request, run.context, {
    runtime,
    clock: clock(),
    onInternalError: (row) => observed.push(row),
    onFailure: (row) => evidence.push(row),
  });
  const result = createValidationResult({
    request: report.request,
    coverage: report.coverage,
    findings: report.findings,
    ruleStates: report.ruleStates,
    interrupted: report.interrupted,
    completedAt: T0,
    authorityCheckedAt: T0,
  });
  for (const text of [
    JSON.stringify(report),
    JSON.stringify(result),
    JSON.stringify(formatSarif(result)),
    JSON.stringify(evidence),
  ])
    assert(!text.includes(MARKER));
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.error, failure);
  assert.deepEqual(
    { ...observed[0], error: undefined },
    {
      stage: 'rules',
      activity: 'rule_evaluation',
      ruleId: 'r2',
      subjectId: report.ruleStates.find((state) => state.status === 'error')?.subjectId,
      location: report.findings.find((finding) => finding.ruleId === 'engine/internal_error')
        ?.location,
      error: undefined,
    },
  );
});

void test('the rest of the run continues: the other eight rule results equal a run without the crash', async () => {
  const run = directRun(RULES);
  // Some ordinary failures, so that findings are compared as well as states.
  const verdict: Answer = ({ name, expression }) =>
    !(name === componentName(2) && expression !== 'r2');
  const plain = await execute(run, 3, verdict);
  const { report } = await execute(
    run,
    3,
    throwsAt(componentName(1), 'r2', () => new TypeError(MARKER), verdict),
  );
  for (const name of [0, 1, 2].map(componentName))
    for (const rule of RULES) {
      if (name === componentName(1) && rule.id === 'r2') continue;
      assert.deepEqual(pair(report, name, rule.id), pair(plain.report, name, rule.id));
    }
  assert.equal(pair(report, componentName(1), 'r2').state?.status, 'error');
});

void test('a rule that requires the crashed rule is blocked; an independent rule is evaluated', async () => {
  const rules = [cel('r1'), cel('r2'), cel('r3', { requires: ['r2'] }), cel('r4')];
  const { report, calls } = await execute(
    directRun(rules),
    2,
    throwsAt(componentName(1), 'r2', () => new TypeError(MARKER)),
  );
  const dependent = pair(report, componentName(1), 'r3');
  assert.deepEqual(
    [dependent.state?.status, dependent.state?.reason, dependent.coverage?.status],
    ['blocked', 'prerequisite_blocked', 'blocked'],
  );
  assert.equal(pair(report, componentName(1), 'r4').state?.status, 'passed');
  assert(calls.some((call) => call.name === componentName(1) && call.expression === 'r4'));
  assert(!calls.some((call) => call.name === componentName(1) && call.expression === 'r3'));
});

void test('a crash fails the run: outcome error and exit code 2 for a required and an optional rule', async () => {
  for (const mandatory of [true, false]) {
    const run = directRun([
      cel('r1'),
      cel('r2', { mandatory, severity: mandatory ? 'error' : 'warning' }),
    ]);
    const { report } = await execute(
      run,
      3,
      throwsAt(componentName(1), 'r2', () => new TypeError(MARKER)),
    );
    const { result, exit } = outcome(run, report);
    assert.deepEqual([result.outcome, exit], ['error', 2], `mandatory ${mandatory}`);
  }
});

void test('a crash and an ordinary violation are both reported and the outcome is error', async () => {
  const run = directRun(RULES);
  const { report } = await execute(
    run,
    2,
    throwsAt(
      componentName(1),
      'r2',
      () => new TypeError(MARKER),
      ({ name, expression }) => !(name === componentName(0) && expression === 'r3'),
    ),
  );
  assert.deepEqual(
    report.findings.map((finding) => [findingName(finding), finding.ruleId]),
    [
      [componentName(0), 'r3'],
      [componentName(1), 'engine/internal_error'],
    ],
  );
  const { result } = outcome(run, report);
  assert.equal(result.outcome, 'error');
  const sarif = formatSarif(result).runs[0]!;
  assert.equal(sarif.invocations[0]?.executionSuccessful, false);
  assert.deepEqual(
    sarif.results.map((row) => row.ruleId),
    ['r3', 'engine/internal_error'],
  );
  const notifications = sarif.invocations[0]?.toolExecutionNotifications ?? [];
  const specific = notifications.filter((row) => 'descriptor' in row);
  assert.equal(specific.length, 1);
  assert.deepEqual(
    specific.map((row) => [row.level, row.descriptor.id, row.message.text]),
    [['error', 'engine/internal_error', report.findings[1]!.message]],
  );
  assert.equal(notifications.length, 2, 'the generic notification is kept');
});

void test('determinism and the limit: 64 of 70 crashes receive a finding, in sorted subject order', async () => {
  const run = directRun([cel('r1')]);
  const reports: string[] = [];
  for (const settle of ORDERS) {
    const observed: InternalErrorReport[] = [];
    const { report } = await execute(
      run,
      70,
      () => ({ throws: new TypeError(MARKER) }),
      settle,
      observed,
    );
    assert.equal(report.ruleStates.length, 70);
    assert(report.ruleStates.every((state) => state.status === 'error'));
    assert.equal(report.failures.length, 70);
    assert.deepEqual(
      report.findings.map(findingName),
      Array.from({ length: 64 }, (_, index) => componentName(index)),
    );
    assert.equal(observed.length, 64);
    assert.deepEqual(
      observed.map((row) => (row.stage === 'rules' ? findingName(row) : '')),
      Array.from({ length: 64 }, (_, index) => componentName(index)),
    );
    reports.push(canonicalJson(report));
  }
  assert.equal(reports[1], reports[0]);
  assert.equal(reports[2], reports[0]);
});

void test('an observer that throws does not change the report', async () => {
  const run = directRun(RULES);
  const answer = throwsAt(componentName(1), 'r2', () => new TypeError(MARKER));
  const plain = await execute(run, 3, answer);
  const { runtime } = controlledRuntime(answer, 'descending');
  const report = await executePolicyRules(run.request, run.context, directSubjects(3), {
    runtime,
    clock: clock(),
    onInternalError: () => {
      throw new Error('observer');
    },
  });
  assert.deepEqual(report, plain.report);
});

void test('through the composition an internal error adds one rules evidence row with the cause unknown', async () => {
  const run = sourceRun([componentDocument(0), componentDocument(1)], RULES, []);
  const { runtime } = controlledRuntime(
    throwsAt(componentName(0), 'r3', () => new RangeError(MARKER)),
  );
  const report = await validatePolicySources(run.request, run.context, {
    runtime,
    clock: clock(),
  });
  assert.deepEqual(
    report.failureEvidence.filter((row) => row.stage === 'rules').map((row) => row.cause),
    ['unknown'],
  );
  assert.equal(
    report.findings.filter((finding) => finding.ruleId === 'engine/internal_error').length,
    1,
  );
});

void test('every CEL failure code produces what it produced before', async () => {
  const expected: Record<string, readonly [CelErrorCode, string, string | undefined, string]> = {
    invalid_expression: ['parse', 'invalid_policy', 'invalid_expression', 'none'],
    evaluation: ['evaluation', 'error', undefined, 'none'],
    resource_limit: ['input_limit', 'incomplete', 'resource_limit', 'resource_limit'],
    queue: ['queue_limit', 'incomplete', 'queue_exhausted', 'resource_limit'],
    cancelled: ['cancelled', 'incomplete', 'cancelled', 'cancelled'],
    timeout: ['request_timeout', 'incomplete', 'timeout', 'timeout'],
    worker: ['worker_failure', 'incomplete', 'worker_failure', 'worker_failure'],
  };
  for (const [name, [code, status, reason, interrupted]] of Object.entries(expected)) {
    const { report } = await execute(directRun([cel('r1')]), 1, () => ({
      throws: new CelError(code),
    }));
    const row = pair(report, componentName(0), 'r1');
    assert.deepEqual(
      [row.state?.status, row.state?.reason, row.coverage?.status, row.coverage?.reason],
      [status, reason, 'blocked', new CelError(code).message],
      name,
    );
    assert.deepEqual(report.failures, [{ subjectId: idOf(componentName(0)), ruleId: 'r1', code }]);
    assert.equal(report.interrupted, interrupted, name);
    assert.deepEqual(report.findings, [], name);
  }
});

void test('a thrown non-Error value is contained and named by its type', async () => {
  const run = directRun([cel('r1')]);
  const runtime = {
    ...controlledRuntime(() => true).runtime,
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    evaluate: () => Promise.reject(MARKER),
  } satisfies CelRuntime;
  const report: Immutable<RuleExecutionReport> = await executePolicyRules(
    run.request,
    run.context,
    directSubjects(1),
    { runtime, clock: clock() },
  );
  assert.equal(report.ruleStates[0]?.status, 'error');
  assert.match(report.findings[0]!.message, /non-Error string/u);
  assert(!JSON.stringify(report).includes(MARKER));
});
