import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BudgetAdmissionError,
  CelError,
  ContractError,
  RequestBudget,
  createCatalogProvider,
  digestJson,
  validatePolicySources,
} from '../src/index.js';
import {
  FailureTimer,
  failureCause,
  sanitizeFailureEvidence,
} from '../src/runtime/failure-evidence.js';
import { makeContext } from './helpers.js';
import { policyRun, team } from './harness/policy-fixture.js';
import { ManagedCelPool } from '../src/runtime/cel/pool.js';

void test('pipeline evidence distinguishes a CEL attempt timeout from its request deadline', async (t) => {
  for (const code of ['execution_timeout', 'request_timeout', 'queue_timeout'] as const)
    await t.test(code, async (t) => {
      const runtime = new ManagedCelPool();
      t.after(() => runtime.close());
      t.mock.method(runtime, 'evaluate', () => Promise.reject(new CelError(code)));
      const run = policyRun({
        rules: [
          {
            id: 'required',
            version: '1',
            kind: 'cel',
            expression: 'true',
            mandatory: true,
            severity: 'error',
            requires: [],
          },
        ],
      });
      const report = await validatePolicySources(run.request, run.context, { runtime });
      assert.equal(report.interrupted, 'timeout');
      assert.equal(report.rules.failures[0]?.code, code);
      assert.equal(report.rules.ruleStates[0]?.status, 'incomplete');
      assert.equal(
        report.failureEvidence.find((row) => row.stage === 'rules')?.cause,
        code === 'execution_timeout' ? 'attempt_timeout' : 'request_timeout',
      );
      assert(report.findings.every((finding) => finding.edits.length === 0));
    });
});

void test('a backward wall-clock correction still rejects an out-of-range deadline with typed evidence', (t) => {
  let wall = Date.now();
  t.mock.method(Date, 'now', () => wall);
  const timer = new FailureTimer();
  const deadline = wall + 5000;
  wall -= 20;
  assert.throws(
    () => new RequestBudget(deadline),
    (error: unknown) => {
      assert(error instanceof BudgetAdmissionError);
      assert(error instanceof RangeError);
      const evidence = timer.capture('sources', failureCause(error), deadline);
      assert.equal(evidence.cause, 'deadline_out_of_range');
      assert.equal(evidence.wallElapsedMs, -20);
      assert.equal(evidence.deadlineRemainingMs, 5020);
      assert(evidence.elapsedMs >= 0);
      return true;
    },
  );
  assert.throws(
    () => new RequestBudget(-1),
    (error: unknown) =>
      error instanceof BudgetAdmissionError && error.reason === 'invalid_deadline',
  );
});

void test('an admitted monotonic deadline is not extended by a later wall-clock correction', async (t) => {
  let wall = Date.now();
  t.mock.method(Date, 'now', () => wall);
  using budget = new RequestBudget(wall + 10);
  wall -= 60_000;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert(budget.interrupted);
  assert.equal(failureCause(budget.signal.reason), 'request_timeout');
});

void test('failure evidence copies only fixed codes and bounded timings', () => {
  const evidence = sanitizeFailureEvidence({
    stage: 'catalog_response',
    cause: 'invalid_response',
    elapsedMs: 1_000_000,
    wallElapsedMs: -1_000_000,
    deadlineRemainingMs: 1_000_000,
    message: 'private-source-content',
    credentials: 'private-token',
  });
  assert.deepEqual(evidence, {
    stage: 'catalog_response',
    cause: 'invalid_response',
    elapsedMs: 60_000,
    wallElapsedMs: -60_000,
    deadlineRemainingMs: 60_000,
  });
  assert(Object.isFrozen(evidence));
  assert.equal(sanitizeFailureEvidence({ ...evidence, cause: 'private-token' }), undefined);
  assert.equal(sanitizeFailureEvidence({ ...evidence, elapsedMs: Number.NaN }), undefined);
  assert.equal(failureCause(new Error('private-token')), 'unknown');
});

void test('pipeline exception evidence identifies the stage without exposing raw errors or replacing enforcement', async () => {
  const run = policyRun({ rules: [] });
  const evidence: unknown[] = [];
  await assert.rejects(
    validatePolicySources(
      run.request,
      {
        ...run.context,
        activation: { ...run.context.activation, policyDigest: digestJson({ private: true }) },
      },
      {
        onFailure: (row) => {
          evidence.push(row);
          throw new Error('private-observer-error');
        },
      },
    ),
    (error: unknown) => error instanceof ContractError && error.code === 'integrity',
  );
  assert.equal(evidence.length, 1);
  assert.match(JSON.stringify(evidence), /bindings/);
  assert.match(JSON.stringify(evidence), /integrity/);
  assert(!JSON.stringify(evidence).includes('private'));
});

void test('transport failures and response failures retain distinct safe provider evidence', async (t) => {
  const context = makeContext();
  const access = {
    installationId: 'installation-1',
    principalId: 'reader',
    permissionRevision: '1',
    credentialRevision: '1',
    scope: ['catalog:read'],
    policyDigest: digestJson(context.policy),
    profileDigest: digestJson(context.profile),
    maxAgeMs: 0,
  };
  for (const [kind, expectedCause, expectedStage] of [
    ['offline', 'offline', 'catalog_transport'],
    ['invalid', 'invalid_response', 'catalog_response'],
  ] as const)
    await t.test(kind, async (t) => {
      const provider = await createCatalogProvider({
        connectionId: 'primary',
        baseUrl: 'https://catalog.invalid/api/catalog',
        adapterId: context.profile.adapterId,
        limits: { retries: 0 },
        credentials: () => Promise.resolve({ ...access, token: 'private-credential' }),
        transport: () =>
          kind === 'offline'
            ? Promise.reject(new Error('private-upstream-error'))
            : Promise.resolve(Response.json({ ...team, metadata: { name: 'wrong' } })),
      });
      t.after(() => provider.close());
      const result = await provider.lookup(['group:default/team'], access, {
        deadlineAt: Date.now() + 5000,
      });
      assert.equal(result.data.entries[0]?.status, 'unavailable');
      assert.equal(result.failures[0]?.evidence?.cause, expectedCause);
      assert.equal(result.failures[0]?.evidence?.stage, expectedStage);
      assert(!JSON.stringify(result.failures).includes('private'));
    });
});
