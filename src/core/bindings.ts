import type {
  ActivationManifest,
  DeploymentProfile,
  PolicyBundle,
  ValidationRequest,
} from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { reject } from './errors.js';
import { digestJson } from './json.js';
import type { Immutable } from './json.js';
import { orderRules } from '../policy/rule-graph.js';

/**
 * Checks pinned artifact consistency after a trusted adapter verifies authority.
 * This does not verify signatures, assignments, inherited policies or permissions.
 */
export function verifyRequestBindings(
  request: Immutable<ValidationRequest>,
  context: {
    readonly profile: Immutable<DeploymentProfile>;
    readonly policy: Immutable<PolicyBundle>;
    readonly activation: Immutable<ActivationManifest>;
  },
): void {
  const run = parseContract('validation-request', request);
  const profile = parseContract('deployment-profile', context.profile);
  const policy = parseContract('policy-bundle', context.policy);
  const activation = parseContract('activation-manifest', context.activation);
  if (
    digestJson(profile) !== run.profile.digest ||
    profile.id !== run.profile.id ||
    digestJson(policy) !== run.policy.digest ||
    policy.revision !== run.policy.revision ||
    digestJson(activation) !== run.activation.digest
  ) {
    reject('integrity', '', 'pinned artifact does not match request');
  }
  if (
    activation.policyDigest !== run.policy.digest ||
    activation.profileDigest !== run.profile.digest ||
    activation.generation !== run.run.generation ||
    activation.installationId !== run.identity.installationId ||
    activation.repositoryId !== run.identity.repositoryId
  ) {
    reject('integrity', '/activation', 'activation does not bind this run');
  }
  if (
    run.execution.deadlineAt - run.execution.startedAt > profile.limits.requestTimeoutMs ||
    [...run.source.files, ...(run.baseline?.files ?? [])].some(
      (file) => Buffer.byteLength(file.text, 'utf8') > profile.limits.fileBytes,
    ) ||
    [...run.source.files, ...(run.baseline?.files ?? [])].reduce(
      (bytes, file) => bytes + Buffer.byteLength(file.text, 'utf8'),
      0,
    ) > profile.limits.requestBytes ||
    policy.rules.length > profile.limits.rules
  ) {
    reject('limit', '', 'request exceeds assigned profile budgets');
  }
  if (policy.extends.length === 0) orderRules(policy.rules, profile.limits.graphDepth);
  for (const rule of policy.rules) {
    if (
      rule.kind === 'catalog' &&
      !profile.referenceContexts.some((reference) => reference.path === rule.referencePath)
    ) {
      reject('invalid_policy', '/rules', 'catalog rule must bind a declared reference context');
    }
  }
}
