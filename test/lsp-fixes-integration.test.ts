import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CodeActionRequest,
  ExecuteCommandRequest,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  FileChangeType,
} from 'vscode-languageserver/node';
import type {
  CodeAction,
  PublishDiagnosticsParams,
  TextDocumentEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BACKSTAGE_ADAPTER_IDS } from '../src/index.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { APPLY_FIX_COMMAND } from '../src/lsp/fixes.js';
import { fixPolicy } from './harness/fix-fixture.js';
import { componentText, policyRun } from './harness/policy-fixture.js';
import { startLspClient } from './harness/lsp-client.js';
import { filesystemFixture } from './harness/filesystem-fixture.js';
import { URI } from './helpers.js';

function config(options: Parameters<typeof policyRun>[0] = {}) {
  const run = policyRun({ ...fixPolicy(), ...options });
  return parseLspConfig({
    ...run.context,
    source: run.request.source,
    identity: run.request.identity,
    debounceMs: 0,
  });
}
const bad = () =>
  componentText().replace('production', 'experimental # keep 😀').replaceAll('\n', '\r\n');
type Host = Awaited<ReturnType<typeof startLspClient>>;
async function open(host: Host, uri = URI, version = 1, text = bad()) {
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri, version, text, languageId: 'yaml' },
  });
  return host.waitFor((row) => row.uri === uri && row.version === version, after);
}
async function actions(host: Host, report: PublishDiagnosticsParams) {
  const result = await host.client.sendRequest(CodeActionRequest.type, {
    textDocument: { uri: report.uri },
    range: report.diagnostics[0]!.range,
    context: { diagnostics: report.diagnostics, only: ['quickfix'] },
  });
  return (result ?? []) as CodeAction[];
}
function execute(host: Host, action: CodeAction) {
  return host.client.sendRequest(ExecuteCommandRequest.type, action.command!);
}

void test('stdio quick fixes apply through versioned client edits and clear only after didChange on both pins', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    await t.test(adapterId, async (t) => {
      let updated = '';
      const host = await startLspClient(t, config({ profile: { adapterId } }), {
        fixes: true,
        applyEdit: ({ edit }) => {
          const change = edit.documentChanges![0] as TextDocumentEdit;
          assert.deepEqual(change.textDocument, { uri: URI, version: 1 });
          assert.equal(edit.changes, undefined);
          const document = TextDocument.create(URI, 'yaml', 1, bad());
          updated = TextDocument.applyEdits(
            document,
            change.edits.map((row) => {
              assert('newText' in row);
              return { range: row.range, newText: row.newText };
            }),
          );
          assert.equal(updated, bad().replace('experimental', '"production"'));
          return { applied: true };
        },
      });
      assert.deepEqual(host.initialized.capabilities.executeCommandProvider, {
        commands: [APPLY_FIX_COMMAND],
      });
      assert.deepEqual(host.initialized.capabilities.codeActionProvider, {
        codeActionKinds: ['quickfix'],
      });
      const report = await open(host);
      assert.equal(report.diagnostics[0]?.code, 'required-value');
      const offered = await actions(host, report);
      assert.equal(offered.length, 1);
      const action = offered[0]!;
      assert.equal(action.edit, undefined);
      assert.equal(action.command?.command, APPLY_FIX_COMMAND);
      const after = host.diagnostics.length;
      assert.deepEqual(await execute(host, action), { applied: true });
      assert.equal(host.applyRequests.length, 1);
      assert.equal(host.diagnostics.length, after);
      assert.deepEqual(await actions(host, report), []);
      assert.deepEqual(await execute(host, action), { applied: false, reason: 'stale' });
      await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: URI, version: 2 },
        contentChanges: [{ text: updated }],
      });
      const fixed = await host.waitFor((row) => row.uri === URI && row.version === 2, after);
      assert.deepEqual(fixed.diagnostics, []);
    });
});

void test('stdio stale, forged and reopened fix requests never reach workspace/applyEdit', async (t) => {
  const host = await startLspClient(t, config(), { fixes: true });
  const report = await open(host);
  const action = (await actions(host, report))[0]!;
  assert.deepEqual(
    await host.client.sendRequest(ExecuteCommandRequest.type, {
      command: APPLY_FIX_COMMAND,
      arguments: [...(action.command!.arguments! as unknown[]), { text: 'forged' }],
    }),
    { applied: false, reason: 'invalid_request' },
  );
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text: bad() + '# new content\r\n' }],
  });
  assert.deepEqual(await execute(host, action), { applied: false, reason: 'stale' });
  const current = await host.waitFor((row) => row.uri === URI && row.version === 2);
  assert.deepEqual(await actions(host, report), []);
  const reopen = (await actions(host, current))[0]!;
  await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
    textDocument: { uri: URI },
  });
  await open(host, URI, 2, bad() + '# new content\r\n');
  assert.deepEqual(await execute(host, reopen), { applied: false, reason: 'stale' });
  assert.equal(host.applyRequests.length, 0);
});

