import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { createConnection } from 'vscode-languageserver';
import {
  CompletionRequest,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  CancellationTokenSource,
  createProtocolConnection,
  InitializeRequest,
  PublishDiagnosticsNotification,
  HoverRequest,
} from 'vscode-languageserver/node';
import type { CompletionList } from 'vscode-languageserver/node';
import { BACKSTAGE_ADAPTER_IDS, createSourceSnapshot, digestText } from '../../src/index.js';
import { parseLspConfig } from '../../src/lsp/config.js';
import {
  componentText,
  localTeam,
  policyRun,
  policyMatrix,
  team,
  ownerRule,
} from '../harness/policy-fixture.js';
import { startLspClient } from '../harness/lsp-client.js';
import { filesystemFixture } from '../harness/filesystem-fixture.js';
import { URI } from '../helpers.js';
import { attachLspServer } from '../../src/lsp/server.js';
import type { CatalogProvider } from '../../src/index.js';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

function config(options: Parameters<typeof policyRun>[0] = {}, baseUrl?: string) {
  const run = policyRun({ text: componentText('te'), rules: [], files: [localTeam], ...options });
  return parseLspConfig({
    ...run.context,
    source: run.request.source,
    identity: run.request.identity,
    debounceMs: 0,
    ...(baseUrl
      ? {
          catalog: {
            connectionId: 'primary',
            baseUrl,
            principalId: 'reader',
            credentialRevision: '1',
            scope: ['catalog:read'],
            maxAgeMs: 5000,
            tokenEnv: 'BVE_TEST_TOKEN',
          },
        }
      : {}),
  });
}
type Host = Awaited<ReturnType<typeof startLspClient>>;
async function open(host: Host, uri = URI, version = 1, text = componentText('te')) {
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri, version, text, languageId: 'yaml' },
  });
  return host.waitFor((row) => row.uri === uri && row.version === version, after);
}
async function complete(host: Host, uri = URI, line = 6, character = 11) {
  const result = await host.client.sendRequest(CompletionRequest.type, {
    textDocument: { uri },
    position: { line, character },
  });
  assert(result && 'items' in result);
  return result;
}
async function eventually(work: () => Promise<CompletionList>, wanted: string) {
  const deadline = performance.now() + 10_000;
  let result = await work();
  while (!result.items.some((row) => row.label === wanted)) {
    if (performance.now() >= deadline)
      assert.fail('Timed out waiting for completion index: ' + JSON.stringify(result));
    await pause(10);
    result = await work();
  }
  return result;
}

void test('local completion stays available before held validation HTTP and follows the new source generation', async (t) => {
  const matrix = await policyMatrix(t);
  for (const { fixture, target } of matrix.fixtures)
    await t.test(target.backstageVersion, async (t) => {
      const gate = fixture.holdNext({ operation: 'byName', entityRef: 'group:default/te' });
      const host = await startLspClient(t, config({ rules: [ownerRule] }, fixture.baseUrl));
      try {
        const after = host.diagnostics.length;
        await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: { uri: URI, version: 1, text: componentText('te'), languageId: 'yaml' },
        });
        await gate.entered;
        const list = await eventually(() => complete(host), 'group:default/team');
        assert(list.items.some((row) => row.label === 'group:default/team'));
        assert.equal(
          host.diagnostics.length,
          after,
          'Local completion does not wait for validation HTTP.',
        );
        await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri: URI, version: 2 },
          contentChanges: [{ text: componentText('team') + '# current\n' }],
        });
        await gate.cancelled;
        gate.release();
        await host.waitFor((row) => row.uri === URI && row.version === 2, after);
        await eventually(() => complete(host), 'group:default/team');
        assert(!host.diagnostics.some((row) => row.uri === URI && row.version === 1));
      } finally {
        gate.release();
      }
    });
});

void test('stdio completes declared references from workspace sources on both native pins', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    await t.test(adapterId, async (t) => {
      const host = await startLspClient(t, config({ profile: { adapterId } }));
      assert.deepEqual(host.initialized.capabilities.completionProvider, {
        triggerCharacters: [':', '/'],
        resolveProvider: false,
      });
      await open(host);
      const result = await eventually(() => complete(host), 'group:default/team');
      assert.equal(result.isIncomplete, true);
      assert.deepEqual(result.items[0]?.textEdit, {
        range: { start: { line: 6, character: 9 }, end: { line: 6, character: 11 } },
        newText: 'group:default/team',
      });
      await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: URI },
      });
      assert.deepEqual((await complete(host)).items, []);
    });
});

