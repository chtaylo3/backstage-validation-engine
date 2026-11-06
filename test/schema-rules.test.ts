import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  BACKSTAGE_ADAPTER_IDS,
  closeSharedCelRuntime,
  createValidationResult,
  digestJson,
  executePolicyRules,
  parseContract,
  resultExitCode,
  validatePolicySources,
} from '../src/index.js';
import type { PolicyBundle } from '../src/index.js';
import { schemaArtifact } from './harness/custom-kind-fixture.js';
import { componentText, policyRun } from './harness/policy-fixture.js';
import { URI } from './helpers.js';

const artifact = schemaArtifact({
  type: 'object',
  required: ['spec'],
  properties: {
    spec: {
      type: 'object',
      required: ['lifecycle'],
      properties: {
        lifecycle: { const: 'production' },
        owner: { type: 'string', default: 'no-insertion' },
      },
    },
  },
});
const rule: PolicyBundle['rules'][number] = {
  id: 'production-only',
  version: '1',
  kind: 'schema',
  mandatory: true,
  severity: 'error',
  requires: [],
  schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
};
after(closeSharedCelRuntime);

function result(run: Awaited<ReturnType<typeof validatePolicySources>>) {
  return createValidationResult({
    request: run.request,
    findings: run.findings,
    coverage: run.coverage,
    ruleStates: run.ruleStates,
    completedAt: Date.now(),
    authorityCheckedAt: run.request.execution.startedAt,
    interrupted: run.interrupted,
  });
}

void test('schema policies validate normalized native entities on both adapters with precise source findings', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    await t.test(adapterId, async () => {
      for (const valid of [true, false]) {
        const run = policyRun({
          mode: 'ci',
          profile: { adapterId },
          rules: [rule],
          schemaArtifacts: [artifact],
          text: componentText().replace('production', valid ? 'production' : 'experimental'),
        });
        const report = await validatePolicySources(run.request, run.context);
        assert.equal(report.ruleStates[0]?.status, valid ? 'passed' : 'failed');
        assert.equal(resultExitCode(result(report)), valid ? 0 : 1);
        if (!valid) {
          assert.equal(report.findings[0]?.location.path, '/spec/lifecycle');
          assert.equal(report.findings[0]?.location.range.start.line, 5);
          assert.equal(report.findings[0]?.location.range.start.character, 13);
          assert.equal(report.findings[0]?.category, 'policy');
        }
      }
    });
});

void test('schema rule findings preserve included file locations and inclusion sites', async () => {
  const included = 'file:///workspace/spec.yaml';
  const run = policyRun({
    mode: 'ci',
    rules: [rule],
    schemaArtifacts: [artifact],
    rootUri: 'file:///workspace/',
    entrypoints: [URI],
    text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service}\nspec: {$yaml: ./spec.yaml}\n',
    files: [
      {
        uri: included,
        text: 'type: service\nlifecycle: experimental\nowner: team\n',
        origin: 'buffer',
        version: 7,
      },
    ],
  });
  const report = await validatePolicySources(run.request, run.context);
  const finding = report.findings.find((entry) => entry.ruleId === rule.id);
  assert.equal(finding?.location.uri, included);
  assert.equal(finding?.location.path, '/lifecycle');
  assert.equal(finding?.location.range.start.line, 1);
  assert(finding?.relatedLocations.some((entry) => entry.uri === URI));
});

void test('missing schema artifacts are incomplete dependency warnings while false selectors skip evaluation', async () => {
  for (const mode of ['ci', 'ide'] as const) {
    const run = policyRun({ mode, rules: [rule] });
    const report = await validatePolicySources(run.request, run.context);
    assert.equal(report.ruleStates[0]?.status, 'incomplete');
    assert.equal(result(report).outcome, 'incomplete');
    assert.equal(report.findings[0]?.category, 'dependency');
    assert.equal(report.findings[0]?.severity, mode === 'ide' ? 'warning' : 'error');
  }
  const skipped = policyRun({ rules: [{ ...rule, selector: 'false' }] });
  const report = await validatePolicySources(skipped.request, skipped.context);
  assert.equal(report.ruleStates[0]?.status, 'not_applicable');
  assert.equal(report.findings.length, 0);
  assert.equal(result(report).outcome, 'completed');
});

void test('schema prerequisites block dependents and selectors/invalid pins retain normal policy semantics', async () => {
  const run = policyRun({
    mode: 'ci',
    text: componentText().replace('production', 'development'),
    rules: [
      rule,
      {
        id: 'dependent',
        version: '1',
        kind: 'cel',
        expression: 'true',
        mandatory: true,
        severity: 'error',
        requires: [rule.id],
      },
    ],
    schemaArtifacts: [artifact],
  });
  const report = await validatePolicySources(run.request, run.context);
  assert.deepEqual(
    report.ruleStates.map((row) => row.status),
    ['failed', 'blocked'],
  );
  assert.equal(resultExitCode(result(report)), 2);
  const bad = policyRun({
    rules: [{ ...rule, schema: { ...rule.schema, digest: digestJson(false) } }],
    schemaArtifacts: [artifact],
  });
  await assert.rejects(validatePolicySources(bad.request, bad.context), /does not match/);
});

void test('schema execution does not coerce types, insert defaults, mutate subjects, or reset deadlines', async () => {
  const run = policyRun({ mode: 'ci', rules: [rule], schemaArtifacts: [artifact] });
  const subject = {
    id: 'raw',
    value: { spec: { lifecycle: 123 } },
    location: {
      uri: URI,
      document: 0,
      path: '',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    },
  };
  const before = structuredClone(subject);
  const report = await executePolicyRules(run.request, run.context, [subject]);
  assert.equal(report.ruleStates[0]?.status, 'failed');
  assert.deepEqual(subject, before);
  const expired = parseContract('validation-request', {
    ...run.request,
    execution: { mode: 'ci', startedAt: Date.now() - 6000, deadlineAt: Date.now() - 1000 },
  });
  const stopped = await executePolicyRules(expired, run.context, [subject]);
  assert.equal(stopped.interrupted, 'timeout');
  assert.equal(stopped.findings.length, 0);
  const cancellation = new AbortController();
  cancellation.abort();
  const cancelled = await executePolicyRules(run.request, run.context, [subject], {
    signal: cancellation.signal,
  });
  assert.equal(cancelled.interrupted, 'cancelled');
});
