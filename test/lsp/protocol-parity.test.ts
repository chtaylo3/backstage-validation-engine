import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ResponseError } from 'vscode-languageserver/node';
import { registerCustomHandlers } from '../../src/lsp/handlers/custom.js';
import { registerLifecycleHandlers } from '../../src/lsp/handlers/lifecycle.js';
import { attachLspServer, createServerContext } from '../../src/lsp/server.js';
import type { LspServerOptions } from '../../src/lsp/server-context.js';
import { BVE_METHODS, BVE_METHOD_SHAPES } from '../../src/protocol/index.js';
import type { BveMethod } from '../../src/protocol/index.js';
import {
  FAKE_ROOT,
  fakeConfig,
  fakeConnection,
  fakeFilesystem,
  token,
} from '../harness/lsp-fake-connection.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const shapes = Object.entries(BVE_METHOD_SHAPES);
const clientToServer = shapes.filter(([, shape]) => shape.direction === 'clientToServer');

for (const filesystem of [false, true])
  void test(`protocol parity: the server registers exactly the client-to-server protocol methods (filesystem ${filesystem})`, async () => {
    const fake = fakeConnection();
    const server = attachLspServer(
      fake.connection,
      fakeConfig({ filesystem }),
      filesystem ? { filesystem: fakeFilesystem() } : {},
    );
    for (const [method, shape] of clientToServer) {
      const rows = fake.registrations.filter((row) => row.method === method);
      assert.equal(rows.length, 1, `${method} has one handler`);
      assert.equal(rows[0]!.kind, shape.kind, `${method} is a ${shape.kind}`);
    }
    const custom = fake.registrations
      .map((row) => row.method)
      .filter((method) => method.startsWith('bve/'))
      .sort();
    assert.deepEqual(custom, clientToServer.map(([method]) => method).sort());
    await server.close();
  });

void test('protocol parity: the VS Code client spells no custom method as a string literal', async () => {
  const file = path.join(repository, 'extensions/vscode/src/extension.ts');
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const literals: string[] = [];
  let strings = 0;
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      strings++;
      if (node.text.startsWith('bve/')) literals.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert(strings > 0, 'The client source has string literals, so the scan ran.');
  assert.deepEqual(literals, []);
});

/*
 * The admission rule of `BVE_METHOD_SHAPES`, driven from the method list: a client-to-server request
 * outside the initialized state rejects (-32002 before initialize, -32600 after shutdown); a
 * client-to-server notification outside it, or with parameters that fail its guard, is dropped
 * without effect and without a response.
 */
const requests = clientToServer
  .filter(([, shape]) => shape.kind === 'request')
  .map(([method]) => method as BveMethod);
const notifications = clientToServer
  .filter(([, shape]) => shape.kind === 'notification')
  .map(([method]) => method as BveMethod);
/**
 * Valid and guard-failing parameters of each client-to-server notification. A notification that is
 * missing here fails the tests below, so a new one cannot go untested.
 */
const NOTIFICATION_PARAMS: Partial<
  Record<BveMethod, { readonly valid: unknown; readonly invalid: readonly unknown[] }>
> = {
  [BVE_METHODS.recordSelection]: {
    valid: 'component:default/service',
    invalid: [7, 'x'.repeat(513), null, undefined],
  },
};
function paramsOf(method: BveMethod) {
  const params = NOTIFICATION_PARAMS[method];
  assert.ok(params, `${method} has test parameters`);
  return params;
}

/** The lifecycle and custom handlers over one context, with the selection recorders observed. */
function customHost(options: LspServerOptions = {}) {
  const fake = fakeConnection();
  const context = createServerContext(fake.connection, fakeConfig(), options);
  registerLifecycleHandlers(context);
  registerCustomHandlers(context);
  const recorded: [string, unknown][] = [];
  const observe = () => {
    const { completion, editor } = context.sessions.current;
    const toCompletion = completion.record.bind(completion);
    const toEditor = editor.record.bind(editor);
    completion.record = (value) => {
      recorded.push(['completion', value]);
      toCompletion(value);
    };
    editor.record = (value) => {
      recorded.push(['editor', value]);
      toEditor(value);
    };
  };
  observe();
  const initialize = () =>
    fake.handler('initialize')({ processId: null, rootUri: FAKE_ROOT, capabilities: {} }, token);
  const shutdown = () => fake.handler('shutdown')() as Promise<void>;
  /** Calls a notification handler; it must neither throw nor return a rejecting promise. */
  const notify = async (method: BveMethod, params: unknown) => {
    await fake.handler(method)(params);
  };
  return { fake, context, recorded, observe, initialize, shutdown, notify };
}
async function requestOutcome(work: () => unknown): Promise<unknown> {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    return error instanceof ResponseError ? error.code : String(error);
  }
}

