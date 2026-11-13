import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKSTAGE_ADAPTER_IDS,
  closeSharedCelRuntime,
  createValidationResult,
  executePolicyRules,
  parseContract,
  prepareBackstageReferenceData,
  resultExitCode,
  validatePolicySources,
} from '../../src/index.js';
import {
  componentText,
  localTeam,
  ownerRule,
  policyMatrix,
  policyRun,
} from '../harness/policy-fixture.js';

test.after(closeSharedCelRuntime);

void test('explicit catalog rules consume pinned facts on both backend contracts and both native models', async (t) => {
  const matrix = await policyMatrix(t);
  for (const [index, entry] of matrix.fixtures.entries())
    for (const adapterId of BACKSTAGE_ADAPTER_IDS)
      await t.test(`${entry.target.backstageVersion}/${adapterId}`, async () => {
        for (const [owner, expected] of [
          ['team', 'passed'],
          ['missing', 'failed'],
        ] as const) {
          const run = policyRun({ text: componentText(owner), profile: { adapterId } });
          const report = await validatePolicySources(run.request, run.context, {
            catalog: await matrix.catalog(run, index),
          });
          assert.equal(report.rules.ruleStates[0]?.status, expected);
          assert.equal(report.findings.length, expected === 'failed' ? 1 : 0);
          if (expected === 'failed') {
            const finding = report.findings[0]!;
            assert.equal(finding.location.path, '/spec/owner');
            assert.equal(finding.location.range.start.line, 6);
            assert.equal(finding.category, 'policy');
            assert.equal(finding.enforcement, 'advisory');
          }
          assert.equal(report.interrupted, 'none');
        }
      });
});

void test('catalog unavailable/permission-denied rules remain incomplete and cannot produce missing findings', async (t) => {
  const matrix = await policyMatrix(t);
  for (const status of [401, 403, 503] as const) {
    const run = policyRun({ mode: 'ci' });
    matrix.fixtures[0]!.fixture.failNext({ operation: 'byName' }, { kind: 'status', status });
    const report = await validatePolicySources(run.request, run.context, {
      catalog: await matrix.catalog(run),
    });
    assert.equal(report.rules.ruleStates[0]?.status, 'incomplete');
    assert.equal(report.findings[0]?.category, 'dependency');
    assert.equal(report.findings[0]?.enforcement, 'blocking');
    const result = createValidationResult({
      request: report.request,
      ...report.rules,
      coverage: report.coverage,
      findings: report.findings,
      completedAt: Date.now(),
      authorityCheckedAt: report.request.execution.startedAt,
    });
    assert.equal(result.outcome, 'incomplete');
    assert.equal(resultExitCode(result), 2);
  }
});

