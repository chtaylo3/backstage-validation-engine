import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CodeActionParams } from 'vscode-languageserver/node';
import type { Finding } from '../src/index.js';
import { createSourceSnapshot, digestText } from '../src/index.js';
import { checkedFixEdit, FixRegistry, FIX_LIMITS } from '../src/lsp/fixes.js';
import { URI } from './helpers.js';

const text = 'abc😀\r\ndef';
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
const edit = { uri: URI, sourceDigest: digestText(text), version: 1, range, text: 'new' };
const finding: Finding = {
  id: 'fix-1',
  ruleId: 'required-value',
  ruleVersion: '1',
  subjectId: 'service',
  message: 'Entity does not satisfy the policy schema.',
  category: 'policy',
  severity: 'error',
  enforcement: 'advisory',
  location: { uri: URI, document: 0, path: '/value', range },
  relatedLocations: [],
  edits: [edit],
};
const limits = {
  fileBytes: 100_000,
  requestBytes: 100_000,
  sourceBytes: Buffer.byteLength(text),
  atomicTextEdits: true,
};
function fixture(options: { expiresAt?: number; findings?: Finding[] } = {}) {
  let wall = 1000,
    monotonic = 10;
  const registry = new FixRegistry({ wall: () => wall, monotonic: () => monotonic });
  const documents = new Map([[URI, TextDocument.create(URI, 'yaml', 1, text)]]);
  const source = createSourceSnapshot({
    repository: 'repo',
    revision: '1',
    files: [{ uri: URI, text, version: 1, origin: 'buffer' }],
  });
  registry.replace({
    generation: 1,
    findings: options.findings ?? [finding],
    source,
    documents,
    expiresAt: options.expiresAt ?? 100_000,
  });
  const params: CodeActionParams = {
    textDocument: { uri: URI },
    range,
    context: { diagnostics: [] },
  };
  const actions = () => registry.actions(params, 1, documents, limits);
  const command = () => actions()[0]!.command!.arguments as unknown[];
  const apply = (args = command()) =>
    registry.apply(args, 1, documents, limits, () => Promise.resolve({ applied: true }));
  return {
    registry,
    documents,
    params,
    actions,
    command,
    apply,
    time: (w: number, m = monotonic) => {
      wall = w;
      monotonic = m;
    },
  };
}

void test('guard emits only versioned text document changes', () => {
  const { documents } = fixture();
  assert.deepEqual(checkedFixEdit([edit], documents, limits), {
    documentChanges: [
      { textDocument: { uri: URI, version: 1 }, edits: [{ range, newText: 'new' }] },
    ],
  });
});

