import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createFindingId,
  createValidationResult,
  digestJson,
  parseContract,
  resultExitCode,
} from '../src/index.js';
import type { BypassReceipt, Finding, ResultInput, RuleState } from '../src/index.js';
import { NOW, URI, makeRequest, passingState, verifiedCoverage } from './helpers.js';

function finding(): Finding {
  const request = makeRequest();
  return {
    id: createFindingId({
      ruleId: 'owner-required',
      ruleVersion: '1',
      subjectId: 'component:default/example',
      path: '/spec/owner',
      policyDigest: request.policy.digest,
      profileDigest: request.profile.digest,
    }),
    ruleId: 'owner-required',
    ruleVersion: '1',
    subjectId: 'component:default/example',
    message: 'Owner is required',
    category: 'policy',
    severity: 'error',
    enforcement: 'blocking',
    location: {
      uri: URI,
      document: 0,
      path: '/spec/owner',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
    },
    relatedLocations: [],
    edits: [],
  };
}

function receipt(): BypassReceipt {
  return {
    recordId: 'fixture-emergency-1',
    revision: 'bypass-revision-1',
    type: 'emergency',
    installationId: 'installation-1',
    repositoryId: 'repository-1',
    reason: 'Fixture emergency record',
    ruleIds: [],
    issuedAt: NOW - 1000,
    expiresAt: NOW + 30_000,
    verifiedAt: NOW,
    authority: {
      repository: 'https://github.com/example/governance',
      revision: 'governance-revision-1',
      verifierId: 'test-verifier',
      evidenceDigest: digestJson({ fixture: true }),
    },
  };
}

function result(input: Partial<ResultInput> = {}) {
  return createValidationResult({
    request: makeRequest(),
    coverage: verifiedCoverage,
    ruleStates: [passingState],
    completedAt: NOW + 100,
    authorityCheckedAt: NOW,
    ...input,
  });
}

void test('a false rule is a completed blocking violation, while invalid policy is an error', () => {
  const passed = result();
  assert.equal(passed.outcome, 'completed');
  assert.equal(passed.enforcement, 'allow');
  assert.equal(resultExitCode(passed), 0);
  const failed = result({
    findings: [finding()],
    ruleStates: [{ ...passingState, status: 'failed' }],
  });
  assert.equal(failed.outcome, 'completed');
  assert.equal(failed.enforcement, 'block');
  assert.equal(resultExitCode(failed), 1);
  const invalid = result({
    ruleStates: [{ ...passingState, status: 'invalid_policy', reason: 'invalid_expression' }],
  });
  assert.equal(invalid.outcome, 'error');
  assert.equal(invalid.enforcement, 'block');
  assert.equal(resultExitCode(invalid), 2);
});

void test('unsupported, unavailable, blocked and skipped mandatory work cannot pass CI', () => {
  for (const status of ['unsupported', 'unavailable', 'blocked', 'skipped'] as const) {
    const incomplete = result({
      coverage: [{ ...verifiedCoverage[0]!, status, reason: 'Required work did not complete' }],
    });
    assert.equal(incomplete.outcome, 'incomplete');
    assert.equal(incomplete.enforcement, 'block');
    assert.equal(resultExitCode(incomplete), 2);
    assert.throws(
      () =>
        parseContract('validation-result', {
          ...incomplete,
          outcome: 'completed',
          enforcement: 'allow',
        }),
      /decision disagrees/,
    );
  }
  assert.equal(result({ coverage: [] }).outcome, 'incomplete');
  assert.equal(
    result({ coverage: [{ ...verifiedCoverage[0]!, required: false }] }).outcome,
    'incomplete',
  );
});

