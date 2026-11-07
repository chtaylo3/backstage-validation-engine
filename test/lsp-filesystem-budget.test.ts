import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createConnection } from 'vscode-languageserver';
import {
  createProtocolConnection,
  DidOpenTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
} from 'vscode-languageserver/node';
import type { PublishDiagnosticsParams } from 'vscode-languageserver/node';
import { attachLspServer } from '../src/lsp/server.js';
import type { FilesystemSource } from '../src/lsp/filesystem.js';
import type { LspConfig } from '../src/lsp/config.js';
import { overlaySourceSnapshot } from '../src/index.js';
import { filesystemFixture } from './harness/filesystem-fixture.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function embedded(t: TestContext, config: LspConfig, filesystem: FilesystemSource) {
  const inbound = new PassThrough(),
    outbound = new PassThrough();
  const connection = createConnection(
    (logger) => createProtocolConnection(inbound, outbound, logger),
    { initialize: () => {}, shutdownReceived: false, exit: () => {} },
  );
  const server = attachLspServer(connection, config, {
    filesystem,
    dispose: () => filesystem.close(),
  });
  const client = createProtocolConnection(outbound, inbound);
  const diagnostics: PublishDiagnosticsParams[] = [];
  const first = deferred<PublishDiagnosticsParams>();
  client.onNotification(PublishDiagnosticsNotification.type, (row) => {
    diagnostics.push(row);
    first.resolve(row);
  });
  connection.listen();
  client.listen();
  t.after(async () => {
    await server.close();
    client.dispose();
    connection.dispose();
    inbound.destroy();
    outbound.destroy();
  });
  await client.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: config.source.rootUri ?? null,
    capabilities: {},
  });
  return { client, diagnostics, first: first.promise };
}

void test('filesystem capture and validation retain one original deadline without resetting after I/O', async (t) => {
  const f = await filesystemFixture(t, { rules: [] });
  let wall = Date.now();
  t.mock.method(Date, 'now', () => wall);
  const entered = deferred(),
    release = deferred();
  const original = wall + f.config.profile.limits.requestTimeoutMs;
  const host = await embedded(t, f.config, {
    files: f.config.filesystem!.files,
    capture: async (base, options) => {
      options.signal!.addEventListener('abort', () => release.resolve(), { once: true });
      assert.equal(options.deadlineAt, original);
      entered.resolve();
      await release.promise;
      return base;
    },
    close: () => Promise.resolve(),
  });
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: {
      uri: f.uri('catalog.yaml'),
      languageId: 'yaml',
      version: 1,
      text: f.source.files[0]!.text,
    },
  });
  await Promise.race([
    entered.promise,
    host.first.then((report) => {
      throw new Error('Validation ended before disk capture: ' + JSON.stringify(report));
    }),
  ]);
  wall += f.config.profile.limits.requestTimeoutMs + 1;
  release.resolve();
  const report = await host.first;
  assert(report.diagnostics.some((row) => row.code === 'validation/incomplete'));
  assert(report.diagnostics.some((row) => row.code === 'yaml/timeout'));
  assert.match(JSON.stringify(report.diagnostics[0]?.data), /request_timeout/);
});

void test('a superseded disk capture cannot commit or publish and the latest disk generation is recaptured', async (t) => {
  const text =
    'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service}\nspec: {$yaml: ./spec.yaml}\n';
  const f = await filesystemFixture(t, {
    files: {
      'catalog.yaml': text,
      'spec.yaml': 'type: service\nlifecycle: production\nowner: team\n',
    },
    rules: [],
  });
  const changed = overlaySourceSnapshot(f.source, [
    { uri: f.uri('spec.yaml'), text: 'owner: [', origin: 'repository' },
  ]);
  const entered = deferred(),
    release = deferred(),
    cancelled = deferred();
  let calls = 0;
  const host = await embedded(t, f.config, {
    files: f.config.filesystem!.files,
    capture: async (_base, options) => {
      if (++calls === 1) {
        options.signal!.addEventListener(
          'abort',
          () => {
            cancelled.resolve();
            release.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await release.promise;
        return f.source;
      }
      return changed;
    },
    close: () => Promise.resolve(),
  });
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: f.uri('catalog.yaml'), languageId: 'yaml', version: 1, text },
  });
  await Promise.race([
    entered.promise,
    host.first.then((report) => {
      throw new Error('Validation ended before disk capture: ' + JSON.stringify(report));
    }),
  ]);
  await host.client.sendNotification(DidChangeWatchedFilesNotification.type, {
    changes: [{ uri: f.uri('spec.yaml'), type: 2 }],
  });
  await cancelled.promise;
  release.resolve();
  const report = await host.first;
  assert.equal(report.version, 1);
  assert(report.diagnostics.length > 0);
  assert.equal(calls, 2);
  assert(host.diagnostics.every((row) => row.diagnostics.length > 0));
});
