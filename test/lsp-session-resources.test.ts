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
void test('replacement drains all tracked users before disposal and activates one complete generation', async (t) => {
  const f = fixture();
  const prepared = deferred<LspServerResources>();
  const work = deferred<void>();
  const manager = new SessionResources(f.resources('initial'), f.ports, () => prepared.promise);
  const old = manager.current;
  const retiring = deferred<void>();
  const closeCompletion = old.completion.close.bind(old.completion);
  t.mock.method(old.completion, 'close', () => {
    retiring.resolve();
    return closeCompletion();
  });
  const running = old.operations.run(() => work.promise);
  const reload = manager.reload();
  assert.equal(manager.available, false);
  assert(old.operations.signal.aborted);
  prepared.resolve(f.resources('next'));
  await retiring.promise;
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
void test('repeated reloads resolve only after queued preparation and disposal finish', async (t) => {
  const f = fixture();
  const gates = [deferred<LspServerResources>(), deferred<LspServerResources>()];
  const entered = [deferred<void>(), deferred<void>()];
  let calls = 0;
  const manager = new SessionResources(f.resources('initial'), f.ports, () => {
    const index = calls++;
    entered[index]!.resolve();
    return gates[index]!.promise;
  });
  t.after(() => manager.close());
  const first = manager.reload();
  const repeated = manager.reload();
  assert.equal(first, repeated);
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await entered[0]!.promise;
  assert.equal(calls, 1);
  gates[0]!.resolve(f.resources('one'));
  await entered[1]!.promise;
  assert.equal(calls, 2);
  assert.equal(settled, false, 'The caller must not observe success while its queued reload runs.');
  assert.equal(manager.available, false);
  assert(!f.events.includes('ready'), 'Intermediate generations must not announce readiness.');
  gates[1]!.resolve(f.resources('two'));
  assert.deepEqual(await first, { reloaded: true });
  assert.deepEqual(await repeated, { reloaded: true });
  assert.equal(manager.available, true);
  assert.equal(manager.current.generation, 2);
  assert.equal(f.events.filter((event) => event === 'ready').length, 1);
  assert.deepEqual(f.closes, ['initial', 'one']);
  await manager.close();
  assert.deepEqual(f.closes, ['initial', 'one', 'two']);
});
void test('shutdown during preparation is terminal and disposes a replacement that arrives late', async () => {
  const f = fixture();
  const prepared = deferred<LspServerResources>();
  const entered = deferred<void>();
  const disposed = deferred<void>();
  const manager = new SessionResources(f.resources('initial'), f.ports, () => {
    entered.resolve();
    return prepared.promise;
  });
  const reload = manager.reload();
  await entered.promise;
  await manager.close();
  assert.deepEqual(await reload, { reloaded: false });
  prepared.resolve({
    ...f.resources('late'),
    dispose: () => {
      f.closes.push('late');
      disposed.resolve();
      return Promise.resolve();
    },
  });
  await disposed.promise;
  assert.deepEqual(f.closes, ['initial', 'late']);
  assert.equal(manager.available, false);
  assert.equal(manager.stopped, true);
  assert(!f.events.includes('ready'));
});
void test('queued reload callers observe final failure or shutdown without intermediate readiness', async (t) => {
  for (const outcome of ['failure', 'shutdown'])
    await t.test(outcome, async (t) => {
      const f = fixture();
      const gates = [deferred<void>(), deferred<void>()];
      const entered = [deferred<void>(), deferred<void>()];
      const lateDisposed = deferred<void>();
      let calls = 0;
      const manager = new SessionResources(f.resources('initial'), f.ports, async () => {
        const index = calls++;
        entered[index]!.resolve();
        await gates[index]!.promise;
        if (index === 1 && outcome === 'failure') throw new Error('Invalid replacement.');
        return index === 0
          ? f.resources('one')
          : {
              config: f.config,
              dispose: () => {
                f.closes.push('late');
                lateDisposed.resolve();
                return Promise.resolve();
              },
            };
      });
      t.after(() => manager.close());
      const first = manager.reload();
      const repeated = manager.reload();
      await entered[0]!.promise;
      gates[0]!.resolve();
      await entered[1]!.promise;
      assert.equal(manager.available, false);
      assert(!f.events.includes('ready'));
      if (outcome === 'shutdown') await manager.close();
      else gates[1]!.resolve();
      assert.deepEqual(await first, { reloaded: false });
      assert.deepEqual(await repeated, { reloaded: false });
      assert.equal(manager.available, false);
      assert(!f.events.includes('ready'));
      if (outcome === 'shutdown') {
        gates[1]!.resolve();
        await lateDisposed.promise;
        assert.deepEqual(f.closes, ['initial', 'one', 'late']);
      } else {
        await manager.close();
        assert.deepEqual(f.closes, ['initial', 'one']);
      }
      assert.equal(calls, 2);
    });
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
  const disposal = deferred<void>();
  session.own(registration.promise);
  await session.close();
  registration.resolve({
    dispose: () => {
      disposed++;
      disposal.resolve();
    },
  });
  await disposal.promise;
  await session.close();
  assert.equal(disposed, 1);
  assert.equal(session.status.registrations, 0);
});
void test('uncooperative internal work cannot prevent a bounded close or suppress finalizer attempts', async () => {
  const f = fixture();
  const session = new SessionGeneration(1, f.resources('initial'), 5);
  const entered = deferred<void>();
  void session.operations.run(() => {
    entered.resolve();
    return new Promise(() => {});
  });
  await entered.promise;
  await assert.rejects(session.close(), /Session cleanup failed/u);
  assert.deepEqual(f.closes, ['initial']);
});

void test('shutdown disposes a prepared generation even when the old coordinator never acknowledges pause', async () => {
  const f = fixture();
  const pause = deferred<void>();
  const prepared = deferred<void>();
  const manager = new SessionResources(
    f.resources('initial'),
    { ...f.ports, pause: () => pause.promise },
    () =>
      Promise.resolve({
        ...f.resources('prepared'),
        get config() {
          prepared.resolve();
          return f.config;
        },
      }),
    5,
  );
  const reload = manager.reload();
  await prepared.promise;
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

void test('a failed late registration disposer invalidates activation and retains bounded failure evidence', async () => {
  for (const duringActivation of [false, true]) {
    const f = fixture();
    const registration = deferred<SessionRegistration>();
    const activation = deferred<void>();
    const activationEntered = deferred<void>();
    const registrationFailed = deferred<void>();
    let injectingFailure = false;
    const manager = new SessionResources(
      f.resources('initial'),
      {
        ...f.ports,
        activated: () => {
          activationEntered.resolve();
          return duringActivation ? activation.promise : undefined;
        },
        invalidate: () => {
          f.ports.invalidate();
          if (injectingFailure) registrationFailed.resolve();
        },
      },
      () => Promise.resolve(f.resources('candidate')),
    );
    manager.current.own(registration.promise);
    const reload = manager.reload();
    await activationEntered.promise;
    if (!duringActivation) assert.deepEqual(await reload, { reloaded: true });
    injectingFailure = true;
    registration.resolve({
      dispose: () => Promise.reject(new Error('private registration detail')),
    });
    await registrationFailed.promise;
    activation.resolve();
    if (duringActivation) {
      assert.deepEqual(await reload, { reloaded: false });
      assert(!f.events.includes('ready'));
      assert(manager.current.closed);
    }
    assert.equal(manager.available, false);
    assert(manager.cleanupFailed);
    assert(manager.current.operations.signal.aborted);
    assert.deepEqual(await manager.reload(), { reloaded: false });
    await assert.rejects(manager.close(), /^Error: Session cleanup failed\.$/u);
    assert.deepEqual(f.closes, ['initial', 'candidate']);
  }
});