void test('timeouts, cancellation, queue pressure and worker failures are incomplete, never false', () => {
  const reasons: NonNullable<RuleState['reason']>[] = [
    'timeout',
    'cancelled',
    'queue_exhausted',
    'resource_limit',
    'worker_failure',
    'dependency_unavailable',
  ];
  for (const reason of reasons) {
    const incomplete = result({ ruleStates: [{ ...passingState, status: 'incomplete', reason }] });
    assert.equal(incomplete.outcome, 'incomplete');
    assert.equal(resultExitCode(incomplete), 2);
  }
  const expired = result({ completedAt: NOW + 5000 });
  assert.equal(expired.resources.interrupted, 'timeout');
  assert.equal(expired.outcome, 'incomplete');
  assert.equal(result({ completedAt: NOW + 5000, interrupted: 'none' }).outcome, 'incomplete');
  assert.throws(
    () =>
      parseContract('validation-result', {
        ...expired,
        resources: { ...expired.resources, interrupted: 'none' },
      }),
    /interruption state/,
  );
});

void test('IDE enforcement stays advisory while retaining error and incomplete outcomes', () => {
  const advisory = result({
    request: makeRequest('ide'),
    coverage: [{ ...verifiedCoverage[0]!, status: 'unavailable' }],
  });
  assert.equal(advisory.outcome, 'incomplete');
  assert.equal(advisory.enforcement, 'advisory');
  assert.equal(resultExitCode(advisory), 2);
});

void test('emergency bypass has a scoped, expiring receipt and explicit bypassed coverage', () => {
  const bypassed = result({
    bypass: receipt(),
    coverage: [{ ...verifiedCoverage[0]!, status: 'bypassed' }],
    ruleStates: [],
  });
  assert.equal(bypassed.outcome, 'bypassed');
  assert.equal(bypassed.enforcement, 'allow');
  assert.equal(resultExitCode(bypassed), 0);
  assert.equal(bypassed.freshness.publishBefore, NOW + 30_000);
  assert.throws(
    () => result({ coverage: [{ ...verifiedCoverage[0]!, status: 'bypassed' }], ruleStates: [] }),
    /authorization receipt/,
  );
  assert.throws(
    () => result({ bypass: { ...receipt(), repositoryId: 'wrong' } }),
    /scope or validity/,
  );
  assert.throws(
    () => result({ bypass: { ...receipt(), expiresAt: NOW + 1 } }),
    /scope or validity/,
  );
  assert.throws(
    () =>
      result({ bypass: receipt(), coverage: [{ ...verifiedCoverage[0]!, status: 'bypassed' }] }),
    /early emergency/,
  );
  assert.throws(
    () =>
      parseContract('validation-result', {
        ...bypassed,
        bypass: { ...receipt(), entityScope: 'component:default/example' },
      }),
    /decision disagrees/,
  );
});

void test('rejects reversed ranges, duplicated findings and contradictory timestamps', () => {
  const original = finding();
  assert.throws(() => result({ findings: [original, original] }), /duplicate identities/);
  assert.throws(
    () =>
      result({
        findings: [
          {
            ...original,
            location: {
              ...original.location,
              range: { start: { line: 1, character: 4 }, end: { line: 0, character: 0 } },
            },
          },
        ],
      }),
    /ends before/,
  );
  assert.throws(() => result({ completedAt: NOW - 1 }), /timestamps/);
  assert.throws(() => result({ authorityCheckedAt: NOW + 101 }), /freshness/);
});

void test('stable finding identity ignores message, location and extra presentation fields', () => {
  const identity = {
    ruleId: 'rule-1',
    ruleVersion: '1',
    subjectId: 'component:default/example',
    path: '/spec/owner',
    policyDigest: digestJson('policy'),
    profileDigest: digestJson('profile'),
  };
  const withPresentation = { ...identity, message: 'new wording', line: 100 };
  assert.equal(createFindingId(identity), createFindingId(withPresentation));
  assert.notEqual(createFindingId(identity), createFindingId({ ...identity, ruleVersion: '2' }));
  assert.notEqual(createFindingId(identity), createFindingId({ ...identity, path: '/spec/type' }));
});
