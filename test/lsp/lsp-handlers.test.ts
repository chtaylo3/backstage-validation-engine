import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ResponseError } from 'vscode-languageserver/node';
import type { FileEvent } from 'vscode-languageserver/node';
import { createSourceSnapshot } from '../../src/index.js';
import { isCanonicalSourceUri } from '../../src/base/source-uris.js';
import { parseLspConfig } from '../../src/lsp/config.js';
import type { LspConfig } from '../../src/lsp/config.js';
import type { CoverageObservation } from '../../src/lsp/coverage-observation.js';
import { DISCOVERY_EXCLUDES } from '../../src/lsp/filesystem-scope.js';
import {
  admitWatchedFiles,
  registerDocumentHandlers,
  watchedFileAdmission,
} from '../../src/lsp/handlers/documents.js';
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
  fakeFilesystem,
  token,
} from '../harness/lsp-fake-connection.js';
import { componentText, policyRun } from '../harness/policy-fixture.js';

const changes = (...uris: string[]): FileEvent[] => uris.map((uri) => ({ uri, type: 2 }));

void test('watched files: more than 1000 changes observe nothing and refresh only for an admitted change', () => {
  const config = fakeConfig({ filesystem: true });
  assert.deepEqual(admitWatchedFiles(config, changes(...Array<string>(1000).fill(FAKE_URI))), {
    refresh: true,
    uris: Array(32).fill(FAKE_URI),
    truncated: true,
  });
  // An oversized notification is scanned for an admitted change; these rows are not admitted.
  assert.deepEqual(admitWatchedFiles(config, changes(...Array<string>(1001).fill('not a uri'))), {
    refresh: false,
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

/** A server context with the lifecycle and document handlers on a recording connection. */
function documentHost(state: 'before initialize' | 'running' | 'after shutdown' = 'running') {
  const fake = fakeConnection();
  const context = createServerContext(fake.connection, fakeConfig(), {});
  registerLifecycleHandlers(context);
  registerDocumentHandlers(context);
  const notify = (method: string, params?: unknown) => fake.handler(method)(params);
  const open = (version = 1, text = 'kind: A\n') =>
    notify('textDocument/didOpen', {
      textDocument: { uri: FAKE_URI, languageId: 'yaml', version, text },
    });
  const setUp = async () => {
    if (state === 'before initialize') return;
    fake.handler('initialize')({ processId: null, rootUri: FAKE_ROOT, capabilities: {} }, token);
    open();
    if (state === 'after shutdown') await fake.handler('shutdown')();
  };
  /** The observable state that a dropped notification must not change. */
  const snapshot = () => ({
    documents: [...context.workspace.documents.values()].map((row) => [
      row.uri,
      row.version,
      row.lifetime,
      row.getText(),
    ]),
    unavailable: context.workspace.isUnavailable(FAKE_URI),
    workspace: context.workspace.generation,
    disk: context.workspace.diskGeneration,
    coordinator: context.coordinator.generation,
    status: context.coordinator.status,
    outbound: fake.outbound.length,
  });
  return { fake, context, notify, open, setUp, snapshot };
}
const DOCUMENT_NOTIFICATIONS = [
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
] as const;
const MALFORMED: readonly [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['{}', {}],
  ['{ textDocument: null }', { textDocument: null }],
  ['{ textDocument: 7 }', { textDocument: 7 }],
];

void test('document notifications without usable parameters are ignored without throwing', async () => {
  for (const method of DOCUMENT_NOTIFICATIONS)
    for (const [label, params] of MALFORMED) {
      const host = documentHost();
      await host.setUp();
      // An async handler reports a parameter failure as a rejection, not a throw.
      await assert.doesNotReject(async () => {
        await host.notify(method, params);
      }, `${method} ${label}`);
      await host.context.lifecycle.close();
    }
});

void test('a malformed document notification changes no document, generation or schedule', async () => {
  for (const method of DOCUMENT_NOTIFICATIONS)
    for (const [label, params] of MALFORMED) {
      const host = documentHost();
      await host.setUp();
      const before = host.snapshot();
      try {
        await host.notify(method, params);
      } catch {
        // The throwing case is the previous test; this one checks only the state.
      }
      assert.deepEqual(host.snapshot(), before, `${method} ${label}`);
      await host.context.lifecycle.close();
    }
});

void test('document notifications without usable parameters are ignored before initialize and after shutdown', async () => {
  for (const state of ['before initialize', 'after shutdown'] as const)
    for (const method of DOCUMENT_NOTIFICATIONS)
      for (const [label, params] of MALFORMED) {
        const host = documentHost(state);
        await host.setUp();
        const before = host.snapshot();
        await assert.doesNotReject(async () => {
          await host.notify(method, params);
        }, `${state} ${method} ${label}`);
        assert.deepEqual(host.snapshot(), before, `${state} ${method} ${label}`);
        await host.context.lifecycle.close();
      }
});

void test('didChange with a valid identifier and an unusable change list keeps its current effect', async () => {
  // Recorded from the code before the fix: the version advances, the text becomes empty, the
  // document is marked unavailable, and one validation is scheduled.
  for (const [label, contentChanges] of [
    ['missing', undefined],
    ['null', null],
    ['a string', 'x'],
    ['an object', { text: 'y' }],
    ['a number', 7],
  ] as const) {
    const host = documentHost();
    await host.setUp();
    const before = host.snapshot();
    const params: Record<string, unknown> = { textDocument: { uri: FAKE_URI, version: 2 } };
    if (label !== 'missing') params.contentChanges = contentChanges;
    assert.doesNotThrow(() => host.notify('textDocument/didChange', params), label);
    const after = host.snapshot();
    assert.deepEqual(after.documents, [[FAKE_URI, 2, before.documents[0]![2], '']], label);
    assert.equal(after.unavailable, true, label);
    assert.equal(after.workspace, before.workspace + 2, label);
    assert.equal(after.coordinator, before.coordinator + 1, label);
    assert.equal(after.status.pending, true, label);
    assert.equal(after.status.timer, true, label);
    await host.context.lifecycle.close();
  }
});

void test('well-formed open, change and close behave as before', async () => {
  const host = documentHost('before initialize');
  host.fake.handler('initialize')({ processId: null, rootUri: FAKE_ROOT, capabilities: {} }, token);
  const start = host.snapshot();
  host.open(1, 'kind: A\n');
  const opened = host.snapshot();
  assert.deepEqual(opened.documents, [[FAKE_URI, 1, opened.documents[0]![2], 'kind: A\n']]);
  assert.equal(opened.unavailable, false);
  assert.equal(opened.coordinator, start.coordinator + 1);
  assert.equal(opened.status.timer, true);
  host.notify('textDocument/didChange', {
    textDocument: { uri: FAKE_URI, version: 2 },
    contentChanges: [{ text: 'kind: B\n' }],
  });
  const changed = host.snapshot();
  assert.deepEqual(changed.documents, [[FAKE_URI, 2, opened.documents[0]![2], 'kind: B\n']]);
  assert.equal(changed.coordinator, opened.coordinator + 1);
  await host.notify('textDocument/didClose', { textDocument: { uri: FAKE_URI } });
  const closed = host.snapshot();
  assert.deepEqual(closed.documents, []);
  assert.equal(closed.coordinator, changed.coordinator + 1);
  assert.equal(closed.status.timer, true);
  // A closed document's diagnostics are cleared with the version and lifetime it had.
  assert.deepEqual(host.fake.outbound.at(-1), {
    channel: 'notification',
    method: 'textDocument/publishDiagnostics',
    params: { uri: FAKE_URI, version: 2, diagnostics: [] },
  });
  await host.context.lifecycle.close();
});

void test('no handler in src/lsp/handlers destructures a parameter of a connection registration', async () => {
  const directory = path.join(
    fileURLToPath(new URL('../../../', import.meta.url)),
    'src/lsp/handlers',
  );
  const offenders: string[] = [];
  let registrations = 0;
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.ts')).sort()) {
    const text = await readFile(path.join(directory, name), 'utf8');
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^on[A-Z]/u.test(node.expression.name.text) &&
        /\bconnection\b/u.test(node.expression.expression.getText(source))
      ) {
        registrations++;
        for (const argument of node.arguments)
          if (
            (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
            argument.parameters.some((parameter) => !ts.isIdentifier(parameter.name))
          ) {
            const { line } = source.getLineAndCharacterOfPosition(argument.getStart(source));
            offenders.push(`${name}:${line + 1} ${node.expression.getText(source)}`);
          }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(registrations > 10, `only ${registrations} registrations were found`);
  assert.deepEqual(offenders, []);
});

/*
 * The admission predicate of `admitWatchedFiles` before the prepared matcher, copied verbatim
 * together with the three scope functions it called (`filesystemEvent`, `approvedFilesystemUri`,
 * `discoveryMatches`), so that the reference does not move when the source does.
 */
function referenceDiscoveryMatches(config: LspConfig, root: string, uri: string): boolean {
  if (!uri.startsWith(root)) return false;
  const name = decodeURIComponent(uri.slice(root.length));
  const settings = config.filesystem?.discovery;
  return (
    !!settings &&
    settings.include.some((pattern) => path.posix.matchesGlob(name, pattern)) &&
    ![...DISCOVERY_EXCLUDES, ...(settings.exclude ?? [])].some((pattern) =>
      path.posix.matchesGlob(name, pattern),
    )
  );
}
function referenceApprovedFilesystemUri(config: LspConfig, uri: string): boolean {
  return (
    !!config.filesystem &&
    isCanonicalSourceUri(uri) &&
    (config.filesystem.files.includes(uri) ||
      !!config.filesystem.discovery?.roots.some((root) =>
        referenceDiscoveryMatches(config, root, uri),
      ))
  );
}
function referenceFilesystemEvent(config: LspConfig, uri: string): boolean {
  return (
    referenceApprovedFilesystemUri(config, uri) ||
    !!config.filesystem?.discovery?.roots.some(
      (root) => uri.startsWith(root) || root.startsWith(uri.endsWith('/') ? uri : uri + '/'),
    )
  );
}
function referenceAdmitted(config: LspConfig, row: FileEvent): boolean {
  return !(
    !row ||
    typeof row.uri !== 'string' ||
    !isCanonicalSourceUri(row.uri, row.uri.endsWith('/')) ||
    ![1, 2, 3].includes(row.type) ||
    !(
      referenceFilesystemEvent(config, row.uri) ||
      config.filesystem!.files.some((uri) =>
        uri.startsWith(row.uri.endsWith('/') ? row.uri : row.uri + '/'),
      )
    )
  );
}

/** A trusted filesystem configuration over a one-file source, validated by `parseLspConfig`. */
function scopeConfig(
  sourceUri: string,
  filesystem: NonNullable<LspConfig['filesystem']>,
): LspConfig {
  const source = createSourceSnapshot({
    repository: 'repository',
    revision: '1',
    rootUri: FAKE_ROOT,
    files: [{ uri: sourceUri, text: componentText(), version: 1, origin: 'buffer' }],
  });
  const run = policyRun({ rules: [], rootUri: FAKE_ROOT, source });
  return parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    debounceMs: 250,
    coverageObservation: true,
    filesystem,
  });
}
const SCOPES: Readonly<Record<string, () => LspConfig>> = {
  'files only': () =>
    scopeConfig(FAKE_URI, {
      files: [FAKE_URI, `${FAKE_ROOT}a/b/c.yaml`, `${FAKE_ROOT}a%20b/d.yaml`],
    }),
  'discovery only, nested roots': () =>
    scopeConfig(`${FAKE_ROOT}svc/catalog-info.yaml`, {
      files: [],
      discovery: { roots: [`${FAKE_ROOT}svc/`, `${FAKE_ROOT}svc/inner/`], include: ['**/*.yaml'] },
    }),
  'files and discovery': () =>
    scopeConfig(FAKE_URI, {
      files: [FAKE_URI, `${FAKE_ROOT}x/y.yaml`],
      discovery: { roots: [`${FAKE_ROOT}root/`], include: ['*.yaml'], exclude: ['skip/**'] },
    }),
  'a root equal to the workspace root': () =>
    scopeConfig(FAKE_URI, {
      files: [],
      discovery: { roots: [FAKE_ROOT], include: ['**/catalog-info.yaml'] },
    }),
};
/** At least 2,000 changes per configuration, covering every shape the admission rule meets. */
function equivalenceRows(config: LspConfig): FileEvent[] {
  const approved = config.filesystem!.files;
  const roots = config.filesystem!.discovery?.roots ?? [];
  const ancestors = (uri: string) =>
    [...uri.matchAll(/\//gu)].map((match) => uri.slice(0, match.index + 1));
  const bases = new Set<string>([
    ...approved,
    ...roots,
    ...[...approved, ...roots].flatMap(ancestors),
    'file:///',
    'file:///workspace',
    'file:///work/',
    'file:///elsewhere/catalog-info.yaml',
    `${FAKE_ROOT}other.yaml`,
    `${FAKE_ROOT}a%20b/`,
    `${FAKE_ROOT}a b/d.yaml`,
    `${FAKE_ROOT}%7Euser/x.yaml`,
    `${FAKE_ROOT}a%2Fb.yaml`,
    `${FAKE_ROOT}a%zz.yaml`,
    `${FAKE_ROOT}caf%C3%A9.yaml`,
    `${FAKE_ROOT}./catalog-info.yaml`,
    `${FAKE_ROOT}../catalog-info.yaml`,
    `${FAKE_ROOT}/catalog-info.yaml`,
    `${FAKE_ROOT}a\\b.yaml`,
    `${FAKE_ROOT}x.yaml?query`,
    `${FAKE_ROOT}x.yaml#fragment`,
    'file://host/workspace/catalog-info.yaml',
    'http://workspace/catalog-info.yaml',
    'FILE:///workspace/catalog-info.yaml',
    'file:///C:/workspace/x.yaml',
    'not a uri',
    '',
  ]);
  const uris = new Set<string>();
  for (const base of bases) {
    uris.add(base);
    const bare = base.endsWith('/') ? base.slice(0, -1) : base;
    // With and without a trailing slash, a shared string prefix, and children.
    for (const variant of [
      bare,
      `${bare}/`,
      `${bare}-other`,
      `${bare}-other/`,
      `${bare}x/`,
      `${bare}/child.yaml`,
      `${bare}/skip/z.yaml`,
      `${bare}/node_modules/z.yaml`,
      `${bare}/deep/er/catalog-info.yaml`,
      `${bare}/z.json`,
      `${bare}/a%20b.yaml`,
      `${bare}/a b.yaml`,
      `${bare}/.`,
      `${bare}//`,
      `${bare}/CATALOG-INFO.YAML`,
      `${bare}.bak`,
      `${bare}/catalog-info.yaml`,
      `${bare}/x/catalog-info.yaml`,
    ])
      uris.add(variant);
  }
  const rows: FileEvent[] = [];
  for (const uri of uris) for (const type of [0, 1, 2, 3, 4]) rows.push({ uri, type } as FileEvent);
  rows.push(
    ...([
      null,
      undefined,
      7,
      'file:///workspace/catalog-info.yaml',
      { uri: 7, type: 1 },
      { uri: null, type: 2 },
      { type: 1 },
      { uri: FAKE_URI },
      { uri: FAKE_URI, type: '1' },
      { uri: FAKE_URI, type: 1.5 },
    ] as unknown as FileEvent[]),
  );
  return rows;
}

void test('watched files: the admission rule equals the reference predicate for every generated change', () => {
  for (const [name, build] of Object.entries(SCOPES)) {
    const config = build();
    const rows = equivalenceRows(config);
    assert.ok(rows.length >= 2000, `${name}: ${rows.length} rows`);
    const prepared = watchedFileAdmission(config);
    let admitted = 0;
    for (const row of rows) {
      const expected = referenceAdmitted(config, row);
      if (expected) admitted++;
      assert.equal(prepared(row), expected, `${name}: prepared ${JSON.stringify(row)}`);
      assert.equal(
        admitWatchedFiles(config, [row]).refresh,
        expected,
        `${name}: ${JSON.stringify(row)}`,
      );
    }
    // The generated set exercises both outcomes.
    assert.ok(admitted > 10 && admitted < rows.length - 10, `${name}: ${admitted} admitted`);
  }
});

const outside = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => ({
    uri: `file:///elsewhere/file-${from + index}.yaml`,
    type: 2,
  })) as FileEvent[];
const OVERSIZED_REFRESH = { refresh: true, uris: [], truncated: true };

void test('watched files: an oversized notification without an admitted change does not refresh', () => {
  const config = fakeConfig({ filesystem: true });
  for (const count of [1001, 20_000])
    assert.deepEqual(admitWatchedFiles(config, outside(count)), { refresh: false }, `${count}`);
});

void test('watched files: an oversized notification with one admitted change refreshes without observing URIs', () => {
  const config = fakeConfig({ filesystem: true });
  for (const position of [0, 1000, 2000]) {
    const rows = outside(2001);
    rows[position] = { uri: FAKE_URI, type: 2 };
    assert.deepEqual(admitWatchedFiles(config, rows), OVERSIZED_REFRESH, `${position}`);
  }
});

void test('watched files: the oversized scan decides within 50,000 changes and refreshes past them', () => {
  const config = fakeConfig({ filesystem: true });
  assert.deepEqual(admitWatchedFiles(config, outside(50_000)), { refresh: false });
  assert.deepEqual(admitWatchedFiles(config, outside(50_001)), OVERSIZED_REFRESH);
  // An admitted change past the bound is not needed for the refresh.
  const late = outside(50_001);
  late[50_000] = { uri: FAKE_URI, type: 2 };
  assert.deepEqual(admitWatchedFiles(config, late), OVERSIZED_REFRESH);
});

void test('watched files: admission calls no glob matcher, for an oversized or a small notification', (t) => {
  const config = SCOPES['discovery only, nested roots']!();
  let calls = 0;
  const matchesGlob = path.posix.matchesGlob.bind(path.posix);
  t.mock.method(path.posix, 'matchesGlob', (name: string, pattern: string) => {
    calls++;
    return matchesGlob(name, pattern);
  });
  const under = Array.from({ length: 1500 }, (_, index) => ({
    uri: `${FAKE_ROOT}svc/file-${index}.yaml`,
    type: 2,
  })) as FileEvent[];
  assert.deepEqual(admitWatchedFiles(config, under), OVERSIZED_REFRESH);
  assert.equal(calls, 0, 'oversized notification');
  assert.equal(admitWatchedFiles(config, under.slice(0, 3)).refresh, true);
  assert.equal(calls, 0, 'small notification');
  // The stub is in place: the scope functions still reach it.
  assert.equal(referenceDiscoveryMatches(config, `${FAKE_ROOT}svc/`, under[0]!.uri), true);
  assert.ok(calls > 0);
});

void test('watched files: the prepared admission is built once per configuration object', () => {
  const base = fakeConfig({ filesystem: true });
  let reads = 0;
  const counted = (config: LspConfig): LspConfig =>
    Object.defineProperty({ ...config }, 'filesystem', {
      get: () => {
        reads++;
        return config.filesystem;
      },
    });
  const first = counted(base);
  admitWatchedFiles(first, changes(FAKE_URI, 'file:///elsewhere/x.yaml'));
  const built = reads;
  assert.ok(built > 0);
  admitWatchedFiles(first, changes(FAKE_URI, 'file:///elsewhere/y.yaml'));
  admitWatchedFiles(first, outside(1001));
  assert.equal(reads, built, 'later notifications reuse the prepared admission');
  // A configuration reload produces a new configuration object, which is prepared anew.
  const reloaded = counted(base);
  admitWatchedFiles(reloaded, changes(FAKE_URI));
  assert.equal(reads, 2 * built);
});

void test('watched files: the handler refreshes, schedules and observes only for an admitted change', async () => {
  for (const [label, rows, refreshes] of [
    ['oversized, none admitted', outside(1001), false],
    ['oversized, one admitted', [...outside(1000), { uri: FAKE_URI, type: 2 }], true],
  ] as const) {
    const fake = fakeConnection();
    const context = createServerContext(fake.connection, fakeConfig({ filesystem: true }), {
      filesystem: fakeFilesystem(),
    });
    registerLifecycleHandlers(context);
    registerDocumentHandlers(context);
    fake.handler('initialize')({ processId: null, rootUri: FAKE_ROOT, capabilities: {} }, token);
    const disk = context.workspace.diskGeneration;
    const generation = context.coordinator.generation;
    const observed = () =>
      context.observations.filesystem({
        available: true,
        enabled: true,
        generation: context.sessions.current.generation,
      });
    assert.equal(observed(), null);
    fake.handler('workspace/didChangeWatchedFiles')({ changes: rows });
    assert.equal(context.workspace.diskGeneration > disk, refreshes, `${label}: disk`);
    assert.equal(context.coordinator.generation > generation, refreshes, `${label}: schedule`);
    assert.equal(context.coordinator.status.timer, refreshes, `${label}: timer`);
    assert.deepEqual(
      observed(),
      refreshes
        ? {
            sessionGeneration: context.sessions.current.generation,
            generation: context.coordinator.generation,
            uris: [],
            truncated: true,
          }
        : null,
      `${label}: observation`,
    );
    await context.lifecycle.close();
  }
});
