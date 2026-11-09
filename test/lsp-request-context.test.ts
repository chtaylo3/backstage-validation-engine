import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CancellationTokenSource } from 'vscode-languageserver/node';
import { RequestContexts, SessionOperations } from '../src/lsp/request-context.js';
import { WorkspaceState } from '../src/lsp/workspace-state.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { policyRun, componentText } from './harness/policy-fixture.js';
import { URI } from './helpers.js';
function fixture() {
  const run = policyRun({ rules: [] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  const workspace = new WorkspaceState(config);
  workspace.open({ uri: URI, languageId: 'yaml', version: 1, text: componentText() });
  const state = {
    initialized: true,
    available: true,
    stopped: false,
    session: { generation: 1, config, operations: new SessionOperations() },
  };
  const requests = new RequestContexts(workspace, () => state);
  return { workspace, state, requests };
}
void test('request admission distinguishes stopped, unavailable, unsynchronized, cancelled and missing-document states', () => {
  const { workspace, state, requests } = fixture();
  state.initialized = false;
  assert.equal(requests.capture().status, 'uninitialized');
  state.initialized = true;
  state.stopped = true;
  assert.equal(requests.capture().status, 'stopped');
  state.stopped = false;
  state.available = false;
  assert.equal(requests.capture().status, 'configuration_unavailable');
  state.available = true;
  const token = new CancellationTokenSource();
  token.cancel();
  assert.equal(requests.capture(token.token).status, 'cancelled');
  token.dispose();
  assert.equal(
    requests.capture(undefined, 'file:///workspace/missing.yaml').status,
    'document_unavailable',
  );
  workspace.change({ uri: URI, version: 2 }, []);
  assert.equal(requests.capture().status, 'source_unsynchronized');
  workspace.change({ uri: URI, version: 3 }, [{ text: componentText() }]);
  workspace.applyOperations([]);
  assert.equal(requests.capture().status, 'capacity');
});
void test('request contexts preserve deadlines and reject document lifetimes, session replacement and cancellation', () => {
  const { workspace, state, requests } = fixture();
  const token = new CancellationTokenSource();
  const admitted = requests.capture(token.token, URI);
  assert.equal(admitted.status, 'ready');
  if (admitted.status !== 'ready') return;
  const original = admitted.context;
  const deadline = original.deadlineAt;
  assert(original.current());
  workspace.closeDocument(URI);
  workspace.open({ uri: URI, version: 1, languageId: 'yaml', text: componentText() });
  assert.equal(original.current(), false);
  assert.equal(original.deadlineAt, deadline);
  original.close();
  const next = requests.capture(token.token, URI);
  assert.equal(next.status, 'ready');
  if (next.status !== 'ready') return;
  state.session.generation++;
  assert.equal(next.context.current(), false);
  token.cancel();
  assert(next.context.signal.aborted);
  next.context.close();
  token.dispose();
});
void test('all asynchronous resource users are tracked and stale results cannot escape after reload', async () => {
  const { state, requests } = fixture();
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const work = requests.execute(
    undefined,
    URI,
    () => 'unavailable',
    () => gate,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.session.operations.size, 1);
  state.available = false;
  release('obsolete');
  assert.equal(await work, 'unavailable');
  await state.session.operations.drain();
  assert.equal(state.session.operations.size, 0);
  state.session.operations.cancel();
  await assert.rejects(
    state.session.operations.run(() => 'not admitted'),
    /retired/u,
  );
});