void test('stdio background search is fresh, cached and authorization scoped on both pinned APIs', async (t) => {
  const matrix = await policyMatrix(t);
  for (const { fixture, target } of matrix.fixtures)
    await t.test(target.backstageVersion, async (t) => {
      fixture.upsert({ ...team, metadata: { name: 'te-visible' } });
      fixture.upsert({ ...team, metadata: { name: 'te-hidden' } });
      fixture.setPrincipal({
        token: 'policy-test-secret',
        principalId: 'reader',
        canRead: true,
        visibleRefs: ['group:default/te-visible'],
      });
      const host = await startLspClient(t, config({}, fixture.baseUrl));
      await open(host);
      const found = await eventually(() => complete(host), 'group:default/te-visible');
      assert.equal(found.items[0]?.label, 'group:default/team');
      assert(!found.items.some((row) => row.label === 'group:default/te-hidden'));
      const remote = found.items.find((row) => row.detail === 'Catalog (fresh)')!;
      assert(remote.data);
      const count = fixture.requests().length;
      await complete(host);
      assert.equal(fixture.requests().length, count);
      assert(!JSON.stringify(found).includes('policy-test-secret'));
      assert(fixture.requests().every((row) => row.operation === 'byQuery'));
    });
});

void test('held search does not block typing and changed epochs cancel stale completion work', async (t) => {
  const matrix = await policyMatrix(t),
    fixture = matrix.fixtures[0]!.fixture;
  const host = await startLspClient(t, config({}, fixture.baseUrl));
  await open(host);
  await eventually(() => complete(host, URI, 6, 10), 'group:default/team');
  const gate = fixture.holdNext({ operation: 'byQuery' });
  const pending = complete(host);
  await gate.entered;
  const result = await pending;
  assert.equal(result.items[0]?.label, 'group:default/team');
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text: componentText('team') + '# changed\n' }],
  });
  await gate.cancelled;
  const updated = await host.waitFor((row) => row.uri === URI && row.version === 2, after);
  assert.deepEqual(updated.diagnostics, []);
  assert.equal(
    (await eventually(() => complete(host), 'group:default/team')).items[0]?.label,
    'group:default/team',
  );
});

void test('late client cancellation preserves a completed local reply and shutdown releases a pending search', async (t) => {
  const matrix = await policyMatrix(t),
    fixture = matrix.fixtures[0]!.fixture;
  const host = await startLspClient(t, config({}, fixture.baseUrl));
  await open(host);
  await eventually(() => complete(host, URI, 6, 10), 'group:default/team');
  const gate = fixture.holdNext({ operation: 'byQuery' }),
    token = new CancellationTokenSource();
  const pending = host.client.sendRequest(
    CompletionRequest.type,
    { textDocument: { uri: URI }, position: { line: 6, character: 11 } },
    token.token,
  );
  await gate.entered;
  const result = await pending;
  assert(result && 'items' in result);
  assert.equal(result.isIncomplete, true);
  assert.equal(result.items[0]?.label, 'group:default/team');
  token.cancel();
  await gate.cancelled;
  token.dispose();
  const shutdownGate = fixture.holdNext({ operation: 'byQuery' });
  const working = complete(host);
  await shutdownGate.entered;
  await Promise.all([host.shutdown(), working, shutdownGate.cancelled]);
});

