import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponseError } from 'vscode-languageserver/node';
import type { FileEvent } from 'vscode-languageserver/node';
import type { CoverageObservation } from '../../src/lsp/coverage-observation.js';
import { admitWatchedFiles } from '../../src/lsp/handlers/documents.js';
import { isFixCommand, registerLanguageHandlers } from '../../src/lsp/handlers/language.js';
import { registerLifecycleHandlers } from '../../src/lsp/handlers/lifecycle.js';
import { createServerContext } from '../../src/lsp/server.js';
import { Lifecycle, currentCoverageObservation } from '../../src/lsp/server-context.js';
import type { CoverageRequestState } from '../../src/lsp/server-context.js';
import {
  FAKE_ROOT,
  FAKE_URI,
  fakeConfig,
  fakeConnection,
  token,
} from '../harness/lsp-fake-connection.js';

const changes = (...uris: string[]): FileEvent[] => uris.map((uri) => ({ uri, type: 2 }));

void test('watched files: more than 1000 changes refresh without traversal and observe nothing', () => {
  const config = fakeConfig({ filesystem: true });
  assert.deepEqual(admitWatchedFiles(config, changes(...Array<string>(1000).fill(FAKE_URI))), {
    refresh: true,
    uris: Array(32).fill(FAKE_URI),
    truncated: true,
  });
  // Rows past the limit are not inspected, so even inadmissible rows refresh.
  assert.deepEqual(admitWatchedFiles(config, changes(...Array<string>(1001).fill('not a uri'))), {
    refresh: true,
    uris: [],
    truncated: true,
  });
});

void test('watched files: at most 32 admissible URIs are observed and the rest are reported truncated', () => {
  const files = [FAKE_URI, ...Array.from({ length: 33 }, (_, i) => `${FAKE_ROOT}file-${i}.yaml`)];
  const config = fakeConfig({ filesystem: files });
  const decision = admitWatchedFiles(config, changes(...files.slice(1)));
  assert.deepEqual(decision, { refresh: true, uris: files.slice(1, 33), truncated: true });
  assert.deepEqual(admitWatchedFiles(config, changes(...files.slice(1, 33))), {
    refresh: true,
    uris: files.slice(1, 33),
    truncated: false,
  });
});

void test('watched files: observed URIs are bounded to 64 KiB of UTF-8', () => {
  const name = 'a'.repeat(3990);
  const files = [
    FAKE_URI,
    ...Array.from({ length: 17 }, (_, i) => `${FAKE_ROOT}${name}-${i}.yaml`),
  ];
  const config = fakeConfig({ filesystem: files });
  const sizes = files.slice(1).map((uri) => Buffer.byteLength(uri, 'utf8'));
  const fitting = sizes.reduce(
    (count, _size, index) =>
      sizes.slice(0, index + 1).reduce((a, b) => a + b, 0) <= 64 * 1024 ? index + 1 : count,
    0,
  );
  assert.ok(fitting < 17 && fitting > 0);
  const decision = admitWatchedFiles(config, changes(...files.slice(1)));
  assert.deepEqual(decision, {
    refresh: true,
    uris: files.slice(1, 1 + fitting),
    truncated: true,
  });
});

void test('watched files: only canonical, typed changes to approved files or their directories refresh', () => {
  const config = fakeConfig({ filesystem: true });
  const none = { refresh: false };
  assert.deepEqual(
    admitWatchedFiles(config, changes('file:///workspace/./catalog-info.yaml')),
    none,
  );
  assert.deepEqual(
    admitWatchedFiles(config, changes('file:///workspace//catalog-info.yaml')),
    none,
  );
  assert.deepEqual(
    admitWatchedFiles(config, [{ uri: FAKE_URI, type: 4 } as unknown as FileEvent]),
    none,
  );
  assert.deepEqual(
    admitWatchedFiles(config, [{ uri: FAKE_URI, type: 0 } as unknown as FileEvent]),
    none,
  );
  assert.deepEqual(admitWatchedFiles(config, changes('file:///elsewhere/catalog-info.yaml')), none);
  assert.deepEqual(admitWatchedFiles(config, changes('file:///workspace/other.yaml')), none);
  // A string prefix that is not a directory boundary does not contain the approved file.
  assert.deepEqual(admitWatchedFiles(config, changes('file:///work/')), none);
  assert.deepEqual(admitWatchedFiles(config, [null, { uri: 7 }] as unknown as FileEvent[]), none);
  for (const type of [1, 2, 3])
    assert.deepEqual(admitWatchedFiles(config, [{ uri: FAKE_URI, type } as FileEvent]), {
      refresh: true,
      uris: [FAKE_URI],
      truncated: false,
    });
  assert.deepEqual(admitWatchedFiles(config, changes(FAKE_ROOT)), {
    refresh: true,
    uris: [FAKE_ROOT],
    truncated: false,
  });
  assert.deepEqual(admitWatchedFiles(config, changes('file:///elsewhere/x.yaml', FAKE_URI)), {
    refresh: true,
    uris: [FAKE_URI],
    truncated: false,
  });
});

