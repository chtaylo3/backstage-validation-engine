import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ResponseError } from 'vscode-languageserver/node';
import { attachLspServer } from '../../src/lsp/server.js';
import { componentText } from '../harness/policy-fixture.js';
import {
  FAKE_ROOT,
  FAKE_URI,
  STAR,
  fakeConfig,
  fakeConnection,
  fakeFilesystem,
  token,
} from '../harness/lsp-fake-connection.js';

/**
 * What every registered handler does before `initialize`, while running, and after `shutdown`: the
 * error it throws or rejects with, the value it returns, and the messages it sends before the next
 * turns of the event loop. Validation is debounced past that window, so scheduled validation never
 * shows up. The table was generated from the server before it was split into handler modules.
 * Regenerate only with BVE_UPDATE_LSP_GOLDEN=1 (then format the file with Prettier) and only when a
 * plan names a protocol change.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const TABLE = path.join(repository, 'test/fixtures/lsp-lifecycle.json');
const STATES = ['before initialize', 'running', 'after shutdown'] as const;
type State = (typeof STATES)[number];
const position = { line: 6, character: 10 };
const capabilities = {
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true, failureHandling: 'transactional' },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
  },
  textDocument: {
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } } },
    publishDiagnostics: { dataSupport: true },
  },
};
/** The arguments each handler receives from the connection, by method. */
const CALLS: Readonly<Record<string, readonly unknown[]>> = {
  initialize: [{ processId: null, rootUri: FAKE_ROOT, capabilities }, token],
  initialized: [{}],
  shutdown: [token],
  exit: [],
  'textDocument/completion': [{ textDocument: { uri: FAKE_URI }, position }, token],
  'textDocument/hover': [{ textDocument: { uri: FAKE_URI }, position }, token],
  'textDocument/definition': [{ textDocument: { uri: FAKE_URI }, position }, token],
  'textDocument/codeAction': [
    {
      textDocument: { uri: FAKE_URI },
      range: { start: position, end: position },
      context: { diagnostics: [] },
    },
    token,
  ],
  'workspace/executeCommand': [{ command: 'bve.applyFix', arguments: ['untrusted'] }, token],
  'textDocument/didOpen': [
    { textDocument: { uri: FAKE_URI, languageId: 'yaml', version: 1, text: componentText() } },
  ],
  'textDocument/didChange': [
    { textDocument: { uri: FAKE_URI, version: 2 }, contentChanges: [{ text: componentText() }] },
  ],
  'textDocument/didClose': [{ textDocument: { uri: FAKE_URI } }],
  'textDocument/didSave': [{ textDocument: { uri: FAKE_URI } }],
  'workspace/didChangeWatchedFiles': [{ changes: [{ uri: FAKE_URI, type: 2 }] }],
  'workspace/didDeleteFiles': [{ files: [{ uri: FAKE_URI }] }],
  'workspace/didRenameFiles': [
    { files: [{ oldUri: FAKE_URI, newUri: 'file:///workspace/renamed.yaml' }] },
  ],
  'bve/filesystemObservation': [undefined, token],
  'bve/validationCoverage': [{ uri: FAKE_URI, version: 1, digest: 'sha256:0' }, token],
  'bve/recordSelection': ['team'],
  'bve/searchReferences': ['team', token],
  'bve/reloadConfiguration': [undefined, token],
  [STAR]: ['bve/unsupported', {}, token],
};

const turns = async (count: number) => {
  for (let index = 0; index < count; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
function describe(error: unknown) {
  return error instanceof ResponseError
    ? { type: 'ResponseError', code: error.code, message: error.message }
    : { type: (error as Error).name, message: (error as Error).message };
}
const value = (result: unknown) => (result === undefined ? '<undefined>' : result);

/** How a call ends: a synchronous throw or return, or a rejected or resolved promise. */
async function settle(call: () => unknown): Promise<Record<string, unknown>> {
  try {
    const result = call();
    if (result instanceof Promise)
      return await result.then(
        (resolved: unknown) => ({ resolves: value(resolved) }),
        (error: unknown) => ({ rejects: describe(error) }),
      );
    return { returns: value(result) };
  } catch (error) {
    return { throws: describe(error) };
  }
}
async function cell(method: string, state: State) {
  const fake = fakeConnection();
  const exits: number[] = [];
  const server = attachLspServer(fake.connection, fakeConfig({ filesystem: true }), {
    filesystem: fakeFilesystem(),
    exit: (code) => exits.push(code),
  });
  if (state !== 'before initialize') {
    await fake.handler('initialize')(...CALLS.initialize!);
    await fake.handler('initialized')(...CALLS.initialized!);
  }
  if (state === 'after shutdown') await fake.handler('shutdown')(...CALLS.shutdown!);
  await turns(3);
  fake.outbound.length = 0;
  const outcome = await settle(() => fake.handler(method)(...CALLS[method]!));
  await turns(3);
  const effects = fake.outbound.map((row) => `${row.channel} ${row.method}`);
  // A watched-file event then an observation read reveals how many validation invalidations
  // the call caused, through the generation the observation records.
  const probe =
    state === 'running'
      ? await settle(() => {
          fake.handler('workspace/didChangeWatchedFiles')({
            changes: [{ uri: FAKE_URI, type: 2 }],
          });
          return fake.handler('bve/filesystemObservation')(undefined, token);
        })
      : undefined;
  await server.close().catch(() => undefined);
  await turns(3);
  return {
    ...outcome,
    effects,
    ...(probe ? { probe } : {}),
    ...(exits.length ? { exit: exits } : {}),
  };
}

const update = process.env.BVE_UPDATE_LSP_GOLDEN === '1';
const observed: Record<string, Record<State, unknown>> = {};
const expected = update
  ? {}
  : (JSON.parse(await readFile(TABLE, 'utf8')) as Record<string, Record<State, unknown>>);
after(async () => {
  if (update) await writeFile(TABLE, `${JSON.stringify(observed, null, 2)}\n`);
});

void test('the lifecycle table covers exactly the registered methods', async () => {
  const probe = fakeConnection();
  const server = attachLspServer(probe.connection, fakeConfig({ filesystem: true }), {
    filesystem: fakeFilesystem(),
  });
  await server.close();
  const registered = probe.registrations.map((row) => row.method).sort();
  assert.deepEqual(registered, Object.keys(CALLS).sort());
  if (!update) assert.deepEqual(Object.keys(expected), registered);
});

for (const method of Object.keys(CALLS).sort())
  void test(`${method} keeps its behavior before initialize, while running, and after shutdown`, async () => {
    const row = {} as Record<State, unknown>;
    for (const state of STATES) row[state] = await cell(method, state);
    observed[method] = row;
    if (!update) assert.equal(JSON.stringify(row), JSON.stringify(expected[method]));
  });
