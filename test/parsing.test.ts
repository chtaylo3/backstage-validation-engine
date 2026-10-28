import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ContractError,
  PARSING_LIMITS,
  SourceLineIndex,
  createSourceSnapshot,
  createValidationResult,
  locateParsedPath,
  overlaySourceSnapshot,
  parseSourceSnapshot,
  parsingFindings,
  resultExitCode,
} from '../src/index.js';
import type { ParsingLimits, ParsingOptions } from '../src/index.js';
import { URI, makeRequest } from './helpers.js';

function snapshot(text: string) {
  return createSourceSnapshot({
    repository: 'https://github.com/example/application',
    revision: 'source-1',
    files: [{ uri: URI, text }],
  });
}
function options(mode: 'ci' | 'ide' = 'ci', limits?: Partial<ParsingLimits>): ParsingOptions {
  return { mode, deadlineAt: Date.now() + 5000, ...(limits ? { limits } : {}) };
}
const parse = (text: string, mode: 'ci' | 'ide' = 'ci', limits?: Partial<ParsingLimits>) =>
  parseSourceSnapshot(snapshot(text), options(mode, limits));

void test('PARSE-01 preserves multi-file order, multi-document ordinals, and explicit null', async () => {
  const source = createSourceSnapshot({
    repository: 'repo',
    revision: 'one',
    files: [
      { uri: 'file:///workspace/z.yaml', text: 'kind: Group\n' },
      { uri: URI, text: '# header\n---\nkind: Component\n---\n# empty\n---\nnull\n' },
    ],
  });
  const report = await parseSourceSnapshot(source, options());
  assert.equal(report.sourceDigest, source.digest);
  assert.deepEqual(
    report.documents.map((doc) => [doc.uri, doc.document, doc.value]),
    [
      [URI, 0, { kind: 'Component' }],
      [URI, 2, null],
      ['file:///workspace/z.yaml', 0, { kind: 'Group' }],
    ],
  );
  assert.equal(report.files[0]?.documentsScanned, 3);
  assert.equal(report.files[0]?.emptyDocuments, 1);
  assert(report.coverage.every((entry) => entry.status === 'verified'));
  assert(Object.isFrozen(report.documents[0]?.value));
  assert(Object.isFrozen(report.documents[0]?.locations));
});

void test('PARSE-01 blank/comment-only streams are explicit empty work', async () => {
  for (const text of ['', '# comment\n', '---\n', '\uFEFF# comment\n']) {
    const report = await parse(text);
    assert.equal(report.documents.length, 0);
    assert.equal(report.diagnostics.length, 0);
    assert.equal(report.files[0]?.emptyDocuments, 1);
    assert.equal(report.files[0]?.status, 'parsed');
  }
});

void test('PARSE-01 preserves original buffer version and does not re-read a live checkout', async () => {
  const base = snapshot('kind: Original\n');
  const proposed = overlaySourceSnapshot(base, [
    { uri: URI, text: 'kind: Proposed\n', origin: 'buffer', version: 7 },
  ]);
  const report = await parseSourceSnapshot(proposed, options('ide'));
  assert.deepEqual(report.documents[0]?.value, { kind: 'Proposed' });
  assert.equal(report.documents[0]?.version, 7);
  assert.equal(report.documents[0]?.sourceDigest, proposed.files[0]?.digest);
  assert.equal(base.files[0]?.text, 'kind: Original\n');
  await assert.rejects(
    parseSourceSnapshot({ ...proposed, revision: 'tampered' }, options()),
    /digest mismatch/,
  );
});

