import {
  CONTRACT_VERSION,
  DEFAULT_DEPLOYMENT_PROFILE,
  createDataSnapshot,
  createSourceSnapshot,
  digestJson,
  parseContract,
} from '../src/index.js';
import type { Coverage, PolicyBundle, RuleState, ValidationRequest } from '../src/index.js';

export const NOW = 1_793_188_800_000;
export const URI = 'file:///workspace/catalog-info.yaml';
export const verifiedCoverage: Coverage[] = [
  { stage: 'rules', subject: 'component:default/example', required: true, status: 'verified' },
];
export const passingState: RuleState = {
  ruleId: 'owner-required',
  subjectId: 'component:default/example',
  required: true,
  status: 'passed',
};
export const policy: PolicyBundle = {
  contractVersion: CONTRACT_VERSION,
  id: 'organization-baseline',
  revision: 'governance-revision-1',
  extends: [],
  rules: [
    {
      id: 'owner-required',
      version: '1',
      kind: 'cel',
      mandatory: true,
      severity: 'error',
      requires: [],
      expression: 'has(entity.spec.owner)',
    },
  ],
  schemas: [],
  plugins: [],
};

export function makeContext() {
  const profile = DEFAULT_DEPLOYMENT_PROFILE;
  const activation = parseContract('activation-manifest', {
    contractVersion: CONTRACT_VERSION,
    generation: 1,
    installationId: 'installation-1',
    repositoryId: 'repository-1',
    policyDigest: digestJson(policy),
    profileDigest: digestJson(profile),
    bypassDigest: digestJson([]),
    activatedAt: NOW - 1000,
    authority: {
      repository: 'https://github.com/example/governance',
      revision: 'governance-revision-1',
      verifierId: 'test-verifier',
      evidenceDigest: digestJson({ fixture: true }),
    },
  });
  return { profile, policy, activation };
}

export function makeRequest(mode: ValidationRequest['execution']['mode'] = 'ci') {
  const context = makeContext();
  return parseContract('validation-request', {
    contractVersion: CONTRACT_VERSION,
    run: { runId: 'run-1', attemptId: 'attempt-1', generation: 1 },
    execution: { mode, startedAt: NOW, deadlineAt: NOW + 5000 },
    identity: {
      installationId: 'installation-1',
      repositoryId: 'repository-1',
      authorityRef: 'test-verifier/identity-1',
      permissionRevision: 'permissions-1',
    },
    source: createSourceSnapshot({
      repository: 'https://github.com/example/application',
      revision: 'source-revision-1',
      files: [{ uri: URI, text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\n' }],
    }),
    policy: { digest: digestJson(context.policy), revision: context.policy.revision },
    profile: { digest: digestJson(context.profile), id: context.profile.id },
    activation: { digest: digestJson(context.activation), generation: 1 },
    data: createDataSnapshot([]),
  });
}
