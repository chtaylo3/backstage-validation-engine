import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  ContractError,
  digestJson,
  parseContract,
  resolvePolicyBundles,
  signPolicyRelease,
  verifyPolicyRelease,
} from '../../src/index.js';
import { releaseFixture } from '../harness/release-fixture.js';
import { schemaArtifact } from '../harness/custom-kind-fixture.js';

void test('signed release resolves immutable baseline inheritance and pins flattened activation', () => {
  const fixture = releaseFixture();
  const context = verifyPolicyRelease(fixture.release, fixture.trust, fixture.now);
  assert.deepEqual(context.policy.rules, fixture.baseline.rules);
  assert.deepEqual(context.policy.extends, []);
  assert.equal(context.activation.policyDigest, digestJson(context.policy));
  assert(Object.isFrozen(context.policy.rules[0]));
  assert.deepEqual(
    context.verification.closureDigests,
    [digestJson(fixture.root), digestJson(fixture.baseline)].sort(),
  );
  assert.equal(context.verification.expiresAt, fixture.now + 60_000);
});

void test('repository additions cannot replace or downgrade any inherited baseline declaration', async (t) => {
  const f = releaseFixture();
  const rule = f.baseline.rules[0]!;
  for (const changes of [
    { mandatory: false },
    { severity: 'warning' },
    { expression: 'true' },
    { version: '2' },
    { selector: 'false' },
    { requires: ['different'] },
  ])
    await t.test(JSON.stringify(changes), () => {
      const root = parseContract('policy-bundle', { ...f.root, rules: [{ ...rule, ...changes }] });
      assert.throws(
        () => resolvePolicyBundles(digestJson(root), [root, f.baseline], f.trust.mandatoryDigests),
        /replaced or weakened/,
      );
    });
});

void test('resolver deduplicates diamond inheritance and validates cross-bundle prerequisites deterministically', () => {
  const f = releaseFixture();
  const base = digestJson(f.baseline);
  const left = { ...f.root, id: 'left' };
  const right = {
    ...f.root,
    id: 'right',
    rules: [{ ...f.baseline.rules[0]!, id: 'child', requires: [f.baseline.rules[0]!.id] }],
  };
  const root = { ...f.root, extends: [digestJson(left), digestJson(right)] };
  const input = [root, right, f.baseline, left];
  const resolved = resolvePolicyBundles(digestJson(root), input, [base]);
  assert.equal(resolved.policy.rules.length, 2);
  assert.deepEqual(
    resolved.policy.rules.map((rule) => rule.id),
    ['owner-required', 'child'],
  );
  assert.deepEqual(resolved, resolvePolicyBundles(digestJson(root), [...input].reverse(), [base]));
});

void test('resolver rejects absent baselines/parents, detached bundles, excessive depth, plugins and conflicting schema pins', () => {
  const f = releaseFixture();
  assert.throws(
    () => resolvePolicyBundles(digestJson(f.root), [f.root], f.trust.mandatoryDigests),
    /inherited bundle is absent/,
  );
  assert.throws(
    () => resolvePolicyBundles(digestJson(f.baseline), [f.baseline], [digestJson({ other: true })]),
    /host-required baseline/,
  );
  assert.throws(
    () => resolvePolicyBundles(digestJson(f.baseline), [f.baseline, f.root], []),
    /outside the root/,
  );
  const plugin = {
    ...f.baseline,
    plugins: [{ id: 'module', version: '1', digest: digestJson({}) }],
  };
  assert.throws(
    () => resolvePolicyBundles(digestJson(plugin), [plugin], []),
    /no executable plugins/,
  );
  const artifact = schemaArtifact(true);
  const baseline = {
    ...f.baseline,
    schemas: [{ id: artifact.id, version: artifact.version, digest: artifact.digest }],
  };
  const root = {
    ...f.root,
    extends: [digestJson(baseline)],
    schemas: [{ ...baseline.schemas[0]!, digest: digestJson(false) }],
  };
  assert.throws(
    () => resolvePolicyBundles(digestJson(root), [root, baseline], []),
    /conflicting schema/,
  );
  const chain = [f.baseline];
  for (let index = 0; index < 16; index++)
    chain.push(
      parseContract('policy-bundle', {
        ...f.root,
        id: String(index),
        extends: [digestJson(chain.at(-1))],
      }),
    );
  assert.throws(() => resolvePolicyBundles(digestJson(chain.at(-1)), chain, []), /depth/);
});

