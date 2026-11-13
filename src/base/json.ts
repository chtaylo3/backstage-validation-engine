import { createHash } from 'node:crypto';
import { reject } from './errors.js';

/**
 * Structural JSON value. `contracts/schemas.ts` derives the same type from `JsonValueSchema` and
 * checks at compile time that the two stay mutually assignable.
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Immutable<T> = T extends readonly (infer U)[]
  ? readonly Immutable<U>[]
  : T extends object
    ? { readonly [K in keyof T]: Immutable<T[K]> }
    : T;

const MAX_DEPTH = 64;
const MAX_VALUES = 100_000;
const MAX_BYTES = 32 * 1024 * 1024;

export interface JsonLimits {
  readonly maxDepth?: number;
  readonly maxValues?: number;
  readonly maxBytes?: number;
  readonly maxStringChars?: number;
}

/**
 * Project canonical JSON: sorted UTF-16 keys and ECMAScript JSON scalars.
 * Rejects unsafe integers, non-finite numbers, accessors, cycles, sparse arrays,
 * and non-JSON objects without invoking getters or toJSON hooks. Not RFC 8785.
 */
export function canonicalJson(value: unknown, limits: JsonLimits = {}): string {
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const maxValues = limits.maxValues ?? MAX_VALUES;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const maxStringChars = limits.maxStringChars ?? MAX_BYTES;
  for (const [limit, ceiling] of [
    [maxDepth, MAX_DEPTH],
    [maxValues, MAX_VALUES],
    [maxBytes, MAX_BYTES],
    [maxStringChars, MAX_BYTES],
  ]) {
    if (
      limit === undefined ||
      ceiling === undefined ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > ceiling
    ) {
      throw new RangeError('JSON limits may only lower the admission ceilings');
    }
  }
  const ancestors = new Set<object>();
  let values = 0;
  let bytes = 0;
  const append = (part: string): string => {
    bytes += Buffer.byteLength(part, 'utf8');
    if (bytes > maxBytes)
      reject(
        'limit',
        '',
        maxBytes === MAX_BYTES
          ? 'canonical JSON exceeds 32 MiB'
          : 'canonical JSON exceeds byte budget',
      );
    return part;
  };
  const visit = (current: unknown, depth: number): string => {
    if (++values > maxValues || depth > maxDepth) {
      reject('limit', '', 'JSON depth or value budget exceeded');
    }
    if (current === null) return append('null');
    if (typeof current === 'string' || typeof current === 'boolean') {
      if (
        typeof current === 'string' &&
        (current.length > maxStringChars || current.length > maxBytes)
      ) {
        reject('limit', '', 'JSON string exceeds byte or character budget');
      }
      return append(JSON.stringify(current));
    }
    if (typeof current === 'number') {
      if (
        !Number.isFinite(current) ||
        (Number.isInteger(current) && !Number.isSafeInteger(current))
      ) {
        reject('invalid_json', '', 'numbers must be finite and integers must be safe');
      }
      return append(JSON.stringify(current));
    }
    if (typeof current !== 'object') reject('invalid_json', '', 'only JSON values are accepted');
    if (ancestors.has(current)) reject('invalid_json', '', 'cyclic JSON is not accepted');
    const array = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      !(prototype === null && !array)
    ) {
      reject('invalid_json', '', 'only plain JSON objects and arrays are accepted');
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Object.getOwnPropertySymbols(current).length > 0) {
      reject('invalid_json', '', 'symbol properties are not accepted');
    }
    ancestors.add(current);
    const read = (key: string): unknown => {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        reject(
          'invalid_json',
          '',
          'accessors, sparse arrays and hidden properties are not accepted',
        );
      }
      return descriptor.value as unknown;
    };
    let result: string;
    if (array) {
      const length = (descriptors.length?.value ?? 0) as number;
      if (length > maxValues) {
        reject('limit', '', 'array properties or length exceed the JSON profile');
      }
      if (Object.keys(descriptors).length !== length + 1) {
        reject('invalid_json', '', 'array properties or length exceed the JSON profile');
      }
      append('[');
      const entries: string[] = [];
      for (let index = 0; index < length; index++) {
        if (index > 0) append(',');
        entries.push(visit(read(String(index)), depth + 1));
      }
      result = `[${entries.join(',')}${append(']')}`;
    } else {
      append('{');
      const entries = Object.keys(descriptors)
        .sort()
        .map((key, index) => {
          if (key.length > maxStringChars || key.length > maxBytes)
            reject('limit', '', 'JSON key exceeds character budget');
          if (index > 0) append(',');
          return `${append(JSON.stringify(key))}${append(':')}${visit(read(key), depth + 1)}`;
        });
      result = `{${entries.join(',')}${append('}')}`;
    }
    ancestors.delete(current);
    return result;
  };
  return visit(value, 0);
}

export function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function digestJson(value: unknown): string {
  return digestText(canonicalJson(value));
}

export function deepFreeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

/** Copies before freezing, so caller-owned input remains untouched. */
export function immutableJson(value: unknown): Immutable<JsonValue> {
  const copy = JSON.parse(canonicalJson(value)) as JsonValue;
  return deepFreeze(copy);
}
