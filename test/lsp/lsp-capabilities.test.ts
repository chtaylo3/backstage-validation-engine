import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ResponseError } from 'vscode-languageserver/node';
import type { ClientCapabilities } from 'vscode-languageserver/node';
import { registerLifecycleHandlers } from '../../src/lsp/handlers/lifecycle.js';
import { attachLspServer, createServerContext } from '../../src/lsp/server.js';
import { expandRepeats, shareRepeats } from '../harness/golden-format.js';
import {
  FAKE_ROOT,
  fakeConfig,
  fakeConnection,
  fakeFilesystem,
  token,
} from '../harness/lsp-fake-connection.js';

/**
 * The `initialize` result for client capability combinations, through a recording connection. The
 * golden file was generated from the server before it was split into handler modules; each case
 * must keep producing the same JSON text, key order included. A repeated result refers to its first
 * occurrence. Regenerate only with BVE_UPDATE_LSP_GOLDEN=1 (then format the file with Prettier) and
 * only when a plan names a protocol change.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const GOLDEN = path.join(repository, 'test/fixtures/lsp-capabilities.json');

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
/** A client that supports every feature the server looks at. */
function full(): Mutable<ClientCapabilities> {
  return {
    general: { positionEncodings: ['utf-16'] },
    workspace: {
      applyEdit: true,
      workspaceEdit: { documentChanges: true, failureHandling: 'transactional' },
      didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    },
    textDocument: {
      codeAction: {
        codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } },
      },
      publishDiagnostics: { dataSupport: true },
    },
  };
}
const variants: Record<string, () => ClientCapabilities> = {
  'empty capabilities': () => ({}),
  'all features': full,
  'fixes without workspace.applyEdit': () => {
    const capabilities = full();
    delete capabilities.workspace!.applyEdit;
    return capabilities;
  },
  'fixes without workspaceEdit.documentChanges': () => {
    const capabilities = full();
    delete capabilities.workspace!.workspaceEdit!.documentChanges;
    return capabilities;
  },
  'fixes without codeActionLiteralSupport': () => {
    const capabilities = full();
    delete capabilities.textDocument!.codeAction!.codeActionLiteralSupport;
    return capabilities;
  },
  'fixes without publishDiagnostics.dataSupport': () => {
    const capabilities = full();
    delete capabilities.textDocument!.publishDiagnostics!.dataSupport;
    return capabilities;
  },
  'fixes with applyEdit false': () => {
    const capabilities = full();
    capabilities.workspace!.applyEdit = false;
    return capabilities;
  },
  'failure handling textOnlyTransactional': () => {
    const capabilities = full();
    capabilities.workspace!.workspaceEdit!.failureHandling = 'textOnlyTransactional';
    return capabilities;
  },
  'failure handling abort': () => {
    const capabilities = full();
    capabilities.workspace!.workspaceEdit!.failureHandling = 'abort';
    return capabilities;
  },
  'failure handling absent': () => {
    const capabilities = full();
    delete capabilities.workspace!.workspaceEdit!.failureHandling;
    return capabilities;
  },
  'watching without relative patterns': () => {
    const capabilities = full();
    delete capabilities.workspace!.didChangeWatchedFiles!.relativePatternSupport;
    return capabilities;
  },
  'watching without dynamic registration': () => {
    const capabilities = full();
    delete capabilities.workspace!.didChangeWatchedFiles!.dynamicRegistration;
    return capabilities;
  },
  'position encodings absent': () => {
    const capabilities = full();
    delete capabilities.general;
    return capabilities;
  },
  'position encodings empty': () => {
    const capabilities = full();
    capabilities.general!.positionEncodings = [];
    return capabilities;
  },
  'position encodings offer UTF-8 and UTF-16': () => {
    const capabilities = full();
    capabilities.general!.positionEncodings = ['utf-8', 'utf-16'];
    return capabilities;
  },
  'position encodings without UTF-16': () => {
    const capabilities = full();
    capabilities.general!.positionEncodings = ['utf-8', 'utf-32'];
    return capabilities;
  },
};

function outcome(work: () => unknown): Promise<unknown> {
  const describe = (error: unknown) =>
    error instanceof ResponseError
      ? {
          error: {
            type: 'ResponseError',
            code: error.code,
            message: error.message,
            ...(error.data === undefined ? {} : { data: error.data as unknown }),
          },
        }
      : { error: { type: (error as Error).name, message: (error as Error).message } };
  try {
    return Promise.resolve(work()).then(
      (result) => ({ result }),
      (error: unknown) => ({ rejects: true, ...describe(error) }),
    );
  } catch (error) {
    return Promise.resolve(describe(error));
  }
}
function host(filesystem: boolean) {
  const fake = fakeConnection();
  const server = attachLspServer(
    fake.connection,
    fakeConfig({ filesystem }),
    filesystem ? { filesystem: fakeFilesystem() } : {},
  );
  const initialize = (capabilities: ClientCapabilities) =>
    outcome(() =>
      fake.handler('initialize')({ processId: null, rootUri: FAKE_ROOT, capabilities }, token),
    );
  return { server, initialize };
}

async function observe(): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown> = {};
  for (const filesystem of [false, true])
    for (const [name, capabilities] of Object.entries(variants)) {
      const { server, initialize } = host(filesystem);
      cases[`${filesystem ? 'filesystem' : 'no filesystem'}; ${name}`] =
        await initialize(capabilities());
      await server.close();
    }
  {
    const { server, initialize } = host(false);
    cases['second initialize after success'] = [await initialize(full()), await initialize(full())];
    await server.close();
  }
  {
    const { server, initialize } = host(false);
    const rejected = full();
    rejected.general!.positionEncodings = ['utf-8'];
    cases['initialize after a rejected position encoding'] = [
      await initialize(rejected),
      await initialize(full()),
    ];
    await server.close();
  }
  return cases;
}

