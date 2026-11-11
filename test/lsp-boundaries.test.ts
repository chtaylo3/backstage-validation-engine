import assert from 'node:assert/strict';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  CompletionRequest,
} from 'vscode-languageserver/node';
import { discoverFiles } from '../src/lsp/discovery.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { WorkspaceState } from '../src/lsp/workspace-state.js';
import { RequestContexts, SessionOperations } from '../src/lsp/request-context.js';
import { RequestBudget } from '../src/runtime/request-budget.js';
import { filesystemFixture } from './harness/filesystem-fixture.js';
import { startLspClient } from './harness/lsp-client.js';
import { componentText, policyRun } from './harness/policy-fixture.js';
import { digestText } from '../src/index.js';
import { URI } from './helpers.js';

function config() {
  const run = policyRun({ rules: [] });
  return parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    debounceMs: 0,
  });
}
void test('workspace admits 1000 documents, rejects document 1001, and recovers only in a new session', () => {
  const selected = config();
  const workspace = new WorkspaceState(selected);
  workspace.open({ uri: URI, languageId: 'yaml', version: 1, text: componentText() });
  for (let i = 1; i < 1000; i++)
    workspace.open({
      uri: `file:///workspace/open-${i}.yaml`,
      languageId: 'yaml',
      version: 1,
      text: '',
    });
  assert.equal(workspace.documents.size, 1000);
  assert.equal(workspace.unavailableSources, false);
  assert.equal(workspace.capacityExceeded, false);
  const state = {
    initialized: true,
    available: true,
    stopped: false,
    session: { generation: 1, config: selected, operations: new SessionOperations() },
  };
  const requests = new RequestContexts(workspace, () => state);
  const admitted = requests.capture(undefined, URI);
  assert.equal(admitted.status, 'ready');
  if (admitted.status === 'ready') admitted.context.close();
  workspace.open({
    uri: 'file:///workspace/overflow.yaml',
    languageId: 'yaml',
    version: 1,
    text: '',
  });
  assert.equal(workspace.documents.size, 1000);
  assert.equal(workspace.document('file:///workspace/overflow.yaml'), undefined);
  assert.equal(requests.capture(undefined, URI).status, 'capacity');
  workspace.closeDocument('file:///workspace/open-999.yaml');
  assert.equal(
    requests.capture(undefined, URI).status,
    'capacity',
    'The documented session latch is not reset by closing a buffer.',
  );
  workspace.close();
  assert.equal(workspace.documents.size, 0);
  const replacement = new WorkspaceState(selected);
  replacement.open({ uri: URI, languageId: 'yaml', version: 1, text: componentText() });
  assert.equal(replacement.capacityExceeded, false);
  assert.equal(replacement.document(URI)?.getText(), componentText());
  replacement.close();
});

void test('child stdio admits exactly 1000 content changes and requires full synchronization after 1001', async (t) => {
  const host = await startLspClient(t, config());
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  assert.deepEqual(
    (await host.waitFor((row) => row.uri === URI && row.version === 1)).diagnostics,
    [],
  );
  const harmless = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    text: '',
  };
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 2 },
    contentChanges: Array.from({ length: 1000 }, () => harmless),
  });
  assert.deepEqual(
    (await host.waitFor((row) => row.uri === URI && row.version === 2)).diagnostics,
    [],
  );
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 3 },
    contentChanges: Array.from({ length: 1001 }, () => harmless),
  });
  const rejected = await host.waitFor((row) => row.uri === URI && row.version === 3);
  assert.equal(rejected.diagnostics[0]?.code, 'validation/incomplete');
  assert.match(JSON.stringify(rejected), /buffer_unavailable/u);
  assert.deepEqual(
    await host.client.sendRequest(CompletionRequest.type, {
      textDocument: { uri: URI },
      position: { line: 6, character: 10 },
    }),
    { isIncomplete: true, items: [] },
  );
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 4 },
    contentChanges: [harmless],
  });
  assert.equal(
    (await host.waitFor((row) => row.uri === URI && row.version === 4)).diagnostics[0]?.code,
    'validation/incomplete',
  );
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 5 },
    contentChanges: [{ text: componentText() }],
  });
  assert.deepEqual(
    (await host.waitFor((row) => row.uri === URI && row.version === 5)).diagnostics,
    [],
  );
  await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
    textDocument: { uri: URI },
  });
  await host.shutdown();
});

