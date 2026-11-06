import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createValidationResult,
  digestJson,
  executeCelRules,
  parseContract,
  resultExitCode,
} from '../src/index.js';
import type {
  JsonValue,
  PolicyBundle,
  RuleExecutionReport,
  RuleSubject,
  ValidationRequest,
} from '../src/index.js';
import { ManagedCelPool } from '../src/runtime/cel/pool.js';
import { URI, makeContext, makeRequest } from './helpers.js';

type CelRule = Extract<PolicyBundle['rules'][number], { kind: 'cel' }>;
function rule(id: string, expression = 'true', overrides: Partial<CelRule> = {}): CelRule {
  return {
    id,
    expression,
    kind: 'cel',
    version: '1',
    mandatory: true,
    severity: 'error',
    requires: [],
    ...overrides,
  };
}

function setup(
  rules: PolicyBundle['rules'],
  deadlineMs = 5000,
  mode: ValidationRequest['execution']['mode'] = 'ci',
) {
  const original = makeContext();
  const policy = parseContract('policy-bundle', { ...original.policy, rules });
  const activation = parseContract('activation-manifest', {
    ...original.activation,
    policyDigest: digestJson(policy),
  });
  const now = Date.now();
  const request = parseContract('validation-request', {
    ...makeRequest(mode),
    execution: { mode, startedAt: now, deadlineAt: now + deadlineMs },
    policy: { digest: digestJson(policy), revision: policy.revision },
    activation: { digest: digestJson(activation), generation: activation.generation },
  });
  return { request, context: { ...original, policy, activation } };
}

function subject(
  id = 'component:default/example',
  value: JsonValue = { spec: { owner: 'platform' } },
): RuleSubject {
  return {
    id,
    value,
    location: {
      uri: URI,
      document: 0,
      path: '',
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
    },
  };
}

function result(request: ReturnType<typeof setup>['request'], report: RuleExecutionReport) {
  return createValidationResult({
    request,
    ...report,
    completedAt: Date.now(),
    authorityCheckedAt: request.execution.startedAt,
  });
}

void test('selectors and expressions use managed CEL and false stays a completed violation', async () => {
  const pool = new ManagedCelPool();
  try {
    await pool.warm();
    const run = setup([
      rule('a', 'entity.spec.[', { selector: 'false' }),
      rule('b', 'false', { selector: 'entity.spec.owner.matches("plat")' }),
      rule('c', 'true'),
    ]);
    const report = await executeCelRules(run.request, run.context, [subject()], { runtime: pool });
    assert.deepEqual(
      report.ruleStates.map((state) => state.status),
      ['not_applicable', 'failed', 'passed'],
    );
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.ruleId, 'b');
    assert.equal(report.interrupted, 'none');
    assert.equal(result(run.request, report).outcome, 'completed');
    assert.equal(resultExitCode(result(run.request, report)), 1);
    assert(Object.isFrozen(report.ruleStates));
  } finally {
    await pool.close();
  }
});

void test('bad selectors, invalid expressions and nonboolean results are invalid policy', async () => {
  const pool = new ManagedCelPool();
  try {
    await pool.warm();
    for (const configured of [
      rule('a', 'true', { selector: 'entity.spec.owner.matches("(?<=a)b")' }),
      rule('a', 'entity.spec.['),
      rule('a', '1 + 1'),
    ]) {
      const run = setup([configured, rule('b', 'true', { requires: ['a'] })]);
      const report = await executeCelRules(run.request, run.context, [subject()], {
        runtime: pool,
      });
      assert.equal(report.ruleStates[0]?.status, 'invalid_policy');
      assert.equal(report.ruleStates[1]?.status, 'blocked');
      assert.equal(report.findings.length, 0);
      assert.equal(result(run.request, report).outcome, 'error');
      assert.equal(resultExitCode(result(run.request, report)), 2);
    }
  } finally {
    await pool.close();
  }
});

void test('failed prerequisites block dependents and unavailable schema rules never pass', async () => {
  const pool = new ManagedCelPool();
  try {
    await pool.warm();
    const run = setup([rule('a', 'false'), rule('b', 'true', { requires: ['a'] }), rule('c')]);
    const report = await executeCelRules(run.request, run.context, [subject()], { runtime: pool });
    assert.deepEqual(
      report.ruleStates.map((state) => state.status),
      ['failed', 'blocked', 'passed'],
    );
    assert.equal(result(run.request, report).outcome, 'incomplete');
    const schemaRule: PolicyBundle['rules'][number] = {
      id: 'schema',
      version: '1',
      kind: 'schema',
      mandatory: true,
      requires: [],
      severity: 'error',
      schema: { id: 'custom', version: '1', digest: digestJson({}) },
    };
    const unsupported = setup([schemaRule]);
    const unavailable = await executeCelRules(
      unsupported.request,
      unsupported.context,
      [subject()],
      { runtime: pool },
    );
    assert(unavailable.coverage.some((entry) => entry.status === 'unavailable'));
    assert.equal(result(unsupported.request, unavailable).outcome, 'incomplete');
    const optional = setup([{ ...schemaRule, mandatory: false }]);
    assert.equal(
      result(
        optional.request,
        await executeCelRules(optional.request, optional.context, [subject()], { runtime: pool }),
      ).outcome,
      'completed',
    );
  } finally {
    await pool.close();
  }
});