const document = { uri: FAKE_URI, version: 3, digest: 'sha256:current' };
const observation: CoverageObservation = {
  sourceDigest: 'sha256:source',
  policyDigest: 'sha256:policy',
  profileDigest: 'sha256:profile',
  activationDigest: 'sha256:activation',
  generation: 5,
  dependencyGeneration: 2,
  documents: [document],
  coverage: [],
};
function coverageState(
  changes: Partial<Omit<CoverageRequestState, 'workspace'>> & {
    workspace?: Partial<CoverageRequestState['workspace']>;
  } = {},
): CoverageRequestState {
  const { workspace, ...rest } = changes;
  return {
    initialized: true,
    stopped: false,
    available: true,
    enabled: true,
    observation,
    generation: 5,
    dependencyGeneration: 2,
    ...rest,
    workspace: {
      unavailableSources: false,
      capacityExceeded: false,
      document: (uri: string) =>
        uri === document.uri ? ({ ...document, lifetime: 1 } as never) : undefined,
      selected: () => true,
      ...workspace,
    },
  };
}

void test('coverage observation: a matching request returns the observation', () => {
  assert.equal(currentCoverageObservation({ ...document }, coverageState()), observation);
});

void test('coverage observation: each stale or malformed request returns null', () => {
  const cases: Record<string, [unknown, CoverageRequestState]> = {
    'wrong version': [{ ...document, version: 2 }, coverageState()],
    'wrong digest': [{ ...document, digest: 'sha256:other' }, coverageState()],
    'unknown document': [{ ...document, uri: 'file:///workspace/other.yaml' }, coverageState()],
    'unselected document': [document, coverageState({ workspace: { selected: () => false } })],
    'older validation generation': [document, coverageState({ generation: 6 })],
    'older dependency generation': [document, coverageState({ dependencyGeneration: 3 })],
    'document not observed': [
      document,
      coverageState({ observation: { ...observation, documents: [{ ...document, version: 2 }] } }),
    ],
    'no observation': [document, coverageState({ observation: undefined })],
    'capacity exceeded': [document, coverageState({ workspace: { capacityExceeded: true } })],
    'unavailable sources': [document, coverageState({ workspace: { unavailableSources: true } })],
    'observation disabled': [document, coverageState({ enabled: false })],
    'session unavailable': [document, coverageState({ available: false })],
    'not initialized': [document, coverageState({ initialized: false })],
    stopped: [document, coverageState({ stopped: true })],
    'null parameters': [null, coverageState()],
    'array parameters': [[document], coverageState()],
    'string parameters': [FAKE_URI, coverageState()],
    'numeric uri': [{ ...document, uri: 1 }, coverageState()],
    'string version': [{ ...document, version: '3' }, coverageState()],
    'missing digest': [{ uri: document.uri, version: document.version }, coverageState()],
  };
  for (const [name, [params, state]] of Object.entries(cases))
    assert.equal(currentCoverageObservation(params, state), null, name);
});

function lifecycle(cleanup: () => readonly Promise<unknown>[] = () => []) {
  const events: string[] = [];
  const owner = new Lifecycle({
    stop: () => events.push('stop'),
    cleanup: () => {
      events.push('cleanup');
      return cleanup();
    },
  });
  return { owner, events };
}

void test('Lifecycle: close is idempotent and returns the promise of the first call', async () => {
  const { owner, events } = lifecycle();
  const first = owner.close();
  assert.equal(owner.stopped, true);
  assert.equal(owner.close(), first);
  await first;
  assert.equal(owner.close(), first);
  assert.deepEqual(events, ['stop', 'cleanup']);
});