void test('PARSE-01 discovery selection is explicit, validated, and can be empty', async () => {
  const source = createSourceSnapshot({
    repository: 'repo',
    revision: 'one',
    files: [
      { uri: URI, text: 'kind: Component\n' },
      { uri: 'file:///workspace/readme.txt', text: '[malformed' },
    ],
  });
  const selected = await parseSourceSnapshot(source, { ...options(), uris: [URI] });
  assert.equal(selected.documents.length, 1);
  assert.equal(selected.diagnostics.length, 0);
  assert.equal((await parseSourceSnapshot(source, { ...options(), uris: [] })).files.length, 0);
  await assert.rejects(
    parseSourceSnapshot(source, { ...options(), uris: [URI, URI] }),
    /duplicate/,
  );
  await assert.rejects(
    parseSourceSnapshot(source, { ...options(), uris: ['file:///missing'] }),
    /unavailable/,
  );
});

void test('PARSE-02 YAML 1.2 normalizes JSON-compatible values without losing missing/null', async () => {
  const report = await parse(
    'spec:\n  blank:\n  nullValue: null\n  yesText: yes\n  offText: off\n  date: 2026-10-28\n  enabled: true\n  hex: 0x10\n  fraction: 1.5\n  max: 9007199254740991\n  min: -9007199254740991\n',
  );
  assert.equal(report.diagnostics.length, 0);
  assert.deepEqual(report.documents[0]?.value, {
    spec: {
      blank: null,
      nullValue: null,
      yesText: 'yes',
      offText: 'off',
      date: '2026-10-28',
      enabled: true,
      hex: 16,
      fraction: 1.5,
      max: Number.MAX_SAFE_INTEGER,
      min: Number.MIN_SAFE_INTEGER,
    },
  });
  const value = report.documents[0]?.value;
  assert(value !== null && typeof value === 'object' && 'spec' in value);
  assert(value.spec !== null && typeof value.spec === 'object');
  assert(!Object.hasOwn(value.spec, 'missing'));
});

void test('PARSE-02 rejects unsafe/nonfinite numeric input before conversion loses precision', async (t) => {
  for (const number of [
    '9007199254740992',
    '9007199254740993',
    '-9007199254740993',
    '.nan',
    '.inf',
    '-.inf',
    '1e400',
  ]) {
    await t.test(number, async () => {
      const report = await parse(`value: ${number}\n`);
      assert.equal(report.documents.length, 0);
      assert.equal(report.diagnostics[0]?.code, 'unsafe_number');
      assert.equal(report.files[0]?.status, 'invalid');
      assert.equal(report.interrupted, 'none');
    });
  }
});

void test('PARSE-02 duplicate keys are detected at nested/flow paths with the first key related', async () => {
  const report = await parse('metadata: {name: first, "name": second}\n');
  const diagnostic = report.diagnostics[0]!;
  assert.equal(diagnostic.code, 'duplicate_key');
  assert.equal(diagnostic.location.path, '/metadata/name');
  assert.equal(diagnostic.location.range.start.character, 24);
  assert.equal(diagnostic.relatedLocations[0]?.range.start.character, 11);
  assert.equal(report.documents.length, 0);
});

void test('PARSE-02 merge keys, non-string keys, YAML 1.1 and unsupported tags fail closed', async (t) => {
  for (const [text, code] of [
    ['base: &base {a: one}\ncopy: {<<: *base}\n', 'merge_key'],
    ['"<<": literal\n', 'merge_key'],
    ['1: value\n', 'invalid_key'],
    ['? [a, b]\n: value\n', 'invalid_key'],
    ['%YAML 1.1\n---\nvalue: yes\n', 'unsupported_version'],
    ['value: !custom private-data\n', 'unsupported_tag'],
    ['value: !!timestamp 2026-10-28\n', 'unsupported_tag'],
    ['value: !!binary c2VjcmV0\n', 'unsupported_tag'],
  ] as const) {
    await t.test(code, async () => {
      const report = await parse(text);
      assert.equal(report.documents.length, 0);
      assert.equal(report.diagnostics[0]?.code, code);
    });
  }
});

void test('PARSE-02 JSON objects and dangerous property names remain plain data', async () => {
  const report = await parse(
    '{"__proto__":{"polluted":true},"constructor":"data","toString":"text"}',
  );
  assert.equal(report.diagnostics.length, 0);
  const value = report.documents[0]?.value;
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert(Object.hasOwn(value, '__proto__'));
  assert.equal(Object.getOwnPropertyDescriptor(value, 'constructor')?.value, 'data');
  assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted'), undefined);
});

