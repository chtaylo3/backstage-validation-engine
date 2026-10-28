import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  CEL_LIMITS,
  CelError,
  RequestBudget,
  closeSharedCelRuntime,
  getSharedCelRuntime,
  digestText,
} from '../src/index.js';
import type { EvaluationContext } from '../src/index.js';
import { ManagedCelPool } from '../src/runtime/cel/pool.js';
import { snapshotCelInput } from '../src/runtime/cel/input.js';

const workerUrl = new URL('./fixtures/cel-worker.js', import.meta.url);
const context = (requestId = 'test-request', milliseconds = 5000): EvaluationContext => ({
  requestId,
  deadlineAt: Date.now() + milliseconds,
});
const errorCode =
  (expected: string) =>
  (error: unknown): boolean => {
    assert(error instanceof CelError);
    assert.equal(error.code, expected);
    assert(!error.message.includes('SENSITIVE'));
    return true;
  };
const expensive =
  'entity.spec.items.all(x, entity.spec.items.all(y, entity.spec.items.all(z, x == z || x != z)))';
const expensiveEntity = { spec: { items: Array.from({ length: 1000 }, (_, index) => index) } };

void test(
  'frozen CEL profile semantics pass through real production workers',
  { timeout: 15_000 },
  async (t) => {
    const source = await readFile('test/fixtures/cel-qualification.json', 'utf8');
    assert.equal(
      digestText(source),
      'sha256:5dbcd903f3caaff62067c4c99e0f04e21d980c53827825536fba4176a74d4fc1',
    );
    const fixtures = JSON.parse(source) as {
      name: string;
      expression: string;
      entity: unknown;
      expected: boolean | 'error';
    }[];
    const pool = new ManagedCelPool();
    try {
      await pool.warm();
      assert.equal(fixtures.length, 43);
      for (const fixture of fixtures) {
        await t.test(fixture.name, async () => {
          const result = pool.evaluate(fixture.expression, fixture.entity, context('frozen'));
          if (fixture.expected === 'error') await assert.rejects(result, CelError);
          else assert.equal(await result, fixture.expected);
        });
      }
      assert.equal(pool.stats().workerStarts, 2);
    } finally {
      await pool.close();
    }
  },
);

void test('CEL admission rejects oversized and non-JSON input without invoking callbacks', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const toJSON = {
    toJSON() {
      calls++;
      return {};
    },
  };
  const invalid = [
    getter,
    toJSON,
    { x: undefined },
    { x: NaN },
    [1n],
    Array(2),
    new Date(),
    Object.assign([1], { extra: 1 }),
    { [Symbol('x')]: 1 },
  ];
  for (const value of invalid)
    assert.throws(() => snapshotCelInput('true', value), errorCode('input_type'));
  for (const value of [
    { x: 'a'.repeat(65_537) },
    { ['x'.repeat(65_537)]: true },
    { x: Array.from({ length: 10_001 }, () => 1) },
    { x: Array.from({ length: 8 }, () => 'a'.repeat(40_000)) },
  ])
    assert.throws(() => snapshotCelInput('true', value), errorCode('input_limit'));
  let nested: unknown = null;
  for (let index = 0; index < 65; index++) nested = { x: nested };
  assert.throws(() => snapshotCelInput('true', nested), errorCode('input_limit'));
  assert.throws(() => snapshotCelInput(' '.repeat(4097), {}), errorCode('input_limit'));
  assert.equal(calls, 0);
});

void test('RE2 resource failures cannot be masked and catastrophic-shaped patterns stay bounded', async () => {
  const pool = new ManagedCelPool();
  try {
    await pool.warm();
    await assert.rejects(
      pool.evaluate(
        'entity.text.matches(entity.pattern) || true',
        { text: 'a', pattern: 'a'.repeat(513) },
        context(),
      ),
      errorCode('regex_limit'),
    );
    const expression = 'entity.text.matches("(a+)+$")';
    await pool.evaluate(expression, { text: 'a!' }, context());
    assert.equal(
      await pool.evaluate(expression, { text: 'a'.repeat(60_000) + '!' }, context()),
      false,
    );
    assert.equal(await pool.evaluate('true', {}, context()), true);
  } finally {
    await pool.close();
  }
});

