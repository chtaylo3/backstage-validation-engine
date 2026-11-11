import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProvider } from '../extensions/vscode/test/readiness.js';

const cancelled = () => Object.assign(new Error('Canceled'), { name: 'Canceled' });

void test('provider readiness requires a completed read after editor cancellation', async () => {
  let calls = 0;
  let cancellations = 0;
  const expected = { items: [{ label: 'remote-team' }] };
  const result = await readProvider(
    () => (++calls === 1 ? Promise.reject(cancelled()) : Promise.resolve(expected)),
    'completion',
    () => cancellations++,
  );
  assert.deepEqual(result, expected);
  assert.equal(calls, 2);
  assert.equal(cancellations, 1);
});

void test('a cancelled provider read cannot prove an absent candidate', async () => {
  let calls = 0;
  const result = await readProvider(
    () => (++calls === 1 ? Promise.reject(cancelled()) : Promise.resolve(['remote-refresh'])),
    'candidate removal',
    () => {},
  );
  assert.equal(result.includes('remote-refresh'), true);
  assert.equal(calls, 2);
  assert.deepEqual(
    await readProvider(
      () => Promise.resolve([]),
      'empty result',
      () => {},
    ),
    [],
  );
});

void test('provider readiness propagates failures that are not editor cancellation', async () => {
  const failure = new Error('Provider failed.');
  let calls = 0;
  await assert.rejects(
    readProvider(
      () => {
        calls++;
        return Promise.reject(failure);
      },
      'hover',
      () => assert.fail('Only cancellation can be retried.'),
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

void test('repeated editor cancellation fails at the existing readiness deadline', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let cancellations = 0;
  await assert.rejects(
    readProvider(
      () => Promise.reject(cancelled()),
      'rule readiness',
      () => {
        cancellations++;
        now = 20_000;
      },
    ),
    /Timed out: rule readiness/u,
  );
  assert.equal(cancellations, 1);
});
