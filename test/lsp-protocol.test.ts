import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  CompletionRequest,
  DefinitionRequest,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  HoverRequest,
  ShutdownRequest,
} from 'vscode-languageserver/node';
import type { ResponseError } from 'vscode-languageserver/node';
import { parseLspConfig } from '../src/lsp/config.js';
import { digestText } from '../src/index.js';
import { createLspClient, startLspClient } from './harness/lsp-client.js';
import { filesystemFixture } from './harness/filesystem-fixture.js';
import { componentText, localTeam, ownerRule, policyRun } from './harness/policy-fixture.js';
import { URI } from './helpers.js';

function configuration() {
  const run = policyRun({ rules: [], files: [localTeam] });
  return parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    debounceMs: 0,
    coverageObservation: true,
  });
}

void test('a rejected pre-initialize shutdown cannot authorize a successful EOF or exit', async (t) => {
  for (const kind of ['eof', 'exit'] as const)
    await t.test(kind, async (t) => {
      const host = await createLspClient(t, configuration());
      await assert.rejects(
        host.client.sendRequest(ShutdownRequest.type),
        (error: ResponseError<unknown>) => error.code === -32002,
      );
      assert.equal(await host.disconnect(kind), 1);
    });
});

void test('child stdio rejects lifecycle requests before initialize and after shutdown', async (t) => {
  const host = await createLspClient(t, configuration());
  const params = { textDocument: { uri: URI }, position: { line: 6, character: 10 } };
  const requests = [
    ['textDocument/completion', params],
    ['textDocument/hover', params],
    ['textDocument/definition', params],
    [
      'textDocument/codeAction',
      {
        textDocument: { uri: URI },
        range: { start: params.position, end: params.position },
        context: { diagnostics: [] },
      },
    ],
    ['workspace/executeCommand', { command: 'bve.applyFix', arguments: ['untrusted'] }],
    ['bve/searchReferences', { kind: 'group', namespace: 'default', prefix: 'te' }],
    ['bve/filesystemObservation', {}],
    ['bve/validationCoverage', { uri: URI, version: 1, digest: digestText(componentText()) }],
    ['bve/reloadConfiguration', {}],
    ['unsupported/probe', {}],
    ['shutdown', undefined],
  ] as const;
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 99, text: 'kind: Invalid\n' },
  });
  for (const [method, input] of requests)
    await assert.rejects(
      host.client.sendRequest(method, input),
      (error: ResponseError<unknown>) => {
        assert.equal(error.code, -32002, method);
        return true;
      },
    );
  await host.initialize();
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  await host.waitFor((row) => row.uri === URI && row.version === 1);
  assert(await host.client.sendRequest(HoverRequest.type, params));
  await assert.rejects(
    host.client.sendRequest('initialize', { processId: null, rootUri: null, capabilities: {} }),
    (error: ResponseError<unknown>) => error.code === -32600,
  );
  await host.client.sendRequest(ShutdownRequest.type);
  const before = host.logs.length;
  for (const [method, input] of [
    ...requests,
    ['initialize', { processId: null, rootUri: null, capabilities: {} }],
  ] as const)
    await assert.rejects(
      host.client.sendRequest(method, input),
      (error: ResponseError<unknown>) => {
        assert.equal(error.code, -32600, method);
        return true;
      },
    );
  assert.equal(
    host.logs.length,
    before,
    'A stopped request must not start new feature work or emit private diagnostics.',
  );
  assert.equal(await host.disconnect('exit'), 0);
});

void test('child stdio publishes a nonempty finding before an ordered close clear', async (t) => {
  const config = configuration();
  const host = await startLspClient(t, config);
  const text = componentText().replace('type: service\n', '');
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 4, text },
  });
  const finding = await host.waitFor(
    (row) => row.uri === URI && row.version === 4 && row.diagnostics.length > 0,
  );
  assert.equal(finding.diagnostics[0]?.code, 'yaml/syntax');
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
    textDocument: { uri: URI },
  });
  assert.deepEqual((await host.waitFor((row) => row.uri === URI, after)).diagnostics, []);
  assert.deepEqual(
    await host.client.sendRequest(CompletionRequest.type, {
      textDocument: { uri: URI },
      position: { line: 6, character: 9 },
    }),
    { isIncomplete: true, items: [] },
  );
  await host.shutdown();
  assert(
    host.diagnostics
      .slice(after)
      .every((row) => row.uri === URI && row.version === 4 && row.diagnostics.length === 0),
  );
});

