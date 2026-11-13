import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type {
  CancellationToken,
  CompletionContext,
  CompletionItem,
  CompletionList,
  ExtensionContext,
  Position,
  TextDocument,
  Uri,
} from 'vscode';
import type { LanguageClientOptions } from 'vscode-languageclient/node';
import { Editor, EditorDocument, MemoryState, editorState } from './harness/editor-api.js';
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
let history: MemoryState;
const original = process.env.BVE_LSP_CONFIG;
const command = (name: string, ...args: unknown[]) =>
  Promise.resolve(editorState.commands.get('backstageValidation.' + name)!(...args));
async function select(value: unknown) {
  await writeFile(config, typeof value === 'string' ? value : JSON.stringify(value));
}
const options = () => clients.at(-1)!.options;
const data = (files: unknown[] = []) => ({ source: { files: files.map((uri) => ({ uri })) } });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bve-client-'));
  config = path.join(directory, 'config.json');
  subscriptions = [];
  history = new MemoryState();
  context = {
    subscriptions,
    asAbsolutePath: (value: string) => path.join(directory, value),
    workspaceState: history,
  } as unknown as ExtensionContext;
  editorState.selected = undefined;
  editorState.trusted = true;
  editorState.messages.length = 0;
  editorState.shown = 0;
  editorState.activeEditor = undefined;
  editorState.documents.length = 0;
  editorState.pickers.length = 0;
  editorState.cancellations.length = 0;
  editorState.clipboard.length = 0;
  editorState.clipboardError = undefined;
  editorState.information.length = 0;
  onStart();
  onStop();
  clients.length = 0;
  delete process.env.BVE_LSP_CONFIG;
  await select(data());
});
afterEach(async () => {
  for (const picker of editorState.pickers) picker.hide();
  onStop();
  onStart();
  await extension.deactivate();
  for (const subscription of subscriptions) subscription.dispose();
  await rm(directory, { recursive: true, force: true });
  if (original === undefined) delete process.env.BVE_LSP_CONFIG;
  else process.env.BVE_LSP_CONFIG = original;
});

