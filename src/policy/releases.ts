import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { PolicyRelease } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { createCustomKindRegistry, createSchemaRegistry } from '../compatibility/custom-schemas.js';
import { canonicalJson, deepFreeze, digestJson } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { reject } from '../base/errors.js';
import { orderRules } from '../contracts/rule-graph.js';
import { POLICY_BUNDLE_LIMITS, resolvePolicyBundles } from './bundles.js';

export type PolicyReleasePayload = Omit<PolicyRelease, 'signature'>;

/** Development/host signing helper. Private keys never enter the release or trust contracts. */
export function signPolicyRelease(
  payload: Immutable<PolicyReleasePayload>,
  privateKey: string,
  keyId: string,
) {
  const checked = parseContract('policy-release', {
    ...payload,
    signature: { algorithm: 'ed25519', keyId, value: Buffer.alloc(64).toString('base64') },
  });
  const { signature: _signature, ...body } = checked;
  void _signature;
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    return parseContract('policy-release', {
      ...body,
      signature: {
        algorithm: 'ed25519',
        keyId,
        value: sign(null, Buffer.from(canonicalJson(body)), key).toString('base64'),
      },
    });
  } catch {
    return reject('integrity', '/signature', 'release signing failed');
  }
}

/** Verify a bounded immutable package against separately installed host keys, scope and baseline pins. */
export function verifyPolicyRelease(input: unknown, hostTrust: unknown, now = Date.now()) {
  canonicalJson(input, { maxBytes: POLICY_BUNDLE_LIMITS.bytes });
  const release = parseContract('policy-release', input);
  const trust = parseContract('policy-trust', hostTrust);
  if (!Number.isSafeInteger(now) || now < 0)
    reject('invalid_contract', '', 'invalid verification time');
  if (new Set(trust.keys.map((key) => key.id)).size !== trust.keys.length)
    reject('invalid_contract', '/keys', 'duplicate trusted key IDs');
  const trustedKey = trust.keys.find((key) => key.id === release.signature.keyId);
  if (!trustedKey) reject('integrity', '/signature', 'release key is not trusted');
  const { signature, ...body } = release;
  let valid = false;
  try {
    const key = createPublicKey(trustedKey.publicKey);
    const bytes = Buffer.from(signature.value, 'base64');
    valid =
      key.asymmetricKeyType === 'ed25519' &&
      bytes.length === 64 &&
      bytes.toString('base64') === signature.value &&
      verify(null, Buffer.from(canonicalJson(body)), key, bytes);
  } catch {
    // Crypto details and rejected key material must not reach diagnostics.
  }
  if (!valid) reject('integrity', '/signature', 'release signature verification failed');
  const validUntil = Math.min(release.expiresAt, release.issuedAt + trust.maxAgeMs);
  if (release.issuedAt > now || validUntil <= now)
    reject('integrity', '/expiresAt', 'release is outside its trusted validity window');
  const resolved = resolvePolicyBundles(
    release.rootDigest,
    release.bundles,
    trust.mandatoryDigests,
  );
  const profile = parseContract('deployment-profile', release.profile);
  const activation = parseContract('activation-manifest', release.activation);
  if (
    activation.generation !== trust.generation ||
    activation.installationId !== trust.identity.installationId ||
    activation.repositoryId !== trust.identity.repositoryId ||
    activation.policyDigest !== digestJson(resolved.policy) ||
    activation.profileDigest !== digestJson(profile) ||
    activation.activatedAt > release.issuedAt
  )
    reject(
      'integrity',
      '/activation',
      'release activation does not match trusted scope, generation or artifacts',
    );
  if (resolved.policy.rules.length > profile.limits.rules)
    reject('limit', '/rules', 'resolved policy exceeds the assigned rule budget');
  orderRules(resolved.policy.rules, profile.limits.graphDepth);
  const registry = createSchemaRegistry(release.schemaArtifacts);
  const custom = createCustomKindRegistry(profile, registry.artifacts);
  for (const declaration of profile.customKinds)
    if (!custom.get(declaration.kind, declaration.apiVersion)?.validate)
      reject('integrity', '/schemaArtifacts', 'custom kind schema artifact is absent');
  for (const pin of resolved.policy.schemas)
    if (!registry.get(pin))
      reject('integrity', '/schemaArtifacts', 'declared schema artifact is absent');
  for (const rule of resolved.policy.rules) {
    if (
      rule.kind === 'schema' &&
      (!resolved.policy.schemas.some((pin) => canonicalJson(pin) === canonicalJson(rule.schema)) ||
        !registry.get(rule.schema))
    )
      reject('integrity', '/rules', 'schema rule must bind a declared bundled artifact');
    if (
      rule.kind === 'catalog' &&
      !profile.referenceContexts.some((row) => row.path === rule.referencePath)
    )
      reject('invalid_policy', '/rules', 'catalog rule must bind a declared reference context');
  }
  return deepFreeze({
    profile,
    policy: resolved.policy,
    activation,
    schemaArtifacts: registry.artifacts,
    identity: trust.identity,
    verification: {
      releaseDigest: digestJson(release),
      rootDigest: release.rootDigest,
      closureDigests: resolved.closureDigests,
      keyId: signature.keyId,
      verifiedAt: now,
      expiresAt: validUntil,
    },
  });
}
