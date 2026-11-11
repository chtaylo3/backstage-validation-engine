import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Environment } from '@marcbachmann/cel-js';
import { RE2JS } from 're2js';
import {
  CEL_LIMITS,
  CelError,
  ContractError,
  canonicalJson,
  createSourceSnapshot,
  parseContract,
  parseSourceSnapshot,
  signPolicyRelease,
  verifyPolicyRelease,
  resolvePolicyBundles,
  digestJson,
} from '../src/index.js';
import { createCelEvaluator } from '../src/runtime/cel/evaluator.js';
import { snapshotCelInput } from '../src/runtime/cel/input.js';
import { releaseFixture } from './harness/release-fixture.js';
import { URI, makeContext } from './helpers.js';

const celCode = (code: string) => (error: unknown) =>
  error instanceof CelError && error.code === code;
const contractCode = (code: string) => (error: unknown) =>
  error instanceof ContractError && error.code === code;
const source = (text: string) =>
  createSourceSnapshot({ repository: 'limits', revision: '1', files: [{ uri: URI, text }] });
const parse = (text: string) =>
  parseSourceSnapshot(source(text), { mode: 'ci', deadlineAt: Date.now() + 5000 });

void test('default CEL character, UTF-8 byte, value, depth and pattern ceilings admit the exact boundary', () => {
  const evaluate = createCelEvaluator();
  assert.equal(evaluate('true' + ' '.repeat(4092), {}), true);
  assert.throws(() => evaluate('true' + ' '.repeat(4093), {}), celCode('input_limit'));
  assert.equal(snapshotCelInput('true', { x: 'a'.repeat(65536) }) !== undefined, true);
  assert.throws(() => snapshotCelInput('true', { x: 'a'.repeat(65537) }), celCode('input_limit'));
  const byteInput = (extra: string) => ({
    a: 'é'.repeat(32768),
    b: 'é'.repeat(32768),
    c: 'é'.repeat(32768),
    d: 'é'.repeat(32753) + 'a' + extra,
  });
  assert.equal(Buffer.byteLength(JSON.stringify(byteInput(''))), 262144);
  assert.doesNotThrow(() => snapshotCelInput('true', byteInput('')));
  assert.throws(() => snapshotCelInput('true', byteInput('a')), celCode('input_limit'));
  assert.doesNotThrow(() => snapshotCelInput('true', Array(9999).fill(null)));
  assert.throws(() => snapshotCelInput('true', Array(10000).fill(null)), celCode('input_limit'));
  const nested = (depth: number) => {
    let value: unknown = null;
    for (let n = 0; n < depth; n++) value = [value];
    return value;
  };
  assert.doesNotThrow(() => snapshotCelInput('true', nested(64)));
  assert.throws(() => snapshotCelInput('true', nested(65)), celCode('input_limit'));
  assert.equal(
    evaluate('entity.text.matches(entity.pattern)', { text: 'a', pattern: 'a' + ' '.repeat(511) }),
    false,
  );
  assert.throws(
    () =>
      evaluate('entity.text.matches(entity.pattern)', {
        text: 'a',
        pattern: 'a' + ' '.repeat(512),
      }),
    celCode('regex_limit'),
  );
});

