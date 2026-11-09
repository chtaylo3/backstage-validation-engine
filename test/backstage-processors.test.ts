import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKSTAGE_ADAPTER_IDS,
  SUPPORTED_DEPLOYMENT_PROCESSORS,
  closeSharedCelRuntime,
  createSourceSnapshot,
  createValidationResult,
  executePolicyRules,
  parseContract,
  resultExitCode,
  validateBackstageSources,
  validatePolicySources,
} from '../src/index.js';
import type { CelRuntime } from '../src/index.js';
import { URI } from './helpers.js';
import { componentText, policyMatrix, policyRun } from './harness/policy-fixture.js';
const processors = [{ id: 'required-owner-transform', stage: 'pre-validation' }];
const blocked = (options: Parameters<typeof policyRun>[0] = {}) =>
  policyRun({ mode: 'ci', profile: { requiredProcessors: processors }, ...options });
test.after(closeSharedCelRuntime);
void test('BC-07 empty executable inventory blocks every declared stage before speculative source work on both pins', async (t) => {
  assert.deepEqual(SUPPORTED_DEPLOYMENT_PROCESSORS, []);
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    for (const stage of [
      'parse',
      'substitution',
      'normalization',
      'admission',
      'references',
      'post-processing',
      'unknown-stage',
    ])
      await t.test(`${adapterId}/${stage}`, async () => {
        const state = blocked({
          text: 'metadata: [invalid secret-value',
          profile: { adapterId, requiredProcessors: [{ id: 'required', stage }] },
        });
        const report = await validateBackstageSources(state.request, state.context);
        assert.equal(report.entities.length, 0);
        assert.equal(report.artifacts.length, 0);
        assert(report.findings.every((row) => row.category === 'dependency'));
        assert(!JSON.stringify(report.findings).includes('secret-value'));
        for (const stage of ['parse', 'substitution', 'compatibility', 'admission', 'overlay'])
          assert(report.coverage.some((row) => row.stage === stage && row.status === 'blocked'));
        const result = createValidationResult({
          ...report,
          request: state.request,
          completedAt: Date.now(),
          authorityCheckedAt: state.request.execution.startedAt,
        });
        assert.equal(resultExitCode(result), 2);
      });
});
void test('BC-07 empty snapshots and zero rules remain blocked rather than verified empty work', async () => {
  const state = blocked({
    source: createSourceSnapshot({ repository: 'repository', revision: 'empty', files: [] }),
    rules: [],
  });
  const report = await validatePolicySources(state.request, state.context);
  assert(
    report.coverage.some(
      (row) => row.stage === 'rules' && row.required && row.status === 'blocked',
    ),
  );
  assert(!report.coverage.some((row) => row.status === 'verified'));
});
void test('BC-07 composed policy reports aggregate shared processor coverage once and remain incomplete on both native pins', async () => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS) {
    const state = blocked({ profile: { adapterId, requiredProcessors: processors } });
    const report = await validatePolicySources(state.request, state.context);
    const keys = report.coverage.map((row) => JSON.stringify([row.stage, row.subject]));
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(report.coverage.filter((row) => row.status === 'unsupported').length, 1);
    const result = createValidationResult({
      request: report.request,
      coverage: report.coverage,
      findings: report.findings,
      artifacts: report.compatibility.artifacts,
      ruleStates: report.ruleStates,
      interrupted: report.interrupted,
      completedAt: Date.now(),
      authorityCheckedAt: state.request.execution.startedAt,
    });
    assert.equal(result.outcome, 'incomplete');
    assert.equal(resultExitCode(result), 2);
    assert(result.ruleStates.every((row) => row.status === 'blocked'));
  }
});
void test('BC-07 direct normalized rule execution cannot bypass required processing or run CEL', async () => {
  const state = blocked({
    rules: [
      {
        id: 'false-rule',
        version: '1',
        mandatory: true,
        severity: 'error',
        requires: [],
        kind: 'cel',
        expression: 'false',
        selector: 'false',
      },
    ],
  });
  const noRuntime: CelRuntime = {
    evaluate: () => {
      throw new Error('must not run');
    },
    warm: () => Promise.reject(new Error('must not run')),
    close: () => Promise.resolve(),
    stats: () => ({ workers: 0, active: 0, queued: 0, pending: 0, workerStarts: 0, closed: false }),
  };
  const report = await executePolicyRules(
    state.request,
    state.context,
    [
      {
        id: 'subject',
        value: {},
        location: {
          uri: URI,
          document: 0,
          path: '',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      },
    ],
    { runtime: noRuntime },
  );
  assert.equal(report.ruleStates[0]?.status, 'blocked');
  assert.equal(report.failures[0]?.code, 'unsupported_processor');
});
void test('BC-07 source and baseline gates never start HTTP on both fixture versions', async (t) => {
  const matrix = await policyMatrix(t);
  for (const [index, entry] of matrix.fixtures.entries())
    await t.test(entry.target.backstageVersion, async () => {
      const baseline = createSourceSnapshot({
        repository: 'repository',
        revision: 'base',
        files: [{ uri: URI, text: componentText() }],
      });
      const state = blocked({ source: baseline, baseline });
      const report = await validatePolicySources(state.request, state.context, {
        catalog: await matrix.catalog(state, index),
      });
      assert.equal(entry.fixture.requests().length, 0);
      assert(report.ruleStates.every((row) => row.status === 'blocked'));
      assert(report.findings.every((row) => row.category === 'dependency'));
    });
});
void test('BC-07 cancellation/deadlines and profile binding still take precedence', async () => {
  const state = blocked();
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
  await assert.rejects(
    validateBackstageSources(state.request, {
      ...state.context,
      profile: { ...state.context.profile, requiredProcessors: [] },
    }),
    /pinned artifact/,
  );
});
