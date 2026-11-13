import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachLspServer } from '../../src/lsp/server.js';
import {
  STAR,
  fakeConfig,
  fakeConnection,
  fakeFilesystem,
} from '../harness/lsp-fake-connection.js';

/**
 * The protocol surface of the language server: every request and notification method it
 * registers, by the connection member it registers through. The committed list was generated
 * from the server before it was split into handler modules. The list is sorted by method,
 * because dispatch is by method name and each method has exactly one handler, so the
 * registration order cannot affect which handler runs. Regenerate only with
 * BVE_UPDATE_LSP_GOLDEN=1, then format the file with Prettier, and only when a plan names a
 * protocol change.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const INVENTORY = path.join(repository, 'test/fixtures/lsp-handlers.json');

function inventory(options: { filesystem: boolean }) {
  const fake = fakeConnection();
  const server = attachLspServer(
    fake.connection,
    fakeConfig({ filesystem: options.filesystem }),
    options.filesystem ? { filesystem: fakeFilesystem() } : {},
  );
  return { server, registrations: fake.registrations };
}
const rows = (registrations: ReturnType<typeof inventory>['registrations']) =>
  registrations
    .map(({ method, kind, registrar }) => ({ method, kind, registrar }))
    .sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0));

void test('the registered request and notification methods equal the committed inventory', async () => {
  const { server, registrations } = inventory({ filesystem: false });
  const observed = `${JSON.stringify(rows(registrations), null, 2)}\n`;
  if (process.env.BVE_UPDATE_LSP_GOLDEN === '1') await writeFile(INVENTORY, observed);
  assert.equal(
    JSON.stringify(JSON.parse(observed)),
    JSON.stringify(JSON.parse(await readFile(INVENTORY, 'utf8'))),
  );
  await server.close();
});

void test('every method is registered exactly once, with or without the filesystem reader', async () => {
  const hosts = [inventory({ filesystem: false }), inventory({ filesystem: true })];
  for (const { registrations } of hosts) {
    const methods = registrations.map((row) => row.method);
    assert.deepEqual(
      methods.filter((method, index) => methods.indexOf(method) !== index),
      [],
    );
  }
  assert.deepEqual(
    rows(hosts[0]!.registrations),
    rows(hosts[1]!.registrations),
    'the protocol surface does not depend on host resources',
  );
  for (const { server } of hosts) await server.close();
});

void test('the catch-all request handler is registered', async () => {
  const { server, registrations } = inventory({ filesystem: false });
  const star = registrations.filter((row) => row.method === STAR);
  assert.equal(star.length, 1);
  assert.equal(star[0]!.registrar, 'onRequest');
  assert.equal(star[0]!.kind, 'request');
  await server.close();
});