void test('initialize results for every client capability combination equal the golden file', async () => {
  const observed = await observe();
  if (process.env.BVE_UPDATE_LSP_GOLDEN === '1')
    await writeFile(GOLDEN, `${JSON.stringify(shareRepeats(observed), null, 2)}\n`);
  const golden = expandRepeats(JSON.parse(await readFile(GOLDEN, 'utf8')));
  assert.equal(JSON.stringify(observed), JSON.stringify(golden));
});

void test('initialize rejects a second call with -32600 and a client without UTF-16 positions', async () => {
  const { server, initialize } = host(false);
  const rejected = full();
  rejected.general!.positionEncodings = ['utf-8'];
  assert.deepEqual(await initialize(rejected), {
    error: {
      type: 'ResponseError',
      code: -32602,
      message: 'UTF-16 positions are required.',
      data: { retry: false },
    },
  });
  assert.ok('result' in ((await initialize(full())) as object));
  assert.deepEqual(await initialize(full()), {
    error: {
      type: 'ResponseError',
      code: -32600,
      message: 'Language server cannot initialize in its current state.',
    },
  });
  await server.close();
});

/** A server context with only the lifecycle handlers, so a test can read its features directly. */
function lifecycleHost() {
  const fake = fakeConnection();
  const context = createServerContext(fake.connection, fakeConfig(), {});
  registerLifecycleHandlers(context);
  const initialize = (capabilities: ClientCapabilities) =>
    fake.handler('initialize')({ processId: null, rootUri: FAKE_ROOT, capabilities }, token);
  const flags = () => ({
    fixesEnabled: context.features.fixesEnabled,
    atomicTextEdits: context.features.atomicTextEdits,
    dynamicWatching: context.features.dynamicWatching,
  });
  return { context, initialize, flags };
}
const NO_FEATURES = { fixesEnabled: false, atomicTextEdits: false, dynamicWatching: false };
const ALL_FEATURES = { fixesEnabled: true, atomicTextEdits: true, dynamicWatching: true };
function withEncodings(encodings: string[] | undefined, capabilities = full()) {
  if (encodings === undefined) delete capabilities.general;
  else capabilities.general = { positionEncodings: encodings };
  return capabilities;
}
function encodingRejection(error: unknown): boolean {
  assert.ok(error instanceof ResponseError, String(error));
  assert.equal(error.code, -32602);
  assert.equal(error.message, 'UTF-16 positions are required.');
  assert.deepEqual(error.data, { retry: false });
  return true;
}

void test('initialize rejects encodings without UTF-16 as invalid parameters that a retry cannot fix', async () => {
  const { context, initialize } = lifecycleHost();
  assert.throws(() => initialize(withEncodings(['utf-8'])), encodingRejection);
  await context.lifecycle.close();
});

void test('a rejected initialize writes no client feature and leaves the server uninitialized', async () => {
  const { context, initialize, flags } = lifecycleHost();
  let rejection: unknown;
  assert.throws(
    () => initialize(withEncodings(['utf-8', 'utf-32'])),
    (error: unknown) => ((rejection = error), true),
  );
  // The state is checked before the error, so that a written state fails on its own.
  assert.deepEqual(flags(), NO_FEATURES);
  assert.equal(context.lifecycle.initialized, false);
  encodingRejection(rejection);
  await context.lifecycle.close();
});

void test('a valid initialize after a rejected one succeeds with the result of a fresh connection', async () => {
  const fresh = lifecycleHost();
  const expected = fresh.initialize(full());
  await fresh.context.lifecycle.close();
  const { context, initialize, flags } = lifecycleHost();
  assert.throws(() => initialize(withEncodings(['utf-8', 'utf-32'])), encodingRejection);
  assert.deepEqual(initialize(full()), expected);
  assert.deepEqual(flags(), ALL_FEATURES);
  assert.equal(context.lifecycle.initialized, true);
  await context.lifecycle.close();
});

void test('a rejected client that offered fixes does not enable them for the next client', async () => {
  const { context, initialize, flags } = lifecycleHost();
  assert.throws(() => initialize(withEncodings(['utf-8'])), encodingRejection);
  const plain = full();
  delete plain.workspace!.applyEdit;
  const result = initialize(plain) as { capabilities: Record<string, unknown> };
  assert.equal(flags().fixesEnabled, false);
  assert.equal('codeActionProvider' in result.capabilities, false);
  assert.equal('executeCommandProvider' in result.capabilities, false);
  await context.lifecycle.close();
});

void test('an absent or empty encoding list, or any list with UTF-16, is accepted with UTF-16 positions', async () => {
  for (const encodings of [undefined, [], ['utf-16'], ['utf-8', 'utf-16'], ['utf-32', 'utf-16']]) {
    const { context, initialize, flags } = lifecycleHost();
    const result = initialize(withEncodings(encodings)) as {
      capabilities: { positionEncoding?: string };
    };
    assert.equal(result.capabilities.positionEncoding, 'utf-16', JSON.stringify(encodings));
    assert.deepEqual(flags(), ALL_FEATURES);
    assert.equal(context.lifecycle.initialized, true);
    await context.lifecycle.close();
  }
});

void test('the state guard runs first: initialize without UTF-16 after a success rejects with -32600', async () => {
  const { context, initialize } = lifecycleHost();
  initialize(full());
  assert.throws(
    () => initialize(withEncodings(['utf-8'])),
    (error: unknown) => error instanceof ResponseError && error.code === -32600,
  );
  await context.lifecycle.close();
});
