import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  ContractError,
  createFindingId,
  createValidationResult,
  formatSarif,
} from '../../src/index.js';
import { BudgetAdmissionError } from '../../src/runtime/request-budget.js';
import {
  duringValidation,
  failureLog,
  failureOutput,
  ValidationFault,
} from '../../src/cli/failure.js';
import { formatInternalError, internalErrorDetail } from '../../src/host/internal-errors.js';
import { makeRequest, NOW, URI } from '../helpers.js';
import { sarifValidator } from '../harness/sarif-schema.js';

const MARKER = 'MARKER-entity-content-c41d';
const INTERNAL = 'Validation failed with an internal error.';
const INPUT = 'Validation input or trusted configuration could not be loaded.';

void test('a non-contract error thrown during validation is labelled internal_error in JSON and SARIF', async () => {
  // The CLI has no hook that makes validation throw; the labelling it applies is tested directly.
  const fault = await duringValidation(() => Promise.reject(new Error(MARKER))).catch(
    (error: unknown) => error,
  );
  assert(fault instanceof ValidationFault);
  assert.deepEqual(failureOutput(fault, 'json'), {
    contractVersion: '0.2',
    outcome: 'error',
    enforcement: 'block',
    error: { code: 'internal_error', message: INTERNAL },
  });
  const sarif = failureOutput(fault, 'sarif') as ReturnType<typeof formatSarif>;
  const validate = await sarifValidator();
  assert(validate(sarif), JSON.stringify(validate.errors));
  assert.deepEqual(sarif.runs[0]?.invocations[0]?.toolExecutionNotifications, [
    { level: 'error', descriptor: { id: 'internal_error' }, message: { text: INTERNAL } },
  ]);
  for (const format of ['json', 'sarif'])
    assert(!JSON.stringify(failureOutput(fault, format)).includes(MARKER));
});

void test('contract errors and budget admission keep their labels; other errors are input_error', async () => {
  const contract = new ContractError('integrity', [{ path: '', message: 'stub' }]);
  await assert.rejects(
    duringValidation(() => Promise.reject(contract)),
    (error) => error === contract,
  );
  const admission = new BudgetAdmissionError('deadline_out_of_range');
  await assert.rejects(
    duringValidation(() => Promise.reject(admission)),
    (error) => error === admission,
  );
  assert.deepEqual((failureOutput(contract, 'json') as { error: unknown }).error, {
    code: 'integrity',
    message: INPUT,
  });
  for (const error of [admission, new Error('read failure')])
    assert.deepEqual((failureOutput(error, 'json') as { error: unknown }).error, {
      code: 'input_error',
      message: INPUT,
    });
  assert.equal(await duringValidation(() => 7), 7);
});

void test('an unreadable input file still prints input_error and exits with 2', async () => {
  const missing = resolve('.test-dist', 'missing-input.json');
  const output = await new Promise<{ code: number; stdout: string }>((done, fail) => {
    execFile(
      process.execPath,
      [
        process.env.BVE_TEST_CLI_ENTRY ?? resolve('.test-dist/src/cli/main.js'),
        'validate',
        '--release',
        missing,
        '--trust',
        missing,
        '--source',
        missing,
      ],
      { encoding: 'utf8', timeout: 20_000 },
      (error, stdout) => {
        if (error && typeof error.code !== 'number')
          fail(new Error('CLI subprocess failed', { cause: error }));
        else done({ code: typeof error?.code === 'number' ? error.code : 0, stdout });
      },
    );
  });
  assert.equal(output.code, 2);
  assert.deepEqual((JSON.parse(output.stdout) as { error: unknown }).error, {
    code: 'input_error',
    message: INPUT,
  });
});

void test('the operator line names the stage, activity, rule, source and type; detail only on request', () => {
  const error = new TypeError(MARKER);
  const location = {
    uri: URI,
    document: 1,
    path: '/spec',
    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
  };
  const rules = {
    stage: 'rules',
    activity: 'rule_evaluation',
    ruleId: 'owner\nrule',
    subjectId: JSON.stringify([URI, 1]),
    location,
    error,
  } as const;
  const line = formatInternalError(rules);
  assert.equal(
    line,
    `internal_error stage=rules activity=rule_evaluation rule="owner\\nrule" source=${JSON.stringify(URI)} document=1 type="TypeError"`,
  );
  assert(!line.includes(MARKER) && !line.includes('\n'));
  const detailed = formatInternalError(rules, true);
  assert(detailed.startsWith(line));
  assert(detailed.includes(MARKER) && !detailed.includes('\n'));
  assert.equal(
    formatInternalError({ stage: 'sources', phase: 'native', uri: URI, document: 0, error: 'x' }),
    `internal_error stage=sources phase=native source=${JSON.stringify(URI)} document=0 type="non-Error string"`,
  );
  assert.equal(internalErrorDetail({}), false);
  assert.equal(internalErrorDetail({ BVE_INTERNAL_ERROR_DETAIL: '1' }), true);
  assert.equal(internalErrorDetail({ BVE_INTERNAL_ERROR_DETAIL: 'true' }), false);
});

void test('SARIF of a run with an execution finding adds one schema-valid error notification', async () => {
  const request = makeRequest('ci');
  const subjectId = JSON.stringify([URI, 0]);
  const location = {
    uri: URI,
    document: 0,
    path: '',
    range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
  };
  const id = createFindingId({
    ruleId: 'engine/internal_error',
    ruleVersion: 'rule@1',
    subjectId,
    path: '',
    policyDigest: request.policy.digest,
    profileDigest: request.profile.digest,
  });
  const result = createValidationResult({
    request,
    coverage: [{ stage: 'rules', subject: subjectId, required: true, status: 'verified' }],
    findings: [
      {
        id,
        ruleId: 'engine/internal_error',
        ruleVersion: 'rule@1',
        subjectId,
        message: 'Internal.',
        category: 'execution',
        severity: 'error',
        enforcement: 'blocking',
        location,
        relatedLocations: [],
        edits: [],
      },
    ],
    completedAt: NOW,
    authorityCheckedAt: NOW,
  });
  const sarif = formatSarif(result);
  const validate = await sarifValidator();
  assert(validate(sarif), JSON.stringify(validate.errors));
  const invocation = sarif.runs[0]!.invocations[0]!;
  assert.equal(invocation.executionSuccessful, false);
  assert.equal(sarif.runs[0]!.results.length, 1);
  assert.deepEqual(invocation.toolExecutionNotifications?.[1], {
    level: 'error',
    descriptor: { id: 'engine/internal_error' },
    message: { text: 'Internal.' },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: URI },
          region: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
        },
        properties: { document: 0, path: '' },
      },
    ],
  });
});

void test('an error that escaped validation writes one redacted operator line; detail only on request', () => {
  const cause = new TypeError(MARKER);
  const fault = new ValidationFault(cause);
  assert.equal(failureLog(fault, false), 'bve: internal_error stage=validation type="TypeError"');
  const detailed = failureLog(fault, true)!;
  assert(detailed.startsWith('bve: internal_error stage=validation type="TypeError" message='));
  assert(detailed.includes(MARKER));
  assert(detailed.includes(JSON.stringify(String(cause.stack)).slice(1, 40)));
  assert(!detailed.includes('\n'));
  for (const error of [
    new ContractError('integrity', [{ path: '', message: MARKER }]),
    new BudgetAdmissionError('deadline_out_of_range'),
    new Error(MARKER),
  ])
    for (const withDetail of [false, true]) assert.equal(failureLog(error, withDetail), undefined);
});
