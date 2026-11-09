import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLspCatalog, parseLspConfig } from '../src/lsp/config.js';
import { policyRun, policyMatrix } from './harness/policy-fixture.js';

void test('catalog credential files rotate between authenticated requests without replacing the provider', async (t) => {
  const matrix = await policyMatrix(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-editor-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'credential');
  await writeFile(tokenFile, 'policy-test-secret\n', { mode: 0o600 });
  const run = policyRun({ rules: [] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    catalog: {
      connectionId: 'primary',
      baseUrl: matrix.fixtures[0]!.fixture.baseUrl,
      principalId: 'reader',
      credentialRevision: '1',
      scope: ['catalog:read'],
      maxAgeMs: 0,
      tokenFile,
    },
  });
  const catalog = (await createLspCatalog(config, {}))!;
  t.after(() => catalog.provider.close());
  const lookup = () =>
    catalog.provider.lookup(['group:default/team'], catalog.access, {
      deadlineAt: Date.now() + 5000,
    });
  assert.equal((await lookup()).data.entries[0]?.status, 'present');
  await writeFile(tokenFile, 'revoked-token');
  assert((await lookup()).failures.some((failure) => failure.code === 'permission_denied'));
  await writeFile(tokenFile, 'policy-test-secret');
  assert.equal((await lookup()).data.entries[0]?.status, 'present');
  assert.throws(() =>
    parseLspConfig({ ...config, catalog: { ...config.catalog, tokenEnv: 'ALSO_SELECTED' } }),
  );
  assert.throws(() =>
    parseLspConfig({ ...config, catalog: { ...config.catalog, tokenFile: 'relative-path' } }),
  );
  await writeFile(tokenFile, 'x'.repeat(16 * 1024 + 1));
  await assert.rejects(createLspCatalog(config, {}));
});
