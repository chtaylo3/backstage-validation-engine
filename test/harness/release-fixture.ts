import { generateKeyPairSync } from 'node:crypto';
import {
  digestJson,
  parseContract,
  resolvePolicyBundles,
  signPolicyRelease,
} from '../../src/index.js';
import type {
  Immutable,
  PolicyBundle,
  PolicyReleasePayload,
  SchemaArtifact,
} from '../../src/index.js';
import { makeContext, makeRequest } from '../helpers.js';

export function releaseFixture(
  options: {
    rules?: readonly Immutable<PolicyBundle['rules'][number]>[];
    schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
    now?: number;
    expiresAt?: number;
  } = {},
) {
  const now = options.now ?? Date.now();
  const context = makeContext();
  const artifacts = options.schemaArtifacts ?? [];
  const baseline = parseContract('policy-bundle', {
    ...context.policy,
    rules: options.rules ?? context.policy.rules,
    schemas: artifacts.map(({ id, version, digest }) => ({ id, version, digest })),
  });
  const root = parseContract('policy-bundle', {
    ...baseline,
    id: 'repository-additions',
    revision: 'repo-1',
    extends: [digestJson(baseline)],
    rules: [],
    schemas: [],
  });
  const resolved = resolvePolicyBundles(digestJson(root), [root, baseline], [digestJson(baseline)]);
  const activation = parseContract('activation-manifest', {
    ...context.activation,
    activatedAt: now - 1000,
    policyDigest: digestJson(resolved.policy),
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const trust = parseContract('policy-trust', {
    contractVersion: '0.2',
    identity: makeRequest().identity,
    generation: activation.generation,
    keys: [
      { id: 'host-key-1', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    ],
    mandatoryDigests: [digestJson(baseline)],
    maxAgeMs: 60_000,
  });
  const payload: Immutable<PolicyReleasePayload> = {
    contractVersion: '0.2',
    rootDigest: digestJson(root),
    bundles: [root, baseline],
    profile: context.profile,
    schemaArtifacts: artifacts,
    activation,
    issuedAt: now,
    expiresAt: options.expiresAt ?? now + 60_000,
  };
  return {
    now,
    baseline,
    root,
    resolved,
    trust,
    payload,
    privatePem,
    release: signPolicyRelease(payload, privatePem, 'host-key-1'),
  };
}