void test('release signature rejects payload tampering across policy/profile/activation/schema, unknown and substituted keys', async (t) => {
  const f = releaseFixture();
  const variants = [
    { ...f.release, bundles: [{ ...f.root, revision: 'tampered' }, f.baseline] },
    { ...f.release, profile: { ...f.release.profile, id: 'different' } },
    { ...f.release, activation: { ...f.release.activation, generation: 2 } },
    { ...f.release, schemaArtifacts: [schemaArtifact(false)] },
    { ...f.release, signature: { ...f.release.signature, keyId: 'self-selected' } },
    { ...f.release, signature: { ...f.release.signature, algorithm: 'none' } },
    { ...f.release, keys: f.trust.keys },
  ];
  const expected = [
    ['integrity', '/signature', 'release signature verification failed'],
    ['integrity', '/signature', 'release signature verification failed'],
    ['integrity', '/signature', 'release signature verification failed'],
    ['integrity', '/signature', 'release signature verification failed'],
    ['integrity', '/signature', 'release key is not trusted'],
    ['invalid_contract', '/signature/algorithm', 'must be equal to constant'],
    ['invalid_contract', '', 'must NOT have additional properties'],
  ] as const;
  for (const [index, release] of variants.entries())
    await t.test(String(index), () =>
      assert.throws(
        () => verifyPolicyRelease(release, f.trust, f.now),
        (error: unknown) => {
          assert(error instanceof ContractError);
          const [code, path, message] = expected[index]!;
          assert.equal(error.code, code);
          assert(error.issues.some((issue) => issue.path === path && issue.message === message));
          return true;
        },
      ),
    );
  const impostor = releaseFixture();
  assert.throws(() => verifyPolicyRelease(impostor.release, f.trust, f.now), /signature/);
  assert.throws(
    () =>
      verifyPolicyRelease(
        f.release,
        { ...f.trust, keys: [f.trust.keys[0], f.trust.keys[0]] },
        f.now,
      ),
    /duplicate trusted/,
  );
});

void test('valid signatures cannot override trusted scope, generation, expiry, max age or mandatory pins', async (t) => {
  const f = releaseFixture();
  const variants = [
    { ...f.trust, generation: 2 },
    { ...f.trust, identity: { ...f.trust.identity, installationId: 'other' } },
    { ...f.trust, identity: { ...f.trust.identity, repositoryId: 'other' } },
    { ...f.trust, mandatoryDigests: [digestJson({ other: true })] },
  ];
  for (const trust of variants)
    await t.test(JSON.stringify(trust.identity), () =>
      assert.throws(() => verifyPolicyRelease(f.release, trust, f.now), ContractError),
    );
  for (const now of [f.now - 1, f.now + 60_000])
    assert.throws(() => verifyPolicyRelease(f.release, f.trust, now), /validity/);
  assert.throws(
    () => verifyPolicyRelease(f.release, { ...f.trust, maxAgeMs: 1 }, f.now + 1),
    /validity/,
  );
  const release = signPolicyRelease(
    { ...f.payload, activation: { ...f.payload.activation, policyDigest: digestJson(f.root) } },
    f.privatePem,
    'host-key-1',
  );
  assert.throws(() => verifyPolicyRelease(release, f.trust, f.now), /activation/);
});

void test('signed schema bodies and rule declarations must match bundled pins and the safe draft-07 profile', () => {
  const artifact = schemaArtifact(true);
  const rule = {
    id: 'schema',
    version: '1',
    kind: 'schema',
    schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
    mandatory: true,
    severity: 'error',
    requires: [],
  } as const;
  const f = releaseFixture({ rules: [rule], schemaArtifacts: [artifact] });
  assert.equal(verifyPolicyRelease(f.release, f.trust, f.now).schemaArtifacts.length, 1);
  const missing = signPolicyRelease(
    { ...f.payload, schemaArtifacts: [] },
    f.privatePem,
    'host-key-1',
  );
  assert.throws(() => verifyPolicyRelease(missing, f.trust, f.now), /artifact is absent/);
  const unsafe = schemaArtifact({ $ref: 'https://example.com/schema' });
  const bad = releaseFixture({ schemaArtifacts: [unsafe] });
  assert.throws(
    () => verifyPolicyRelease(bad.release, bad.trust, bad.now),
    /supported synchronous/,
  );
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(
    () =>
      signPolicyRelease(
        f.payload,
        rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        'host-key-1',
      ),
    /signing failed/,
  );
});

void test('signed release expiry during execution blocks publication without renewing the authority window', async () => {
  const { createVerifiedPolicyResult, validatePolicySources, resultExitCode } =
    await import('../../src/index.js');
  const { policyRun } = await import('../harness/policy-fixture.js');
  const f = releaseFixture({ rules: [], expiresAt: Date.now() + 1000 });
  const context = verifyPolicyRelease(f.release, f.trust, f.now);
  const base = policyRun({ mode: 'ci', rules: [] });
  const request = parseContract('validation-request', {
    ...base.request,
    policy: { digest: digestJson(context.policy), revision: context.policy.revision },
    activation: {
      digest: digestJson(context.activation),
      generation: context.activation.generation,
    },
  });
  const report = await validatePolicySources(request, context);
  const completed = createVerifiedPolicyResult(report, context, request.execution.startedAt + 1);
  assert.equal(resultExitCode(completed), 0);
  assert.equal(completed.freshness.publishBefore, f.release.expiresAt);
  const expired = createVerifiedPolicyResult(report, context, f.release.expiresAt);
  assert.equal(resultExitCode(expired), 2);
  assert.equal(expired.outcome, 'incomplete');
  assert(expired.coverage.some((row) => row.stage === 'policy' && row.status === 'blocked'));
  assert.equal(expired.freshness.publishBefore, f.release.expiresAt);
});
