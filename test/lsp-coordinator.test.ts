import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationCoordinator } from '../src/lsp/validation-coordinator.js';
import type { ValidationRun } from '../src/lsp/validation-coordinator.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function clock() {
  const callbacks = new Set<() => void>();
  return {
    callbacks,
    schedule: (work: () => void) => {
      callbacks.add(work);
      return () => {
        callbacks.delete(work);
      };
    },
    tick: () => {
      const work = [...callbacks];
      callbacks.clear();
      for (const callback of work) callback();
    },
  };
}
void test('coordinator serializes active work, keeps only the latest pending update and waits for validation quiescence', async () => {
  const time = clock();
  const releases = [deferred(), deferred()];
  const runs: ValidationRun[] = [];
  let active = 0;
  const coordinator = new ValidationCoordinator(
    async (context) => {
      assert.equal(++active, 1);
      runs.push(context);
      await releases[runs.length - 1]!.promise;
      active--;
    },
    () => 25,
    () => {},
    time,
  );
  coordinator.invalidate('buffer');
  let idle = false;
  const waiting = coordinator.whenIdle().then(() => {
    idle = true;
  });
  await turn();
  assert.equal(idle, false);
  time.tick();
  await turn();
  coordinator.invalidate('disk');
  coordinator.invalidate('dependencies');
  time.tick();
  assert(runs[0]!.signal.aborted);
  assert.equal(runs.length, 1);
  releases[0]!.resolve();
  await turn();
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.generation, 3);
  assert(runs[1]!.current());
  releases[1]!.resolve();
  await waiting;
  assert.equal(coordinator.status.active, 0);
  assert.equal(coordinator.status.pending, false);
  assert.equal(coordinator.status.timer, false);
  await coordinator.close();
});
void test('paused invalidations coalesce and terminal close cancels timers without admitting new work', async () => {
  const time = clock();
  const seen: number[] = [];
  const coordinator = new ValidationCoordinator(
    (context) => {
      seen.push(context.generation);
      return Promise.resolve();
    },
    () => 0,
    () => {},
    time,
  );
  coordinator.pause();
  coordinator.invalidate('configuration');
  coordinator.invalidate('selection');
  assert.equal(time.callbacks.size, 0);
  coordinator.resume();
  await coordinator.whenIdle();
  assert.deepEqual(seen, [2]);
  coordinator.invalidate('buffer');
  assert.equal(time.callbacks.size, 1);
  await coordinator.close();
  assert.equal(time.callbacks.size, 0);
  coordinator.invalidate('buffer');
  coordinator.resume();
  await coordinator.whenIdle();
  assert.deepEqual(seen, [2]);
});
