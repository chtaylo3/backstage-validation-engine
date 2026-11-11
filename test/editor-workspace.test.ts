import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, unlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFilesystemSource } from '../src/lsp/filesystem.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { approvedFilesystemUri } from '../src/lsp/discovery.js';
import { filesystemFixture } from './harness/filesystem-fixture.js';
import { componentText, policyRun, localTeam } from './harness/policy-fixture.js';
import { startLspClient } from './harness/lsp-client.js';
import { fixPolicy } from './harness/fix-fixture.js';
import { URI } from './helpers.js';
import {
  CompletionRequest,
  HoverRequest,
  DidOpenTextDocumentNotification,
} from 'vscode-languageserver/node';

void test('discovery captures new matching files, excludes dependencies, and records deletion', async (t) => {
  const f = await filesystemFixture(t, { rules: [] });
  const config = parseLspConfig({
    ...f.config,
    filesystem: {
      ...f.config.filesystem,
      discovery: { roots: [f.config.source.rootUri], include: ['**/catalog-info.yaml'] },
    },
  });
  await mkdir(path.join(f.root, 'service'));
  await mkdir(path.join(f.root, 'node_modules/dependency'), { recursive: true });
  await writeFile(path.join(f.root, 'service/catalog-info.yaml'), componentText());
  await writeFile(path.join(f.root, 'node_modules/dependency/catalog-info.yaml'), 'bad');
  await writeFile(path.join(f.root, 'service/secrets.txt'), 'not a catalog');
  const source = await createFilesystemSource(config);
  t.after(() => source.close());
  const capture = await source.capture(f.source, { deadlineAt: Date.now() + 5000 });
  assert(capture.files.some((file) => file.uri === f.uri('service/catalog-info.yaml')));
  assert(capture.entrypoints?.includes(f.uri('service/catalog-info.yaml')));
  assert(!capture.files.some((file) => file.uri.includes('node_modules')));
  assert(!approvedFilesystemUri(config, f.uri('service/secrets.txt')));
  assert(
    !approvedFilesystemUri(
      config,
      pathToFileURL(path.join(f.directory, 'outside/catalog-info.yaml')).href,
    ),
  );
  await unlink(path.join(f.root, 'service/catalog-info.yaml'));
  const next = await source.capture(capture, { deadlineAt: Date.now() + 5000 });
  assert(!next.files.some((file) => file.uri === f.uri('service/catalog-info.yaml')));
});

void test('discovery rejects a matched symbolic link and keeps exact-only defaults', async (t) => {
  const f = await filesystemFixture(t, { rules: [] });
  await writeFile(path.join(f.root, 'catalog-info.yaml'), componentText());
  const exact = await createFilesystemSource(f.config);
  t.after(() => exact.close());
  assert.equal((await exact.capture(f.source, { deadlineAt: Date.now() + 5000 })).files.length, 1);
  if (process.platform === 'win32') return;
  const config = parseLspConfig({
    ...f.config,
    filesystem: {
      ...f.config.filesystem,
      discovery: { roots: [f.config.source.rootUri], include: ['**/linked.yaml'] },
    },
  });
  await symlink(path.join(f.root, 'catalog.yaml'), path.join(f.root, 'linked.yaml'));
  const discovery = await createFilesystemSource(config);
  t.after(() => discovery.close());
  await assert.rejects(discovery.capture(f.source, { deadlineAt: Date.now() + 5000 }));
});

void test('discovery configuration rejects traversal and roots outside the trusted source root', async (t) => {
  const f = await filesystemFixture(t, { rules: [] });
  for (const discovery of [
    { roots: [f.config.source.rootUri], include: ['../*.yaml'] },
    { roots: ['file:///outside/'], include: ['**/*.yaml'] },
  ])
    assert.throws(() =>
      parseLspConfig({ ...f.config, filesystem: { ...f.config.filesystem, discovery } }),
    );
});

void test('stdio completion and hover work on unfinished YAML while authoritative validation reports syntax', async (t) => {
  const text = componentText()
    .replace('  lifecycle: production\n', '')
    .replace('  owner: team\n', '  li');
  const run = policyRun({ text, rules: [] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    debounceMs: 0,
  });
  const host = await startLspClient(t, config);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text },
  });
  const syntax = await host.waitFor((row) => row.uri === URI && row.version === 1);
  assert(
    syntax.diagnostics.some(
      (row) =>
        row.code === 'yaml/syntax' && typeof row.message === 'string' && row.message.length > 0,
    ),
  );
  const result = await host.client.sendRequest(CompletionRequest.type, {
    textDocument: { uri: URI },
    position: { line: 5, character: 4 },
  });
  assert(result && 'items' in result && result.items.some((item) => item.label === 'lifecycle'));
  const hover = await host.client.sendRequest(HoverRequest.type, {
    textDocument: { uri: URI },
    position: { line: 4, character: 3 },
  });
  assert(hover && typeof hover.contents === 'object' && 'value' in hover.contents);
  assert('kind' in hover.contents);
  assert.equal(hover.contents.kind, 'plaintext');
  assert.match(hover.contents.value, /The type of component\./u);
});