void test('a real expensive selector times out with no entity violation and the pool recovers', async () => {
  const pool = new ManagedCelPool();
  try {
    await pool.warm();
    const selector =
      'entity.items.all(x, entity.items.all(y, entity.items.all(z, x == z || x != z)))';
    const run = setup([rule('a', 'false', { selector })]);
    const report = await executeCelRules(
      run.request,
      run.context,
      [subject(undefined, { items: Array.from({ length: 1000 }, (_, index) => index) })],
      { runtime: pool },
    );
    assert.equal(report.ruleStates[0]?.status, 'incomplete');
    assert.equal(report.ruleStates[0]?.reason, 'timeout');
    assert.equal(report.findings.length, 0);
    assert.equal(result(run.request, report).outcome, 'incomplete');
    const next = setup([rule('a')]);
    assert.equal(
      result(
        next.request,
        await executeCelRules(next.request, next.context, [subject()], { runtime: pool }),
      ).outcome,
      'completed',
    );
  } finally {
    await pool.close();
  }
});

void test('whole-request deadline spans multiple successful evaluations and blocks later work', async () => {
  const pool = new ManagedCelPool({
    workers: 1,
    workerUrl: new URL('./fixtures/cel-worker.js', import.meta.url),
  });
  try {
    await pool.warm();
    const run = setup([rule('a', 'delay:55'), rule('b', 'delay:55'), rule('c', 'delay:55')], 90);
    const report = await executeCelRules(run.request, run.context, [subject()], { runtime: pool });
    assert.equal(report.ruleStates[0]?.status, 'passed');
    assert.equal(report.ruleStates[1]?.reason, 'timeout');
    assert.equal(report.ruleStates[2]?.reason, 'timeout');
    assert.equal(report.interrupted, 'timeout');
    assert.equal(resultExitCode(result(run.request, report)), 2);
  } finally {
    await pool.close();
  }
});

void test('request cancellation stops active/queued subjects and IDE enforcement stays advisory', async () => {
  const pool = new ManagedCelPool({
    workers: 1,
    workerUrl: new URL('./fixtures/cel-worker.js', import.meta.url),
  });
  const abort = new AbortController();
  try {
    await pool.warm();
    const run = setup([rule('a', 'hang')], 5000, 'ide');
    const work = executeCelRules(
      run.request,
      run.context,
      [subject('component:default/a'), subject('component:default/b')],
      { runtime: pool, signal: abort.signal },
    );
    abort.abort();
    const report = await work;
    assert(
      report.ruleStates.every(
        (state) => state.status === 'incomplete' && state.reason === 'cancelled',
      ),
    );
    assert.equal(report.interrupted, 'cancelled');
    assert.equal(report.findings.length, 0);
    assert.equal(result(run.request, report).enforcement, 'advisory');
    assert.equal(pool.stats().pending, 0);
  } finally {
    await pool.close();
  }
});

void test('100-entity rule batches snapshot inputs, preserve order and reuse only two workers', async () => {
  const pool = new ManagedCelPool();
  try {
    await pool.warm();
    const run = setup([rule('a', 'entity.value == "original"', { selector: 'has(entity.value)' })]);
    const values = Array.from({ length: 100 }, (_, index) => ({
      id: `component:default/${String(index).padStart(3, '0')}`,
      value: { value: 'original' },
    }));
    const work = executeCelRules(
      run.request,
      run.context,
      values.map((entry) => subject(entry.id, entry.value)),
      { runtime: pool },
    );
    for (const entry of values) entry.value.value = 'changed';
    const report = await work;
    assert.equal(report.ruleStates.length, 100);
    assert(report.ruleStates.every((state) => state.status === 'passed'));
    assert.deepEqual(
      report.ruleStates.map((state) => state.subjectId),
      values.map((entry) => entry.id),
    );
    assert.equal(pool.stats().workerStarts, 2);
    assert.equal(pool.stats().pending, 0);
    assert.equal(result(run.request, report).enforcement, 'allow');
  } finally {
    await pool.close();
  }
});

void test('rule execution rejects swapped pins, duplicate subjects and unresolved inheritance', async () => {
  const pool = new ManagedCelPool();
  try {
    const run = setup([rule('a')]);
    await assert.rejects(
      executeCelRules(
        run.request,
        { ...run.context, policy: { ...run.context.policy, revision: 'changed' } },
        [subject()],
        { runtime: pool },
      ),
      /pinned artifact/,
    );
    await assert.rejects(
      executeCelRules(run.request, run.context, [subject(), subject()], { runtime: pool }),
      /unique/,
    );
    const policy = { ...run.context.policy, extends: [digestJson('baseline')] };
    const activation = { ...run.context.activation, policyDigest: digestJson(policy) };
    const request = {
      ...run.request,
      policy: { digest: digestJson(policy), revision: policy.revision },
      activation: { ...run.request.activation, digest: digestJson(activation) },
    };
    await assert.rejects(
      executeCelRules(request, { ...run.context, policy, activation }, [subject()], {
        runtime: pool,
      }),
      /resolved before/,
    );
    assert.equal(pool.stats().workers, 0);
  } finally {
    await pool.close();
  }
});
