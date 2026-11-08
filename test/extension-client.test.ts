import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ExtensionContext, Uri } from 'vscode';
import type { LanguageClientOptions } from 'vscode-languageclient/node';
import { editorState } from './harness/editor-api.js';
import { clients, onStart, onStop } from './harness/editor-language-client.js';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'vscode')
      return { url: new URL('./harness/editor-api.js', import.meta.url).href, shortCircuit: true };
    if (specifier === 'vscode-languageclient/node')
      return {
        url: new URL('./harness/editor-language-client.js', import.meta.url).href,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const extension = await import('../extensions/vscode/src/extension.js');
const { Uri: EditorUri } = await import('./harness/editor-api.js');
let directory: string;
let config: string;
let subscriptions: { dispose(): unknown }[];
let context: ExtensionContext;
const original = process.env.BVE_LSP_CONFIG;
const command = (name: string) =>
  Promise.resolve(editorState.commands.get('backstageValidation.' + name)!());
async function select(value: unknown) {
  await writeFile(config, typeof value === 'string' ? value : JSON.stringify(value));
}
const options = () => clients.at(-1)!.options;
const data = (files: unknown[] = []) => ({ source: { files: files.map((uri) => ({ uri })) } });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bve-client-'));
  config = path.join(directory, 'config.json');
  subscriptions = [];
  context = {
    subscriptions,
    asAbsolutePath: (value: string) => path.join(directory, value),
  } as ExtensionContext;
  editorState.selected = undefined;
  editorState.trusted = true;
  editorState.messages.length = 0;
  editorState.shown = 0;
  onStart();
  onStop();
  clients.length = 0;
  delete process.env.BVE_LSP_CONFIG;
  await select(data());
});
afterEach(async () => {
  onStop();
  onStart();
  await extension.deactivate();
  for (const subscription of subscriptions) subscription.dispose();
  await rm(directory, { recursive: true, force: true });
  if (original === undefined) delete process.env.BVE_LSP_CONFIG;
  else process.env.BVE_LSP_CONFIG = original;
});