void test('guard rejects invalid edit preconditions and resource/range violations', async (t) => {
  const rows: {
    name: string;
    edits?: Finding['edits'];
    mutate?: (f: ReturnType<typeof fixture>) => void;
    caps?: Partial<typeof limits>;
  }[] = [
    { name: 'empty', edits: [] },
    { name: 'closed', mutate: (f) => f.documents.clear() },
    {
      name: 'missing version',
      edits: [{ uri: URI, sourceDigest: edit.sourceDigest, range, text: edit.text }],
    },
    { name: 'wrong version', edits: [{ ...edit, version: 2 }] },
    { name: 'wrong digest', edits: [{ ...edit, sourceDigest: digestText('other') }] },
    {
      name: 'out of bounds line',
      edits: [{ ...edit, range: { ...range, end: { line: 90, character: 0 } } }],
    },
    {
      name: 'out of bounds character',
      edits: [{ ...edit, range: { ...range, end: { line: 0, character: 90 } } }],
    },
    {
      name: 'negative',
      edits: [{ ...edit, range: { ...range, start: { line: -1, character: 0 } } }],
    },
    {
      name: 'fractional',
      edits: [{ ...edit, range: { ...range, start: { line: 0, character: 0.5 } } }],
    },
    { name: 'reversed', edits: [{ ...edit, range: { start: range.end, end: range.start } }] },
    {
      name: 'surrogate split',
      edits: [{ ...edit, range: { ...range, end: { line: 0, character: 4 } } }],
    },
    { name: 'unpaired replacement', edits: [{ ...edit, text: '\ud800' }] },
    {
      name: 'oversized replacement',
      edits: [{ ...edit, text: 'x'.repeat(FIX_LIMITS.textBytes + 1) }],
    },
    { name: 'file budget', caps: { fileBytes: 2 } },
    { name: 'request budget including baseline', caps: { sourceBytes: 100_000, requestBytes: 5 } },
    { name: 'overlap', edits: [edit, edit] },
    {
      name: 'ambiguous insertion boundary',
      edits: [edit, { ...edit, range: { start: range.end, end: range.end } }],
    },
    {
      name: 'no atomic multi-edit capability',
      edits: [
        edit,
        { ...edit, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
      ],
      caps: { atomicTextEdits: false },
    },
    { name: 'multi-file', edits: [edit, { ...edit, uri: 'file:///workspace/other.yaml' }] },
    { name: 'too many edits', edits: Array.from({ length: 17 }, () => edit) },
    {
      name: 'same-version content changed',
      mutate: (f) => f.documents.set(URI, TextDocument.create(URI, 'yaml', 1, 'xyz😀\r\ndef')),
    },
  ];
  for (const row of rows)
    await t.test(row.name, () => {
      const f = fixture();
      row.mutate?.(f);
      assert.equal(
        checkedFixEdit(row.edits ?? [edit], f.documents, { ...limits, ...row.caps }),
        undefined,
      );
    });
  const { documents } = fixture();
  assert(
    checkedFixEdit(
      [
        edit,
        { ...edit, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
      ],
      documents,
      limits,
    ),
  );
});

void test('actions carry opaque single-use tokens and require fresh diagnostic metadata', async () => {
  const f = fixture();
  const action = f.actions()[0]!;
  assert.equal(action.edit, undefined);
  assert.equal(action.kind, 'quickfix');
  assert.match(action.command!.arguments![0] as string, /^[a-f0-9-]{36}$/u);
  f.params.context.diagnostics = action.diagnostics!;
  assert.equal(f.actions().length, 1);
  f.params.context.diagnostics = [
    {
      ...action.diagnostics![0]!,
      data: { findingId: finding.id, version: 1, sourceDigest: digestText(text), fixGeneration: 0 },
    },
  ];
  assert.deepEqual(f.actions(), []);
  f.params.context.diagnostics = [];
  assert.deepEqual(await f.apply(action.command!.arguments), { applied: true });
  assert.deepEqual(await f.apply(action.command!.arguments), { applied: false, reason: 'stale' });
  assert.deepEqual(f.actions(), []);
});

void test('every workspace epoch, open frame and time precondition is checked again at execution', async (t) => {
  const cases: { name: string; mutate: (f: ReturnType<typeof fixture>) => void }[] = [
    {
      name: 'changed version',
      mutate: (f) => f.documents.set(URI, TextDocument.create(URI, 'yaml', 2, text)),
    },
    {
      name: 'changed digest with same version',
      mutate: (f) => f.documents.set(URI, TextDocument.create(URI, 'yaml', 1, 'changed')),
    },
    {
      name: 'new included buffer',
      mutate: (f) =>
        f.documents.set(
          'file:///workspace/other.yaml',
          TextDocument.create('file:///workspace/other.yaml', 'yaml', 1, text),
        ),
    },
    { name: 'closed target', mutate: (f) => f.documents.clear() },
    {
      name: 'close and reopen version reuse',
      mutate: (f) => {
        f.registry.invalidate();
        f.documents.set(URI, TextDocument.create(URI, 'yaml', 1, text));
      },
    },
    { name: 'save or watched disk change', mutate: (f) => f.registry.invalidate() },
    { name: 'wall expiry', mutate: (f) => f.time(61_000) },
    { name: 'backward wall clock', mutate: (f) => f.time(999) },
    { name: 'monotonic expiry during slow wall time', mutate: (f) => f.time(1001, 60_010) },
  ];
  for (const row of cases)
    await t.test(row.name, async () => {
      const f = fixture(),
        args = f.command();
      row.mutate(f);
      let dispatched = false;
      const result = await f.registry.apply(args, 1, f.documents, limits, () => {
        dispatched = true;
        return Promise.resolve({ applied: true });
      });
      assert.deepEqual(result, { applied: false, reason: 'stale' });
      assert.equal(dispatched, false);
      assert.deepEqual(f.actions(), []);
    });
  const f = fixture({ expiresAt: 1010 });
  const args = f.command();
  f.time(1010);
  assert.deepEqual(await f.apply(args), { applied: false, reason: 'stale' });
  const rolledBack = fixture({ expiresAt: 1010 });
  const expiredData = rolledBack.command();
  rolledBack.time(1001, 20);
  assert.deepEqual(await rolledBack.apply(expiredData), { applied: false, reason: 'stale' });
  const g = fixture();
  const token = g.command();
  assert.deepEqual(
    await g.registry.apply(token, 2, g.documents, limits, () => {
      throw new Error('must not dispatch');
    }),
    { applied: false, reason: 'stale' },
  );
});

void test('untrusted command arguments cannot select or replace edits', async () => {
  const f = fixture(),
    args = f.command();
  for (const invalid of [undefined, [], ['made-up'], [...args, { text: 'attacker' }], [edit]]) {
    const result = await f.registry.apply(invalid, 1, f.documents, limits, () => {
      throw new Error('must not dispatch');
    });
    assert.equal(result.applied, false);
  }
  f.params.context.only = ['source.fixAll'];
  assert.deepEqual(f.actions(), []);
});

void test('client rejection, unknown outcome and concurrent requests remain bounded and sanitized', async () => {
  const f = fixture(),
    args = f.command();
  let finish!: (value: { applied: boolean }) => void;
  const pending = f.registry.apply(
    args,
    1,
    f.documents,
    limits,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  assert.deepEqual(await f.apply(args), { applied: false, reason: 'busy' });
  assert.deepEqual(f.actions(), []);
  finish({ applied: false });
  assert.deepEqual(await pending, { applied: false, reason: 'client_rejected' });
  assert.deepEqual(await f.apply(args), { applied: false, reason: 'stale' });
  const next = f.command();
  const failed = await f.registry.apply(next, 1, f.documents, limits, () =>
    Promise.reject(new Error('secret raw client payload')),
  );
  assert.deepEqual(failed, { applied: false, reason: 'client_error' });
  assert.deepEqual(f.actions(), []);
});

void test('token storage uses bounded FIFO eviction', async () => {
  const f = fixture(),
    first = f.command();
  for (let i = 0; i < FIX_LIMITS.tokens; i++) f.command();
  assert.deepEqual(await f.apply(first), { applied: false, reason: 'stale' });
  const newest = f.command();
  assert.deepEqual(await f.apply(newest), { applied: true });
});
