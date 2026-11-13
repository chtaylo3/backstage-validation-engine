import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diagnosticPublications,
  watchedFileUris,
} from '../../extensions/vscode/test/diagnostic-trace.js';
const publication = (diagnostics: unknown[]) =>
  `2026-11-11 00:00:00.001 [trace] Received notification 'textDocument/publishDiagnostics'.\nParams: ${JSON.stringify({ uri: 'file:///fixture/catalog.yaml', version: 7, diagnostics })}\n`;
void test('installed trace history retains a transient forbidden finding before the final empty clear', () => {
  const trace =
    publication([{ code: 'owner-exists' }]) +
    publication([]) +
    "2026-11-11 00:00:00.002 [trace] Received response 'barrier - (4)'.\nResult: null\n";
  const rows = diagnosticPublications(trace);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.diagnostics[0]!.code, 'owner-exists');
  assert.deepEqual(rows[1]!.diagnostics, []);
  assert.equal(rows[0]!.version, 7);
});
void test('malformed or excessive trace data cannot masquerade as complete publication evidence', () => {
  assert.throws(() => diagnosticPublications(publication([]).repeat(129)), /Never truncate/);
  assert.throws(
    () => diagnosticPublications(publication([]).replace('"diagnostics":[]', '"diagnostics":null')),
    /complete publication/,
  );
  assert.throws(
    () => diagnosticPublications('x'.repeat(1024 * 1024 + 1)),
    /complete diagnostic observation/,
  );
});
void test('watched-file notifications yield every sent URI and skip a block still being written', () => {
  const sent = (changes: unknown) =>
    `2026-11-11 00:00:00.003 [trace] Sending notification 'workspace/didChangeWatchedFiles'.\nParams: ${JSON.stringify({ changes })}\n`;
  const first = sent([
    { uri: 'file:///C:/workspace/team.yaml', type: 2 },
    { uri: 'file:///C:/workspace/depth', type: 1 },
  ]);
  const second = sent([{ uri: 'file:///C:/workspace/catalog.yaml', type: 2 }]);
  const trace =
    publication([]) +
    first +
    "2026-11-11 00:00:00.004 [trace] Received response 'barrier - (4)'.\nResult: null\n" +
    second;
  assert.deepEqual(watchedFileUris(trace), [
    'file:///C:/workspace/team.yaml',
    'file:///C:/workspace/depth',
    'file:///C:/workspace/catalog.yaml',
  ]);
  // A publication that merely mentions the method is not a sent notification.
  assert.deepEqual(watchedFileUris(publication([{ code: 'workspace/didChangeWatchedFiles' }])), []);
  // The editor is still writing the last block: it is skipped, and earlier blocks are kept.
  assert.deepEqual(watchedFileUris(first + second.slice(0, -20)), [
    'file:///C:/workspace/team.yaml',
    'file:///C:/workspace/depth',
  ]);
  // Entries without a string URI, and parameters without a change list, contribute nothing.
  assert.deepEqual(watchedFileUris(sent([{ type: 1 }, 7]) + sent('none')), []);
});
