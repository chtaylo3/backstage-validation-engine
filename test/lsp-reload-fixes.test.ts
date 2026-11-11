import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createConnection } from 'vscode-languageserver';
import {
  ApplyWorkspaceEditRequest,
  CodeActionRequest,
  createProtocolConnection,
  DidOpenTextDocumentNotification,
  ExecuteCommandRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
} from 'vscode-languageserver/node';
import type { CodeAction, PublishDiagnosticsParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseLspConfig } from '../src/lsp/config.js';
import { APPLY_FIX_COMMAND } from '../src/lsp/fixes.js';
import { attachLspServer } from '../src/lsp/server.js';
import { fixPolicy } from './harness/fix-fixture.js';
import { componentText, policyRun } from './harness/policy-fixture.js';
import { URI } from './helpers.js';
import { digestText } from '../src/index.js';
import type { CoverageObservation } from '../src/lsp/coverage-observation.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

void test('overlapping reloads reject old repairs as stale throughout replacement and admit fresh repairs after readiness', async (t) => {
  const text = componentText().replace('production', 'experimental');
  const run = policyRun({ text, ...fixPolicy() });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    debounceMs: 0,
    coverageObservation: true,
  });
  const entered = [deferred<void>(), deferred<void>()];
  const release = [deferred<void>(), deferred<void>()];
  let loads = 0;
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const connection = createConnection(
    (logger) => createProtocolConnection(inbound, outbound, logger),
    { initialize: () => {}, shutdownReceived: false, exit: () => {} },
  );
  const server = attachLspServer(connection, config, {
    reload: async () => {
      const index = loads++;
      entered[index]!.resolve();
      await release[index]!.promise;
      return { config };
    },
  });
  const client = createProtocolConnection(outbound, inbound);
  const reports = [deferred<PublishDiagnosticsParams>(), deferred<PublishDiagnosticsParams>()];
  let publications = 0;
  let dispatches = 0;
  const pendingReloads: Promise<unknown>[] = [];
  client.onNotification(PublishDiagnosticsNotification.type, (report) => {
    if (report.uri === URI && report.diagnostics.some((row) => row.code === 'required-value'))
      reports[publications++]?.resolve(report);
  });
  client.onRequest(ApplyWorkspaceEditRequest.type, ({ edit }) => {
    dispatches++;
    const change = edit.documentChanges?.[0];
    assert(change && 'textDocument' in change);
    assert.deepEqual(change.textDocument, { uri: URI, version: 1 });
    const updated = TextDocument.applyEdits(
      TextDocument.create(URI, 'yaml', 1, text),
      change.edits.map((row) => {
        assert('newText' in row);
        return row;
      }),
    );
    assert.equal(updated, text.replace('experimental', '"production"'));
    return { applied: true };
  });
  connection.listen();
  client.listen();
  t.after(async () => {
    release.forEach((gate) => gate.resolve());
    await server.close();
    await Promise.allSettled(pendingReloads);
    client.dispose();
    connection.dispose();
    inbound.destroy();
    outbound.destroy();
  });
  await client.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: null,
    capabilities: {
      workspace: {
        applyEdit: true,
        workspaceEdit: { documentChanges: true, failureHandling: 'textOnlyTransactional' },
      },
      textDocument: {
        publishDiagnostics: { dataSupport: true },
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } } },
      },
    },
  });
  await client.sendNotification(InitializedNotification.type, {});
  await client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 1, languageId: 'yaml', text },
  });
  const actions = async (report: PublishDiagnosticsParams) =>
    (await client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri: URI },
      range: report.diagnostics[0]!.range,
      context: { diagnostics: report.diagnostics },
    })) as CodeAction[];
  const [old] = await actions(await reports[0]!.promise);
  const observe = () =>
    client.sendRequest<CoverageObservation | null>('bve/validationCoverage', {
      uri: URI,
      version: 1,
      digest: digestText(text),
    });
  const initialCoverage = await observe();
  assert(initialCoverage && initialCoverage.coverage.some((row) => row.required));
  assert(old?.command);
  const first = client.sendRequest('bve/reloadConfiguration');
  pendingReloads.push(first);
  await entered[0]!.promise;
  assert.equal(
    await observe(),
    null,
    'An entered reload revokes verified coverage without a document edit.',
  );
  const repeated = client.sendRequest('bve/reloadConfiguration');
  pendingReloads.push(repeated);
  assert.deepEqual(await client.sendRequest(ExecuteCommandRequest.type, old.command), {
    applied: false,
    reason: 'stale',
  });
  for (const command of [
    { command: 'unknown', arguments: [] },
    { command: APPLY_FIX_COMMAND, arguments: [] },
    { command: APPLY_FIX_COMMAND, arguments: [42] },
  ])
    assert.deepEqual(await client.sendRequest(ExecuteCommandRequest.type, command), {
      applied: false,
      reason: 'invalid_request',
    });
  assert.equal(dispatches, 0);
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  release[0]!.resolve();
  await entered[1]!.promise;
  assert.equal(await observe(), null, 'The queued replacement cannot reveal the retired coverage.');
  assert.equal(settled, false);
  assert.deepEqual(await client.sendRequest(ExecuteCommandRequest.type, old.command), {
    applied: false,
    reason: 'stale',
  });
  assert.equal(dispatches, 0);
  release[1]!.resolve();
  assert.deepEqual(await first, { reloaded: true });
  assert.deepEqual(await repeated, { reloaded: true });
  assert.deepEqual(await client.sendRequest(ExecuteCommandRequest.type, old.command), {
    applied: false,
    reason: 'stale',
  });
  const [fresh] = await actions(await reports[1]!.promise);
  assert(fresh?.command);
  const freshCoverage = await observe();
  assert(freshCoverage && freshCoverage.generation > initialCoverage.generation);
  assert.deepEqual(freshCoverage.documents, initialCoverage.documents);
  assert.deepEqual(freshCoverage.coverage, initialCoverage.coverage);
  assert.deepEqual(await client.sendRequest(ExecuteCommandRequest.type, fresh.command), {
    applied: true,
  });
  assert.equal(dispatches, 1);
});