void test('included fixes require an open target and preserve actual URI/version from a projected diagnostic', async (t) => {
  const specUri = 'file:///workspace/spec.yaml';
  const root =
    'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service}\nspec: {$yaml: ./spec.yaml}\n';
  const spec = 'type: service\nlifecycle: experimental\nowner: team\n';
  const host = await startLspClient(
    t,
    config({
      text: root,
      rootUri: 'file:///workspace/',
      entrypoints: [URI],
      files: [{ uri: specUri, text: spec }],
    }),
    { fixes: true },
  );
  const closed = await open(host, URI, 1, root);
  assert.deepEqual(await actions(host, closed), []);
  const after = host.diagnostics.length;
  const included = await open(host, specUri, 7, spec);
  const projected = await host.waitFor((row) => row.uri === URI && row.version === 1, after);
  assert.deepEqual(await actions(host, closed), []);
  const offered = await actions(host, projected);
  assert.equal(offered.length, 1);
  assert.equal((await actions(host, included)).length, 1);
  assert.deepEqual(await execute(host, offered[0]!), { applied: false, reason: 'client_rejected' });
  const change = host.applyRequests[0]?.edit.documentChanges?.[0] as TextDocumentEdit;
  assert.deepEqual(change.textDocument, { uri: specUri, version: 7 });
  assert.deepEqual(change.edits, [
    {
      range: { start: { line: 1, character: 11 }, end: { line: 1, character: 23 } },
      newText: '"production"',
    },
  ]);
});

void test('watch notifications revoke actions even when the target buffer version stays unchanged', async (t) => {
  const text = bad();
  const disk = await filesystemFixture(t, {
    ...fixPolicy(),
    files: { 'catalog.yaml': text, 'other.yaml': componentText() },
    entrypoints: ['catalog.yaml'],
  });
  const host = await startLspClient(t, disk.config, { fixes: true, watchFiles: true });
  const report = await open(host, disk.uri('catalog.yaml'), 1, text);
  const action = (await actions(host, report))[0]!;
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidChangeWatchedFilesNotification.type, {
    changes: [{ uri: disk.uri('other.yaml'), type: FileChangeType.Changed }],
  });
  assert.deepEqual(await execute(host, action), { applied: false, reason: 'stale' });
  const refreshed = await host.waitFor((row) => row.uri === report.uri && row.version === 1, after);
  assert.equal((await actions(host, refreshed)).length, 1);
  assert.equal(host.applyRequests.length, 0);
});

void test('the client version check rejects an edit if typing races its delivery', async (t) => {
  let clientVersion = 1;
  const host = await startLspClient(t, config(), {
    fixes: true,
    applyEdit: ({ edit }) => {
      const change = edit.documentChanges![0] as TextDocumentEdit;
      const applied = change.textDocument.version === clientVersion;
      assert.equal(change.textDocument.version, 1);
      assert.equal(clientVersion, 2);
      return {
        applied,
        failureReason: 'sensitive raw client rejection',
      };
    },
  });
  const report = await open(host),
    action = (await actions(host, report))[0]!;
  clientVersion = 2;
  assert.deepEqual(await execute(host, action), { applied: false, reason: 'client_rejected' });
  assert.equal(host.applyRequests.length, 1);
});

void test('a silent apply client times out, suppresses retries, then shuts down cleanly', async (t) => {
  let finish!: (result: { applied: boolean }) => void;
  const host = await startLspClient(t, config(), {
    fixes: true,
    applyEdit: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const report = await open(host),
    action = (await actions(host, report))[0]!;
  assert.deepEqual(await execute(host, action), { applied: false, reason: 'client_error' });
  assert.deepEqual(await execute(host, action), { applied: false, reason: 'busy' });
  assert.deepEqual(await actions(host, report), []);
  assert.equal(host.applyRequests.length, 1);
  finish({ applied: false });
  await host.shutdown();
});

void test('shutdown completes gracefully while a silent client edit remains unresolved', async (t) => {
  const host = await startLspClient(t, config(), {
    fixes: true,
    applyEdit: () => new Promise(() => {}),
  });
  const report = await open(host);
  const action = (await actions(host, report))[0]!;
  assert.deepEqual(await execute(host, action), { applied: false, reason: 'client_error' });
  assert.equal(host.applyRequests.length, 1);
  await host.shutdown();
});

void test('fixes stay unavailable without client capabilities or complete validation', async (t) => {
  await t.test('capabilities absent', async (t) => {
    const host = await startLspClient(t, config());
    assert.equal(host.initialized.capabilities.codeActionProvider, undefined);
    assert.equal(host.initialized.capabilities.executeCommandProvider, undefined);
    const report = await open(host);
    assert.deepEqual(await actions(host, report), []);
    assert.deepEqual(
      await host.client.sendRequest(ExecuteCommandRequest.type, {
        command: APPLY_FIX_COMMAND,
        arguments: ['forged'],
      }),
      { applied: false, reason: 'invalid_request' },
    );
    assert.equal(host.applyRequests.length, 0);
  });
  await t.test('unsupported processor', async (t) => {
    const host = await startLspClient(
      t,
      config({ profile: { requiredProcessors: [{ id: 'required', stage: 'pre-validation' }] } }),
      { fixes: true },
    );
    const report = await open(host);
    assert(report.diagnostics.length);
    assert.deepEqual(await actions(host, report), []);
    assert.equal(host.applyRequests.length, 0);
  });
});
