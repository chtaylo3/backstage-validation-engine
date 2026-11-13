import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { DidChangeWatchedFilesNotification } from 'vscode-languageserver/node';
import type { FilesystemObservation } from '../../src/lsp/coverage-observation.js';
import { filesystemFixture } from '../harness/filesystem-fixture.js';
import { startLspClient } from '../harness/lsp-client.js';

void test('filesystem observation is opt-in, admits only selected canonical URIs and does not itself invalidate', async (t) => {
  const f = await filesystemFixture(t, { rules: [] });
  const host = await startLspClient(t, f.config);
  const event = async (changes: { uri: string; type: 1 | 2 | 3 }[]) => {
    await host.client.sendNotification(DidChangeWatchedFilesNotification.type, { changes });
    return host.client.sendRequest<FilesystemObservation | null>('bve/filesystemObservation');
  };
  assert.equal(await event([{ uri: f.uri('catalog.yaml'), type: 2 }]), null);
  await writeFile(host.configPath, JSON.stringify({ ...f.config, coverageObservation: true }));
  assert.deepEqual(await host.client.sendRequest('bve/reloadConfiguration'), { reloaded: true });
  assert.equal(
    await host.client.sendRequest('bve/filesystemObservation'),
    null,
    'Enabling approval cannot expose a preceding event.',
  );
  const observed = await event([
    { uri: 'file:///outside/private.yaml', type: 2 },
    { uri: f.uri('unapproved.yaml'), type: 2 },
    { uri: f.uri('catalog.yaml'), type: 2 },
    { uri: f.uri('catalog.yaml').replace('catalog', '%63atalog'), type: 2 },
  ]);
  assert(observed);
  assert.deepEqual(observed.uris, [f.uri('catalog.yaml')]);
  assert.equal(observed.truncated, false);
  assert(Number.isSafeInteger(observed.generation));
  assert.deepEqual(
    await host.client.sendRequest('bve/filesystemObservation', { path: '/ignored', force: true }),
    observed,
  );
  assert.deepEqual(await event([{ uri: 'file:///outside/private.yaml', type: 2 }]), observed);
  const bounded = await event(
    Array.from({ length: 1000 }, () => ({ uri: f.uri('catalog.yaml'), type: 2 })),
  );
  assert(bounded);
  assert.equal(bounded.uris.length, 32);
  assert(bounded.truncated);
  assert(Buffer.byteLength(bounded.uris.join(''), 'utf8') <= 65536);
  assert(bounded.generation > observed.generation);
  const coalesced = await event(
    Array.from({ length: 1001 }, () => ({ uri: 'file:///outside/private.yaml', type: 2 })),
  );
  assert(coalesced);
  assert.deepEqual(coalesced.uris, []);
  assert(coalesced.truncated);
  assert(coalesced.generation > bounded.generation);
  await writeFile(host.configPath, '{');
  assert.deepEqual(await host.client.sendRequest('bve/reloadConfiguration'), { reloaded: false });
  assert.equal(await host.client.sendRequest('bve/filesystemObservation'), null);
  await writeFile(host.configPath, JSON.stringify({ ...f.config, coverageObservation: true }));
  assert.deepEqual(await host.client.sendRequest('bve/reloadConfiguration'), { reloaded: true });
  assert.equal(
    await host.client.sendRequest('bve/filesystemObservation'),
    null,
    'Replacement discards the previous session observation.',
  );
});

void test('filesystem observation applies its UTF-8 byte bound before the URI count bound', async (t) => {
  const f = await filesystemFixture(t, { rules: [] });
  const longUris = Array.from(
    { length: 32 },
    (_, index) => f.config.source.rootUri! + 'x'.repeat(2200) + index + '.yaml',
  );
  const config = {
    ...f.config,
    coverageObservation: true,
    filesystem: { ...f.config.filesystem!, files: [...f.config.filesystem!.files, ...longUris] },
  };
  const host = await startLspClient(t, config);
  await host.client.sendNotification(DidChangeWatchedFilesNotification.type, {
    changes: longUris.map((uri) => ({ uri, type: 2 as const })),
  });
  const receipt = await host.client.sendRequest<FilesystemObservation>('bve/filesystemObservation');
  assert(receipt.truncated);
  assert(
    receipt.uris.length > 0 && receipt.uris.length < 32,
    'The byte limit must bind before the independent count limit.',
  );
  assert(Buffer.byteLength(receipt.uris.join(''), 'utf8') <= 65536);
  assert(
    Buffer.byteLength([...receipt.uris, longUris[receipt.uris.length]!].join(''), 'utf8') > 65536,
  );
});
