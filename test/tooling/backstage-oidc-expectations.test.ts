import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

type Steps = Record<string, Record<string, unknown>>;
const { unmetFlowExpectations, unmetHostExpectations } = (await import(
  pathToFileURL(path.resolve('test/integration/backstage/oidc/expectations.mjs')).href
)) as {
  unmetFlowExpectations: (steps: Steps, options: { secondUser: string }) => string[];
  unmetHostExpectations: (
    facts: { sqliteRotationWarning?: boolean; userPermissionDecisions?: string[] },
    users: { firstUser: string; secondUser: string },
  ) => string[];
};
const evidence = (name: string) =>
  readFile(path.join('docs/oidc-sign-in/evidence', name), 'utf8').then(
    (text) => JSON.parse(text) as Record<string, unknown>,
  );
const users = { firstUser: 'user:bve-demo/alice', secondUser: 'user:bve-demo/bve-denied-user' };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

void test('the recorded flow reports of both releases meet every expectation', async () => {
  for (const release of ['1.55.3', '1.56.3']) {
    const report = await evidence(`flow-${release}.json`);
    assert.deepEqual(unmetFlowExpectations(report.steps as Steps, users), [], release);
  }
});

void test('a refusal with another reason, a state mismatch, or a missing step is unmet', async () => {
  const report = await evidence('flow-1.56.3.json');
  const steps = copy(report.steps as Steps);
  // The second exchange answered as if the verifier were wrong: still `invalid_grant`, wrong reason.
  steps['TC3.second-exchange'] = copy(steps['TC2.wrong-verifier']!);
  (steps['B1-B3.authorize-consent-redirect']!.redirect as { stateMatches: boolean }).stateMatches =
    false;
  steps['B2-TC6.reuse-rotated-out'] = { status: 200 };
  delete steps['TC5.client-not-allowed'];
  assert.deepEqual(unmetFlowExpectations(steps, users), [
    'B1-B3.authorize-consent-redirect',
    'TC3.second-exchange',
    'B2-TC6.reuse-rotated-out',
    'TC5.client-not-allowed (step missing)',
  ]);
  const swapped = copy(report.steps as Steps);
  swapped['TC4.loopback-redirect'] = copy(swapped['TC4.redirect-with-query-not-in-document']!);
  assert.deepEqual(unmetFlowExpectations(swapped, users), ['TC4.loopback-redirect']);
  assert.deepEqual(unmetFlowExpectations(report.steps as Steps, { secondUser: 'user:x/y' }), [
    'B5.two-users',
  ]);
});

void test('the recorded backend log facts attribute B5 to the test policy', async () => {
  for (const release of ['1.55.3', '1.56.3']) {
    const facts = (await evidence(`host-${release}.json`)) as {
      sqliteRotationWarning: boolean;
      userPermissionDecisions: string[];
    };
    assert.deepEqual(unmetHostExpectations(facts, users), [], release);
    const withoutDeny = {
      ...facts,
      userPermissionDecisions: facts.userPermissionDecisions.filter(
        (line) => !line.includes('"DENY"'),
      ),
    };
    assert.deepEqual(unmetHostExpectations(withoutDeny, users), [
      'policy denies user:bve-demo/bve-denied-user',
    ]);
    const inverted = {
      ...facts,
      userPermissionDecisions: [
        ...facts.userPermissionDecisions,
        JSON.stringify({
          user: users.firstUser,
          permission: 'catalog.entity.read',
          nativeResult: 'ALLOW',
          result: 'DENY',
        }),
      ],
    };
    assert.deepEqual(unmetHostExpectations(inverted, users), [
      'policy decided the opposite for a user',
    ]);
    assert.deepEqual(unmetHostExpectations({ ...facts, sqliteRotationWarning: false }, users), [
      'sqlite rotation warning logged',
    ]);
  }
});