void test('duplicate child didOpen cannot replace the first document lifetime or bytes', async (t) => {
  const host = await startLspClient(t, configuration());
  const text = componentText();
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 7, text },
  });
  await host.waitFor((row) => row.uri === URI && row.version === 7);
  const binding = { uri: URI, version: 7, digest: digestText(text) };
  const first = await host.client.sendRequest('bve/validationCoverage', binding);
  assert(first);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 8, text: 'kind: Broken\n' },
  });
  assert.deepEqual(await host.client.sendRequest('bve/validationCoverage', binding), first);
  assert.equal(
    await host.client.sendRequest('bve/validationCoverage', { ...binding, version: 8 }),
    null,
  );
});

void test('child encoding offers select UTF-16 or reject unsupported-only offers', async (t) => {
  for (const encodings of [
    undefined,
    ['utf-16'],
    ['utf-8', 'utf-16'],
    ['utf-32', 'utf-16'],
    ['utf-8'],
    ['unsupported'],
  ])
    await t.test(JSON.stringify(encodings) ?? 'default', async (t) => {
      const host = await createLspClient(t, configuration());
      const result = host.initialize({
        capabilities: encodings ? { general: { positionEncodings: encodings } } : {},
      });
      if (!encodings || encodings.includes('utf-16'))
        assert.equal((await result).capabilities.positionEncoding, 'utf-16');
      else
        await assert.rejects(result, (error: ResponseError<unknown>) => {
          assert.equal(error.code, -32603);
          assert.match(error.message, /UTF-16 positions are required/u);
          return true;
        });
    });
});

void test('client roots cannot widen the trusted filesystem source selection', async (t) => {
  const disk = await filesystemFixture(t, { rules: [] });
  await writeFile(
    path.join(disk.directory, 'outside.yaml'),
    componentText().replace('type: service\n', ''),
  );
  const outside = disk.uri('../outside.yaml');
  for (const [index, roots] of [
    { rootUri: null },
    {
      rootUri: 'file:///untrusted/',
      workspaceFolders: [{ uri: 'file:///untrusted/', name: 'untrusted' }],
    },
    { rootUri: disk.config.source.rootUri!, workspaceFolders: [{ uri: outside, name: 'outside' }] },
  ].entries())
    await t.test(
      ['no client root', 'foreign client root', 'mixed workspace folders'][index],
      async (t) => {
        const host = await startLspClient(t, disk.config, { initializeParams: roots });
        const before = host.diagnostics.length;
        await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: { uri: outside, languageId: 'yaml', version: 1, text: 'kind: Invalid\n' },
        });
        await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: {
            uri: disk.uri('catalog.yaml'),
            languageId: 'yaml',
            version: 1,
            text: componentText(),
          },
        });
        assert.deepEqual(
          (
            await host.waitFor(
              (row) => row.uri === disk.uri('catalog.yaml') && row.version === 1,
              before,
            )
          ).diagnostics,
          [],
        );
        assert.equal(
          await host.client.sendRequest(HoverRequest.type, {
            textDocument: { uri: outside },
            position: { line: 0, character: 2 },
          }),
          null,
        );
        assert(!host.diagnostics.slice(before).some((row) => row.uri === outside));
      },
    );
});

