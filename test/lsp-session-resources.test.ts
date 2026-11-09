import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionGeneration, SessionResources } from '../src/lsp/session-resources.js';
import type {
  LspServerResources,
  SessionPorts,
  SessionRegistration,
} from '../src/lsp/session-resources.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { policyRun } from './harness/policy-fixture.js';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const run = policyRun({ rules: [] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  const closes: string[] = [];
  const events: string[] = [];
  const resources = (name: string): LspServerResources => ({
    config,
    dispose: () => {
      closes.push(name);
      return Promise.resolve();
    },
  });
  const ports: SessionPorts = {
    invalidate: () => {
      events.push('invalidate');
    },
    pause: () => Promise.resolve(),
    commit: (session) => {
      events.push('commit:' + session.generation);
    },
    activated: () => {},
    resume: () => {},
    ready: () => {
      events.push('ready');
    },
  };
  return { config, closes, events, resources, ports };
}
void test('replacement drains all tracked users before disposal and activates one complete generation', async () => {
  const f = fixture();
  const prepared = deferred<LspServerResources>();
  const work = deferred<void>();
  const manager = new SessionResources(f.resources('initial'), f.ports, () => prepared.promise);
  const old = manager.current;
  const running = old.operations.run(() => work.promise);
  const reload = manager.reload();
  assert.equal(manager.available, false);
  assert(old.operations.signal.aborted);
  prepared.resolve(f.resources('next'));
  await turn();
  assert.deepEqual(f.closes, []);
  assert(!f.events.some((event) => event.startsWith('commit:')));
  work.resolve();
  await running;
  assert.deepEqual(await reload, { reloaded: true });
  assert.deepEqual(f.closes, ['initial']);
  assert.equal(manager.current.generation, 1);
  assert.equal(manager.available, true);
  await manager.close();
  await manager.close();
  assert.deepEqual(f.closes, ['initial', 'next']);
});
void test('repeated reloads coalesce without overlapping preparation or disposal', async () => {
  const f = fixture();
  const gates = [deferred<LspServerResources>(), deferred<LspServerResources>()];
  let calls = 0;
  const manager = new SessionResources(
    f.resources('initial'),
    f.ports,
    () => gates[calls++]!.promise,
  );
  const first = manager.reload();
  const repeated = manager.reload();
  assert.equal(first, repeated);
  await turn();
  assert.equal(calls, 1);
  gates[0]!.resolve(f.resources('one'));
  await first;
  await turn();
  assert.equal(calls, 2);
  gates[1]!.resolve(f.resources('two'));
  await turn();
  assert.equal(manager.available, true);
  assert.equal(manager.current.generation, 2);
  assert.deepEqual(f.closes, ['initial', 'one']);
  await manager.close();
});
void test('shutdown during preparation is terminal and disposes a replacement that arrives late', async () => {
  const f = fixture();
  const prepared = deferred<LspServerResources>();
  const manager = new SessionResources(f.resources('initial'), f.ports, () => prepared.promise);
  const reload = manager.reload();
  await turn();
  await manager.close();
  assert.deepEqual(await reload, { reloaded: false });
  prepared.resolve(f.resources('late'));
  await turn();
  assert.deepEqual(f.closes, ['initial', 'late']);
  assert.equal(manager.available, false);
  assert.equal(manager.stopped, true);
  assert(!f.events.includes('ready'));
});
void test('activation failure closes the committed candidate and cannot restore retired resources', async () => {
  const f = fixture();
  const manager = new SessionResources(
    f.resources('initial'),
    {
      ...f.ports,
      activated: () => {
        throw new Error('watch setup failed');
      },
    },
    () => Promise.resolve(f.resources('candidate')),
  );
  assert.deepEqual(await manager.reload(), { reloaded: false });
  assert.equal(manager.available, false);
  assert.equal(manager.current.generation, 1);
  assert(manager.current.closed);
  assert.deepEqual(f.closes, ['initial', 'candidate']);
  await manager.close();
  assert.deepEqual(f.closes, ['initial', 'candidate']);
});
void test('cleanup failure attempts registrations and other owners, stays unavailable and reports bounded failure', async () => {
  const f = fixture();
  const initial = {
    ...f.resources('initial'),
    dispose: () => {
      f.closes.push('failed-owner');
      return Promise.reject(new Error('private detail'));
    },
  };
  const manager = new SessionResources(initial, f.ports, () =>
    Promise.resolve(f.resources('candidate')),
  );
  manager.current.own({
    dispose: () => {
      f.closes.push('registration');
    },
  });
  await turn();
  assert.deepEqual(await manager.reload(), { reloaded: false });
  assert.equal(manager.available, false);
  assert(manager.cleanupFailed);
  assert(f.closes.includes('registration'));
  assert(f.closes.includes('candidate'));
  await assert.rejects(manager.close(), /^Error: Session cleanup failed\.$/u);
});
void test('a watcher registration that resolves after retirement is disposed once', async () => {
  const f = fixture();
  const registration = deferred<SessionRegistration>();
  const session = new SessionGeneration(1, f.resources('initial'));
  let disposed = 0;
  session.own(registration.promise);
  await session.close();
  registration.resolve({
    dispose: () => {
      disposed++;
    },
  });
  await turn();
  await session.close();
  assert.equal(disposed, 1);
  assert.equal(session.status.registrations, 0);
});
void test('uncooperative internal work cannot prevent a bounded close or suppress finalizer attempts', async () => {
  const f = fixture();
  const session = new SessionGeneration(1, f.resources('initial'), 5);
  void session.operations.run(() => new Promise(() => {}));
  await assert.rejects(session.close(), /Session cleanup failed/u);
  assert.deepEqual(f.closes, ['initial']);
});

void test('shutdown disposes a prepared generation even when the old coordinator never acknowledges pause', async () => {
  const f = fixture();
  const pause = deferred<void>();
  const manager = new SessionResources(
    f.resources('initial'),
    { ...f.ports, pause: () => pause.promise },
    () => Promise.resolve(f.resources('prepared')),
    5,
  );
  const reload = manager.reload();
  await turn();
  await assert.rejects(manager.close(), /Session cleanup failed/u);
  assert.deepEqual(await reload, { reloaded: false });
  assert.deepEqual(new Set(f.closes), new Set(['initial', 'prepared']));
  assert.equal(manager.stopped, true);
  assert(!f.events.includes('ready'));
});

void test('readiness and resume faults retain candidate ownership until cleanup completes', async () => {
  for (const port of ['ready', 'resume'] as const) {
    const f = fixture();
    const manager = new SessionResources(
      f.resources('initial'),
      {
        ...f.ports,
        [port]: () => {
          throw new Error('private readiness detail');
        },
      },
      () => Promise.resolve(f.resources('candidate')),
    );
    assert.deepEqual(await manager.reload(), { reloaded: false });
    assert.equal(manager.available, false);
    assert(manager.current.closed);
    assert.deepEqual(f.closes, ['initial', 'candidate']);
    if (port === 'resume') {
      assert(manager.cleanupFailed);
      await assert.rejects(manager.close(), /^Error: Session cleanup failed\.$/u);
    } else await manager.close();
    assert.deepEqual(f.closes, ['initial', 'candidate']);
  }
});
