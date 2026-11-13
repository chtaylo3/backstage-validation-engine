import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ContractError,
  canonicalJson,
  digestJson,
  digestText,
  immutableJson,
} from '../../src/index.js';

void test('canonical JSON has a fixed representation and known SHA-256', () => {
  assert.equal(canonicalJson({ z: [true, null, -0], a: 1.5 }), '{"a":1.5,"z":[true,null,0]}');
  assert.equal(digestJson({ b: 2, a: 1 }), digestJson({ a: 1, b: 2 }));
  assert.equal(
    digestText('abc'),
    'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.notEqual(digestJson({ value: null }), digestJson({}));
  assert.equal(
    canonicalJson(JSON.parse('{"__proto__":{"value":1}}') as unknown),
    '{"__proto__":{"value":1}}',
  );
});

void test('rejects values that would be silently changed by JSON.stringify', () => {
  const values: unknown[] = [
    undefined,
    NaN,
    Infinity,
    1n,
    () => true,
    new Date(),
    new Map(),
    /x/,
    Number.MAX_SAFE_INTEGER + 1,
    { a: undefined },
    [undefined],
    Array(2),
    Object.assign([1], { extra: true }),
    { [Symbol('hidden')]: 1 },
    Object.defineProperty({}, 'secret', { value: 1, enumerable: false }),
  ];
  for (const value of values) assert.throws(() => canonicalJson(value), ContractError);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cyclic JSON/);
});

void test('never invokes a getter or toJSON function while taking a snapshot', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      calls++;
      return 'secret';
    },
  });
  const hook = {
    toJSON() {
      calls++;
      return 'secret';
    },
  };
  assert.throws(() => immutableJson(getter), ContractError);
  assert.throws(() => immutableJson(hook), ContractError);
  assert.equal(calls, 0);
});

void test('immutable JSON detaches and recursively freezes caller data', () => {
  const input = { values: [{ value: 'original' }] };
  const snapshot = immutableJson(input);
  input.values[0]!.value = 'changed';
  assert.deepEqual(snapshot, { values: [{ value: 'original' }] });
  assert(Object.isFrozen(snapshot));
  assert(snapshot !== null && typeof snapshot === 'object' && 'values' in snapshot);
  assert(Object.isFrozen(snapshot.values));
  assert(!Object.isFrozen(input));
});

void test('enforces depth, value and serialized byte budgets', () => {
  let nested: unknown = null;
  for (let index = 0; index < 65; index++) nested = { value: nested };
  assert.throws(() => canonicalJson(nested), /budget exceeded/);
  assert.throws(
    () => canonicalJson(Array.from({ length: 100_001 }, () => null)),
    /array properties or length/,
  );
  assert.throws(() => canonicalJson('x'.repeat(32 * 1024 * 1024)), /exceeds 32 MiB/);
});
