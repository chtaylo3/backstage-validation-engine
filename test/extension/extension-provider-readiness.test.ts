import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readProvider,
  until,
  OBSERVATION_TIMEOUT_MS,
} from '../../extensions/vscode/test/readiness.js';

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

void test('repeated editor cancellations share one complete observation deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancellations = 0;
  const pending = readProvider(
    () => Promise.reject(cancelled()),
    'rule readiness',
    () => cancellations++,
  );
  const rejected = assert.rejects(pending, /Timed out: rule readiness/u);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancellations, 1);
  t.mock.timers.tick(OBSERVATION_TIMEOUT_MS - 1);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert(cancellations >= 2);
  t.mock.timers.tick(1);
  await rejected;
});
void test('an unsettled provider attempt cannot escape the total observation deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectLate!: (error: Error) => void;
  const pending = until(
    () =>
      new Promise<boolean>((_, reject) => {
        rejectLate = reject;
      }),
    'pending provider',
  );
  const rejected = assert.rejects(pending, /Timed out: pending provider/u);
  t.mock.timers.tick(OBSERVATION_TIMEOUT_MS);
  await rejected;
  rejectLate(new Error('Late rejected provider work remains observed.'));
  await Promise.resolve();
  await Promise.resolve();
});