void test('LSP cancellation of an entered provider aborts its signal before publishing completion items', async (t) => {
  const selected = config();
  const inbound = new PassThrough(),
    outbound = new PassThrough();
  const token = new CancellationTokenSource();
  let entered = 0,
    cancelled = 0;
  const provider: CatalogProvider = {
    connectionId: 'test',
    adapterId: selected.profile.adapterId,
    lookup: () => Promise.reject(new Error('Completion must not perform validation lookups.')),
    suggest: (_query, _access, execution) =>
      new Promise((resolve) => {
        entered++;
        const signal = execution.signal!;
        signal.addEventListener(
          'abort',
          () => {
            cancelled++;
            resolve({
              status: 'unavailable',
              failure: 'cancelled',
              refs: [],
              truncated: false,
              fetchedAt: Date.now(),
              expiresAt: Date.now(),
            });
          },
          { once: true },
        );
        // The real JSON-RPC cancellation frame is sent at provider entry, in the
        // same event loop. A cross-process HTTP acknowledgement can arrive after
        // the intentional 50 ms local fallback and cannot establish this ordering.
        token.cancel();
      }),
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  const connection = createConnection(
    (logger) => createProtocolConnection(inbound, outbound, logger),
    { initialize: () => {}, shutdownReceived: false, exit: () => {} },
  );
  const server = attachLspServer(connection, selected, {
    catalog: {
      provider,
      access: {
        installationId: selected.identity.installationId,
        principalId: 'reader',
        permissionRevision: selected.identity.permissionRevision,
        credentialRevision: '1',
        scope: ['catalog:read'],
        policyDigest: selected.activation.policyDigest,
        profileDigest: selected.activation.profileDigest,
        maxAgeMs: 5000,
      },
    },
    dispose: () => provider.close(),
  });
  const client = createProtocolConnection(outbound, inbound);
  let published!: () => void;
  const ready = new Promise<void>((resolve) => {
    published = resolve;
  });
  client.onNotification(PublishDiagnosticsNotification.type, () => published());
  connection.listen();
  client.listen();
  t.after(async () => {
    await server.close();
    token.dispose();
    client.dispose();
    connection.dispose();
    inbound.destroy();
    outbound.destroy();
  });
  await client.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: null,
    capabilities: {},
  });
  await client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText('te') },
  });
  await ready;
  await eventually(async () => {
    const result = await client.sendRequest(CompletionRequest.type, {
      textDocument: { uri: URI },
      position: { line: 6, character: 10 },
    });
    assert(result && 'items' in result);
    return result;
  }, 'group:default/team');
  const result = await client.sendRequest(
    CompletionRequest.type,
    { textDocument: { uri: URI }, position: { line: 6, character: 11 } },
    token.token,
  );
  assert(result && 'items' in result);
  assert.deepEqual(result, { isIncomplete: true, items: [] });
  assert.equal(entered, 1);
  assert.equal(cancelled, 1);
});

void test('included YAML completion edits the open payload scalar and watch refreshes invalidate candidates', async (t) => {
  const root =
    'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service}\nspec: {$yaml: ./spec.yaml}\n';
  const spec = 'type: service\nlifecycle: production\nowner: te\n';
  const disk = await filesystemFixture(t, {
    rules: [],
    files: { 'catalog.yaml': root, 'spec.yaml': spec, 'team.yaml': localTeam.text },
    entrypoints: ['catalog.yaml', 'team.yaml'],
  });
  const host = await startLspClient(
    t,
    parseLspConfig({ ...disk.config, coverageObservation: true }),
    { watchFiles: true },
  );
  await open(host, disk.uri('catalog.yaml'), 1, root);
  await open(host, disk.uri('spec.yaml'), 9, spec);
  const result = await eventually(
    () => complete(host, disk.uri('spec.yaml'), 2, 9),
    'group:default/team',
  );
  assert.deepEqual(result.items[0]?.textEdit, {
    range: { start: { line: 2, character: 7 }, end: { line: 2, character: 9 } },
    newText: 'group:default/team',
  });
  const after = host.diagnostics.length;
  await unlink(path.join(disk.root, 'team.yaml'));
  await host.client.sendNotification(DidChangeWatchedFilesNotification.type, {
    changes: [{ uri: disk.uri('team.yaml'), type: FileChangeType.Deleted }],
  });
  await host.waitFor((row) => row.uri === disk.uri('spec.yaml') && row.version === 9, after);
  const expected = createSourceSnapshot({
    repository: disk.source.repository,
    revision: disk.source.revision,
    rootUri: disk.source.rootUri!,
    entrypoints: [disk.uri('catalog.yaml')],
    files: [
      { uri: disk.uri('catalog.yaml'), text: root, origin: 'buffer', version: 1 },
      { uri: disk.uri('spec.yaml'), text: spec, origin: 'buffer', version: 9 },
    ],
    changes: [{ uri: disk.uri('team.yaml'), kind: 'deleted' }],
  });
  const deadline = performance.now() + 10_000;
  let observation: { sourceDigest: string } | null;
  do {
    observation = await host.client.sendRequest('bve/validationCoverage', {
      uri: disk.uri('spec.yaml'),
      version: 9,
      digest: digestText(spec),
    });
    if (observation?.sourceDigest === expected.digest) break;
    assert(
      performance.now() < deadline,
      'Watch processing must capture the exact deleted-file snapshot.',
    );
    await pause(10);
  } while (observation?.sourceDigest !== expected.digest);
  assert.equal(observation.sourceDigest, expected.digest);
  const removed = await complete(host, disk.uri('spec.yaml'), 2, 9);
  assert(!removed.items.some((row) => row.label === 'group:default/team'));
  assert(removed.items.length === 0);
  assert(
    await host.client.sendRequest(HoverRequest.type, {
      textDocument: { uri: disk.uri('spec.yaml') },
      position: { line: 0, character: 2 },
    }),
  );
});