void test('admission: every client-to-server request rejects before initialize and after shutdown', async () => {
  const exercised: string[] = [];
  for (const method of requests) {
    const host = customHost();
    assert.equal(
      await requestOutcome(() => host.fake.handler(method)(undefined, token)),
      -32002,
      `${method} before initialize`,
    );
    host.initialize();
    await host.shutdown();
    assert.equal(
      await requestOutcome(() => host.fake.handler(method)(undefined, token)),
      -32600,
      `${method} after shutdown`,
    );
    exercised.push(method);
    await host.context.lifecycle.close();
  }
  assert.ok(requests.length > 0);
  assert.deepEqual(exercised, requests);
});

void test('admission: every client-to-server notification is dropped before initialize and after shutdown', async () => {
  const exercised: string[] = [];
  for (const method of notifications) {
    const { valid } = paramsOf(method);
    const host = customHost();
    const outbound = host.fake.outbound.length;
    await assert.doesNotReject(host.notify(method, valid), `${method} before initialize`);
    assert.equal(host.fake.outbound.length, outbound, `${method} sent nothing`);
    assert.deepEqual(host.recorded, [], `${method} recorded nothing`);
    host.initialize();
    await host.shutdown();
    const stopped = host.fake.outbound.length;
    await assert.doesNotReject(host.notify(method, valid), `${method} after shutdown`);
    assert.equal(host.fake.outbound.length, stopped, `${method} sent nothing`);
    assert.deepEqual(host.recorded, [], `${method} recorded nothing`);
    exercised.push(method);
    await host.context.lifecycle.close();
  }
  assert.ok(notifications.length > 0);
  assert.deepEqual(exercised, notifications);
});

void test('admission: a running server drops a notification whose parameters fail its guard', async () => {
  const exercised: string[] = [];
  for (const method of notifications) {
    const host = customHost();
    host.initialize();
    for (const params of paramsOf(method).invalid) {
      const outbound = host.fake.outbound.length;
      await assert.doesNotReject(host.notify(method, params), `${method} ${String(params)}`);
      assert.equal(host.fake.outbound.length, outbound);
      assert.deepEqual(host.recorded, [], `${method} ${String(params)}`);
    }
    exercised.push(method);
    await host.context.lifecycle.close();
  }
  assert.deepEqual(exercised, notifications);
});

void test('admission: a running server drops a valid notification while the session is unavailable', async () => {
  const exercised: string[] = [];
  for (const method of notifications) {
    const host = customHost({ reload: () => Promise.reject(new Error('reload unavailable')) });
    host.initialize();
    assert.deepEqual(await host.context.reloadConfiguration(), { reloaded: false });
    assert.equal(host.context.sessions.available, false);
    host.observe();
    const outbound = host.fake.outbound.length;
    await assert.doesNotReject(host.notify(method, paramsOf(method).valid));
    assert.equal(host.fake.outbound.length, outbound);
    assert.deepEqual(host.recorded, [], method);
    exercised.push(method);
    await host.context.lifecycle.close();
  }
  assert.deepEqual(exercised, notifications);
});

void test('admission: a running server records a valid selection once in the completion service and the editor', async () => {
  const host = customHost();
  host.initialize();
  const outbound = host.fake.outbound.length;
  const { valid } = paramsOf(BVE_METHODS.recordSelection);
  await host.notify(BVE_METHODS.recordSelection, valid);
  assert.deepEqual(host.recorded, [
    ['completion', valid],
    ['editor', valid],
  ]);
  assert.equal(host.fake.outbound.length, outbound);
  await host.context.lifecycle.close();
});

void test('admission: every custom notification handler is registered through the one admission helper', async () => {
  const directory = path.join(repository, 'src/lsp/handlers');
  const outside: string[] = [];
  let calls = 0;
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.ts')).sort()) {
    const text = await readFile(path.join(directory, name), 'utf8');
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node, helper: boolean): void => {
      const inHelper =
        helper || (ts.isFunctionDeclaration(node) && node.name?.text === 'onAdmittedNotification');
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'onNotification'
      ) {
        calls++;
        if (!inHelper) outside.push(`${name}:${node.getText(source).slice(0, 60)}`);
      }
      ts.forEachChild(node, (child) => visit(child, inHelper));
    };
    visit(source, false);
  }
  assert.equal(calls, 1, 'the helper is the one onNotification registration');
  assert.deepEqual(outside, []);
});
