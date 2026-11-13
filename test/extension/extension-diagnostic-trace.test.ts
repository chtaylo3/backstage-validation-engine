import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosticPublications } from '../../extensions/vscode/test/diagnostic-trace.js';
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
