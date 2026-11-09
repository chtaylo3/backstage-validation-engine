import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceState } from '../src/lsp/workspace-state.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { createSourceSnapshot } from '../src/core/snapshots.js';
import { policyRun, componentText } from './harness/policy-fixture.js';
import { filesystemFixture } from './harness/filesystem-fixture.js';
import { URI } from './helpers.js';
function config() {
  const run = policyRun({ rules: [] });
  return parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
}
void test('workspace snapshots retain immutable text and lifetime while current buffers change and reopen', () => {
  const workspace = new WorkspaceState(config());
  workspace.open({ uri: URI, languageId: 'yaml', version: 1, text: componentText() });
  const snapshot = workspace.snapshot();
  const first = snapshot.documents[0]!;
  workspace.change({ uri: URI, version: 2 }, [{ text: 'kind: API' }]);
  assert.equal(first.getText(), componentText());
  assert.equal(snapshot.allDocuments.get(URI), first);
  assert.equal(Reflect.get(snapshot.allDocuments, 'set'), undefined);
  assert.equal(workspace.document(URI)!.lifetime, first.lifetime);
  workspace.closeDocument(URI);
  workspace.open({ uri: URI, languageId: 'yaml', version: 1, text: componentText() });
  assert.notEqual(workspace.document(URI)!.lifetime, first.lifetime);
  assert.equal(first.version, 1);
});
void test('workspace file operations admit the complete batch before modifying any source or open buffer', () => {
  const workspace = new WorkspaceState(config());
  workspace.open({ uri: URI, languageId: 'yaml', version: 1, text: componentText() });
  const previous = workspace.snapshot();
  workspace.applyOperations([
    { oldUri: URI, newUri: 'file:///workspace/renamed.yaml' },
    { oldUri: 'file:///workspace/missing.yaml' },
  ]);
  assert.equal(workspace.source, previous.source);
  assert.equal(workspace.document(URI), previous.allDocuments.get(URI));
  assert(workspace.capacityExceeded);
});
void test('disk capture commits only the current invalidation and buffer generation', () => {
  const workspace = new WorkspaceState(config());
  const prior = workspace.snapshot();
  workspace.invalidateDisk();
  assert.equal(
    workspace.commitCapture(prior.source, prior.diskGeneration, prior.generation),
    false,
  );
  const current = workspace.snapshot();
  assert.equal(
    workspace.commitCapture(current.source, current.diskGeneration, current.generation),
    true,
  );
  assert.equal(workspace.capturedGeneration, current.diskGeneration);
  workspace.close();
  assert.equal(
    workspace.commitCapture(current.source, current.diskGeneration, current.generation),
    false,
  );
});
void test('retained excluded buffers cannot block selected sources through synchronization failures', async (t) => {
  const f = await filesystemFixture(t, {
    files: { 'catalog.yaml': componentText(), 'other.yaml': componentText() },
    rules: [],
  });
  const workspace = new WorkspaceState(f.config);
  for (const name of ['catalog.yaml', 'other.yaml'])
    workspace.open({ uri: f.uri(name), languageId: 'yaml', version: 1, text: componentText() });
  const source = createSourceSnapshot({
    ...f.source,
    files: f.source.files.filter((file) => file.uri === f.uri('catalog.yaml')),
    entrypoints: [f.uri('catalog.yaml')],
  });
  workspace.replaceConfiguration(
    parseLspConfig({ ...f.config, source, filesystem: { files: [f.uri('catalog.yaml')] } }),
  );
  workspace.change({ uri: f.uri('other.yaml'), version: 2 }, [
    { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }, text: 'bad' },
  ]);
  assert(workspace.isUnavailable(f.uri('other.yaml')));
  assert.equal(workspace.unavailableSources, false);
  assert.equal(workspace.snapshot().documents.length, 1);
  assert.equal(workspace.documents.size, 2);
});