void test('PARSE-03 ranges use UTF-16, CRLF, quoted keys, escaped pointers, and array paths', async () => {
  const line = '  "a/b~c": [first, "😀", {name: team}]';
  const report = await parse(`metadata:\r\n${line}\r\n`);
  const doc = report.documents[0]!;
  const key = locateParsedPath(doc, '/metadata/a~1b~0c', 'key');
  assert.deepEqual(key.range, { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } });
  const emoji = locateParsedPath(doc, '/metadata/a~1b~0c/1');
  const start = line.indexOf('"😀"');
  assert.deepEqual(emoji.range, {
    start: { line: 1, character: start },
    end: { line: 1, character: start + 4 },
  });
  assert.equal(
    locateParsedPath(doc, '/metadata/a~1b~0c/2/name').range.start.character,
    line.indexOf('team'),
  );
  const missing = locateParsedPath(doc, '/metadata/new/path');
  assert.equal(missing.path, '/metadata/new/path');
  assert.deepEqual(missing.range, doc.locations['/metadata']?.value);
  assert.throws(() => locateParsedPath(doc, 'metadata'), RangeError);
  assert.throws(() => locateParsedPath(doc, '/metadata/~2'), RangeError);
});

void test('PARSE-03 block scalars preserve values and inline comments do not extend scalar ranges', async () => {
  const report = await parse('owner: team # private comment\ntext: |\n  first\n  second\n');
  const doc = report.documents[0]!;
  assert.deepEqual(doc.value, { owner: 'team', text: 'first\nsecond\n' });
  assert.deepEqual(locateParsedPath(doc, '/owner').range, {
    start: { line: 0, character: 7 },
    end: { line: 0, character: 11 },
  });
  assert.deepEqual(locateParsedPath(doc, '/text').range.start, { line: 1, character: 6 });
});

void test('PARSE-03 line indexing clamps boundaries and handles LF, CRLF, bare CR, and emoji', () => {
  const lines = new SourceLineIndex('😀x\r\ny\rz\n');
  assert.deepEqual(lines.position(2), { line: 0, character: 2 });
  assert.deepEqual(lines.position(4), { line: 0, character: 3 });
  assert.deepEqual(lines.position(5), { line: 1, character: 0 });
  assert.deepEqual(lines.position(7), { line: 2, character: 0 });
  assert.deepEqual(lines.position(100), { line: 3, character: 0 });
  assert.deepEqual(lines.position(-10), { line: 0, character: 0 });
  assert.throws(() => lines.position(NaN), RangeError);
});

void test('PARSE-04 aliases expand as independent JSON and retain authored provenance', async () => {
  const report = await parse('base: &base\n  owner: team\ncopy: *base\n');
  const doc = report.documents[0]!;
  assert.deepEqual(doc.value, { base: { owner: 'team' }, copy: { owner: 'team' } });
  const copy = doc.locations['/copy/owner']!;
  assert.equal(copy.origin, 'alias');
  assert.deepEqual(copy.value, {
    start: { line: 2, character: 6 },
    end: { line: 2, character: 11 },
  });
  assert.equal(copy.relatedLocations[0]?.path, '/base/owner');
  assert.deepEqual(copy.relatedLocations[0]?.range.start, { line: 1, character: 9 });
  assert.deepEqual(locateParsedPath(doc, '/copy', 'key').range.start, { line: 2, character: 0 });
  const value = doc.value;
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.notEqual(value.base, value.copy);
});

