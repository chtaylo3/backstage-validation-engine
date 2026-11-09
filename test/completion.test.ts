import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { stringify } from 'yaml';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BACKSTAGE_ADAPTER_IDS, overlaySourceSnapshot } from '../src/index.js';
import type { CatalogProvider, CatalogSuggestionReport } from '../src/index.js';
import { CompletionService, COMPLETION_LIMITS } from '../src/lsp/completion.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { componentText, localTeam, policyRun, team } from './harness/policy-fixture.js';
import { URI } from './helpers.js';

async function setup(
  t: TestContext,
  options: Parameters<typeof policyRun>[0] = {},
  remote?: { suggest: NonNullable<CatalogProvider['suggest']>; maxAgeMs?: number },
  clock?: { wall(): number; mono(): number },
) {
  const run = policyRun({ rules: [], files: [localTeam], ...options });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    ...(run.request.baseline ? { baseline: run.request.baseline } : {}),
  });
  const provider: CatalogProvider = {
    connectionId: 'test',
    adapterId: config.profile.adapterId,
    lookup: () => Promise.reject(new Error('completion must not run validation lookups')),
    ...(remote ? { suggest: remote.suggest } : {}),
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  const service = new CompletionService(
    config,
    remote
      ? {
          provider,
          access: {
            installationId: run.request.identity.installationId,
            principalId: 'reader',
            permissionRevision: run.request.identity.permissionRevision,
            credentialRevision: '1',
            scope: ['catalog:read'],
            policyDigest: run.request.policy.digest,
            profileDigest: run.request.profile.digest,
            maxAgeMs: remote.maxAgeMs ?? 5000,
          },
        }
      : undefined,
    clock,
  );
  t.after(() => service.close());
  const file = run.request.source.files.find((row) => row.uri === URI)!;
  const documents = new Map([[URI, TextDocument.create(URI, 'yaml', file.version!, file.text)]]);
  await service.update(run.request, 1);
  const complete = (line = 6, character = 11, signal = new AbortController().signal) =>
    service.complete(
      { textDocument: { uri: URI }, position: { line, character } },
      1,
      documents,
      signal,
    );
  return { service, run, documents, complete };
}
const fresh = (refs = ['group:default/te-remote']): CatalogSuggestionReport => ({
  status: 'ready',
  refs,
  truncated: false,
  fetchedAt: Date.now(),
  expiresAt: Date.now() + 30_000,
});

void test('search picker results retain local precedence, validated queries and bounded selection ranking', async (t) => {
  const f = await setup(
    t,
    {
      files: [
        localTeam,
        {
          uri: 'file:///workspace/second.yaml',
          text: stringify({ ...team, metadata: { name: 'team-second' } }),
        },
      ],
    },
    {
      suggest: () =>
        Promise.resolve(fresh(['group:default/team-remote', 'user:default/team-hidden'])),
    },
  );
  const query = { kind: 'group', namespace: 'default', prefix: 'te' };
  const signal = new AbortController().signal;
  const before = await f.service.searchReferences(query, 1, signal);
  assert.deepEqual(
    before.map((row) => row.reference),
    ['group:default/team', 'group:default/team-second', 'group:default/team-remote'],
  );
  f.service.record('group:default/team-second');
  assert.equal(
    (await f.service.searchReferences(query, 1, signal))[0]?.reference,
    'group:default/team-second',
  );
  assert.deepEqual(
    await f.service.searchReferences({ ...query, baseUrl: 'https://untrusted.invalid' }, 1, signal),
    [],
  );
  assert.deepEqual(await f.service.searchReferences({ ...query, prefix: '../' }, 1, signal), []);
  f.service.invalidate();
  assert.deepEqual(await f.service.searchReferences(query, 1, signal), []);
});

