import assert from 'node:assert/strict';

// Expected public contract0.2 projections, authored independently from the driver.
export function assertH4CliReason(id, report) {
  if (id === 'cli.native-rejection') {
    assert(report.findings.some((row) => row.ruleId === 'backstage/kind/invalid_kind'));
    assert(
      report.coverage.some(
        (row) => row.stage === 'compatibility' && row.required && row.status === 'verified',
      ),
    );
  } else if (id === 'cli.malformed-yaml') {
    assert(report.findings.some((row) => row.ruleId === 'yaml/syntax'));
    assert(
      report.coverage.some(
        (row) => row.stage === 'parse' && row.required && row.status === 'verified',
      ),
    );
  } else if (['cli.invalid-credentials', 'cli.permission-denied', 'cli.outage'].includes(id)) {
    assert.equal(report.outcome, 'incomplete');
    assert(
      report.ruleStates.some(
        (row) =>
          row.ruleId === 'owner-exists' &&
          row.required &&
          row.status === 'incomplete' &&
          row.reason === 'dependency_unavailable',
      ),
    );
    assert(
      report.findings.some((row) => row.ruleId === 'owner-exists' && row.category === 'dependency'),
    );
    assert(
      report.coverage.some(
        (row) =>
          row.stage === 'rules' &&
          row.subject.endsWith(',"owner-exists"]') &&
          row.required &&
          row.status === 'unavailable' &&
          row.reason === 'Catalog observations required by the policy are unavailable.',
      ),
    );
  } else if (id === 'cli.missing-credentials') {
    assert.equal(report.error.code, 'input_error');
  } else if (id === 'cli.required-processor') {
    assert.equal(report.outcome, 'incomplete');
    assert(
      report.coverage.some(
        (row) =>
          row.stage === 'compatibility' &&
          row.subject === '["processor","unavailable-release-processor","before-native"]' &&
          row.required &&
          row.status === 'unsupported' &&
          row.reason ===
            'Required deployment processing is unavailable; dependent validation was not executed.',
      ),
    );
  }
}

export function assertH4CliCase(id, value) {
  const expected = {
    'cli.valid-json': 0,
    'cli.native-rejection': 1,
    'cli.malformed-yaml': 1,
    'cli.required-processor': 2,
    'cli.missing-credentials': 2,
    'cli.invalid-credentials': 2,
    'cli.permission-denied': 2,
    'cli.outage': 2,
    'cli.mutation': 0,
    'cli.recovery': 0,
  };
  if (Object.hasOwn(expected, id))
    assert.equal(value.code, expected[id], 'Require the independently declared scenario exit.');
  assertH4CliReason(id, value.report);
}