async function startClient() {
  editorState.selected = config;
  await extension.activate(context);
  return clients.at(-1)!;
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Client operation did not settle.');
}
async function openSearch() {
  const current = await startClient();
  void command('searchReferences');
  return { current, picker: editorState.pickers.at(-1)! };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

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

void test('restart and stop dispose the previous configuration notification handler', async () => {
  editorState.selected = config;
  await extension.activate(context);
  const first = clients[0]!;
  assert(first.notificationHandlers.has('bve/configurationReloaded'));
  await command('restart');
  assert.equal(first.notificationHandlers.size, 0);
  const second = clients.at(-1)!;
  assert(second.notificationHandlers.has('bve/configurationReloaded'));
  await command('stop');
  assert.equal(second.notificationHandlers.size, 0);
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

void test('reload requires a running trusted client and reports accepted and unavailable configuration', async () => {
  await extension.activate(context);
  await command('reloadConfiguration');
  assert.equal(clients.length, 0);
  editorState.selected = config;
  await command('restart');
  const current = clients.at(-1)!;
  editorState.trusted = false;
  await command('reloadConfiguration');
  assert.deepEqual(current.requests, []);
  editorState.trusted = true;
  await command('reloadConfiguration');
  assert.deepEqual(current.requests, ['bve/reloadConfiguration']);
  assert.match(editorState.messages.at(-1)!, /credentials reloaded/u);
  current.requestHandler = () => Promise.resolve({ reloaded: false });
  await command('reloadConfiguration');
  assert.match(editorState.messages.at(-1)!, /Validation is unavailable/u);
  current.requestHandler = () => Promise.reject(new Error('reload failed'));
  await assert.rejects(command('reloadConfiguration'), /reload failed/u);
  current.requestHandler = undefined;
  await command('reloadConfiguration');
  assert.match(editorState.messages.at(-1)!, /credentials reloaded/u);
});

void test('selection history rejects invalid input, deduplicates, bounds storage and restores on restart', async () => {
  await extension.activate(context);
  await command('recordSelection', 'group:default/stopped');
  assert.deepEqual(history.keys(), []);
  editorState.selected = config;
  await command('restart');
  const current = clients.at(-1)!;
  await command('recordSelection', 42);
  await command('recordSelection', 'x'.repeat(513));
  assert.deepEqual(current.notifications, []);
  await command('recordSelection', 'group:default/team');
  const key = history.keys()[0]!;
  assert.match(key, /^backstageValidation\.history:[a-f0-9]{64}$/u);
  const prior = Array.from({ length: 130 }, (_, index) => `group:default/team-${index}`);
  history.values.set(key, prior);
  await command('recordSelection', 'group:default/team-0');
  assert.deepEqual(history.get<string[]>(key), [...prior.slice(3), prior[0]]);
  await command('restart');
  assert.deepEqual(
    clients.at(-1)!.notifications,
    history.get<string[]>(key)!.map((value) => ({ method: 'bve/recordSelection', value })),
  );
  await select({ source: { files: [] }, catalog: { principalId: 'another-principal' } });
  await command('restart');
  assert.deepEqual(clients.at(-1)!.notifications, []);
  await command('recordSelection', 'group:default/other');
  assert.equal(history.keys().length, 2);
});

void test('completion history commands preserve server commands and both completion result forms', async () => {
  await startClient();
  const provide = options().middleware!.provideCompletionItem!;
  const complete = (result: CompletionItem[] | CompletionList | null | undefined) =>
    provide(
      {} as TextDocument,
      {} as Position,
      {} as CompletionContext,
      {} as CancellationToken,
      () => Promise.resolve(result),
    );
  assert.equal(await complete(undefined), undefined);
  assert.equal(await complete(null), null);
  const existing = { title: 'Server repair', command: 'server.repair' };
  const items: CompletionItem[] = [
    { label: 'group:default/team' },
    { label: { label: 'component:default/service', description: 'local' } },
    { label: 'repair', command: existing },
  ];
  assert.equal(await complete(items), items);
  assert.deepEqual(items[0]!.command, {
    title: 'Record Backstage selection',
    command: 'backstageValidation.recordSelection',
    arguments: ['group:default/team'],
  });
  assert.deepEqual(items[1]!.command!.arguments, ['component:default/service']);
  assert.equal(items[2]!.command, existing);
  const list = { items: [{ label: 'kind' }], isIncomplete: true };
  assert.equal(await complete(list), list);
  assert.deepEqual(list.items[0], {
    label: 'kind',
    command: {
      title: 'Record Backstage selection',
      command: 'backstageValidation.recordSelection',
      arguments: ['kind'],
    },
  });
});

void test('discovery selectors include trusted roots and reject non-file or malformed roots', async () => {
  const root = pathToFileURL(directory + path.sep).href;
  const extra = pathToFileURL(path.join(directory, 'services') + path.sep).href;
  await select({ source: { rootUri: root }, filesystem: { discovery: { roots: [extra] } } });
  await startClient();
  const filters = options().documentSelector as unknown[];
  assert.deepEqual(filters.slice(-2), [
    { scheme: 'file', pattern: { baseUri: extra, pattern: '**/*' } },
    { scheme: 'file', pattern: { baseUri: root, pattern: '**/*' } },
  ]);
  for (const value of [
    { source: {}, filesystem: { discovery: { roots: [1] } } },
    { source: {}, filesystem: { discovery: { roots: ['https://example.invalid/'] } } },
    { source: { rootUri: 'https://example.invalid/' }, filesystem: {} },
  ]) {
    await select(value);
    await assert.rejects(command('restart'), /Invalid (?:discovery|source) root/u);
  }
});

void test('configuration reload replays only approved open documents and authority-scoped history', async () => {
  const explicit = pathToFileURL(path.join(directory, 'explicit.yaml')).href;
  const root = pathToFileURL(path.join(directory, 'services')).href;
  const inside = root + '/catalog-info.yaml';
  const outside = pathToFileURL(path.join(directory, 'outside.yaml')).href;
  const sibling = pathToFileURL(path.join(directory, 'services-other', 'catalog-info.yaml')).href;
  await select({
    ...data([explicit]),
    filesystem: { files: [explicit], discovery: { roots: [root] } },
  });
  const current = await startClient();
  await command('recordSelection', 'group:default/team');
  current.notifications.length = 0;
  editorState.documents.push(
    new EditorDocument(EditorUri.parse(explicit), 'kind: API'),
    new EditorDocument(EditorUri.parse(inside)),
    new EditorDocument(EditorUri.parse(outside)),
    new EditorDocument(EditorUri.parse(sibling)),
    new EditorDocument(EditorUri.parse('untitled:buffer')),
  );
  current.notificationHandlers.get('bve/configurationReloaded')!();
  await until(() => current.notifications.length === 3);
  assert.deepEqual(current.notifications, [
    {
      method: 'textDocument/didOpen',
      value: { textDocument: { uri: explicit, languageId: 'yaml', version: 1, text: 'kind: API' } },
    },
    {
      method: 'textDocument/didOpen',
      value: {
        textDocument: { uri: inside, languageId: 'yaml', version: 1, text: 'kind: Component' },
      },
    },
    { method: 'bve/recordSelection', value: 'group:default/team' },
  ]);
  const staleHandler = current.notificationHandlers.get('bve/configurationReloaded')!;
  await command('restart');
  staleHandler();
  assert.equal(current.notifications.length, 3);
  const replacement = clients.at(-1)!;
  await select('{');
  replacement.notificationHandlers.get('bve/configurationReloaded')!();
  await until(
    () => editorState.messages.at(-1) === 'Unable to refresh the editor selection history.',
  );
});

void test('search stays closed without a running trusted client', async () => {
  await extension.activate(context);
  void command('searchReferences');
  assert.deepEqual(editorState.pickers, []);
  editorState.selected = config;
  await command('restart');
  editorState.trusted = false;
  void command('searchReferences');
  assert.deepEqual(editorState.pickers, []);
});

void test('search debounces valid queries, normalizes their identity and clears invalid or failed results', async () => {
  const { current, picker } = await openSearch();
  assert(picker.shown);
  assert.match(picker.title, /Search Entity References/u);
  assert(picker.matchOnDescription);
  const rows = [
    { reference: 'group:default/team', source: 'workspace' },
    { reference: 'group:default/tech', source: 'catalog' },
  ];
  current.requestHandler = () => Promise.resolve(rows);
  picker.change('GROUP:DEFAULT/T');
  await settle();
  assert.equal(current.requestCalls.length, 0);
  picker.change('GROUP:DEFAULT/TE');
  await until(() => current.requestCalls.length === 1);
  await settle();
  assert.equal(current.requestCalls.length, 1);
  assert.equal(current.requestCalls[0]!.method, 'bve/searchReferences');
  assert.deepEqual(current.requestCalls[0]!.params, {
    kind: 'group',
    namespace: 'default',
    prefix: 'te',
  });
  assert.equal(picker.busy, false);
  assert.deepEqual(
    picker.items,
    rows.map((row) => ({
      label: row.reference,
      description: row.source,
      reference: row.reference,
    })),
  );
  picker.change('not a reference');
  assert.deepEqual(picker.items, []);
  assert.equal(picker.busy, false);
  assert(editorState.cancellations[0]!.token.isCancellationRequested);
  current.requestHandler = () => Promise.reject(new Error('private remote details'));
  picker.change('group:default/fail');
  await until(() => current.requestCalls.length === 2);
  await settle();
  assert.deepEqual(picker.items, []);
  assert.equal(picker.busy, false);
  assert(!editorState.messages.join('\n').includes('private remote details'));
});

void test('new search queries cancel old requests and late success or failure cannot replace current results', async () => {
  const { current, picker } = await openSearch();
  const requests = Array.from({ length: 4 }, () =>
    deferred<{ reference: string; source: string }[]>(),
  );
  let index = 0;
  current.requestHandler = () => requests[index++]!.promise;
  picker.change('group:default/old');
  await until(() => current.requestCalls.length === 1);
  picker.change('group:default/new');
  await until(() => current.requestCalls.length === 2);
  assert(current.requestCalls[0]!.token!.isCancellationRequested);
  assert(editorState.cancellations[0]!.disposed);
  requests[1]!.resolve([{ reference: 'group:default/new', source: 'workspace' }]);
  await settle();
  requests[0]!.resolve([{ reference: 'group:default/old', source: 'catalog' }]);
  await settle();
  assert.equal(picker.items[0]!.reference, 'group:default/new');
  picker.change('group:default/reject');
  await until(() => current.requestCalls.length === 3);
  picker.change('group:default/current');
  await until(() => current.requestCalls.length === 4);
  requests[2]!.reject(new Error('old request failed'));
  await settle();
  assert(picker.busy);
  requests[3]!.resolve([{ reference: 'group:default/current', source: 'workspace' }]);
  await settle();
  assert.equal(picker.items[0]!.reference, 'group:default/current');
  assert.equal(picker.busy, false);
});

void test('closing search disposes listeners and cancels both scheduled and in-flight work', async () => {
  const { current, picker } = await openSearch();
  picker.change('group:default/pending');
  picker.hide();
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(current.requests, []);
  assert(picker.disposed);
  assert.equal(picker.changes.size + picker.accepts.size + picker.hides.size, 0);
  void command('searchReferences');
  const second = editorState.pickers.at(-1)!;
  const response = deferred<{ reference: string; source: string }[]>();
  current.requestHandler = () => response.promise;
  second.change('group:default/inflight');
  await until(() => current.requestCalls.length === 1);
  second.hide();
  assert(editorState.cancellations[0]!.token.isCancellationRequested);
  assert(editorState.cancellations[0]!.disposed);
  response.resolve([{ reference: 'group:default/late', source: 'catalog' }]);
  await settle();
  assert.deepEqual(second.items, []);
});

void test('search without an editor copies a chosen reference and records it only after a successful copy', async () => {
  const { current, picker } = await openSearch();
  picker.accept();
  picker.accept({ label: 'header' });
  assert.equal(picker.disposed, false);
  picker.accept({ label: 'team', reference: 'group:default/team' });
  await settle();
  assert.deepEqual(editorState.clipboard, ['group:default/team']);
  assert.deepEqual(current.notifications, [
    { method: 'bve/recordSelection', value: 'group:default/team' },
  ]);
  assert(picker.disposed);
  void command('searchReferences');
  editorState.clipboardError = new Error('private clipboard failure');
  editorState.pickers.at(-1)!.accept({ label: 'other', reference: 'group:default/other' });
  await settle();
  assert.equal(current.notifications.length, 1);
  assert.equal(editorState.messages.at(-1), 'Unable to insert the selected reference.');
});

void test('search inserts into the captured editor selection and records only successful edits', async () => {
  const editor = new Editor(
    new EditorDocument(EditorUri.file(path.join(directory, 'catalog.yaml'))),
  );
  editorState.activeEditor = editor;
  const { current, picker } = await openSearch();
  picker.accept({ label: 'team', reference: 'group:default/team' });
  await settle();
  assert.deepEqual(editor.replacements, [
    { selection: editor.selection, value: 'group:default/team' },
  ]);
  assert.deepEqual(current.notifications, [
    { method: 'bve/recordSelection', value: 'group:default/team' },
  ]);
  void command('searchReferences');
  editor.editResult = false;
  editorState.pickers.at(-1)!.accept({ label: 'rejected', reference: 'group:default/rejected' });
  await settle();
  assert.equal(current.notifications.length, 1);
  void command('searchReferences');
  editor.editError = new Error('private editor failure');
  editorState.pickers.at(-1)!.accept({ label: 'failed', reference: 'group:default/failed' });
  await settle();
  assert.equal(current.notifications.length, 1);
  assert.equal(editorState.messages.at(-1), 'Unable to insert the selected reference.');
});

for (const change of ['version', 'closed', 'editor', 'client'] as const)
  void test(`search refuses insertion after the captured ${change} changes`, async () => {
    const editor = new Editor(
      new EditorDocument(EditorUri.file(path.join(directory, 'catalog.yaml'))),
    );
    editorState.activeEditor = editor;
    const { current, picker } = await openSearch();
    if (change === 'version') editor.document.version++;
    if (change === 'closed') editor.document.isClosed = true;
    if (change === 'editor') editorState.activeEditor = undefined;
    if (change === 'client') await command('restart');
    picker.accept({ label: 'team', reference: 'group:default/team' });
    await settle();
    assert.deepEqual(editor.replacements, []);
    assert.deepEqual(editorState.clipboard, []);
    assert.deepEqual(current.notifications, []);
    assert.match(editorState.information.at(-1)!, /document changed during search/u);
  });
void test('coverage bridge requires a trusted running client and forwards only the read-only document binding', async () => {
  const api = await extension.activate(context);
  const binding = {
    uri: 'file:///workspace/catalog.yaml',
    version: 7,
    digest: 'sha256:' + 'a'.repeat(64),
  };
  assert.equal(await api.coverage(binding.uri, binding.version, binding.digest), null);
  assert.equal(clients.length, 0);
  editorState.selected = config;
  await command('restart');
  const current = clients.at(-1)!;
  const observation = {
    generation: 9,
    coverage: [{ stage: 'parse', subject: binding.uri, required: true, status: 'verified' }],
  };
  current.requestHandler = (request) => {
    assert.deepEqual(request, {
      method: 'bve/validationCoverage',
      params: binding,
      token: undefined,
    });
    return Promise.resolve(observation);
  };
  assert.equal(await api.coverage(binding.uri, binding.version, binding.digest), observation);
  assert.equal(current.requestCalls.length, 1);
  editorState.trusted = false;
  assert.equal(await api.coverage(binding.uri, binding.version, binding.digest), null);
  assert.equal(current.requestCalls.length, 1);
  editorState.trusted = true;
  const handler: NonNullable<LanguageClientOptions['errorHandler']> = current.options.errorHandler!;
  await handler.error(new Error('disconnected'), undefined, 10);
  assert.equal(await api.coverage(binding.uri, binding.version, binding.digest), null);
  assert.equal(current.requestCalls.length, 1);
  await command('stop');
  assert.equal(await api.coverage(binding.uri, binding.version, binding.digest), null);
  assert.equal(current.requestCalls.length, 1);
});

void test('search command completes after cancellation and after the accepted clipboard/history work', async () => {
  const current = await startClient();
  let completed = false;
  const cancelled = command('searchReferences').then(() => {
    completed = true;
  });
  await settle();
  assert.equal(completed, false);
  editorState.pickers.at(-1)!.hide();
  await cancelled;
  assert.equal(completed, true);
  completed = false;
  const accepted = command('searchReferences').then(() => {
    completed = true;
  });
  const saved = deferred<void>();
  const update = history.update.bind(history);
  history.update = async (key, value) => {
    await saved.promise;
    await update(key, value);
  };
  const picker = editorState.pickers.at(-1)!;
  picker.accept({ label: 'team', reference: 'group:default/team' });
  picker.accept({ label: 'other', reference: 'group:default/other' });
  await settle();
  assert.equal(completed, false);
  assert.deepEqual(editorState.clipboard, ['group:default/team']);
  saved.resolve();
  await accepted;
  assert.equal(completed, true);
  assert.deepEqual(current.notifications, [
    { method: 'bve/recordSelection', value: 'group:default/team' },
  ]);
});

void test('filesystem receipt bridge requires trust and a live client and sends no caller control', async () => {
  const api = await extension.activate(context);
  assert.equal(await api.filesystemObservation(), null);
  editorState.selected = config;
  await command('restart');
  const current = clients.at(-1)!;
  const receipt = {
    sessionGeneration: 1,
    generation: 3,
    uris: ['file:///approved/catalog.yaml'],
    truncated: false,
  };
  current.requestHandler = () => Promise.resolve(receipt);
  assert.deepEqual(await api.filesystemObservation(), receipt);
  assert.equal(current.requestCalls.at(-1)!.method, 'bve/filesystemObservation');
  assert.equal(current.requestCalls.at(-1)!.params, undefined);
  editorState.trusted = false;
  assert.equal(await api.filesystemObservation(), null);
  editorState.trusted = true;
  await options().errorHandler!.closed();
  assert.equal(await api.filesystemObservation(), null);
});

void test('reload rejects an invalid server response like a failed request and logs nothing', async () => {
  const current = await startClient();
  const messages = editorState.messages.length;
  for (const response of [null, [], { reloaded: 'yes' }, {}]) {
    current.requestHandler = () => Promise.resolve(response);
    await assert.rejects(
      command('reloadConfiguration'),
      /invalid bve\/reloadConfiguration response/u,
    );
  }
  assert.equal(editorState.messages.length, messages);
  current.requestHandler = undefined;
  await command('reloadConfiguration');
  assert.match(editorState.messages.at(-1)!, /credentials reloaded/u);
});

void test('search clears its results for an invalid server response like a failed request', async () => {
  const { current, picker } = await openSearch();
  const valid = [{ reference: 'group:default/team', source: 'workspace' }];
  let calls = 0;
  for (const response of [
    null,
    { reference: 'group:default/team', source: 'workspace' },
    [{ reference: 'group:default/team' }],
    [null],
    [{ reference: 7, source: 'workspace' }],
  ]) {
    current.requestHandler = () => Promise.resolve(valid);
    picker.change('group:default/te');
    calls++;
    await until(() => current.requestCalls.length === calls);
    await settle();
    assert.equal(picker.items.length, 1);
    current.requestHandler = () => Promise.resolve(response);
    picker.change('group:default/tea');
    calls++;
    await until(() => current.requestCalls.length === calls);
    await settle();
    assert.deepEqual(picker.items, [], JSON.stringify(response));
    assert.equal(picker.busy, false);
  }
  assert(!editorState.messages.join('\n').includes('invalid'));
});

void test('observation bridges reject invalid server responses and pass valid ones through unchanged', async () => {
  editorState.selected = config;
  const api = await extension.activate(context);
  const current = clients.at(-1)!;
  let response: unknown;
  current.requestHandler = () => Promise.resolve(response);
  for (response of [
    undefined,
    [],
    'receipt',
    { sessionGeneration: 1, generation: 3, uris: 'file:///a.yaml', truncated: false },
    { sessionGeneration: 1, generation: 3, uris: [7], truncated: false },
    { sessionGeneration: '1', generation: 3, uris: [], truncated: false },
    { sessionGeneration: 1, generation: 3, uris: [] },
  ])
    await assert.rejects(
      api.filesystemObservation(),
      /invalid bve\/filesystemObservation response/u,
    );
  response = null;
  assert.equal(await api.filesystemObservation(), null);
  for (response of [undefined, [], 'coverage', 7])
    await assert.rejects(
      api.coverage('file:///workspace/catalog.yaml', 1, 'sha256:' + 'a'.repeat(64)),
      /invalid bve\/validationCoverage response/u,
    );
  response = null;
  assert.equal(
    await api.coverage('file:///workspace/catalog.yaml', 1, 'sha256:' + 'a'.repeat(64)),
    null,
  );
  response = { generation: 1 };
  assert.equal(
    await api.coverage('file:///workspace/catalog.yaml', 1, 'sha256:' + 'a'.repeat(64)),
    response,
  );
});
