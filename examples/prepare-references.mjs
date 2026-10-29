import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createCatalogProvider,
  createSourceSnapshot,
  parseContract,
  prepareBackstageReferenceData,
} from '../dist/index.js';

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error('Pass the catalog base URL printed by npm run fixtures:serve.');
const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./contracts/${name}.json`, import.meta.url), 'utf8'));
const template = await fixture('validation-request');
const context = {
  profile: await fixture('deployment-profile'),
  policy: await fixture('policy-bundle'),
  activation: await fixture('activation-manifest'),
};
const source = createSourceSnapshot({
  repository: template.source.repository,
  revision: 'synthetic-reference-example',
  files: [
    {
      uri: 'file:///workspace/catalog-info.yaml',
      origin: 'buffer',
      version: 7,
      text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: example\nspec:\n  type: service\n  lifecycle: production\n  owner: Team\n  providesApis: [Missing]\n',
    },
  ],
});
const startedAt = Date.now();
const request = parseContract('validation-request', {
  ...template,
  source,
  run: { ...template.run, runId: randomUUID() },
  execution: { mode: 'ide', startedAt, deadlineAt: startedAt + 5000 },
});
const access = {
  installationId: request.identity.installationId,
  principalId: 'fixture-developer',
  permissionRevision: request.identity.permissionRevision,
  credentialRevision: 'fixture-credentials-1',
  scope: ['catalog:read'],
  policyDigest: request.policy.digest,
  profileDigest: request.profile.digest,
  maxAgeMs: 5000,
};
const provider = await createCatalogProvider({
  connectionId: 'local-fixture',
  baseUrl,
  adapterId: context.profile.adapterId,
  credentials: () =>
    Promise.resolve({
      token: 'development-only-token',
      installationId: access.installationId,
      principalId: access.principalId,
      permissionRevision: access.permissionRevision,
      credentialRevision: access.credentialRevision,
      scope: access.scope,
    }),
});
try {
  const report = await prepareBackstageReferenceData(request, context, { provider, access });
  console.log(
    JSON.stringify(
      {
        scope:
          'Source-reference observations; existence policy and full ingestion remain separate stages.',
        references: report.compatibility.references,
        observations: report.observations,
        findings: report.compatibility.findings,
        interrupted: report.interrupted,
        pinned: Boolean(report.evaluationRequest),
        originalDeadlineAt: request.execution.deadlineAt,
        evaluationDeadlineAt: report.evaluationRequest?.execution.deadlineAt,
        sourceDigest: report.compatibility.sourceDigest,
      },
      null,
      2,
    ),
  );
} finally {
  await provider.close();
}