void test('client remains stopped without trusted launcher input and starts after a User Setting change', async () => {
  const api = await extension.activate(context);
  assert.equal(api.status().running, false);
  assert.match(editorState.messages.join('\n'), /Config Path/u);
  editorState.selected = config;
  for (const change of editorState.changes) change({ affectsConfiguration: () => true });
  await command('restart');
  assert.equal(api.status().running, true);
  await command('showOutput');
  assert.equal(editorState.shown, 1);
});
void test('client refuses startup in an untrusted workspace even with valid launcher input', async () => {
  editorState.selected = config;
  editorState.trusted = false;
  assert.equal((await extension.activate(context)).status().running, false);
  assert.equal(clients.length, 0);
});
void test('User Setting takes precedence over launcher environment and launches the packaged executable over stdio', async () => {
  editorState.selected = config;
  process.env.BVE_LSP_CONFIG = path.join(directory, 'missing');
  const api = await extension.activate(context);
  assert(api.status().running);
  const server = clients[0]!.server as {
    command: string;
    args: string[];
    options: { shell: boolean; cwd: string; env: Record<string, unknown> };
  };
  assert.equal(
    server.command,
    path.join(directory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  assert.deepEqual(server.args, [
    path.join(directory, 'server/dist/lsp/stdio.js'),
    '--config',
    config,
  ]);
  assert.equal(server.options.shell, false);
  assert.equal(server.options.cwd, directory);
  assert.equal(server.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(options().initializationFailedHandler!(new Error()), false);
});
void test('launcher environment is accepted when no User Setting exists', async () => {
  process.env.BVE_LSP_CONFIG = config;
  assert((await extension.activate(context)).status().running);
});
for (const [name, value] of [
  ['malformed JSON', '{'],
  ['null', null],
  ['array', []],
  ['missing source', {}],
  ['invalid source', { source: [] }],
  ['invalid URI', data([3])],
  ['non-file URI', data(['untitled:thing'])],
  [
    'too many files',
    data(Array.from({ length: 1001 }, () => pathToFileURL(path.join(tmpdir(), 'same')).href)),
  ],
  ['invalid source entry', { source: { files: [{}] } }],
  [
    'ambiguous spellings',
    data([
      pathToFileURL(path.join(tmpdir(), 'alpha.yaml')).href,
      pathToFileURL(path.join(tmpdir(), 'alpha.yaml')).href.replace('alpha.yaml', '%61lpha.yaml'),
    ]),
  ],
] as const)
  void test(`client rejects ${name} without launching and recovers after correcting configuration`, async () => {
    editorState.selected = config;
    await select(value);
    const api = await extension.activate(context);
    assert.equal(api.status().running, false);
    assert.equal(clients.length, 0);
    await select(data());
    await command('restart');
    assert(api.status().running);
  });
void test('relative and missing paths fail closed and the operation queue recovers', async () => {
  editorState.selected = 'relative.json';
  const api = await extension.activate(context);
  assert.equal(api.status().running, false);
  editorState.selected = config + '.missing';
  await assert.rejects(command('restart'));
  editorState.selected = config;
  await command('restart');
  assert(api.status().running);
});
void test('configuration byte limit includes the boundary and rejects overflow', async () => {
  const prefix = JSON.stringify(data());
  editorState.selected = config;
  await select(prefix + ' '.repeat(32 * 1024 * 1024 - Buffer.byteLength(prefix)));
  const api = await extension.activate(context);
  assert(api.status().running);
  await select(prefix + ' '.repeat(32 * 1024 * 1024));
  await assert.rejects(command('restart'), /size limit/u);
  assert.equal(api.status().running, false);
});
void test('selectors accept exactly 1000 approved files and filesystem selection takes precedence', async () => {
  const uris = Array.from(
    { length: 1000 },
    (_, i) => pathToFileURL(path.join(directory, `${i}.yaml`)).href,
  );
  await select({ source: { files: [{}] }, filesystem: { files: uris } });
  editorState.selected = config;
  await extension.activate(context);
  assert.equal((options().documentSelector as unknown[]).length, 1000);
});
void test('empty and missing inventories select only supported local document languages', async () => {
  for (const value of [{ source: {} }, { source: { files: [] } }, { source: {}, filesystem: {} }]) {
    await select(value);
    editorState.selected = config;
    await extension.activate(context);
    assert.deepEqual(
      options().documentSelector,
      ['yaml', 'json', 'plaintext'].map((language) => ({ scheme: 'file', language })),
    );
  }
});
void test('selector globs escape metacharacters and URI converters retain configured identity', async () => {
  const filename = path.join(directory, 'file[1]*?.yaml');
  const uri = pathToFileURL(filename).href;
  await select(data([uri, uri]));
  editorState.selected = config;
  await extension.activate(context);
  const selected = options().documentSelector as { pattern: { pattern: string } }[];
  assert.equal(selected[0]!.pattern.pattern, 'file[[]1[]][*][?].yaml');
  const convert = options().uriConverters!;
  assert.equal(convert.code2Protocol(EditorUri.file(filename) as unknown as Uri), uri);
  const other = path.join(directory, 'other.yaml');
  assert.equal(
    convert.code2Protocol(EditorUri.file(other) as unknown as Uri),
    pathToFileURL(other).href,
  );
  assert.equal(
    convert.code2Protocol(EditorUri.parse('untitled:example') as unknown as Uri),
    'untitled:example',
  );
  assert.equal(convert.protocol2Code(uri).toString(), uri);
});
void test('initialization failure cleans its client, reports safely and allows a later successful restart', async () => {
  editorState.selected = config;
  onStart(() => Promise.reject(new Error('secret details')));
  const api = await extension.activate(context);
  assert.equal(api.status().running, false);
  assert(!editorState.messages.join('\n').includes('secret details'));
  onStart();
  await command('restart');
  assert(api.status().running);
});
void test('failed stop retains ownership and can be retried without spawning a second server', async () => {
  editorState.selected = config;
  const api = await extension.activate(context);
  onStop(() => Promise.reject(new Error('stop failed')));
  await assert.rejects(command('restart'), /stop failed/u);
  assert.equal(clients.length, 1);
  assert(api.status().running);
  onStop();
  await command('stop');
  assert.equal(api.status().running, false);
});
void test('failed initialization cleanup retains its child until an explicit stop succeeds', async () => {
  editorState.selected = config;
  onStart(() => Promise.reject(new Error('init failed')));
  onStop(() => Promise.reject(new Error('cleanup failed')));
  const api = await extension.activate(context);
  assert.equal(api.status().running, false);
  assert.equal(api.status().pid, clients[0]!.serverProcess!.pid);
  onStop();
  await command('stop');
  assert.equal(api.status().pid, undefined);
});
void test('SDK-reaped failed initialization does not poison the next restart', async () => {
  editorState.selected = config;
  onStart(() => Promise.reject(new Error('init failed')));
  onStop(() => {
    clients.at(-1)!.serverProcess = undefined;
    return Promise.reject(new Error('already reaped'));
  });
  const api = await extension.activate(context);
  assert.equal(api.status().pid, undefined);
  onStart();
  onStop();
  await command('restart');
  assert.equal(api.status().running, true);
});
void test('shutdown during gated startup waits for startup then stops its only child', async () => {
  editorState.selected = config;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const starting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  onStart(() => {
    entered();
    return gate;
  });
  const activation = extension.activate(context);
  await starting;
  const shutdown = extension.deactivate();
  release();
  const api = await activation;
  await shutdown;
  assert.equal(api.status().running, false);
  assert.equal(clients.length, 1);
});
void test('concurrent command queue honors the last requested state and ignores unrelated settings', async () => {
  editorState.selected = config;
  const api = await extension.activate(context);
  for (const change of editorState.changes) change({ affectsConfiguration: () => false });
  await Promise.all([command('stop'), command('restart'), command('stop'), command('restart')]);
  assert(api.status().running);
  assert.equal(clients.filter((row) => row.running).length, 1);
  editorState.selected = 'bad';
  for (const change of editorState.changes) change({ affectsConfiguration: () => true });
  await command('stop');
  assert.match(editorState.messages.join('\n'), /Unable to restart/u);
});
void test('server disconnect and transport errors never trigger an automatic restart loop', async () => {
  editorState.selected = config;
  const api = await extension.activate(context);
  const handler: NonNullable<LanguageClientOptions['errorHandler']> = options().errorHandler!;
  assert.equal((await handler.error(new Error(), undefined, 10)).action, 2);
  assert.equal(api.status().disconnected, true);
  assert.equal(api.status().running, false);
  assert.equal((await handler.closed()).action, 1);
  assert.match(editorState.messages.join('\n'), /Restart Language Server/u);
  assert.equal(clients.length, 1);
});
