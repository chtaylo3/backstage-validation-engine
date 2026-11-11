import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, rename, symlink, unlink } from 'node:fs/promises';
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
  const exact = 'policy-test-secret' + ' '.repeat(16384 - 'policy-test-secret'.length);
  assert.equal(Buffer.byteLength(exact), 16384);
  await writeFile(tokenFile, exact);
  const atLimit = (await createLspCatalog(config, {}))!;
  t.after(() => atLimit.provider.close());
  assert.equal((await lookup()).data.entries[0]?.status, 'present');
  assert.equal(
    (
      await atLimit.provider.lookup(['group:default/team'], atLimit.access, {
        deadlineAt: Date.now() + 5000,
      })
    ).data.entries[0]?.status,
    'present',
  );
  const replacement = path.join(directory, 'replacement');
  await writeFile(replacement, 'revoked-token');
  await rename(replacement, tokenFile);
  assert((await lookup()).failures.some((failure) => failure.code === 'permission_denied'));
  await writeFile(replacement, 'policy-test-secret');
  await rename(replacement, tokenFile);
  assert.equal((await lookup()).data.entries[0]?.status, 'present');
  await t.test(
    'symbolic credentials are rejected before capture and after replacement',
    async (t) => {
      await writeFile(replacement, 'policy-test-secret');
      await unlink(tokenFile);
      try {
        await symlink(replacement, tokenFile);
      } catch (error) {
        if (
          process.platform === 'win32' &&
          ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
        ) {
          await rename(replacement, tokenFile);
          t.skip('The operating system denied symbolic-link creation.');
          return;
        }
        throw error;
      }
      await assert.rejects(
        createLspCatalog(config, {}),
        /^Error: Configured catalog credential is unavailable\.$/u,
      );
      const denied = await lookup();
      assert.equal(denied.data.entries[0]?.status, 'unavailable');
      await unlink(tokenFile);
      await rename(replacement, tokenFile);
      assert.equal((await lookup()).data.entries[0]?.status, 'present');
    },
  );
});