void test(
  'real expensive CEL times out while the parent stays responsive, then recovers',
  { timeout: 10_000 },
  async () => {
    const pool = new ManagedCelPool();
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 5);
    try {
      await pool.warm();
      await assert.rejects(
        pool.evaluate(expensive, expensiveEntity, context()),
        errorCode('execution_timeout'),
      );
      assert(heartbeats > 0);
      assert.equal(await pool.evaluate('true', {}, context()), true);
      assert(pool.stats().workerStarts >= 3);
    } finally {
      clearInterval(heartbeat);
      await pool.close();
    }
  },
);

void test('active cancellation terminates a busy interpreter and the next call succeeds', async () => {
  const pool = new ManagedCelPool();
  const controller = new AbortController();
  try {
    await pool.warm();
    const evaluation = pool.evaluate(expensive, expensiveEntity, {
      ...context(),
      signal: controller.signal,
    });
    const rejected = assert.rejects(evaluation, errorCode('cancelled'));
    setTimeout(() => controller.abort('SENSITIVE USER REASON'), 15);
    await rejected;
    assert.equal(await pool.evaluate('true', {}, context()), true);
    await assert.rejects(
      pool.evaluate('true', {}, { ...context(), signal: controller.signal }),
      errorCode('cancelled'),
    );
  } finally {
    await pool.close();
  }
});

void test('global admission counts active and queued jobs and snapshots input at enqueue', async () => {
  const pool = new ManagedCelPool({ workerUrl });
  try {
    await pool.warm();
    const jobs = Array.from({ length: 64 }, () => pool.evaluate('delay:4', {}, context('bulk')));
    assert.equal(pool.stats().pending, CEL_LIMITS.pending);
    assert.equal(pool.stats().active, 2);
    await assert.rejects(pool.evaluate('true', {}, context('overflow')), errorCode('queue_limit'));
    await Promise.all(jobs);
    assert.equal(pool.stats().pending, 0);
    assert.equal(pool.stats().workerStarts, 2);
  } finally {
    await pool.close();
  }
  const actual = new ManagedCelPool({ workers: 1 });
  try {
    await actual.warm();
    const entity = { value: 'original' };
    const job = actual.evaluate('entity.value == "original"', entity, context());
    entity.value = 'changed';
    assert.equal(await job, true);
  } finally {
    await actual.close();
  }
});

void test('round-robin dispatch lets an admitted interactive request overtake bulk backlog', async () => {
  const pool = new ManagedCelPool({ workers: 1, workerUrl });
  const completed: string[] = [];
  try {
    await pool.warm();
    const jobs = Array.from({ length: 6 }, (_, index) =>
      pool.evaluate('delay:10', {}, context('bulk')).then(() => {
        completed.push(`bulk-${index}`);
      }),
    );
    const interactive = pool.evaluate('true', {}, context('interactive')).then(() => {
      completed.push('interactive');
    });
    await Promise.all([...jobs, interactive]);
    assert(completed.indexOf('interactive') <= 2);
    assert.equal(pool.stats().workerStarts, 1);
  } finally {
    await pool.close();
  }
});

void test('queued cancellation frees admission immediately without killing the running worker', async () => {
  const pool = new ManagedCelPool({ workers: 1, pending: 2, workerUrl });
  const controller = new AbortController();
  try {
    await pool.warm();
    const blocker = pool.evaluate('delay:60', {}, context());
    const cancelled = assert.rejects(
      pool.evaluate('true', {}, { ...context(), signal: controller.signal }),
      errorCode('cancelled'),
    );
    controller.abort();
    assert.equal(pool.stats().pending, 1);
    await cancelled;
    const admitted = pool.evaluate('true', {}, context('new'));
    await Promise.all([blocker, admitted]);
    assert.equal(pool.stats().workerStarts, 1);
  } finally {
    await pool.close();
  }
});

void test('queue age and whole-request deadlines are independent of per-expression limits', async () => {
  const pool = new ManagedCelPool({ workers: 1, queueMs: 20, workerUrl });
  try {
    await pool.warm();
    const blocker = pool.evaluate('delay:60', {}, context());
    await assert.rejects(pool.evaluate('true', {}, context('queued')), errorCode('queue_timeout'));
    await blocker;
    await assert.rejects(
      pool.evaluate('delay:60', {}, context('deadline', 20)),
      errorCode('request_timeout'),
    );
    assert.equal(await pool.evaluate('true', {}, context()), true);
  } finally {
    await pool.close();
  }
});

