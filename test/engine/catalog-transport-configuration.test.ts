import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogProvider, digestJson } from '../../src/index.js';
import type { CatalogAccessContext, CatalogProviderOptions } from '../../src/index.js';
import { createLspCatalog, parseLspConfig } from '../../src/lsp/config.js';
import { policyRun } from '../harness/policy-fixture.js';

const baseUrl = 'http://backstage:7007/api/catalog';
function options(): CatalogProviderOptions {
  return {
    connectionId: 'private-compose',
    baseUrl,
    adapterId: '@backstage/catalog-model@1.10.2',
    credentials: (access) =>
      Promise.resolve({
        token: 'synthetic-transport-token',
        installationId: access.installationId,
        principalId: access.principalId,
        permissionRevision: access.permissionRevision,
        credentialRevision: access.credentialRevision,
        scope: access.scope,
      }),
  };
}

void test('non-loopback HTTP requires an explicit boolean approval from the provider host', async () => {
  for (const allowInsecureHttp of [undefined, false])
    await assert.rejects(
      createCatalogProvider({
        ...options(),
        ...(allowInsecureHttp === undefined ? {} : { allowInsecureHttp }),
      }),
      /trusted catalog provider configuration/u,
    );
  for (const value of ['true', 1, null])
    await assert.rejects(
      createCatalogProvider({
        ...options(),
        allowInsecureHttp: value,
      } as unknown as CatalogProviderOptions),
      /configuration/u,
    );
  for (const endpoint of [
    'file:///tmp/catalog',
    'ftp://backstage/catalog',
    'http://token@backstage:7007/api/catalog',
    baseUrl + '?token=secret',
    baseUrl + '#fragment',
  ])
    await assert.rejects(
      createCatalogProvider({ ...options(), baseUrl: endpoint, allowInsecureHttp: true }),
      /configuration/u,
    );
});

void test('approved private HTTP keeps the host endpoint and credential binding for actual transport calls', async (t) => {
  const run = policyRun();
  const access: CatalogAccessContext = {
    installationId: run.request.identity.installationId,
    principalId: 'reader',
    permissionRevision: run.request.identity.permissionRevision,
    credentialRevision: '1',
    scope: ['catalog:read'],
    policyDigest: digestJson(run.context.policy),
    profileDigest: digestJson(run.context.profile),
    maxAgeMs: 0,
  };
  let calls = 0;
  const provider = await createCatalogProvider({
    ...options(),
    allowInsecureHttp: true,
    transport: (input, init) => {
      calls++;
      const endpoint =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      assert.equal(endpoint, baseUrl + '/entities/by-name/group/default/team');
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer synthetic-transport-token',
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: { name: 'team' },
            spec: { type: 'team', children: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  });
  t.after(() => provider.close());
  const report = await provider.lookup(['group:default/team'], access, {
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(report.data.entries[0]?.status, 'present');
  assert.equal(calls, 1);
  const untrustedAccess = { ...access, allowInsecureHttp: true };
  await assert.rejects(
    provider.lookup(['group:default/team'], untrustedAccess, { deadlineAt: Date.now() + 5000 }),
    /configuration/u,
  );
  assert.equal(calls, 1, 'Lookup input cannot change the trusted transport policy.');
});

function launcher() {
  const run = policyRun();
  return {
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    catalog: {
      connectionId: 'private-compose',
      baseUrl,
      principalId: 'reader',
      credentialRevision: '1',
      scope: ['catalog:read'],
      maxAgeMs: 0,
      tokenEnv: 'BVE_TRANSPORT_TOKEN',
    },
  };
}
void test('trusted LSP and CLI catalog configuration forwards explicit HTTP approval and rejects malformed options', async () => {
  const initial = launcher();
  const environment = { BVE_TRANSPORT_TOKEN: 'synthetic-transport-token' };
  await assert.rejects(createLspCatalog(parseLspConfig(initial), environment), /configuration/u);
  const config = parseLspConfig({
    ...initial,
    catalog: { ...initial.catalog, allowInsecureHttp: true },
  });
  const catalog = await createLspCatalog(config, environment);
  assert(catalog);
  try {
    assert.equal(config.catalog?.allowInsecureHttp, true);
    assert.equal(catalog.provider.connectionId, 'private-compose');
    assert(Object.isFrozen(config.catalog));
  } finally {
    await catalog.provider.close();
  }
  for (const value of ['true', 1, null])
    assert.throws(
      () =>
        parseLspConfig({ ...initial, catalog: { ...initial.catalog, allowInsecureHttp: value } }),
      /trusted LSP configuration/u,
    );
  assert.throws(
    () => parseLspConfig({ ...initial, allowInsecureHttp: true }),
    /trusted LSP configuration/u,
  );
});