void test('qualified workspace references complete on both model pins with exact plain scalar edits', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    await t.test(adapterId, async (t) => {
      const f = await setup(t, { profile: { adapterId } });
      const result = await f.complete();
      assert.equal(result.isIncomplete, true);
      assert.deepEqual(
        result.items.map((row) => row.label),
        ['group:default/team'],
      );
      assert.equal(result.items[0]?.detail, 'Workspace source');
      assert.deepEqual(result.items[0]?.textEdit, {
        range: { start: { line: 6, character: 9 }, end: { line: 6, character: 13 } },
        newText: 'group:default/team',
      });
      assert.equal(result.items[0]?.filterText, 'team');
      assert.equal(result.items[0]?.command, undefined);
      assert.equal(result.items[0]?.additionalTextEdits, undefined);
    });
});

void test('empty YAML values, quotes, JSON and CRLF preserve punctuation/comments and UTF-16 offsets', async (t) => {
  const cases = [
    componentText(''),
    componentText("'te' # keep 😀"),
    componentText('"te" # keep 😀').replaceAll('\n', '\r\n'),
    JSON.stringify({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'service', description: '😀' },
      spec: { type: 'service', lifecycle: 'production', owner: 'te' },
    }),
  ];
  for (const text of cases)
    await t.test(text.slice(-30), async (t) => {
      const f = await setup(t, { text });
      const document = f.documents.get(URI)!;
      const at = text.includes('"owner"')
        ? text.indexOf('"owner":"te"') + '"owner":"te'.length
        : text.indexOf('owner: ') +
          'owner: '.length +
          (text.includes("'te'") || text.includes('"te"') ? 2 : 0);
      const position = document.positionAt(at);
      const result = await f.complete(position.line, position.character);
      assert.equal(result.items[0]?.label, 'group:default/team');
      const edit = result.items[0].textEdit!;
      assert('range' in edit);
      const updated = TextDocument.applyEdits(document, [edit]);
      assert(updated.includes('group:default/team'));
      if (text.includes('# keep')) assert(updated.includes('# keep 😀'));
    });
});

void test('reference contexts honor arrays, explicit kinds and namespace defaults', async (t) => {
  const api = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'API',
    metadata: { name: 'test-api' },
    spec: { type: 'openapi', lifecycle: 'production', owner: 'team', definition: '{}' },
  };
  const text = componentText('team', '  providesApis: [te]\n');
  const f = await setup(t, {
    text,
    files: [localTeam, { uri: 'file:///workspace/api.yaml', text: stringify(api) }],
  });
  const result = await f.complete(7, 19);
  assert.deepEqual(
    result.items.map((row) => row.label),
    ['api:default/test-api'],
  );
  const numeric = await setup(t, {
    text,
    files: [localTeam, { uri: 'file:///workspace/api.yaml', text: stringify(api) }],
    profile: {
      referenceContexts: [
        { path: '/spec/providesApis/0', defaultKind: 'API', namespace: 'entity' },
      ],
    },
  });
  assert.deepEqual(
    (await numeric.complete(7, 19)).items.map((row) => row.label),
    ['api:default/test-api'],
  );
  const namespaced = await setup(t, {
    text: componentText('te').replace('{name: service}', '{name: service, namespace: payments}'),
    files: [
      {
        ...localTeam,
        text: stringify({ ...team, metadata: { name: 'team', namespace: 'payments' } }),
      },
    ],
  });
  assert.deepEqual(
    (await namespaced.complete()).items.map((row) => row.label),
    ['group:payments/team'],
  );
  const explicit = await setup(t, { text: componentText('group:default/te') });
  assert.equal((await explicit.complete(6, 25)).items[0]?.filterText, 'group:default/team');
});

void test('keys, comments, aliases, block scalars, unknown fields and invalid positions have no completion edits', async (t) => {
  for (const text of [
    componentText('*value').replace('spec:', 'value: &value team\nspec:'),
    componentText('|-\n    te'),
    componentText('{$text: ./owner.txt}'),
  ])
    await t.test(text.slice(-45), async (t) => {
      const f = await setup(t, {
        text,
        rootUri: 'file:///workspace/',
        entrypoints: [URI],
        files: [localTeam, { uri: 'file:///workspace/owner.txt', text: 'te' }],
      });
      assert.deepEqual((await f.complete(6, 10)).items, []);
    });
  const f = await setup(t, { text: componentText('team # comment') });
  for (const [line, character] of [
    [6, 4],
    [6, 17],
    [2, 20],
    [-1, 0],
    [200, 0],
    [6, 0.5],
  ])
    assert.deepEqual((await f.complete(line, character)).items, []);
});

