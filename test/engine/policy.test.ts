import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  digestJson,
  orderRules,
  parseContract,
  verifyRequestBindings,
} from '../../src/index.js';
import type { PolicyBundle } from '../../src/index.js';
import { makeContext, makeRequest, policy } from '../helpers.js';

function rule(id: string, requires: string[] = []): PolicyBundle['rules'][number] {
  return {
    id,
    requires,
    kind: 'cel',
    version: '1',
    mandatory: true,
    severity: 'error',
    expression: 'true',
  };
}

void test('rule graph ordering is deterministic and prerequisites come first', () => {
  const rules = [rule('z', ['a']), rule('b'), rule('a')];
  assert.deepEqual(orderRules(rules), ['a', 'b', 'z']);
  assert.deepEqual(orderRules([...rules].reverse()), ['a', 'b', 'z']);
  assert(Object.isFrozen(orderRules(rules)));
});

void test('rejects duplicate IDs, cycles, missing prerequisites and excessive graph depth', () => {
  assert.throws(() => orderRules([rule('a'), rule('a')]), /duplicate/);
  assert.throws(() => orderRules([rule('a', ['b'])]), /missing/);
  assert.throws(() => orderRules([rule('a', ['b']), rule('b', ['a'])]), /cyclic/);
  assert.throws(() => orderRules([rule('a'), rule('b', ['a']), rule('c', ['b'])], 2), /depth/);
  const chain = Array.from({ length: 65 }, (_, index) =>
    rule(String(index).padStart(3, '0'), index ? [String(index - 1).padStart(3, '0')] : []),
  );
  assert.throws(() => orderRules(chain), /depth/);
  assert.throws(() => orderRules([rule('a')], 0), /depth/);
  assert.throws(
    () => parseContract('policy-bundle', { ...policy, rules: [rule('a', ['missing'])] }),
    /missing/,
  );
});

void test('profile rejects unknown adapters and attempts to increase central ceilings', () => {
  assert.throws(() =>
    parseContract('deployment-profile', { ...DEFAULT_DEPLOYMENT_PROFILE, adapterId: 'latest' }),
  );
  assert.throws(() =>
    parseContract('deployment-profile', {
      ...DEFAULT_DEPLOYMENT_PROFILE,
      limits: { ...DEFAULT_DEPLOYMENT_PROFILE.limits, requestTimeoutMs: 5001 },
    }),
  );
  assert.throws(
    () =>
      parseContract('deployment-profile', {
        ...DEFAULT_DEPLOYMENT_PROFILE,
        limits: { ...DEFAULT_DEPLOYMENT_PROFILE.limits, requestBytes: 1 },
      }),
    /file budget/,
  );
  assert.throws(
    () =>
      parseContract('deployment-profile', {
        ...DEFAULT_DEPLOYMENT_PROFILE,
        referenceContexts: [
          ...DEFAULT_DEPLOYMENT_PROFILE.referenceContexts,
          DEFAULT_DEPLOYMENT_PROFILE.referenceContexts[0],
        ],
      }),
    /duplicate/,
  );
});

void test('request bindings detect swapped policy, profile, activation and installation', () => {
  const request = makeRequest();
  const context = makeContext();
  verifyRequestBindings(request, context);
  assert.throws(
    () =>
      verifyRequestBindings(request, {
        ...context,
        policy: { ...context.policy, revision: 'different' },
      }),
    /pinned artifact/,
  );
  assert.throws(
    () =>
      verifyRequestBindings(request, {
        ...context,
        profile: { ...context.profile, id: 'different' },
      }),
    /pinned artifact/,
  );
  const activation = { ...context.activation, installationId: 'other-installation' };
  const swapped = {
    ...request,
    activation: { ...request.activation, digest: digestJson(activation) },
  };
  assert.throws(() => verifyRequestBindings(swapped, { ...context, activation }), /does not bind/);
});

void test('assigned lower budgets apply even when snapshots fit absolute ceilings', () => {
  const request = makeRequest();
  const context = makeContext();
  const profile = { ...context.profile, limits: { ...context.profile.limits, fileBytes: 1 } };
  const activation = { ...context.activation, profileDigest: digestJson(profile) };
  const run = {
    ...request,
    profile: { ...request.profile, digest: digestJson(profile) },
    activation: { ...request.activation, digest: digestJson(activation) },
  };
  assert.throws(
    () => verifyRequestBindings(run, { ...context, profile, activation }),
    /assigned profile budgets/,
  );
});