void test('default CEL structural bounds are reachable or rejected by an explicitly earlier bound', () => {
  const evaluate = createCelEvaluator();
  const list = (count: number) => '[' + Array(count).fill('0').join(',') + '].size() == ' + count;
  assert.equal(evaluate(list(1000), {}), true);
  assert.throws(() => evaluate(list(1001), {}), celCode('parse'));
  assert.equal(evaluate('!'.repeat(64) + 'true', {}), true);
  assert.throws(() => evaluate('!'.repeat(65) + 'true', {}), celCode('parse'));
  // Parenthesized expressions consume recursive parser depth. The top-level expression consumes one frame.
  assert.equal(evaluate('('.repeat(63) + 'true' + ')'.repeat(63), {}), true);
  assert.throws(() => evaluate('('.repeat(64) + 'true' + ')'.repeat(64), {}), celCode('parse'));
  // size with many args reaches the structural parser before overload checking.
  // At 32 args syntax is admitted and the unsupported overload is an evaluation error.
  assert.throws(
    () => evaluate('size(' + Array(32).fill('0').join(',') + ') == 0', {}),
    celCode('evaluation'),
  );
  assert.throws(
    () => evaluate('size(' + Array(33).fill('0').join(',') + ') == 0', {}),
    celCode('parse'),
  );
  // Each authored AST node needs at least one character. 4,097 nodes cannot fit in 4,096 chars.
  // Actual AST depth admission precedes interpreter evaluation.
  assert.equal(evaluate('!'.repeat(64) + 'true', {}), true);
  assert.doesNotThrow(() => snapshotCelInput('!'.repeat(4095) + '0', {}));
  assert.throws(() => evaluate('!'.repeat(4096) + '0', {}), celCode('input_limit'));
  // A map with 1,000 distinct keys needs more than 4,096 chars even with empty-string values.
  const map = '{' + Array.from({ length: 1000 }, (_, n) => `${n}:0`).join(',') + '}.size() == 1000';
  assert(map.length > 4096);
  assert.throws(() => evaluate(map, {}), celCode('input_limit'));
});

void test('more than 256 program and RE2 patterns clear bounded caches and recompile correct answers', (t) => {
  const parseSpy = t.mock.method(Environment.prototype, 'parse');
  const regexSpy = t.mock.method(RE2JS, 'compile');
  const evaluate = createCelEvaluator();
  for (let n = 0; n < 256; n++) assert.equal(evaluate(`${n} == ${n}`, {}), true);
  assert.equal(parseSpy.mock.callCount(), 256);
  assert.equal(evaluate('0 == 0', {}), true);
  assert.equal(parseSpy.mock.callCount(), 256, 'A hit within the ceiling must reuse compilation.');
  assert.equal(evaluate('256 == 256', {}), true);
  assert.equal(evaluate('0 == 0', {}), true);
  assert.equal(
    parseSpy.mock.callCount(),
    258,
    'The oldest program recompiles after ceiling clearing.',
  );
  const regex = 'entity.text.matches(entity.pattern)';
  for (let n = 0; n < 256; n++)
    assert.equal(evaluate(regex, { text: `token-${n}`, pattern: `^token-${n}$` }), true);
  assert.equal(regexSpy.mock.callCount(), 256);
  assert.equal(evaluate(regex, { text: 'wrong', pattern: '^token-0$' }), false);
  assert.equal(regexSpy.mock.callCount(), 256);
  assert.equal(evaluate(regex, { text: 'token-256', pattern: '^token-256$' }), true);
  assert.equal(evaluate(regex, { text: 'wrong', pattern: '^token-0$' }), false);
  assert.equal(regexSpy.mock.callCount(), 258);
  for (let n = 257; n < 800; n++) {
    assert.equal(evaluate(`${n} != ${n}`, {}), false);
    assert.equal(evaluate(regex, { text: 'wrong', pattern: `^token-${n}$` }), false);
  }
  const before = regexSpy.mock.callCount();
  assert.equal(evaluate(regex, { text: 'token-0', pattern: '^token-0$' }), true);
  assert.equal(regexSpy.mock.callCount(), before + 1);
  assert.equal(CEL_LIMITS.cacheEntries, 256);
});

void test('snapshot UTF-8 file and aggregate source limits admit exact bytes and reject plus one', () => {
  const file = 'é'.repeat(524288);
  assert.equal(Buffer.byteLength(file), 1048576);
  assert.doesNotThrow(() => source(file));
  assert.throws(() => source(file + 'a'), contractCode('limit'));
  const files = Array.from({ length: 16 }, (_, n) => ({
    uri: `file:///workspace/${n}.yaml`,
    text: file,
  }));
  assert.equal(
    createSourceSnapshot({ repository: 'limits', revision: '1', files }).files.length,
    16,
  );
  assert.throws(
    () =>
      createSourceSnapshot({
        repository: 'limits',
        revision: '1',
        files: [...files, { uri: 'file:///workspace/extra.yaml', text: 'a' }],
      }),
    contractCode('limit'),
  );
});

