import assert from 'node:assert/strict';

/** The scenario selects the variant before the untrusted process output is read. */
export function verifyCliReport(engine, report, expected) {
  assert(['validation', 'error', 'sarif'].includes(expected.variant));
  if (expected.variant === 'error') {
    assert.deepEqual(Object.keys(report).sort(), [
      'contractVersion',
      'enforcement',
      'error',
      'outcome',
    ]);
    assert.equal(report.contractVersion, '0.2');
    assert.equal(expected.exitCode, 2);
    assert.equal(report.outcome, 'error');
    assert.equal(report.enforcement, 'block');
    assert.deepEqual(Object.keys(report.error).sort(), ['code', 'message']);
    assert.equal(typeof report.error.code, 'string');
    assert(report.error.code.length > 0);
    assert.equal(
      report.error.message,
      'Validation input or trusted configuration could not be loaded.',
    );
    return;
  }
  if (expected.variant === 'sarif') {
    assert.equal(report.version, '2.1.0');
    assert.equal(report.runs.length, 1);
    assert(Array.isArray(report.runs[0].results));
    assert.equal(typeof report.runs[0].invocations[0].executionSuccessful, 'boolean');
    return;
  }
  engine.parseContract('validation-result', report);
  assert.equal(report.mode, 'ci');
  assert.notEqual(report.enforcement, 'advisory', 'CLI validation must enforce CI semantics.');
  assert.equal(report.outcome, expected.outcome ?? 'completed');
  assert(Number.isInteger(expected.exitCode) && [0, 1, 2].includes(expected.exitCode));
  assert.equal(
    engine.resultExitCode(report),
    expected.exitCode,
    'CLI exit must agree with its validated result.',
  );
  for (const key of [
    'sourceDigest',
    'policyDigest',
    'profileDigest',
    'activationDigest',
    'installationId',
    'repositoryId',
  ]) {
    assert(expected.provenance[key], 'The host must bind every required identity.');
    assert.equal(
      report.provenance[key],
      expected.provenance[key],
      'Unexpected CLI provenance: ' + key,
    );
  }
}

export function normalizeCoverage(rows) {
  assert(Array.isArray(rows) && rows.length > 0, 'Observe actual coverage records.');
  return rows
    .map((row) => {
      assert(
        Object.keys(row).every((key) =>
          ['stage', 'subject', 'required', 'status', 'reason'].includes(key),
        ),
        'Reject undeclared coverage fields.',
      );
      assert.equal(typeof row.stage, 'string');
      assert.equal(typeof row.subject, 'string');
      assert.equal(typeof row.required, 'boolean');
      assert.equal(typeof row.status, 'string');
      return {
        stage: row.stage,
        subject: row.subject,
        required: row.required,
        status: row.status,
        ...(row.reason === undefined ? {} : { reason: row.reason }),
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function verifyCoverageParity(cli, editor) {
  assert(
    cli.some((row) => row.required),
    'The pinned fixture must require coverage.',
  );
  // Only the CLI authenticates a signed release. The LSP consumes an already approved launcher policy.
  const signed = cli.filter((row) => row.stage === 'policy' && row.subject === 'signed-release');
  assert.deepEqual(signed, [
    { stage: 'policy', subject: 'signed-release', required: true, status: 'verified' },
  ]);
  const shared = cli.filter((row) => !(row.stage === 'policy' && row.subject === 'signed-release'));
  assert.deepEqual(
    normalizeCoverage(editor),
    normalizeCoverage(shared),
    'Installed clients must agree on every coverage record.',
  );
}
