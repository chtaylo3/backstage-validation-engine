import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kind, Type } from '@sinclair/typebox';
import { count, digest, object, text } from '../../src/contracts/schema-kit.js';

/** Serialized key order matters for `schemas/`, so compare JSON text and the TypeBox kind. */
const same = (actual: object, literal: object, kind: string) => {
  assert.equal(JSON.stringify(actual), JSON.stringify(literal));
  assert.equal((actual as Record<symbol, unknown>)[Kind], kind);
};

// The expected literals are what the local builders produced before they moved into the kit.
void test('object equals the former contracts and capabilities `object` builder', () => {
  same(
    object({ a: Type.String(), b: Type.Optional(Type.Integer()) }),
    {
      additionalProperties: false,
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
    },
    'Object',
  );
});

void test('text() equals the former contracts `text()`: no maximum length', () => {
  same(text(), { minLength: 1, type: 'string' }, 'String');
});

void test('text(maximum) equals the former capabilities, editor artifact and config builders', () => {
  // capabilities `text()` and the LSP and host catalog config `text` constants: 4096.
  same(text(4096), { minLength: 1, maxLength: 4096, type: 'string' }, 'String');
  // capabilities `text(128)` and editor artifact `text(63)`.
  same(text(128), { minLength: 1, maxLength: 128, type: 'string' }, 'String');
  same(text(63), { minLength: 1, maxLength: 63, type: 'string' }, 'String');
});

void test('count equals the former contracts and capabilities `count()`', () => {
  same(count(), { minimum: 0, maximum: 9007199254740991, type: 'integer' }, 'Integer');
});

void test('digest equals the former contracts, capabilities and editor artifact `digest`', () => {
  same(digest(), { pattern: '^sha256:[a-f0-9]{64}$', type: 'string' }, 'String');
});

void test('each builder call returns a new schema object', () => {
  assert.notEqual(text(4096), text(4096));
  assert.notEqual(digest(), digest());
  assert.notEqual(count(), count());
});
