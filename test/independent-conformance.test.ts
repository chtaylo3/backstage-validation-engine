import assert from 'node:assert/strict';
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { sarifValidator } from './harness/sarif-schema.js';
import {
  canonicalJson,
  createValidationResult,
  digestJson,
  formatSarif,
  formatSarifError,
  parseSourceSnapshot,
  createSourceSnapshot,
  verifyPolicyRelease,
} from '../src/index.js';
import type { JsonValue } from '../src/index.js';
import { createSchemaRegistry } from '../src/compatibility/custom-schemas.js';
import { schemaArtifact } from './harness/custom-kind-fixture.js';
import { releaseFixture } from './harness/release-fixture.js';
import { makeRequest, NOW, URI, verifiedCoverage } from './helpers.js';

const root = 'test/fixtures/conformance';
void test('vendored independent inputs retain pinned bytes and source/license identities', async () => {
  const manifest = JSON.parse(await readFile(`${root}/upstream-manifest.json`, 'utf8')) as {
    files: { path: string; sha256: string; url: string; license: string }[];
  };
  assert.equal(manifest.files.length, 39);
  for (const file of manifest.files) {
    assert.match(
      file.url,
      /^https:\/\/(raw.githubusercontent.com|docs.oasis-open.org|www.rfc-editor.org)\//,
    );
    assert(file.license);
    assert.equal(
      createHash('sha256')
        .update(await readFile(`${root}/${file.path}`))
        .digest('hex'),
      file.sha256,
      file.path,
    );
  }
});

void test('curated official draft-07 groups retain upstream expected valid flags', async (t) => {
  const manifest = JSON.parse(await readFile(`${root}/upstream-manifest.json`, 'utf8')) as {
    files: { path: string }[];
  };
  let cases = 0;
  for (const { path } of manifest.files.filter(
    ({ path }) => path.endsWith('.json') && path.startsWith('draft7/'),
  )) {
    const groups = JSON.parse(await readFile(`${root}/${path}`, 'utf8')) as {
      description: string;
      schema: JsonValue;
      tests: { description: string; data: JsonValue; valid: boolean }[];
    }[];
    // A fixed curated selection: the first upstream group in each named feature file.
    // Keep every test in that group. Other groups are preserved as source, not claimed as executed.
    const group =
      groups[path.endsWith('/if-then-else.json') ? 5 : path.endsWith('/ref.json') ? 1 : 0]!;
    await t.test(`${path}: ${group.description}`, () => {
      if (path.endsWith('/definitions.json')) {
        assert.throws(
          () => createSchemaRegistry([schemaArtifact(group.schema)]),
          /supported synchronous draft-07 profile/,
        );
        return;
      }
      const artifact = schemaArtifact(group.schema);
      const validator = createSchemaRegistry([artifact]).get(artifact);
      assert(validator);
      for (const vector of group.tests) {
        assert.equal(validator(vector.data) === undefined, vector.valid, vector.description);
        cases++;
      }
    });
  }
  assert.equal(cases, 181, 'The curated subset must execute every selected upstream case.');
  t.diagnostic(
    `${cases} unmodified official expected-valid flags executed across the curated feature groups.`,
  );
});

void test('safe schema admission explicitly excludes remote, recursive, async, format and unknown extensions', () => {
  for (const schema of [
    { $ref: 'https://example.com/remote' },
    { if: { const: 0 } },
    { $ref: '#' },
    { $async: true, type: 'string' },
    { format: 'email' },
    { $dynamicRef: '#' },
    { $recursiveRef: '#' },
    { properties: { a: { $id: 'nested', type: 'string' } } },
    { unknownExtension: true },
    { pattern: '(?<=a)b' },
  ])
    assert.throws(
      () => createSchemaRegistry([schemaArtifact(schema)]),
      /supported synchronous draft-07 profile/,
    );
  const artifact = schemaArtifact({
    definitions: { value: { type: 'string' } },
    properties: { a: { $ref: '#/definitions/value' } },
  });
  const validate = createSchemaRegistry([artifact]).get(artifact)!;
  assert.equal(validate({ a: 'ok' }), undefined);
  assert.equal(validate({ a: false }), '/a');
});