void test('remote suggestions merge behind local identities and obey deletion, invalid replacement and conflict masks', async (t) => {
  const remote = {
    suggest: () => Promise.resolve(fresh(['group:default/team', 'group:default/te-remote'])),
  };
  const f = await setup(t, {}, remote);
  assert.deepEqual(
    (await f.complete()).items.map((row) => [row.label, row.detail]),
    [
      ['group:default/team', 'Workspace source'],
      ['group:default/te-remote', 'Catalog (fresh)'],
    ],
  );
  const baseline = policyRun({ rules: [], files: [localTeam] }).request.source;
  const deleted = await setup(
    t,
    { source: overlaySourceSnapshot(baseline, [{ uri: localTeam.uri, deleted: true }]), baseline },
    remote,
  );
  assert.deepEqual(
    (await deleted.complete()).items.map((row) => row.label),
    ['group:default/te-remote'],
  );
  const invalid = await setup(
    t,
    {
      source: overlaySourceSnapshot(baseline, [
        {
          ...localTeam,
          text: 'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {}\n',
        },
      ]),
      baseline,
    },
    remote,
  );
  assert(!JSON.stringify((await invalid.complete()).items).includes('group:default/team'));
  const conflict = await setup(
    t,
    { files: [localTeam, { uri: 'file:///workspace/duplicate.yaml', text: localTeam.text }] },
    remote,
  );
  assert(!JSON.stringify((await conflict.complete()).items).includes('group:default/team'));
});

