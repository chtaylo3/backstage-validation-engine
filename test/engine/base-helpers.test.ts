import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bounded } from '../../src/base/async.js';
import { isRecord } from '../../src/base/json.js';
import { CapabilityError } from '../../src/capabilities/admission.js';

// The copies `bounded` and `isRecord` replaced, verbatim apart from their names. Every case below
// must behave the same with the shared helper as with each copy.
async function sessionCopy<T>(work: Promise<T>, remaining: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Session cleanup deadline exceeded.')),
          Math.max(0, remaining),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function capabilityCopy<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CapabilityError('cleanup')), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const nativeErrorsCopy = (value: unknown): value is Readonly<Record<string, unknown>> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const customSchemasCopy = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const shared = {
  session: <T>(work: Promise<T>, ms: number) =>
    bounded(work, ms, () => new Error('Session cleanup deadline exceeded.')),
  capability: <T>(work: Promise<T>, ms: number) =>
    bounded(work, ms, () => new CapabilityError('cleanup')),
};
const copies = { session: sessionCopy, capability: capabilityCopy };
const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
const never = () => new Promise<never>(() => {});
const settle = async <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({
      status: 'rejected' as const,
      type: (error as Error).constructor.name,
      message: (error as Error).message,
      code: error instanceof CapabilityError ? error.code : undefined,
    }),
  );

const cases: readonly { name: string; work: () => Promise<unknown>; ms: number }[] = [
  { name: 'work resolving before the limit', work: () => Promise.resolve('value'), ms: 1_000 },
  {
    name: 'work resolving after a delay before the limit',
    work: () => new Promise((resolve) => setTimeout(() => resolve(7), 5)),
    ms: 1_000,
  },
  { name: 'work that never settles', work: never, ms: 10 },
  {
    name: 'work rejecting before the limit',
    work: () => Promise.reject(new TypeError('work failed')),
    ms: 1_000,
  },
  { name: 'already settled work with a zero limit', work: () => Promise.resolve(0), ms: 0 },
  { name: 'already settled work with a negative limit', work: () => Promise.resolve(-1), ms: -50 },
  { name: 'pending work with a zero limit', work: never, ms: 0 },
  { name: 'pending work with a negative limit', work: never, ms: -50 },
];

for (const flavour of ['session', 'capability'] as const)
  for (const { name, work, ms } of cases)
    void test(`bounded (${flavour}): ${name} settles as the replaced copy did`, async () => {
      const before = timers();
      const expected = await settle(copies[flavour](work(), ms));
      assert.equal(timers(), before, 'the replaced copy cleared its timer');
      const actual = await settle(shared[flavour](work(), ms));
      assert.equal(timers(), before, 'the shared helper leaves no timer behind');
      assert.deepEqual(actual, expected);
    });

void test('bounded resolves with the value, rejects at the limit and propagates rejections', async () => {
  assert.equal(await bounded(Promise.resolve('value'), 1_000, () => new Error('late')), 'value');
  const marker = new Error('limit');
  await assert.rejects(
    bounded(never(), 5, () => marker),
    (error) => error === marker,
  );
  const failure = new TypeError('work failed');
  await assert.rejects(
    bounded(Promise.reject(failure), 1_000, () => new Error('late')),
    (error) => error === failure,
  );
});

void test('bounded calls the timeout factory only when the limit wins', async () => {
  let calls = 0;
  const timeout = () => {
    calls += 1;
    return new Error('limit');
  };
  await bounded(Promise.resolve(1), 1_000, timeout);
  await bounded(Promise.reject(new Error('work')), 1_000, timeout).catch(() => undefined);
  assert.equal(calls, 0);
  await bounded(never(), 0, timeout).catch(() => undefined);
  assert.equal(calls, 1);
});

void test('bounded clears its timer on every outcome', async () => {
  const before = timers();
  await bounded(Promise.resolve(1), 60_000, () => new Error('limit'));
  await bounded(Promise.reject(new Error('work')), 60_000, () => new Error('limit')).catch(
    () => undefined,
  );
  await bounded(never(), 1, () => new Error('limit')).catch(() => undefined);
  assert.equal(timers(), before);
});

class Instance {
  readonly field = 1;
}
const values: readonly [string, unknown, boolean][] = [
  ['plain object', { a: 1 }, true],
  ['empty object', {}, true],
  ['null-prototype object', Object.create(null) as object, true],
  ['class instance', new Instance(), true],
  ['boxed primitive', Object(1) as object, true],
  ['array', [1, 2], false],
  ['empty array', [], false],
  ['null', null, false],
  ['undefined', undefined, false],
  ['string', 'text', false],
  ['number', 0, false],
  ['boolean', false, false],
  ['bigint', 1n, false],
  ['symbol', Symbol('s'), false],
  ['function', () => undefined, false],
];

for (const [name, value, expected] of values)
  void test(`isRecord: ${name} matches both replaced copies`, () => {
    assert.equal(nativeErrorsCopy(value), expected);
    assert.equal(customSchemasCopy(value), expected);
    assert.equal(isRecord(value), expected);
  });