void test('YAML 1.2.2 core table, explicit JSON tags, directive and authored alias-key exclusion', async (t) => {
  // Authored from YAML 1.2.2 sections 10.3.2 and 6.9.1. These are fixed spec expectations.
  const vectors: [string, JsonValue][] = [
    ['null', null],
    ['Null', null],
    ['NULL', null],
    ['~', null],
    ['true', true],
    ['True', true],
    ['FALSE', false],
    ['false', false],
    ['0o14', 12],
    ['0xC', 12],
    ['+12', 12],
    ['-12', -12],
    ['12.', 12],
    ['.5', 0.5],
    ['1.2e+3', 1200],
    ['yes', 'yes'],
    ['ON', 'ON'],
    ['2001-12-15', '2001-12-15'],
    ['!!str 12', '12'],
    ['!!int 0o14', 12],
    ['!!float 1.5', 1.5],
    ['!!bool true', true],
    ['!!null null', null],
    ['!!seq [a, b]', ['a', 'b']],
    ['!!map {a: b}', { a: 'b' }],
    ['%YAML 1.2\n---\nvalue: true', { value: true }],
  ];
  for (const [text, expected] of vectors)
    await t.test(text, async () => {
      const snapshot = createSourceSnapshot({
        repository: 'spec',
        revision: 'yaml-1.2.2',
        files: [{ uri: URI, text }],
      });
      const report = await parseSourceSnapshot(snapshot, {
        mode: 'ci',
        deadlineAt: Date.now() + 5000,
      });
      assert.deepEqual(report.diagnostics, []);
      assert.equal(report.documents.length, 1);
      assert.deepEqual(report.documents[0]!.value, expected);
    });
  for (const [text, code] of [
    ['key: &a field\n*a : value\n', 'invalid_key'],
    ['!!timestamp 2001-12-15', 'unsupported_tag'],
    ['.inf', 'unsafe_number'],
    ['.nan', 'unsafe_number'],
    ['%YAML 1.1\n---\nvalue: true', 'unsupported_version'],
  ]) {
    const report = await parseSourceSnapshot(
      createSourceSnapshot({
        repository: 'spec',
        revision: '1',
        files: [{ uri: URI, text: text! }],
      }),
      { mode: 'ci', deadlineAt: Date.now() + 5000 },
    );
    assert.equal(report.documents.length, 0);
    assert.equal(report.diagnostics[0]?.code, code);
  }
});