void test('zero max-age bypasses reuse and changed authority needs a new host', async (t) => {
  let calls = 0;
  const f = await setup(
    t,
    {},
    {
      maxAgeMs: 0,
      suggest: () => {
        calls++;
        return Promise.resolve(fresh());
      },
    },
  );
  await f.complete();
  await f.complete();
  assert.equal(calls, 2);
  const config = parseLspConfig({
    ...f.run.context,
    identity: f.run.request.identity,
    source: f.run.request.source,
  });
  const provider: CatalogProvider = {
    connectionId: 'wrong',
    adapterId: config.profile.adapterId,
    lookup: () => Promise.reject(new Error('unused')),
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  assert.throws(
    () =>
      new CompletionService(config, {
        provider,
        access: {
          installationId: 'another-installation',
          principalId: 'reader',
          permissionRevision: f.run.request.identity.permissionRevision,
          credentialRevision: '1',
          scope: [],
          profileDigest: f.run.request.profile.digest,
          policyDigest: f.run.request.policy.digest,
          maxAgeMs: 1000,
        },
      }),
    /Invalid trusted completion/,
  );
});

void test('warm completion scans a 1000-entity source snapshot without I/O', async (t) => {
  const files = Array.from({ length: 999 }, (_, i) => ({
    uri: `file:///workspace/team-${i}.yaml`,
    text: stringify({ ...team, metadata: { name: 'team-' + String(i).padStart(3, '0') } }),
  }));
  const f = await setup(t, { files });
  const samples: number[] = [];
  for (let i = 0; i < 23; i++) {
    const started = performance.now();
    assert.equal((await f.complete()).items.length, COMPLETION_LIMITS.items);
    const elapsed = performance.now() - started;
    if (i >= 3) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  t.diagnostic(
    '1000 entities, warm completion, 20 samples after 3 warmups; p95 ms=' +
      samples[Math.ceil(samples.length * 0.95) - 1]!.toFixed(3),
  );
});

void test('one large buffer with 1000 reference slots builds its line index once per completion', async (t) => {
  const text =
    componentText(
      'team',
      '  consumesApis: [' + Array.from({ length: 999 }, () => 'te').join(', ') + ']\n',
    ) +
    '#' +
    'padding'.repeat(120_000) +
    '\n';
  const f = await setup(t, { text });
  const started = performance.now();
  assert.equal((await f.complete()).items[0]?.label, 'group:default/team');
  t.diagnostic(
    'Large buffer (UTF-8 bytes=' +
      Buffer.byteLength(text) +
      '), 1000 slots, warm completion ms=' +
      (performance.now() - started).toFixed(3),
  );
});

void test('completion is bounded while remote lookup stalls, coalesces identical queries and cancels on invalidation', async (t) => {
  let calls = 0,
    resolve!: (report: CatalogSuggestionReport) => void,
    remoteSignal: AbortSignal | undefined;
  const f = await setup(
    t,
    {},
    {
      suggest: (_query, _access, execution) => {
        calls++;
        remoteSignal = execution.signal;
        return new Promise((finish) => {
          resolve = finish;
        });
      },
    },
  );
  const pending = f.complete();
  const simultaneous = f.complete();
  const immediate = await pending;
  assert.equal(immediate.items[0]?.label, 'group:default/team');
  assert.equal(calls, 1);
  await simultaneous;
  f.service.invalidate();
  assert.equal(remoteSignal?.aborted, true);
  resolve(fresh());
  assert.deepEqual((await f.complete()).items, []);
});

void test('stale buffer versions/content, lifecycle changes and cancellation suppress results', async (t) => {
  const f = await setup(t);
  const document = f.documents.get(URI)!;
  f.documents.set(URI, TextDocument.create(URI, 'yaml', 2, document.getText()));
  assert.deepEqual((await f.complete()).items, []);
  f.documents.set(
    URI,
    TextDocument.create(URI, 'yaml', 1, document.getText() + '# same version changed\n'),
  );
  assert.deepEqual((await f.complete()).items, []);
  f.documents.set(URI, document);
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual((await f.complete(6, 11, abort.signal)).items, []);
  f.documents.clear();
  assert.deepEqual((await f.complete()).items, []);
  await f.service.close();
  assert.deepEqual((await f.complete()).items, []);
});

void test('cache freshness uses authority-bound max age, monotonic expiry and clock rollback; failures are not negative cache entries', async (t) => {
  let calls = 0,
    wall = Date.now(),
    mono = 100;
  const clock = { wall: () => wall, mono: () => mono };
  const f = await setup(
    t,
    {},
    {
      maxAgeMs: 100,
      suggest: () => {
        calls++;
        return Promise.resolve({ ...fresh(), fetchedAt: wall, expiresAt: wall + 10 });
      },
    },
    clock,
  );
  await f.complete();
  await f.complete();
  assert.equal(calls, 1);
  wall++;
  mono += 10;
  await f.complete();
  assert.equal(calls, 2);
  wall--;
  await f.complete();
  assert.equal(calls, 3);
  let failed = 0;
  const errors = await setup(
    t,
    {},
    {
      suggest: () => {
        failed++;
        return Promise.resolve({
          status: 'unavailable',
          failure: 'permission_denied',
          refs: [],
          truncated: false,
          fetchedAt: Date.now(),
          expiresAt: Date.now(),
        });
      },
    },
  );
  assert.equal((await errors.complete()).items[0]?.label, 'group:default/team');
  await errors.complete();
  assert.equal(failed, 2);
});

void test('only the latest source generation can publish an index, unsupported processing blocks suggestions, and results are capped', async (t) => {
  const f = await setup(t);
  f.service.invalidate();
  await f.service.update(f.run.request, 2);
  assert.deepEqual((await f.complete()).items, []);
  const blocked = await setup(t, {
    profile: { requiredProcessors: [{ id: 'required', stage: 'pre-validation' }] },
  });
  assert.deepEqual((await blocked.complete()).items, []);
  const files = Array.from({ length: 120 }, (_, i) => ({
    uri: `file:///workspace/team-${i}.yaml`,
    text: stringify({ ...team, metadata: { name: 'team-' + i } }),
  }));
  const many = await setup(t, { files });
  assert.equal((await many.complete()).items.length, COMPLETION_LIMITS.items);
});
