import path from 'node:path';
import type { TestContext } from 'node:test';
import { stringify } from 'yaml';
import {
  createCatalogProvider,
  createSourceSnapshot,
  digestJson,
  parseContract,
} from '../../src/index.js';
import type {
  CatalogProvider,
  DeploymentProfile,
  Immutable,
  PolicyBundle,
  SchemaArtifact,
  SourceInput,
  SourceSnapshot,
} from '../../src/index.js';
import { makeContext, makeRequest, URI } from '../helpers.js';
import { startFakeBackstage } from './fake-backstage.js';
import { startFixtureMatrix } from './fixture-matrix.js';
import { loadPinnedMatrix } from './pinned-matrix.js';

export const ownerRule = {
  id: 'owner-exists',
  version: '1',
  kind: 'catalog',
  check: 'exists',
  referencePath: '/spec/owner',
  mandatory: true,
  severity: 'error',
  requires: [] as string[],
  selector: 'entity.kind == "Component"',
} as const;
export const team = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name: 'team' },
  spec: { type: 'team', children: [] },
};
export const componentText = (owner = 'team', extra = '') =>
  'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service}\nspec:\n  type: service\n  lifecycle: production\n  owner: ' +
  owner +
  '\n' +
  extra;

export function policyRun(
  options: {
    text?: string;
    rules?: readonly PolicyBundle['rules'][number][];
    mode?: 'ci' | 'ide';
    files?: readonly SourceInput[];
    profile?: Partial<DeploymentProfile>;
    rootUri?: string;
    entrypoints?: readonly string[];
    schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
    baseline?: Immutable<SourceSnapshot>;
    source?: Immutable<SourceSnapshot>;
  } = {},
) {
  const base = makeContext();
  const profile = parseContract('deployment-profile', { ...base.profile, ...options.profile });
  const policy = parseContract('policy-bundle', {
    ...base.policy,
    rules: options.rules ?? [ownerRule],
  });
  const activation = parseContract('activation-manifest', {
    ...base.activation,
    policyDigest: digestJson(policy),
    profileDigest: digestJson(profile),
  });
  const source =
    options.source ??
    createSourceSnapshot({
      repository: 'repository',
      revision: '1',
      ...(options.rootUri === undefined ? {} : { rootUri: options.rootUri }),
      ...(options.entrypoints === undefined ? {} : { entrypoints: options.entrypoints }),
      files: [
        { uri: URI, text: options.text ?? componentText(), version: 1, origin: 'buffer' },
        ...(options.files ?? []),
      ],
    });
  const now = Date.now();
  const request = parseContract('validation-request', {
    ...makeRequest(options.mode ?? 'ide'),
    source,
    ...(options.baseline ? { baseline: options.baseline } : {}),
    execution: { mode: options.mode ?? 'ide', startedAt: now, deadlineAt: now + 5000 },
    policy: { digest: digestJson(policy), revision: policy.revision },
    profile: { id: profile.id, digest: digestJson(profile) },
    activation: { generation: activation.generation, digest: digestJson(activation) },
  });
  return {
    request,
    context: { profile, policy, activation, schemaArtifacts: options.schemaArtifacts ?? [] },
  };
}
export const localTeam = { uri: 'file:///workspace/team.yaml', text: stringify(team) };

export async function policyMatrix(t: TestContext) {
  const root = path.resolve('test/fixtures/backstage');
  const matrix = await startFixtureMatrix(await loadPinnedMatrix(root), root, (artifact) =>
    startFakeBackstage(artifact, {
      entities: [team],
      principals: [
        { token: 'policy-test-secret', principalId: 'reader', canRead: true, visibleRefs: '*' },
      ],
    }),
  );
  const providers: CatalogProvider[] = [];
  t.after(async () => {
    try {
      await Promise.all(providers.map((provider) => provider.close()));
    } finally {
      await matrix.close();
      for (const { fixture } of matrix.fixtures) fixture.assertHealthy();
    }
  });
  return {
    fixtures: matrix.fixtures,
    async catalog(run: ReturnType<typeof policyRun>, index = 0) {
      const provider = await createCatalogProvider({
        connectionId: 'primary',
        baseUrl: matrix.fixtures[index]!.fixture.baseUrl,
        adapterId: run.context.profile.adapterId,
        limits: { retries: 0 },
        credentials: (access) =>
          Promise.resolve({
            token: 'policy-test-secret',
            installationId: access.installationId,
            principalId: access.principalId,
            permissionRevision: access.permissionRevision,
            credentialRevision: access.credentialRevision,
            scope: access.scope,
          }),
      });
      providers.push(provider);
      return {
        provider,
        access: {
          installationId: run.request.identity.installationId,
          principalId: 'reader',
          permissionRevision: run.request.identity.permissionRevision,
          credentialRevision: '1',
          scope: ['catalog:read'],
          profileDigest: run.request.profile.digest,
          policyDigest: run.request.policy.digest,
          maxAgeMs: 0,
        },
      };
    },
  };
}
