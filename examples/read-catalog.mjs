import { createCatalogProvider, DEFAULT_DEPLOYMENT_PROFILE, digestJson } from '../dist/index.js';

const baseUrl = process.argv[2];
if (!baseUrl)
  throw new Error('Pass a running fixture catalog base URL from npm run fixtures:serve.');
const access = {
  installationId: 'local-demo',
  principalId: 'fixture-developer',
  permissionRevision: 'fixture-permissions-1',
  credentialRevision: 'fixture-credentials-1',
  scope: ['catalog:read'],
  policyDigest: digestJson({ example: 'catalog-read' }),
  profileDigest: digestJson(DEFAULT_DEPLOYMENT_PROFILE),
  maxAgeMs: 5000,
};
const provider = await createCatalogProvider({
  connectionId: 'local-fixture',
  baseUrl,
  adapterId: '@backstage/catalog-model@1.10.2',
  credentials: () =>
    Promise.resolve({
      installationId: access.installationId,
      principalId: access.principalId,
      permissionRevision: access.permissionRevision,
      credentialRevision: access.credentialRevision,
      scope: access.scope,
      token: 'development-only-token',
    }),
});
try {
  const report = await provider.lookup(
    ['group:default/team', 'component:default/service', 'group:default/missing'],
    access,
    { deadlineAt: Date.now() + 5000 },
  );
  console.log(
    JSON.stringify({ scope: 'catalog observations; no enforcement verdict', ...report }, null, 2),
  );
} finally {
  await provider.close();
}
