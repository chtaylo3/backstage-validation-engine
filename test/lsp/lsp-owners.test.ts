import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CancellationToken,
  CancellationTokenSource,
  DiagnosticSeverity,
} from 'vscode-languageserver/node';
import type {
  ApplyWorkspaceEditResult,
  PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { ClientEdits } from '../../src/lsp/client-edits.js';
import { DiagnosticPublisher } from '../../src/lsp/diagnostic-publisher.js';

void test('a client timeout retains the connection reservation through reload and terminal close never waits for its response', async () => {
  let timeout!: () => void;
  let respond!: (result: ApplyWorkspaceEditResult) => void;
  let cancelled = false;
  let timersCleared = 0;
  const edits = new ClientEdits(
    (_edit, token) => {
      token.onCancellationRequested(() => {
        cancelled = true;
      });
      return new Promise((resolve) => {
        respond = resolve;
      });
    },
    (work) => {
      timeout = work;
      return () => {
        timersCleared++;
      };
    },
  );
  const pending = edits.apply({}, CancellationToken.None);
  await Promise.resolve();
  assert(edits.busy);
  timeout();
  await assert.rejects(pending, /cancelled/u);
  assert(cancelled);
  assert(edits.busy);
  edits.cancel();
  await assert.rejects(edits.apply({}, CancellationToken.None), /unavailable/u);
  await edits.close();
  assert.equal(timersCleared, 1);
  await assert.rejects(edits.apply({}, CancellationToken.None), /unavailable/u);
  respond({ applied: true });
  await Promise.resolve();
  await edits.close();
});
void test('upstream cancellation retains a slot until a late client rejection settles it', async () => {
  const upstream = new CancellationTokenSource();
  let reject!: (error: Error) => void;
  const edits = new ClientEdits(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const pending = edits.apply({}, upstream.token);
  await Promise.resolve();
  upstream.cancel();
  await assert.rejects(pending, /cancelled/u);
  assert(edits.busy);
  reject(new Error('late refusal'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(edits.busy, false);
  await edits.close();
  upstream.dispose();
});
void test('diagnostic delivery rejects stale findings and an old lifetime clear without erasing the reopened lifetime', async () => {
  const sends: PublishDiagnosticsParams[] = [];
  const publisher = new DiagnosticPublisher((row) => {
    sends.push(row);
    return Promise.resolve();
  });
  const diagnostic = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: 'current',
    severity: DiagnosticSeverity.Error,
  };
  const context = {
    uri: 'file:///workspace/catalog.yaml',
    version: 1,
    generation: 2,
    lifetime: 2,
    current: () => true,
  };
  await publisher.publish(context, [diagnostic]);
  await publisher.clear({ ...context, generation: 3, lifetime: 1 });
  await publisher.publish({ ...context, current: () => false }, [diagnostic]);
  assert.equal(sends.length, 1);
  await publisher.clear(context);
  assert.deepEqual(sends.at(-1)?.diagnostics, []);
  publisher.close();
  await publisher.publish(context, [diagnostic]);
  assert.deepEqual(sends, [
    { uri: context.uri, version: 1, diagnostics: [diagnostic] },
    { uri: context.uri, version: 1, diagnostics: [] },
  ]);
});

void test('a current clean result clears diagnostics retained from an older document lifetime', async () => {
  const sends: PublishDiagnosticsParams[] = [];
  const publisher = new DiagnosticPublisher((row) => {
    sends.push(row);
    return Promise.resolve();
  });
  const previous = {
    uri: 'file:///workspace/catalog.yaml',
    version: 1,
    generation: 1,
    lifetime: 1,
    current: () => true,
  };
  await publisher.publish(previous, [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: 'Old document error',
    },
  ]);
  // A close clear can be superseded before delivery. The reopened document is
  // clean, and its validation must replace the previous lifetime's findings.
  await publisher.clear({ ...previous, current: () => false });
  await publisher.publish({ ...previous, generation: 3, lifetime: 2 }, []);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.at(-1), { uri: previous.uri, version: 1, diagnostics: [] });
  publisher.close();
  assert.deepEqual(sends, [
    {
      uri: previous.uri,
      version: 1,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: 'Old document error',
        },
      ],
    },
    { uri: previous.uri, version: 1, diagnostics: [] },
  ]);
});