void test('PARSE-04 aliases use the last preceding anchor and never cross document boundaries', async () => {
  const repeated = await parse('a: &x {value: first}\nb: &x {value: second}\ncopy: *x\n');
  assert.deepEqual(repeated.documents[0]?.value, {
    a: { value: 'first' },
    b: { value: 'second' },
    copy: { value: 'second' },
  });
  const crossing = await parse('a: &x one\n---\nb: *x\n', 'ide');
  assert.equal(crossing.documents.length, 1);
  assert.equal(crossing.diagnostics[0]?.code, 'alias_missing');
  const cycle = await parse('root: &root {self: *root}\n');
  assert.equal(cycle.diagnostics[0]?.code, 'alias_cycle');
  assert.equal(cycle.documents.length, 0);
});

void test('PARSE-04 depth is guarded before recursive composition', async () => {
  const allowed = await parse('['.repeat(64) + '0' + ']'.repeat(64));
  assert.equal(allowed.diagnostics.length, 0);
  const rejected = await parse('['.repeat(5000) + '0' + ']'.repeat(5000));
  assert.equal(rejected.diagnostics[0]?.code, 'resource_limit');
  assert.equal(rejected.interrupted, 'resource_limit');
  assert.equal(rejected.documents.length, 0);
});

void test('PARSE-04 aliases, expansion, nodes, tokens, documents and source budgets are bounded', async (t) => {
  for (const [text, limits] of [
    ['base: &base x\n' + Array.from({ length: 51 }, (_, i) => `copy${i}: *base\n`).join(''), {}],
    ['base: &base [x,x,x]\ncopy: [*base,*base,*base]\n', { expandedValues: 10 }],
    ['owner: a-long-owner-name\n', { documentBytes: 12 }],
    ['a: one\n---\nb: two\n', { expandedBytes: 15 }],
    ['a: one\n', { syntaxNodes: 2 }],
    ['a: one\n', { tokens: 1 }],
    ['a: one\n---\nb: two\n', { documents: 1 }],
    ['a: one\n', { fileBytes: 1 }],
    ['a: one\n', { requestBytes: 1 }],
  ] satisfies [string, Partial<ParsingLimits>][]) {
    await t.test(JSON.stringify(limits), async () => {
      const report = await parse(text, 'ci', limits);
      assert.equal(report.interrupted, 'resource_limit');
      assert.equal(report.diagnostics.at(-1)?.code, 'resource_limit');
      assert(report.coverage.some((entry) => entry.status === 'blocked'));
      assert.equal(report.documents.length, 0);
    });
  }
  await assert.rejects(
    parseSourceSnapshot(snapshot('a: one'), options('ci', { depth: PARSING_LIMITS.depth + 1 })),
    RangeError,
  );
});

void test('PARSE-05 CI withholds an invalid file while IDE keeps unaffected document ordinals', async () => {
  const text = 'kind: First\n---\nmetadata: [broken\n---\nkind: Third\n';
  const ci = await parse(text);
  const ide = await parse(text, 'ide');
  assert.equal(ci.documents.length, 0);
  assert.equal(ci.files[0]?.status, 'invalid');
  assert.deepEqual(
    ide.documents.map((doc) => doc.document),
    [0, 2],
  );
  assert.deepEqual(
    ide.documents.map((doc) => doc.value),
    [{ kind: 'First' }, { kind: 'Third' }],
  );
  assert(ide.diagnostics.every((diagnostic) => diagnostic.location.document === 1));
  assert.equal(ide.coverage[0]?.status, 'verified');
});

void test('PARSE-05 invalid files do not suppress separate valid files, and diagnostics are redacted', async () => {
  const source = createSourceSnapshot({
    repository: 'repo',
    revision: 'one',
    files: [
      { uri: URI, text: 'value: !private TOP_SECRET_PAYLOAD\n' },
      { uri: 'file:///workspace/valid.yaml', text: 'kind: Group\n' },
    ],
  });
  const report = await parseSourceSnapshot(source, options());
  assert.equal(report.documents.length, 1);
  assert(!JSON.stringify(report.diagnostics).includes('TOP_SECRET_PAYLOAD'));
  assert(!JSON.stringify(report.diagnostics).includes('!private'));
});