void test('worker crash, uncaught error, wrong IDs and malformed replies fail closed and recover', async () => {
  const pool = new ManagedCelPool({ workers: 1, workerUrl });
  try {
    await pool.warm();
    for (const [expression, code] of [
      ['crash', 'worker_failure'],
      ['throw', 'worker_failure'],
      ['wrong-id', 'protocol'],
      ['malformed', 'protocol'],
      ['hang', 'execution_timeout'],
    ] as const) {
      await assert.rejects(pool.evaluate(expression, {}, context()), errorCode(code));
      assert.equal(await pool.evaluate('true', {}, context()), true);
    }
    assert.equal(pool.stats().workerStarts, 6);
    assert.equal(await pool.evaluate('env-empty', {}, context()), true);
  } finally {
    await pool.close();
  }
});

void test('startup deadline, cancellation and shutdown leave no live workers or pending jobs', async () => {
  const unreadyUrl = new URL('./fixtures/unready-worker.js', import.meta.url);
  const broken = new ManagedCelPool({ workers: 1, startupMs: 30, workerUrl: unreadyUrl });
  try {
    await assert.rejects(broken.warm(), errorCode('worker_start'));
    assert.equal(broken.stats().workers, 0);
    await assert.rejects(broken.warm(), errorCode('worker_start'));
    assert.equal(broken.stats().workerStarts, 2);
  } finally {
    await broken.close();
  }
  const starting = new ManagedCelPool({ workers: 1, workerUrl: unreadyUrl });
  const abort = new AbortController();
  const rejected = assert.rejects(
    starting.evaluate('true', {}, { ...context(), signal: abort.signal }),
    errorCode('cancelled'),
  );
  await delay(10);
  assert.equal(starting.stats().workers, 1);
  abort.abort();
  await rejected;
  await starting.close();
  assert.equal(starting.stats().workers, 0);
  const warming = new ManagedCelPool({ workers: 1, workerUrl: unreadyUrl });
  const warmRejected = assert.rejects(warming.warm(), errorCode('closed'));
  await warming.close();
  await warmRejected;
  assert.equal(warming.stats().workers, 0);
  const undispatched = new ManagedCelPool();
  const refused = assert.rejects(undispatched.evaluate('true', {}, context()), errorCode('closed'));
  await undispatched.close();
  await refused;
  assert.equal(undispatched.stats().workerStarts, 0);
  const pool = new ManagedCelPool({ workers: 1, workerUrl });
  await pool.warm();
  const active = assert.rejects(pool.evaluate('hang', {}, context()), errorCode('closed'));
  const queued = assert.rejects(pool.evaluate('true', {}, context()), errorCode('closed'));
  const close = pool.close();
  assert.equal(pool.close(), close);
  await Promise.all([close, active, queued]);
  assert.deepEqual(pool.stats(), {
    workers: 0,
    active: 0,
    queued: 0,
    pending: 0,
    workerStarts: 1,
    closed: true,
  });
  await assert.rejects(pool.evaluate('true', {}, context()), errorCode('closed'));
});

void test('shared runtime stays process-scoped and request budgets propagate cancellation', async () => {
  const first = getSharedCelRuntime();
  assert.equal(first, getSharedCelRuntime());
  try {
    await first.warm();
    assert.equal(first.stats().workers, 2);
    using budget = new RequestBudget(Date.now() + 20);
    await delay(30);
    assert.throws(() => budget.throwIfInterrupted(), errorCode('request_timeout'));
    const abort = new AbortController();
    using forwarded = new RequestBudget(Date.now() + 5000, abort.signal);
    abort.abort();
    assert.throws(() => forwarded.throwIfInterrupted(), errorCode('cancelled'));
    assert.throws(() => new RequestBudget(Date.now() + 10_000), RangeError);
    assert.throws(() => new ManagedCelPool({ workers: 3 }), RangeError);
  } finally {
    await closeSharedCelRuntime();
  }
  assert.equal(first.stats().workers, 0);
});
