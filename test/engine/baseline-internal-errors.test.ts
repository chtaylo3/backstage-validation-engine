import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'yaml';
import {
  canonicalJson,
  createSourceSnapshot,
  createValidationResult,
  formatSarif,
  loadBackstageAdapter,
  parseContract,
  resultExitCode,
  validatePolicySources,
} from '../../src/index.js';
import type { JsonValue, PolicyBundle } from '../../src/index.js';
import { runBackstageSources } from '../../src/compatibility/sources.js';
import { MESSAGES } from '../../src/compatibility/stages/state.js';
import type { BackstageAdapter } from '../../src/compatibility/types.js';
import type { InternalErrorReport } from '../../src/core/internal-errors.js';
import { runPolicySources } from '../../src/pipeline/policy-sources.js';
import { policyRun } from '../harness/policy-fixture.js';
import { clock, controlledRuntime, ROOT, T0 } from '../harness/rule-stage-fixture.js';

const MARKER = 'MARKER-baseline-content-2d7e';
const ownerExists: PolicyBundle['rules'][number] = {
  id: 'owner-exists',
  version: '1',
  kind: 'catalog',
  check: 'exists',
  referencePath: '/spec/owner',
  mandatory: true,
  severity: 'error',
  requires: [],
};
const entities: Record<string, JsonValue> = {
  a: {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'a' },
    spec: { type: 'service', lifecycle: 'production', owner: 'team' },
  },
  team: {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name: 'team' },
    spec: { type: 'team', children: [] },
  },
};
const snapshot = (revision: string) =>
  createSourceSnapshot({
    repository: 'repository',
    revision,
    rootUri: ROOT,
    files: Object.entries(entities).map(([name, value]) => ({
      uri: `${ROOT}${name}.yaml`,
      text: stringify(value),
      version: 1,
      origin: 'buffer' as const,
    })),
  });

/** A CI run whose catalog facts all come from the proposed sources, with a baseline snapshot. */
function baselineRun() {
  const run = policyRun({
    mode: 'ci',
    rules: [ownerExists],
    source: snapshot('2'),
    baseline: snapshot('1'),
  });
  const request = parseContract('validation-request', {
    ...run.request,
    execution: { ...run.request.execution, startedAt: T0, deadlineAt: T0 + 5000 },
  });
  return { request, context: run.context };
}

type Snapshot = 'proposed' | 'baseline';
/** Runs the composition with native validation of `a` failing in the chosen source runs. */
async function compose(failing: readonly Snapshot[], observed: InternalErrorReport[] = []) {
  const run = baselineRun();
  const adapter = await loadBackstageAdapter(run.context.profile.adapterId);
  const faulty: BackstageAdapter = {
    ...adapter,
    normalizeEntity: (value, settings, context) =>
      (value as { metadata: { name: string } }).metadata.name === 'a'
        ? Promise.reject(new TypeError(MARKER))
        : adapter.normalizeEntity(value, settings, context),
  };
  const report = await runPolicySources(
    run.request,
    run.context,
    {
      clock: clock(),
      runtime: controlledRuntime(() => true).runtime,
      onInternalError: (row) => observed.push(row),
    },
    (request, context, options) => {
      const which: Snapshot =
        request.source.digest === run.request.baseline?.digest ? 'baseline' : 'proposed';
      return runBackstageSources(request, context, options ?? {}, () =>
        Promise.resolve(failing.includes(which) ? faulty : adapter),
      );
    },
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
  return { run, report, result };
}
const baselineRow = (report: Awaited<ReturnType<typeof compose>>['report']) =>
  report.coverage.filter((row) => row.subject === 'baseline-sources');
const sourceEvidence = (report: Awaited<ReturnType<typeof compose>>['report']) =>
  report.failureEvidence.filter((row) => row.stage === 'sources').map((row) => row.cause);

void test('a baseline-only internal error blocks the run with a baseline-sources row and evidence', async () => {
  const plain = await compose([]);
  assert.equal(plain.result.outcome, 'completed');
  const observed: InternalErrorReport[] = [];
  const { report, result } = await compose(['baseline'], observed);
  assert.deepEqual([result.outcome, resultExitCode(result)], ['incomplete', 2]);
  assert.deepEqual(baselineRow(report), [
    {
      stage: 'overlay',
      subject: 'baseline-sources',
      required: true,
      status: 'blocked',
      reason: MESSAGES.internal_error,
    },
  ]);
  assert.deepEqual(report.findings, plain.report.findings);
  assert.deepEqual(report.ruleStates, plain.report.ruleStates);
  assert(!report.findings.some((finding) => finding.ruleId === 'backstage/internal_error'));
  assert.deepEqual(sourceEvidence(report), ['unknown']);
  assert.equal(observed.length, 1);
});

void test('without a baseline internal error there is no baseline-sources row and the report is unchanged', async () => {
  const { run, report } = await compose([]);
  assert.deepEqual(baselineRow(report), []);
  assert.deepEqual(sourceEvidence(report), []);
  const direct = await validatePolicySources(run.request, run.context, {
    clock: clock(),
    runtime: controlledRuntime(() => true).runtime,
  });
  assert.equal(canonicalJson(report), canonicalJson(direct));
});

void test('internal errors in both runs: one proposed finding, the baseline row, outcome error, one evidence row', async () => {
  const observed: InternalErrorReport[] = [];
  const { report, result } = await compose(['proposed', 'baseline'], observed);
  assert.deepEqual(
    report.findings
      .filter((finding) => finding.ruleId === 'backstage/internal_error')
      .map((finding) => finding.location.uri),
    [`${ROOT}a.yaml`],
  );
  assert.equal(baselineRow(report).length, 1);
  assert.deepEqual([result.outcome, resultExitCode(result)], ['error', 2]);
  assert.deepEqual(sourceEvidence(report), ['unknown']);
  // The operator sees one line per run in which the document failed.
  assert.deepEqual(
    observed.map((row) => (row.stage === 'sources' ? [row.phase, row.uri] : [])),
    [
      ['native', `${ROOT}a.yaml`],
      ['native', `${ROOT}a.yaml`],
    ],
  );
});

void test('redaction: a baseline internal error leaves its message in no result surface', async () => {
  const { report, result } = await compose(['baseline']);
  for (const text of [
    JSON.stringify(report),
    JSON.stringify(result),
    JSON.stringify(formatSarif(result)),
  ])
    assert(!text.includes(MARKER));
});