void test('trusted configuration reload changes policy without replacing the server and fails closed until repaired', async (t) => {
  const text = componentText().replace('production', '');
  const create = (value: string) => {
    const run = policyRun({ text, ...fixPolicy(value) });
    return parseLspConfig({
      ...run.context,
      identity: run.request.identity,
      source: run.request.source,
      debounceMs: 0,
    });
  };
  const config = create('production');
  const host = await startLspClient(t, config);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text },
  });
  await host.waitFor((row) => row.uri === URI && row.version === 1);
  const complete = () =>
    host.client.sendRequest(CompletionRequest.type, {
      textDocument: { uri: URI },
      position: { line: 5, character: 13 },
    });
  const initial = await complete();
  assert(
    initial && 'items' in initial && initial.items.some((item) => item.label === 'production'),
  );
  let after = host.diagnostics.length;
  await writeFile(host.configPath, JSON.stringify(create('internal')));
  assert.deepEqual(
    await host.client.sendRequest('bve/reloadConfiguration', { path: '/untrusted/ignored' }),
    { reloaded: true },
  );
  await host.waitFor(
    (row) =>
      row.uri === URI &&
      row.version === 1 &&
      !row.diagnostics.some((item) => item.code === 'validation/incomplete'),
    after,
  );
  const changed = await complete();
  assert(changed && 'items' in changed);
  assert.deepEqual(
    changed.items.map((item) => item.label),
    ['internal'],
  );
  after = host.diagnostics.length;
  await writeFile(host.configPath, '{');
  assert.deepEqual(await host.client.sendRequest('bve/reloadConfiguration'), { reloaded: false });
  await host.waitFor(
    (row) => row.diagnostics.some((item) => item.code === 'validation/incomplete'),
    after,
  );
  const unavailable = await complete();
  assert(unavailable && 'items' in unavailable && unavailable.items.length === 0);
  await writeFile(host.configPath, JSON.stringify(config));
  assert.deepEqual(await host.client.sendRequest('bve/reloadConfiguration'), { reloaded: true });
});

void test('catalog search works from the pinned workspace without opening a document', async (t) => {
  const run = policyRun({ rules: [], files: [localTeam] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  const host = await startLspClient(t, config);
  const result = await host.client.sendRequest('bve/searchReferences', {
    kind: 'group',
    namespace: 'default',
    prefix: 'te',
  });
  assert.deepEqual(result, [{ reference: 'group:default/team', source: 'Workspace source' }]);
});

void test('the stdio host automatically reloads its fixed configuration path and recovers after invalid JSON', async (t) => {
  const text = componentText().replace('production', '');
  const create = (value: string) => {
    const run = policyRun({ text, ...fixPolicy(value) });
    return parseLspConfig({
      ...run.context,
      identity: run.request.identity,
      source: run.request.source,
      debounceMs: 0,
    });
  };
  const host = await startLspClient(t, create('production'));
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text },
  });
  await host.waitFor((row) => row.uri === URI && row.version === 1);
  let after = host.diagnostics.length;
  await writeFile(host.configPath, JSON.stringify(create('internal')));
  await host.waitFor(
    (row) =>
      row.uri === URI && !row.diagnostics.some((item) => item.code === 'validation/incomplete'),
    after,
  );
  const result = await host.client.sendRequest(CompletionRequest.type, {
    textDocument: { uri: URI },
    position: { line: 5, character: 13 },
  });
  assert(result && 'items' in result);
  assert.deepEqual(
    result.items.map((item) => item.label),
    ['internal'],
  );
  after = host.diagnostics.length;
  await writeFile(host.configPath, '{');
  await host.waitFor(
    (row) => row.diagnostics.some((item) => item.code === 'validation/incomplete'),
    after,
  );
  after = host.diagnostics.length;
  await writeFile(host.configPath, JSON.stringify(create('production')));
  await host.waitFor(
    (row) =>
      row.uri === URI && !row.diagnostics.some((item) => item.code === 'validation/incomplete'),
    after,
  );
});