void test('child document 1001 makes the admitted workspace incomplete until a fresh trusted server starts', async (t) => {
  // Coalesce the large wire batch through the documented host debounce. This isolates admission,
  // rather than repeatedly preempting validation while the 1000 notifications arrive.
  const selected = parseLspConfig({ ...config(), debounceMs: 250, coverageObservation: true });
  const host = await startLspClient(t, selected);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  await host.waitFor((row) => row.uri === URI && row.version === 1);
  for (let i = 1; i < 1000; i++)
    await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: `file:///workspace/limit-${i}.yaml`,
        languageId: 'yaml',
        version: 1,
        text: '',
      },
    });
  await host.waitFor((row) => row.uri === 'file:///workspace/limit-999.yaml');
  const binding = { uri: URI, version: 1, digest: digestText(componentText()) };
  const admitted = await host.client.sendRequest<{ documents: { uri: string }[] } | null>(
    'bve/validationCoverage',
    binding,
  );
  assert(admitted);
  assert.equal(admitted.documents.length, 1000);
  assert(admitted.documents.some((row) => row.uri === URI));
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: {
      uri: 'file:///workspace/limit-1000.yaml',
      languageId: 'yaml',
      version: 1,
      text: '',
    },
  });
  const rejected = await host.waitFor(
    (row) =>
      row.uri === URI &&
      row.diagnostics.some((diagnostic) => diagnostic.code === 'validation/incomplete'),
    after,
  );
  assert.match(JSON.stringify(rejected), /buffer_unavailable/u);
  assert.equal(await host.client.sendRequest('bve/validationCoverage', binding), null);
  await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
    textDocument: { uri: 'file:///workspace/limit-999.yaml' },
  });
  assert.equal(await host.client.sendRequest('bve/validationCoverage', binding), null);
  await host.shutdown();
  const restarted = await startLspClient(t, selected);
  await restarted.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  assert.deepEqual(
    (await restarted.waitFor((row) => row.uri === URI && row.version === 1)).diagnostics,
    [],
  );
  assert(await restarted.client.sendRequest('bve/validationCoverage', binding));
});

void test('discovery entry ceiling counts unmatched files and recovers after the excess entry is removed', async (t) => {
  const disk = await filesystemFixture(t, { rules: [] });
  const selected = parseLspConfig({
    ...disk.config,
    filesystem: {
      ...disk.config.filesystem,
      discovery: { roots: [disk.config.source.rootUri], include: ['**/*.yaml'] },
    },
  });
  // One existing YAML file plus 9999 unmatched files isolates entries from the 1000-file ceiling.
  for (let offset = 0; offset < 9999; offset += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, 9999 - offset) }, (_, index) =>
        writeFile(path.join(disk.root, `unmatched-${offset + index}.txt`), ''),
      ),
    );
  const scan = async () => {
    using budget = new RequestBudget(Date.now() + 5000);
    return discoverFiles(selected, budget, async () => {});
  };
  assert.deepEqual(await scan(), [disk.uri('catalog.yaml')]);
  await writeFile(path.join(disk.root, 'entry-10001.txt'), '');
  await assert.rejects(scan(), /^Error: Discovery exceeds limits\.$/u);
  await unlink(path.join(disk.root, 'entry-10001.txt'));
  assert.deepEqual(await scan(), [disk.uri('catalog.yaml')]);
});

void test('discovery admits depth 32, rejects depth 33, and recovers after removal', async (t) => {
  const disk = await filesystemFixture(t, { rules: [] });
  const selected = parseLspConfig({
    ...disk.config,
    filesystem: {
      ...disk.config.filesystem,
      discovery: { roots: [disk.config.source.rootUri], include: ['**/deep.yaml'] },
    },
  });
  const levels = Array.from({ length: 32 }, (_, i) => 'd' + i);
  const directory = path.join(disk.root, ...levels);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'deep.yaml'), componentText());
  const scan = async () => {
    using budget = new RequestBudget(Date.now() + 5000);
    return discoverFiles(selected, budget, async () => {});
  };
  assert.deepEqual(await scan(), [disk.uri([...levels, 'deep.yaml'].join('/'))]);
  const overflow = path.join(directory, 'depth-33');
  await mkdir(overflow);
  await assert.rejects(scan(), /^Error: Discovery exceeds limits\.$/u);
  await (await import('node:fs/promises')).rmdir(overflow);
  assert.deepEqual(await scan(), [disk.uri([...levels, 'deep.yaml'].join('/'))]);
});

void test('discovery admits 1000 selected files and rejects file 1001 independently of entry count', async (t) => {
  const disk = await filesystemFixture(t, { rules: [] });
  const selected = parseLspConfig({
    ...disk.config,
    filesystem: {
      ...disk.config.filesystem,
      discovery: { roots: [disk.config.source.rootUri], include: ['**/*.yaml'] },
    },
  });
  for (let offset = 0; offset < 999; offset += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, 999 - offset) }, (_, index) =>
        writeFile(path.join(disk.root, `file-${offset + index}.yaml`), ''),
      ),
    );
  const scan = async () => {
    using budget = new RequestBudget(Date.now() + 5000);
    return discoverFiles(selected, budget, async () => {});
  };
  const admitted = await scan();
  assert.equal(admitted.length, 1000);
  assert(admitted.includes(disk.uri('file-998.yaml')));
  await writeFile(path.join(disk.root, 'file-1001.yaml'), '');
  await assert.rejects(scan(), /^Error: Discovery exceeds limits\.$/u);
  await unlink(path.join(disk.root, 'file-1001.yaml'));
  assert.deepEqual(await scan(), admitted);
});