void test('canonical JSON defaults admit exact value, depth and UTF-8 boundaries', () => {
  assert.doesNotThrow(() => canonicalJson(Array(99999).fill(null)));
  assert.throws(() => canonicalJson(Array(100000).fill(null)), contractCode('limit'));
  let nested: unknown = null;
  for (let n = 0; n < 64; n++) nested = [nested];
  assert.doesNotThrow(() => canonicalJson(nested));
  assert.throws(() => canonicalJson([nested]), contractCode('limit'));
  const at = 'é'.repeat((32 * 1024 * 1024 - 2) / 2);
  assert.equal(Buffer.byteLength(canonicalJson(at)), 32 * 1024 * 1024);
  assert.throws(() => canonicalJson(at + 'a'), contractCode('limit'));
});

void test('parser default file, document, alias, depth and expanded document boundaries', async () => {
  const exactRaw = '#' + 'é'.repeat(524287) + 'a';
  assert.equal(Buffer.byteLength(exactRaw), 1048576);
  assert.equal((await parse(exactRaw)).files[0]?.status, 'parsed');
  assert.throws(() => source(exactRaw + 'a'), contractCode('limit'));
  const files = (count: number) =>
    createSourceSnapshot({
      repository: 'limits',
      revision: '1',
      files: Array.from({ length: count }, (_, n) => ({
        uri: `file:///workspace/${String(n).padStart(4, '0')}.yaml`,
        text: '',
      })),
    });
  const admitted = await parseSourceSnapshot(files(1000), {
    mode: 'ci',
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(admitted.files.length, 1000);
  assert(admitted.files.every((row) => row.status === 'parsed'));
  const rejected = await parseSourceSnapshot(files(1001), {
    mode: 'ci',
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(rejected.diagnostics[0]?.code, 'resource_limit');
  assert.equal(rejected.files[0]?.status, 'incomplete');
  assert.equal((await parse('---\nnull\n'.repeat(1000))).documents.length, 1000);
  const overDocs = await parse('---\nnull\n'.repeat(1001));
  assert.equal(overDocs.interrupted, 'resource_limit');
  const aliases = (n: number) => 'a: &a 0\nb: [' + Array(n).fill('*a').join(',') + ']';
  assert.equal((await parse(aliases(50))).files[0]?.status, 'parsed');
  assert.equal((await parse(aliases(51))).diagnostics[0]?.code, 'resource_limit');
  assert.equal((await parse('['.repeat(64) + '0' + ']'.repeat(64))).files[0]?.status, 'parsed');
  assert.equal(
    (await parse('['.repeat(65) + '0' + ']'.repeat(65))).diagnostics[0]?.code,
    'resource_limit',
  );
  // Authored control characters use one source byte and six canonical JSON bytes.
  const expanded = (n: number, suffix = '') => '"' + '\\u0001'.repeat(n) + suffix + '"';
  // Raw byte ceiling binds first for escaped controls. Aliases permit expansion at the document ceiling.
  assert.throws(() => source(expanded(174763)), contractCode('limit'));
  const base = 'x'.repeat(65534);
  // [anchor plus 15 aliases] = 16*(65534+2) +15 commas+2 brackets = 1,048,593, so trim 17 bytes via last literal.
  const document = (last: number) =>
    '[&a "' + base + '",' + Array(14).fill('*a').join(',') + ',"' + 'x'.repeat(last) + '"]';
  assert.equal(
    Buffer.byteLength(JSON.stringify(Array(15).fill(base).concat('x'.repeat(65517)))),
    1048576,
  );
  assert.equal((await parse(document(65517))).files[0]?.status, 'parsed');
  assert.equal((await parse(document(65518))).diagnostics[0]?.code, 'resource_limit');
});

void test('release default 2 MiB, bundle count/depth and seven-day host authority boundaries', () => {
  const f = releaseFixture({ rules: [] });
  const sevenDays = 604800000;
  const trust = parseContract('policy-trust', { ...f.trust, maxAgeMs: sevenDays });
  assert.throws(
    () => parseContract('policy-trust', { ...f.trust, maxAgeMs: sevenDays + 1 }),
    contractCode('invalid_contract'),
  );
  const release = signPolicyRelease(
    { ...f.payload, expiresAt: f.now + sevenDays + 1 },
    f.privatePem,
    'host-key-1',
  );
  assert.equal(
    verifyPolicyRelease(release, trust, f.now + sevenDays - 1).verification.expiresAt,
    f.now + sevenDays,
  );
  assert.throws(
    () => verifyPolicyRelease(release, trust, f.now + sevenDays),
    /trusted validity window/,
  );
  // A valid long profile label pads the signed release without changing bundle or schema ceilings.
  const padded = (padding: number) => {
    const profile = { ...f.payload.profile, id: 'x'.repeat(padding) };
    return signPolicyRelease(
      {
        ...f.payload,
        profile,
        activation: { ...f.payload.activation, profileDigest: digestJson(profile) },
      },
      f.privatePem,
      'host-key-1',
    );
  };
  const overhead = Buffer.byteLength(JSON.stringify(padded(1))) - 1;
  const at = padded(2097152 - overhead);
  assert.equal(Buffer.byteLength(JSON.stringify(at)), 2097152);
  assert.equal(verifyPolicyRelease(at, f.trust, f.now).verification.keyId, 'host-key-1');
  assert.throws(
    () => verifyPolicyRelease(padded(2097153 - overhead), f.trust, f.now),
    contractCode('limit'),
  );
  const base = makeContext().policy;
  const bundles = Array.from({ length: 64 }, (_, n) => ({ ...base, id: `bundle-${n}`, rules: [] }));
  const root = { ...bundles[0]!, extends: bundles.slice(1).map(digestJson) };
  assert.equal(
    resolvePolicyBundles(digestJson(root), [root, ...bundles.slice(1)], [digestJson(root)])
      .closureDigests.length,
    64,
  );
  assert.throws(
    () => resolvePolicyBundles(digestJson(root), [...bundles, { ...base, id: 'extra' }], []),
    contractCode('limit'),
  );
  const chain = [{ ...base, rules: [] }];
  for (let n = 1; n < 17; n++)
    chain.push({ ...base, id: `depth-${n}`, rules: [], extends: [digestJson(chain.at(-1))] });
  assert.equal(
    resolvePolicyBundles(digestJson(chain[15]), chain.slice(0, 16), []).closureDigests.length,
    16,
  );
  assert.throws(
    () => resolvePolicyBundles(digestJson(chain[16]), chain, []),
    /inheritance depth exceeded/,
  );
});

void test('parser default lexical tokens and syntax nodes use exact attainable controls', async () => {
  // Each comment and newline contributes one lexical token. No syntax/value bound competes here.
  const tokens = '#\n'.repeat(100000);
  assert.equal((await parse(tokens)).files[0]?.status, 'parsed');
  assert.equal((await parse(tokens + '#')).diagnostics[0]?.code, 'resource_limit');
  // A stream marker, brackets, 99,999 quoted scalars and 99,998 commas give exactly 200,000 tokens.
  // The root sequence plus its scalars give exactly 100,000 syntax and expanded value nodes.
  const syntax = '[' + Array(99999).fill('""').join(',') + ']';
  const admitted = await parse(syntax);
  assert.equal(admitted.files[0]?.status, 'parsed');
  assert.equal((admitted.documents[0]?.value as readonly unknown[]).length, 99999);
  const rejected = await parse('[' + Array(100000).fill('""').join(',') + ']');
  assert.equal(rejected.interrupted, 'resource_limit');
  // The 200,001st lexical token rejects this candidate before CST syntax-node admission.
  // A larger syntax ceiling cannot make it admissible under the unchanged token ceiling.
  assert.equal(rejected.diagnostics[0]?.code, 'resource_limit');
});

void test('parser default expanded value ceiling binds independently of authored nodes and alias visits', async () => {
  const values = (last: number) =>
    '[&a [' +
    Array(1999).fill('""').join(',') +
    '],' +
    Array(48).fill('*a').join(',') +
    ',[' +
    Array(last).fill('""').join(',') +
    ']]';
  // Root 1 + anchor 2,000 + 48 expanded aliases*2,000 + final array 1,999 = 100,000 values.
  const admitted = await parse(values(1998));
  assert.equal(admitted.files[0]?.status, 'parsed');
  assert.equal((admitted.documents[0]?.value as readonly unknown[]).length, 50);
  const rejected = await parse(values(1999));
  assert.equal(rejected.interrupted, 'resource_limit');
  assert.equal(rejected.diagnostics[0]?.code, 'resource_limit');
});

void test('parser default aggregate expanded bytes bind at 16 MiB independently of raw source bytes', async () => {
  const base = 'x'.repeat(65534);
  const document = (last: number) =>
    '[&a "' + base + '",' + Array(14).fill('*a').join(',') + ',"' + 'x'.repeat(last) + '"]';
  const snapshot = (extra: number) =>
    createSourceSnapshot({
      repository: 'limits',
      revision: '1',
      files: Array.from({ length: 17 }, (_, n) => ({
        uri: `file:///workspace/${String(n).padStart(2, '0')}.yaml`,
        text: n < 15 ? document(65517) : n === 15 ? document(65515) : '"' + 'x'.repeat(extra) + '"',
      })),
    });
  // 15*1 MiB + (1 MiB-2) + an empty string's 2 canonical bytes = exactly 16 MiB.
  const admitted = await parseSourceSnapshot(snapshot(0), {
    mode: 'ci',
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(admitted.interrupted, 'none');
  assert.equal(admitted.documents.length, 17);
  const rejected = await parseSourceSnapshot(snapshot(1), {
    mode: 'ci',
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(rejected.interrupted, 'resource_limit');
  assert.equal(rejected.files[16]?.status, 'incomplete');
  assert.equal(rejected.diagnostics[0]?.code, 'resource_limit');
});

void test('parser diagnostic quota reaches 1000 and the document ceiling binds before a 1001st one-error document', async () => {
  const at = await parse('---\n!!timestamp 2026-01-01\n'.repeat(1000));
  assert.equal(at.diagnostics.length, 1000);
  assert(at.diagnostics.every((row) => row.code === 'unsupported_tag'));
  assert.equal(at.interrupted, 'none');
  const over = await parse('---\n!!timestamp 2026-01-01\n'.repeat(1001));
  assert.equal(
    over.diagnostics.length,
    1000,
    'The terminal resource diagnostic replaces the final row without silent truncation.',
  );
  assert.equal(over.diagnostics.at(-1)?.code, 'resource_limit');
  assert.equal(over.interrupted, 'resource_limit');
});

void test('parser diagnostic default quota rejects the 1001st diagnostic within one document', async () => {
  const input = (count: number) =>
    '[' + Array(count).fill('!!timestamp 2026-01-01').join(',') + ']';
  const at = await parse(input(1000));
  assert.equal(at.diagnostics.length, 1000);
  assert(at.diagnostics.every((row) => row.code === 'unsupported_tag'));
  assert.equal(at.interrupted, 'none');
  assert.equal(at.files[0]?.status, 'invalid');
  const over = await parse(input(1001));
  assert.equal(over.diagnostics.length, 1000);
  assert.equal(over.diagnostics.at(-1)?.code, 'resource_limit');
  assert.equal(over.interrupted, 'resource_limit');
});