void test('rejected watcher registration reports its reason and save still refreshes the live child', async (t) => {
  const disk = await filesystemFixture(t, {
    rules: [ownerRule],
    files: { 'catalog.yaml': componentText(), 'team.yaml': localTeam.text },
    entrypoints: ['catalog.yaml', 'team.yaml'],
  });
  let registrationAllowed = false;
  const host = await startLspClient(t, disk.config, {
    watchFiles: true,
    registration: () => registrationAllowed,
  });
  const warning = await host.waitForLog((row) =>
    row.message.includes('Automatic file-change notifications are unavailable'),
  );
  assert.equal(warning.type, 2);
  assert.equal(
    warning.message,
    'Automatic file-change notifications are unavailable; save notifications still refresh approved files.',
  );
  assert.equal(host.registrations.length, 1);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: {
      uri: disk.uri('catalog.yaml'),
      languageId: 'yaml',
      version: 1,
      text: componentText(),
    },
  });
  assert.deepEqual(
    (await host.waitFor((row) => row.uri === disk.uri('catalog.yaml') && row.version === 1))
      .diagnostics,
    [],
  );
  await writeFile(
    path.join(disk.root, 'team.yaml'),
    localTeam.text.replace('name: team', 'name: other-team'),
  );
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidSaveTextDocumentNotification.type, {
    textDocument: { uri: disk.uri('team.yaml') },
  });
  const changed = await host.waitFor(
    (row) => row.uri === disk.uri('catalog.yaml') && row.version === 1,
    after,
  );
  assert(changed.diagnostics.some((row) => row.code === 'owner-exists'));
  const restore = host.diagnostics.length;
  await writeFile(path.join(disk.root, 'team.yaml'), localTeam.text);
  await host.client.sendNotification(DidSaveTextDocumentNotification.type, {
    textDocument: { uri: disk.uri('team.yaml') },
  });
  assert.deepEqual(
    (
      await host.waitFor(
        (row) => row.uri === disk.uri('catalog.yaml') && row.version === 1,
        restore,
      )
    ).diagnostics,
    [],
  );
  assert(
    await host.client.sendRequest(HoverRequest.type, {
      textDocument: { uri: disk.uri('catalog.yaml') },
      position: { line: 4, character: 3 },
    }),
  );
  registrationAllowed = true;
  const reloadedAfter = host.diagnostics.length;
  assert.deepEqual(await host.client.sendRequest('bve/reloadConfiguration'), { reloaded: true });
  assert.deepEqual(
    (
      await host.waitFor(
        (row) => row.uri === disk.uri('catalog.yaml') && row.version === 1,
        reloadedAfter,
      )
    ).diagnostics,
    [],
  );
  assert.equal(host.registrations.length, 2);
  assert.equal(host.logs.filter((row) => row.message === warning.message).length, 1);
  await host.shutdown();
  assert(host.logs.every((row) => !row.message.includes('policy-test-secret')));
});

void test('child cancellation responses retain the declared completion, hover and definition shapes', async (t) => {
  const host = await startLspClient(t, configuration());
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  await host.waitFor((row) => row.uri === URI && row.version === 1);
  const params = { textDocument: { uri: URI }, position: { line: 6, character: 11 } };
  const deadline = performance.now() + 10000;
  let completion = await host.client.sendRequest(CompletionRequest.type, params);
  while (!completion || !('items' in completion) || completion.items.length === 0) {
    assert(performance.now() < deadline, 'The positive local index must become ready.');
    await new Promise<void>((resolve) => setImmediate(resolve));
    completion = await host.client.sendRequest(CompletionRequest.type, params);
  }
  const positive = [
    completion,
    await host.client.sendRequest(HoverRequest.type, params),
    await host.client.sendRequest(DefinitionRequest.type, params),
  ];
  assert(positive[0] && 'items' in positive[0] && positive[0].items.length > 0);
  assert(positive[1]);
  assert(Array.isArray(positive[2]) && positive[2].length === 1);
  for (const [request, expected] of [
    [CompletionRequest.type, { isIncomplete: true, items: [] }],
    [HoverRequest.type, null],
    [DefinitionRequest.type, []],
  ] as const) {
    const result = await host.cancelledRequest(request.method, params);
    assert.deepEqual(result, expected);
    assert.equal(host.cancellationFrames.at(-1)?.method, request.method);
  }
  assert.equal(host.cancellationFrames.length, 3);
});
