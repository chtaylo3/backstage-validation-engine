import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemClock } from '../../src/base/clock.js';
import { ManualClock } from '../harness/manual-clock.js';

void test('systemClock wall time tracks Date.now and monotonic time never decreases', () => {
  const before = Date.now();
  const wall = systemClock.wall();
  const after = Date.now();
  assert(before <= wall && wall <= after, `${before} <= ${wall} <= ${after}`);
  let previous = systemClock.monotonic();
  for (let index = 0; index < 1000; index++) {
    const current = systemClock.monotonic();
    assert(current >= previous, `${current} >= ${previous}`);
    previous = current;
  }
  assert(Object.isFrozen(systemClock));
});

void test('the manual clock advances wall and monotonic time together and rejects negative steps', () => {
  const clock = new ManualClock(5000, 20);
  assert.deepEqual([clock.wall(), clock.monotonic()], [5000, 20]);
  clock.advance(0);
  clock.advance(15);
  assert.deepEqual([clock.wall(), clock.monotonic()], [5015, 35]);
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.advance(Number.NaN), RangeError);
  assert.deepEqual([clock.wall(), clock.monotonic()], [5015, 35]);
});

void test('the manual clock steps wall time forward or backward without moving monotonic time', () => {
  const clock = new ManualClock(5000, 20);
  clock.set(9000);
  assert.deepEqual([clock.wall(), clock.monotonic()], [9000, 20]);
  clock.set(1000);
  assert.deepEqual([clock.wall(), clock.monotonic()], [1000, 20]);
  clock.advance(5);
  assert.deepEqual([clock.wall(), clock.monotonic()], [1005, 25]);
  assert.throws(() => clock.set(Number.POSITIVE_INFINITY), RangeError);
});
