import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ResponseError } from 'vscode-languageserver/node';
import type { ClientCapabilities } from 'vscode-languageserver/node';
import { attachLspServer } from '../../src/lsp/server.js';
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
      ? { error: { type: 'ResponseError', code: error.code, message: error.message } }
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
    error: { type: 'Error', message: 'UTF-16 positions are required.' },
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