void test('PARSE-05 diagnostic quota is explicit incomplete coverage, never silent truncation', async () => {
  const report = await parse('value: !first one\nother: !second two\n', 'ci', { diagnostics: 1 });
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0]?.code, 'resource_limit');
  assert.equal(report.interrupted, 'resource_limit');
});

void test('PARSE-06 expired and cancelled requests produce mandatory incomplete coverage', async () => {
  const source = snapshot('kind: Component\n');
  const expired = await parseSourceSnapshot(source, { ...options(), deadlineAt: Date.now() - 1 });
  assert.equal(expired.interrupted, 'timeout');
  assert.equal(expired.documents.length, 0);
  const abort = new AbortController();
  abort.abort('TOP_SECRET_REASON');
  const cancelled = await parseSourceSnapshot(source, { ...options('ide'), signal: abort.signal });
  assert.equal(cancelled.interrupted, 'cancelled');
  assert.equal(cancelled.coverage[0]?.status, 'blocked');
  assert(!JSON.stringify(cancelled.diagnostics).includes('TOP_SECRET_REASON'));
  const empty = await parseSourceSnapshot(source, { ...options(), uris: [], signal: abort.signal });
  assert.equal(empty.interrupted, 'cancelled');
  assert.equal(empty.coverage[0]?.status, 'blocked');
});

void test('PARSE-06 cancellation interrupts lexing without blocking the parent event loop', async () => {
  const source = snapshot(
    Array.from({ length: 8000 }, (_, index) => `field${index}: value\n`).join(''),
  );
  const abort = new AbortController();
  const work = parseSourceSnapshot(source, { ...options('ide'), signal: abort.signal });
  setTimeout(() => abort.abort(), 0);
  const report = await work;
  assert.equal(report.interrupted, 'cancelled');
  assert.equal(report.documents.length, 0);
});

void test('PARSE-06 many duplicate keys are handled with bounded linear validation', async () => {
  const report = await parse('name: duplicate\n'.repeat(10_000));
  assert.equal(report.diagnostics[0]?.code, 'duplicate_key');
  assert.equal(report.interrupted, 'none');
});

void test('parser diagnostics integrate with canonical CI/IDE outcomes and preserve provenance', async () => {
  for (const mode of ['ci', 'ide'] as const) {
    const source = snapshot('metadata: {name: first, name: second}\n');
    const request = { ...makeRequest(mode), source };
    const report = await parseSourceSnapshot(source, options(mode));
    const findings = parsingFindings(request, report);
    assert.equal(findings[0]?.ruleId, 'yaml/duplicate_key');
    assert.equal(findings[0]?.location.path, '/metadata/name');
    assert.equal(findings[0]?.relatedLocations.length, 1);
    const result = createValidationResult({
      request,
      findings,
      coverage: report.coverage,
      interrupted: report.interrupted,
      completedAt: request.execution.startedAt + 100,
      authorityCheckedAt: request.execution.startedAt,
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.enforcement, mode === 'ci' ? 'block' : 'advisory');
    assert.equal(resultExitCode(result), mode === 'ci' ? 1 : 0);
    assert.throws(
      () => parsingFindings({ ...request, source: snapshot('kind: Different\n') }, report),
      ContractError,
    );
  }
});

void test('parser resource failures become incomplete results and duplicate diagnostic IDs coalesce', async () => {
  const source = snapshot('value: !first one\nother: !second two\n');
  const request = { ...makeRequest(), source };
  const report = await parseSourceSnapshot(source, options());
  const findings = parsingFindings(request, report);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.relatedLocations.length, 1);
  const limited = await parseSourceSnapshot(source, options('ci', { tokens: 1 }));
  const result = createValidationResult({
    request,
    findings: parsingFindings(request, limited),
    coverage: limited.coverage,
    interrupted: limited.interrupted,
    completedAt: request.execution.startedAt + 100,
    authorityCheckedAt: request.execution.startedAt,
  });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(resultExitCode(result), 2);
});