void test('independent UTF-16 key order and ECMAScript number vectors preserve the declared canonical profile', () => {
  // RFC 8785 section 3.2.3 publishes this ordering. Safe integers deliberately restrict the numeric subset.
  assert.equal(
    canonicalJson({
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    }),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
  // ECMAScript Number::toString and RFC 8785 appendix B. Expected strings are literal source vectors.
  for (const [value, expected] of [
    [-0, '0'],
    [5e-324, '5e-324'],
    [-5e-324, '-5e-324'],
    [0.000001, '0.000001'],
    [0.0000009999999999999997, '9.999999999999997e-7'],
    [Number('333333333.33333329'), '333333333.3333333'],
    [4.5, '4.5'],
    [2e-3, '0.002'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
  ] as const)
    assert.equal(canonicalJson(value), expected);
  for (const value of [1e21, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])
    assert.throws(() => canonicalJson(value), /numbers must be finite and integers must be safe/);
});

void test('normal, incomplete and error SARIF satisfy the pinned OASIS draft-04 schema including formats', async () => {
  const validate = await sarifValidator();
  const request = makeRequest();
  const completed = createValidationResult({
    request,
    coverage: verifiedCoverage,
    completedAt: NOW + 1,
    authorityCheckedAt: NOW,
  });
  const incomplete = createValidationResult({
    request,
    coverage: [{ ...verifiedCoverage[0]!, status: 'blocked' }],
    completedAt: NOW + 1,
    authorityCheckedAt: NOW,
  });
  for (const report of [
    formatSarif(completed),
    formatSarif(incomplete),
    formatSarifError('input_error'),
  ]) {
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...report, version: '9.9.9' }), false);
    const bad = structuredClone(report);
    delete (bad.runs[0] as { tool?: unknown }).tool;
    assert.equal(validate(bad), false);
    const formatted = {
      ...report,
      $schema: 'https://example.com/schema',
      runs: [
        {
          ...report.runs[0],
          artifacts: [
            { location: { uri: 'src/catalog.yaml' }, lastModifiedTimeUtc: '2026-11-11T12:00:00Z' },
          ],
        },
      ],
    };
    assert.equal(validate(formatted), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...formatted, $schema: 'invalid uri' }), false);
    const invalidDate = structuredClone(formatted);
    invalidDate.runs[0]!.artifacts[0]!.lastModifiedTimeUtc = '2026-99-99';
    assert.equal(validate(invalidDate), false);
    const invalidRef = structuredClone(formatted);
    invalidRef.runs[0]!.artifacts[0]!.location.uri = 'bad uri';
    assert.equal(validate(invalidRef), false);
  }
});

void test('node:crypto independently signs and verifies literal-order release bytes with precise failure reasons', () => {
  const f = releaseFixture();
  // Independent canonicalizer for this fixture only: JSON data, finite safe numbers, plain records.
  // This code never calls canonicalJson or digestJson for the signing message.
  const external = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(external).join(',') + ']';
    if (value && typeof value === 'object')
      return (
        '{' +
        Object.keys(value)
          .sort()
          .map(
            (key) => JSON.stringify(key) + ':' + external((value as Record<string, unknown>)[key]),
          )
          .join(',') +
        '}'
      );
    return JSON.stringify(value);
  };
  const bytes = Buffer.from(external(f.payload));
  const key = createPublicKey(f.trust.keys[0]!.publicKey);
  assert.equal(verify(null, bytes, key, Buffer.from(f.release.signature.value, 'base64')), true);
  assert.equal(
    verify(
      null,
      Buffer.concat([bytes, Buffer.from(' ')]),
      key,
      Buffer.from(f.release.signature.value, 'base64'),
    ),
    false,
  );
  const independentlySigned = {
    ...f.payload,
    signature: {
      algorithm: 'ed25519',
      keyId: 'host-key-1',
      value: sign(null, bytes, f.privatePem).toString('base64'),
    },
  };
  assert.equal(
    verifyPolicyRelease(independentlySigned, f.trust, f.now).verification.keyId,
    'host-key-1',
  );
  assert.equal(digestJson(f.release), digestJson(independentlySigned));
});

void test('RFC 8032 section 7.1 Ed25519 empty-message signature is independently verified by node:crypto', async () => {
  const { ed25519: vector } = JSON.parse(
    await readFile(`${root}/independent-vectors.json`, 'utf8'),
  ) as { ed25519: { publicKeyHex: string; messageHex: string; signatureHex: string } };
  const publicKey = Buffer.from('302a300506032b6570032100' + vector.publicKeyHex, 'hex');
  const signature = Buffer.from(vector.signatureHex, 'hex');
  assert.equal(vector.messageHex, '');
  const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  assert.equal(verify(null, Buffer.alloc(0), key, signature), true);
  assert.equal(verify(null, Buffer.from('x'), key, signature), false);
  const changed = Buffer.from(signature);
  changed[0] = changed[0]! ^ 1;
  assert.equal(verify(null, Buffer.alloc(0), key, changed), false);
});
