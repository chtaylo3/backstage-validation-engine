import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CelError,
  createValidationResult,
  executePolicyRules,
  resultExitCode,
} from '../src/index.js';
import type { CelRuntime, RuleSubject } from '../src/index.js';
import { CEL_ERROR_MESSAGES } from '../src/runtime/cel/errors.js';
import { ManagedCelPool } from '../src/runtime/cel/pool.js';
import { policyRun } from './harness/policy-fixture.js';
import { makeContext, URI } from './helpers.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_done, fail) => {
        timer = setTimeout(
          () => fail(new Error('Entered scheduling barrier exceeded 10,000 ms.')),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const rule = (id: string, requires: string[] = [], selector?: string) => ({
  id,
  version: '1',
  kind: 'cel' as const,
  mandatory: true,
  severity: 'error' as const,
  requires,
  expression: 'true',
  ...(selector ? { selector } : {}),
});
const subject = (id = 'subject'): RuleSubject => ({
  id,
  value: {},
  location: {
    uri: URI,
    document: 0,
    path: '',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  },
});

// Independently reviewed contract table. Do not compute expectations from failureState.
const failures = [
  ['parse', 'invalid_policy', 'invalid_expression', 'none', 'error'],
  ['profile', 'invalid_policy', 'invalid_expression', 'none', 'error'],
  ['regex', 'invalid_policy', 'invalid_expression', 'none', 'error'],
  ['result_type', 'invalid_policy', 'invalid_expression', 'none', 'error'],
  ['evaluation', 'error', undefined, 'none', 'error'],
  ['input_type', 'error', undefined, 'none', 'error'],
  ['input_limit', 'incomplete', 'resource_limit', 'resource_limit', 'incomplete'],
  ['regex_limit', 'incomplete', 'resource_limit', 'resource_limit', 'incomplete'],
  ['queue_limit', 'incomplete', 'queue_exhausted', 'resource_limit', 'incomplete'],
  ['cancelled', 'incomplete', 'cancelled', 'cancelled', 'incomplete'],
  ['queue_timeout', 'incomplete', 'timeout', 'timeout', 'incomplete'],
  ['request_timeout', 'incomplete', 'timeout', 'timeout', 'incomplete'],
  ['execution_timeout', 'incomplete', 'timeout', 'timeout', 'incomplete'],
  ['worker_start', 'incomplete', 'worker_failure', 'worker_failure', 'incomplete'],
  ['worker_failure', 'incomplete', 'worker_failure', 'worker_failure', 'incomplete'],
  ['protocol', 'incomplete', 'worker_failure', 'worker_failure', 'incomplete'],
  ['closed', 'incomplete', 'worker_failure', 'worker_failure', 'incomplete'],
] as const;

void test('every declared CEL failure crosses executePolicyRules with exact state, required coverage, interruption and exit', async (t) => {
  assert.deepEqual(failures.map(([code]) => code).sort(), Object.keys(CEL_ERROR_MESSAGES).sort());
  const pool = new ManagedCelPool();
  t.after(() => pool.close());
  await pool.warm();
  for (const [code, status, reason, interrupted, outcome] of failures) {
    await t.test(code, async () => {
      const run = policyRun({ mode: 'ci', rules: [rule('a'), rule('b', ['a']), rule('c')] });
      let calls = 0;
      const runtime: CelRuntime = {
        evaluate: () =>
          ++calls === 1 ? Promise.reject(new CelError(code)) : Promise.resolve(true),
        warm: () => pool.warm(),
        close: () => pool.close(),
        stats: () => pool.stats(),
      };
      const report = await executePolicyRules(run.request, run.context, [subject()], { runtime });
      assert.deepEqual(report.ruleStates, [
        {
          ruleId: 'a',
          subjectId: 'subject',
          required: true,
          status,
          ...(reason ? { reason } : {}),
        },
        {
          ruleId: 'b',
          subjectId: 'subject',
          required: true,
          status: 'blocked',
          reason: 'prerequisite_blocked',
        },
        { ruleId: 'c', subjectId: 'subject', required: true, status: 'passed' },
      ]);
      assert.deepEqual(report.coverage, [
        {
          stage: 'rules',
          subject: '["subject","a"]',
          required: true,
          status: 'blocked',
          reason: CEL_ERROR_MESSAGES[code],
        },
        {
          stage: 'rules',
          subject: '["subject","b"]',
          required: true,
          status: 'blocked',
          reason: 'A prerequisite did not pass.',
        },
        { stage: 'rules', subject: '["subject","c"]', required: true, status: 'verified' },
        { stage: 'rules', subject: '["subject"]', required: true, status: 'blocked' },
      ]);
      assert.equal(calls, 2, 'The blocked dependent must never reach the runtime.');
      assert.deepEqual(report.failures, [{ subjectId: 'subject', ruleId: 'a', code }]);
      assert.deepEqual(report.findings, []);
      assert.equal(report.interrupted, interrupted);
      const result = createValidationResult({
        request: run.request,
        ...report,
        completedAt: Date.now(),
        authorityCheckedAt: run.request.execution.startedAt,
      });
      assert.equal(result.outcome, outcome);
      assert.equal(resultExitCode(result), 2);
      const positive = await executePolicyRules(run.request, run.context, [subject()], {
        runtime: pool,
      });
      assert(positive.ruleStates.every((state) => state.status === 'passed'));
      assert(positive.coverage.every((row) => row.required && row.status === 'verified'));
      assert.equal(positive.interrupted, 'none');
      assert.equal(
        resultExitCode(
          createValidationResult({
            request: run.request,
            ...positive,
            completedAt: Date.now(),
            authorityCheckedAt: run.request.execution.startedAt,
          }),
        ),
        0,
      );
    });
  }
});

void test('not_applicable prerequisites block dependents while independent rules still execute', async () => {
  const run = policyRun({
    mode: 'ci',
    rules: [rule('a', [], 'false'), rule('b', ['a']), rule('c')],
  });
  const pool = new ManagedCelPool();
  try {
    await pool.warm();
    const report = await executePolicyRules(run.request, run.context, [subject()], {
      runtime: pool,
    });
    assert.deepEqual(
      report.ruleStates.map(({ status, reason }) => [status, reason]),
      [
        ['not_applicable', undefined],
        ['blocked', 'prerequisite_blocked'],
        ['passed', undefined],
      ],
    );
    assert.deepEqual(
      report.coverage.map(({ required, status }) => [required, status]),
      [
        [true, 'verified'],
        [true, 'blocked'],
        [true, 'verified'],
        [true, 'blocked'],
      ],
    );
    assert.equal(report.interrupted, 'none');
    assert.equal(
      resultExitCode(
        createValidationResult({
          request: run.request,
          ...report,
          completedAt: Date.now(),
          authorityCheckedAt: run.request.execution.startedAt,
        }),
      ),
      2,
    );
  } finally {
    await pool.close();
  }
});

for (const limit of [
  { celWorkers: 1, celOutstandingJobs: 64 },
  { celWorkers: 2, celOutstandingJobs: 1 },
]) {
  void test(`request-specific lane limits ${JSON.stringify(limit)} hold against one shared production pool`, async () => {
    const pool = new ManagedCelPool();
    const gates: (() => void)[] = [];
    const entered = deferred();
    const counts = new Map<string, number>();
    const maxima = new Map<string, number>();
    const requestIds = new Map<string, string>();
    let calls = 0;
    let gateChanged = deferred();
    let releasing = false;
    let completion: Promise<void> | undefined;
    const runtime: CelRuntime = {
      async evaluate(expression, entity, context) {
        assert(entity && typeof entity === 'object' && 'request' in entity);
        assert(entity.request === 'low' || entity.request === 'high');
        const id = entity.request;
        if (requestIds.has(id)) assert.equal(context.requestId, requestIds.get(id));
        else requestIds.set(id, context.requestId);
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        maxima.set(id, Math.max(maxima.get(id) ?? 0, count));
        const gate = deferred();
        gates.push(() => gate.resolve());
        const previous = gateChanged;
        gateChanged = deferred();
        previous.resolve();
        if (releasing) gate.resolve();
        const work = pool.evaluate(expression, entity, context);
        if (++calls === 3) entered.resolve();
        const value = await work;
        await gate.promise;
        counts.set(id, counts.get(id)! - 1);
        return value;
      },
      warm: () => pool.warm(),
      close: () => pool.close(),
      stats: () => pool.stats(),
    };
    try {
      await pool.warm();
      const base = makeContext().profile;
      const low = policyRun({
        mode: 'ci',
        rules: [rule('a')],
        profile: {
          limits: { ...base.limits, ...limit },
        },
      });
      const high = policyRun({ mode: 'ci', rules: [rule('a')] });
      const lowRequest = { ...low.request, run: { ...low.request.run, runId: 'low' } };
      const highRequest = { ...high.request, run: { ...high.request.run, runId: 'high' } };
      const subjects = (request: string) =>
        ['a', 'b', 'c', 'd'].map((id) => ({ ...subject(id), value: { request } }));
      const work = Promise.all([
        executePolicyRules(lowRequest, low.context, subjects('low'), { runtime }),
        executePolicyRules(highRequest, high.context, subjects('high'), { runtime }),
      ]);
      completion = work.then(
        () => undefined,
        () => undefined,
      );
      const stopped = work.then(() => {
        throw new Error('Scheduling completed before the required entry.');
      });
      await within(Promise.race([entered.promise, stopped]));
      assert.deepEqual(Object.fromEntries(counts), { low: 1, high: 2 });
      assert.equal(
        requestIds.get('low'),
        JSON.stringify(['installation-1', 'repository-1', 'low', 'attempt-1', 1]),
      );
      assert.equal(
        requestIds.get('high'),
        JSON.stringify(['installation-1', 'repository-1', 'high', 'attempt-1', 1]),
      );
      assert.equal(pool.stats().workers, 2);
      assert(pool.stats().active <= 2);
      // Release each subsequent entered evaluation through the same gate, without elapsed-time assumptions.
      for (let index = 0; index < 8; index++) {
        if (!gates[index]) await within(Promise.race([gateChanged.promise, stopped]));
        assert(gates[index], 'Each release requires observed entry.');
        gates[index]!();
      }
      const reports = await within(work);
      assert.deepEqual(Object.fromEntries(maxima), { low: 1, high: 2 });
      assert(
        reports.every(
          (report) =>
            report.ruleStates.length === 4 &&
            report.ruleStates.every((state) => state.status === 'passed'),
        ),
      );
      assert.equal(pool.stats().workerStarts, 2);
      assert.equal(pool.stats().pending, 0);
    } finally {
      releasing = true;
      gates.forEach((release) => release());
      try {
        if (completion) await within(completion);
      } finally {
        await pool.close();
      }
    }
  });
}