void test('Lifecycle: a failing owner cleanup rejects with the cleanup error after every owner settles', async () => {
  let settled = false;
  const { owner } = lifecycle(() => [
    Promise.reject(new Error('owner failed')),
    new Promise<void>((resolve) =>
      setImmediate(() => {
        settled = true;
        resolve();
      }),
    ),
  ]);
  await assert.rejects(owner.close(), { message: 'Language server cleanup failed.' });
  assert.equal(settled, true);
});

void test('Lifecycle: shutdown then exit reports 0, exit alone reports 1, and a failed close reports 1', async () => {
  const codes: number[] = [];
  const report = (code: number) => codes.push(code);
  const shut = lifecycle().owner;
  shut.initialize();
  await shut.shutdown();
  assert.equal(shut.requestedShutdown, true);
  shut.exit(report);
  const alone = lifecycle().owner;
  alone.initialize();
  alone.exit(report);
  const failing = lifecycle(() => [Promise.reject(new Error('owner failed'))]).owner;
  failing.initialize();
  await failing.shutdown().catch(() => undefined);
  failing.exit(report);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(codes, [0, 1, 1]);
});

void test('Lifecycle: the admission guard rejects before initialize and after close', async () => {
  const { owner } = lifecycle();
  const code = (work: () => unknown) => {
    try {
      work();
      return undefined;
    } catch (error) {
      return error instanceof ResponseError ? error.code : error;
    }
  };
  assert.equal(
    code(() => owner.admitted(() => 1)),
    -32002,
  );
  await assert.rejects(owner.shutdown(), (error: ResponseError<unknown>) => error.code === -32002);
  owner.initialize();
  assert.equal(
    owner.admitted(() => 1),
    1,
  );
  await owner.close();
  assert.equal(
    code(() => owner.admitted(() => 1)),
    -32600,
  );
});

void test('execute command: only the fix command with one string argument is a fix request', () => {
  const fix = (args: unknown) => ({ command: 'bve.applyFix', arguments: args as unknown[] });
  assert.equal(isFixCommand(fix(['id']), true), true);
  assert.equal(isFixCommand(fix(['id']), false), false);
  assert.equal(isFixCommand({ command: 'bve.other', arguments: ['id'] }, true), false);
  assert.equal(isFixCommand(fix([]), true), false);
  assert.equal(isFixCommand(fix(['id', 'id']), true), false);
  assert.equal(isFixCommand(fix([1]), true), false);
  assert.equal(isFixCommand(fix(undefined), true), false);
  assert.equal(isFixCommand(fix('id'), true), false);
  assert.equal(isFixCommand(undefined, true), false);
});

void test('execute command: invalid requests and a busy edit slot are answered without applying', async () => {
  let release!: (value: unknown) => void;
  const fake = fakeConnection({
    sendRequest: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const context = createServerContext(fake.connection, fakeConfig(), {});
  registerLifecycleHandlers(context);
  registerLanguageHandlers(context);
  fake.handler('initialize')(
    {
      processId: null,
      rootUri: FAKE_ROOT,
      capabilities: {
        workspace: { applyEdit: true, workspaceEdit: { documentChanges: true } },
        textDocument: {
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
          publishDiagnostics: { dataSupport: true },
        },
      },
    },
    token,
  );
  const execute = fake.handler('workspace/executeCommand');
  const invalid = { applied: false, reason: 'invalid_request' };
  assert.deepEqual(execute({ command: 'bve.other', arguments: ['id'] }, token), invalid);
  assert.deepEqual(execute({ command: 'bve.applyFix', arguments: [] }, token), invalid);
  assert.deepEqual(execute({ command: 'bve.applyFix', arguments: ['a', 'b'] }, token), invalid);
  assert.deepEqual(execute({ command: 'bve.applyFix', arguments: [7] }, token), invalid);
  const pending = context.clientEdits.apply({ changes: {} }, token);
  assert.equal(context.clientEdits.busy, true);
  assert.deepEqual(await execute({ command: 'bve.applyFix', arguments: ['id'] }, token), {
    applied: false,
    reason: 'busy',
  });
  release({ applied: true });
  assert.deepEqual(await pending, { applied: true });
  await context.lifecycle.close();
});