void test('a confirmed missing mandatory reference fails CI while IDE findings stay advisory', async (t) => {
  const matrix = await policyMatrix(t);
  const run = policyRun({ mode: 'ci', text: componentText('missing') });
  const report = await validatePolicySources(run.request, run.context, {
    catalog: await matrix.catalog(run),
  });
  const result = createValidationResult({
    request: report.request,
    ...report.rules,
    coverage: report.coverage,
    findings: report.findings,
    completedAt: Date.now(),
    authorityCheckedAt: report.request.execution.startedAt,
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(resultExitCode(result), 1);
});

void test('policy-selected contexts bound provider I/O; unbound contexts remain native-only', async (t) => {
  const matrix = await policyMatrix(t);
  const run = policyRun({ text: componentText('team', '  providesApis: [missing]\n') });
  const report = await validatePolicySources(run.request, run.context, {
    catalog: await matrix.catalog(run),
  });
  assert.equal(report.findings.length, 0);
  assert.deepEqual(
    report.preparation?.observations.map((row) => row.targetRef),
    ['group:default/team'],
  );
  const noRules = policyRun({
    rules: [
      {
        id: 'owner-required',
        version: '1',
        kind: 'cel',
        expression: 'has(entity.spec.owner)',
        mandatory: true,
        severity: 'error',
        requires: [],
      },
    ],
  });
  await validatePolicySources(noRules.request, noRules.context, {
    catalog: await matrix.catalog(noRules),
  });
  assert.equal(matrix.fixtures[0]!.fixture.requests().length, 1);
});

void test('unconfigured external dependencies warn while qualified local targets need no API', async () => {
  for (const files of [[], [localTeam]]) {
    const run = policyRun({ files });
    const report = await validatePolicySources(run.request, run.context);
    if (files.length) {
      assert.equal(report.rules.ruleStates[0]?.status, 'passed');
      assert.deepEqual(report.findings, []);
      continue;
    }
    assert.equal(report.rules.ruleStates[0]?.status, 'incomplete');
    const finding = report.findings.find((row) => row.ruleId === ownerRule.id)!;
    assert.equal(finding.category, 'dependency');
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.location.path, '/spec/owner');
  }
});

void test('catalog binding requires an exact declared context before provider access', async (t) => {
  const matrix = await policyMatrix(t);
  const run = policyRun({ rules: [{ ...ownerRule, referencePath: '/spec/unknown' }] });
  await assert.rejects(
    validatePolicySources(run.request, run.context, { catalog: await matrix.catalog(run) }),
    /declared reference context/,
  );
  assert.equal(matrix.fixtures[0]!.fixture.requests().length, 0);
});

void test('catalog selectors, wildcard occurrences, absent fields and DAG dependencies retain rule semantics', async (t) => {
  const matrix = await policyMatrix(t);
  const run = policyRun({
    text: componentText('team', '  providesApis: [missing, missing]\n'),
    rules: [
      { ...ownerRule, id: 'skip', selector: 'false' },
      { ...ownerRule, id: 'api', referencePath: '/spec/providesApis/*' },
      { ...ownerRule, id: 'absent', referencePath: '/spec/system' },
      { ...ownerRule, id: 'dependent', requires: ['api'] },
    ],
  });
  const report = await validatePolicySources(run.request, run.context, {
    catalog: await matrix.catalog(run),
  });
  assert.deepEqual(Object.fromEntries(report.ruleStates.map((row) => [row.ruleId, row.status])), {
    absent: 'not_applicable',
    api: 'failed',
    dependent: 'blocked',
    skip: 'not_applicable',
  });
  assert.deepEqual(
    report.findings.map((row) => row.location.path),
    ['/spec/providesApis/0', '/spec/providesApis/1'],
  );
  assert.notEqual(report.findings[0]?.id, report.findings[1]?.id);
});

void test('tampered prepared data and cross-version requests cannot lend catalog authority to rule subjects', async (t) => {
  const matrix = await policyMatrix(t);
  const run = policyRun();
  const preparation = await prepareBackstageReferenceData(
    run.request,
    run.context,
    await matrix.catalog(run),
  );
  const entity = preparation.compatibility.entities[0]!;
  const subjects = [
    {
      id: 'subject',
      value: entity.normalized,
      location: { uri: entity.document.uri, document: 0, path: '', range: entity.document.range },
    },
  ];
  const pinned = preparation.evaluationRequest!;
  await assert.rejects(
    executePolicyRules(
      parseContract('validation-request', {
        ...pinned,
        run: { ...pinned.run, attemptId: 'other' },
      }),
      run.context,
      subjects,
      { referenceData: preparation },
    ),
    /does not bind/,
  );
  const altered = {
    ...preparation,
    observations: preparation.observations.map((row) =>
      row.status === 'present' ? { ...row, value: {} } : row,
    ),
  };
  await assert.rejects(
    executePolicyRules(pinned, run.context, subjects, { referenceData: altered }),
    /differs from pinned/,
  );
  const report = await executePolicyRules(pinned, run.context, [{ ...subjects[0]!, value: {} }], {
    referenceData: preparation,
  });
  assert.notEqual(report.ruleStates[0]?.status, 'passed');
});

void test('cancelling catalog-bound rule composition propagates incomplete execution', async (t) => {
  const matrix = await policyMatrix(t);
  const run = policyRun();
  const gate = matrix.fixtures[0]!.fixture.holdNext({ operation: 'byName' });
  const abort = new AbortController();
  const pending = validatePolicySources(run.request, run.context, {
    catalog: await matrix.catalog(run),
    signal: abort.signal,
  });
  await gate.entered;
  abort.abort();
  const report = await pending;
  await gate.cancelled;
  assert.equal(report.interrupted, 'cancelled');
  assert.notEqual(report.ruleStates[0]?.status, 'passed');
});
