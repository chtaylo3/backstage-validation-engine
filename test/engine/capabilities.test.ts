import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import {
  CapabilitySession,
  CapabilityError,
  capabilityBinding,
  capabilityAuthorityDigest,
  parseCapabilityRequest,
  parseCapabilityOutput,
  parseManifest,
  inputSchemas,
  outputSchemas,
  capabilitySchemas,
} from '../../src/capabilities/index.js';
import type {
  CapabilityApproval,
  CapabilityEndpoint,
  CapabilityInvocation,
} from '../../src/capabilities/index.js';
import type {
  BoundRequest,
  CapabilityId,
  CapabilityManifest,
  CapabilityOutputs,
  HostHandshake,
} from '../../src/capabilities/index.js';
import type { Immutable } from '../../src/base/json.js';
import { digestJson } from '../../src/base/json.js';
import { policyRun } from '../harness/policy-fixture.js';
import { BuiltinValidationService } from '../../src/host/builtin-validation.js';
import { createDataSnapshot } from '../../src/core/snapshots.js';
import { closeSharedCelRuntime } from '../../src/runtime/cel/index.js';
import type { ValidationRequest } from '../../src/contracts/schemas.js';
import { after } from 'node:test';

after(closeSharedCelRuntime);
const code = (expected: string) => (error: unknown) =>
  error instanceof CapabilityError && error.code === expected;
function fixture(
  id: CapabilityId = 'hover',
  options: { required?: boolean; mode?: 'prepared' | 'async'; closeMs?: number } = {},
) {
  const manifest: CapabilityManifest = {
    apiVersion: 'bve-plugin/1',
    pluginId: 'approved.fixture',
    version: '1',
    artifactDigest: digestJson({ artifact: 'known-host-test-artifact' }),
    executionProfile: 'builtin/1',
    capabilities: [
      {
        id,
        version: 1,
        required: options.required ?? true,
        mode: options.mode ?? 'prepared',
        inputSchemaDigest: digestJson(inputSchemas[id]),
        outputSchemaDigest: digestJson(outputSchemas[id]),
      },
    ],
    dependencies: ['fixed-adapter@1'],
    permissions: [],
    subjectStages: ['authored'],
    languageProfiles: ['host-contract/0.2'],
  };
  const approval: CapabilityApproval = {
    pluginId: manifest.pluginId,
    artifactDigest: manifest.artifactDigest,
    manifestDigest: digestJson(manifest),
    capabilities: [id],
    dependencies: ['fixed-adapter@1'],
    permissions: [],
    executionProfiles: ['builtin/1'],
    languageProfiles: ['host-contract/0.2'],
  };
  const report = (
    request: Immutable<BoundRequest<CapabilityId>>,
    value: unknown = { text: 'Approved description.' },
  ) => ({
    status: 'ready',
    invocationId: request.invocationId,
    capabilityId: request.capabilityId,
    binding: request.binding,
    completeness: 'complete',
    value,
  });
  const endpoint: CapabilityEndpoint = {
    initialize: (request) => ({
      apiVersion: 'bve-plugin/1',
      pluginId: request.pluginId,
      artifactDigest: request.artifactDigest,
      manifestDigest: request.manifestDigest,
      capabilities: request.capabilities.map(({ id, version }) => ({ id, version })),
    }),
    provide: (request) => report(request),
    cancel: () => {},
    dispose: () => {},
  };
  const run = policyRun({ rules: [] });
  const context = (): CapabilityInvocation => ({
    requestId: 'host-owned-request',
    binding: capabilityBinding(run.request, {
      workspaceGeneration: 11,
      sessionGeneration: 3,
      dependencyGeneration: 7,
    }),
    deadlineAt: Date.now() + 1000,
  });
  const create = (actual = manifest, permissions = approval) =>
    new CapabilitySession(actual, permissions, endpoint, options.closeMs ?? 100);
  return { manifest, approval, endpoint, run, context, create, report };
}
const metadata = {
  path: '/spec',
  subjectStage: 'authored' as const,
  scope: { status: 'known' as const, kind: 'Component', apiVersion: 'backstage.io/v1alpha1' },
  subject: { state: 'present' as const, value: { spec: {} } },
  schemas: [],
};

void test('capability schemas are versioned JSON resources independently of contract 0.2', () => {
  assert.equal(Object.keys(capabilitySchemas).length, 40);
  for (const schema of Object.values(capabilitySchemas)) {
    assert.match(schema.$id!, /^urn:backstage-validation:capability:.+:1$/u);
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert(Object.isFrozen(schema));
    assert.doesNotThrow(() => digestJson(schema));
  }
});

void test('manifest tampering and host permission/dependency/profile escalation reject before initialization', () => {
  const changes: ((m: CapabilityManifest) => void)[] = [
    (m) => {
      m.version = '2';
    },
    (m) => {
      m.artifactDigest = digestJson('other artifact');
    },
    (m) => {
      m.dependencies.push('unapproved-provider');
    },
    (m) => {
      m.permissions.push('catalog-read');
    },
    (m) => {
      m.languageProfiles.push('unapproved-language/1');
    },
  ];
  for (const mutate of changes) {
    const f = fixture();
    let initialized = false;
    f.endpoint.initialize = () => {
      initialized = true;
      throw new Error('Unexpected initialization.');
    };
    const actual = structuredClone(f.manifest);
    mutate(actual);
    assert.throws(() => f.create(actual), code('not_approved'));
    assert.equal(initialized, false);
  }
  const f = fixture();
  assert.throws(
    () => parseManifest({ ...f.manifest, module: 'unapproved-code.mjs' }),
    code('invalid_record'),
  );
  assert.throws(
    () => parseManifest({ ...f.manifest, apiVersion: 'bve-plugin/2' }),
    code('invalid_record'),
  );
  assert.throws(
    () => parseManifest({ ...f.manifest, executionProfile: 'process/1' }),
    code('invalid_record'),
  );
});

void test('unsupported required capability versions and altered schema pins fail admission', () => {
  for (const mutate of [
    (m: CapabilityManifest) => {
      m.capabilities[0]!.version = 2;
    },
    (m: CapabilityManifest) => {
      m.capabilities[0]!.inputSchemaDigest = digestJson('wrong input schema');
    },
    (m: CapabilityManifest) => {
      m.capabilities[0]!.outputSchemaDigest = digestJson('wrong output schema');
    },
  ]) {
    const f = fixture();
    mutate(f.manifest);
    assert.throws(
      () => f.create(f.manifest, { ...f.approval, manifestDigest: digestJson(f.manifest) }),
      code('unsupported'),
    );
  }
});

void test('an unsupported optional function is not negotiated or invoked', async () => {
  const f = fixture('hover', { required: false });
  f.manifest.capabilities[0]!.version = 2;
  let calls = 0;
  f.endpoint.provide = () => {
    calls++;
    return {};
  };
  const session = f.create(f.manifest, { ...f.approval, manifestDigest: digestJson(f.manifest) });
  assert.deepEqual(session.status.capabilities, []);
  assert.throws(() => session.providePrepared('hover', metadata, f.context()), code('unsupported'));
  assert.equal(calls, 0);
  await session.close();
});

void test('an unknown optional capability stays disabled and the same required capability fails closed', async () => {
  const f = fixture('hover', { required: false });
  f.manifest.capabilities[0]!.id = 'future-function';
  const session = f.create(f.manifest, { ...f.approval, manifestDigest: digestJson(f.manifest) });
  assert.deepEqual(session.status.capabilities, []);
  await session.close();
  f.manifest.capabilities[0]!.required = true;
  assert.throws(
    () => f.create(f.manifest, { ...f.approval, manifestDigest: digestJson(f.manifest) }),
    code('unsupported'),
  );
});

void test('change providers require declared observation semantics and can return only invalidation hints', () => {
  const f = fixture('dependency-changes');
  assert.throws(() => f.create(), code('not_approved'));
  assert.throws(
    () =>
      parseCapabilityOutput('dependency-changes', {
        changes: [],
        reset: false,
        coverage: 'hints',
        observedAt: 1,
        entities: [{ authoritative: true }],
      }),
    code('invalid_record'),
  );
  const result = parseCapabilityOutput('dependency-changes', {
    changes: [{ kind: 'query', key: 'group:default/team' }],
    cursor: 'opaque-cursor',
    reset: true,
    coverage: 'hints',
    observedAt: 1,
  });
  assert.equal(result.reset, true);
  assert.equal(result.coverage, 'hints');
});

void test('handshake cannot add a capability, change identity, or omit a required evaluator', async () => {
  for (const value of ['identity', 'extra', 'missing']) {
    const f = fixture('validation', { mode: 'async' });
    f.endpoint.initialize = (request) => ({
      apiVersion: 'bve-plugin/1',
      pluginId: value === 'identity' ? 'other-plugin' : request.pluginId,
      artifactDigest: request.artifactDigest,
      manifestDigest: request.manifestDigest,
      capabilities:
        value === 'extra'
          ? [{ id: 'search', version: 1 }]
          : value === 'missing'
            ? []
            : [{ id: 'validation', version: 1 }],
    });
    const session = f.create();
    await assert.rejects(session.whenReady(), code('unsupported'));
    await assert.rejects(
      session.provide('validation', { request: f.run.request }, f.context()),
      code('closed'),
    );
    await session.close();
  }
});

void test('admission preserves absence versus explicit null and rejects unknown request fields and oversized payloads', () => {
  assert.deepEqual(
    parseCapabilityOutput('values', {
      candidates: [{ value: null, label: 'Explicit null', classification: 'allowed', sources: [] }],
    }).candidates[0]!.value,
    null,
  );
  const f = fixture();
  const context = f.context();
  const request = {
    invocationId: 'one',
    requestId: 'host',
    capabilityId: 'hover',
    capabilityVersion: 1,
    binding: context.binding,
    deadlineAt: context.deadlineAt,
    input: metadata,
  };
  assert.equal(parseCapabilityRequest('hover', request).input.subject.state, 'present');
  assert.equal(
    parseCapabilityRequest('hover', {
      ...request,
      input: { ...metadata, subject: { state: 'absent' } },
    }).input.subject.state,
    'absent',
  );
  assert.equal(
    parseCapabilityRequest('hover', {
      ...request,
      input: { ...metadata, subject: { state: 'present', value: null } },
    }).input.subject.state,
    'present',
  );
  assert.throws(
    () => parseCapabilityRequest('hover', { ...request, endpoint: 'https://unapproved.invalid/' }),
    code('invalid_record'),
  );
  assert.throws(
    () =>
      parseCapabilityRequest('hover', {
        ...request,
        input: { ...metadata, subject: { state: 'present', value: 'x'.repeat(2 * 1024 * 1024) } },
      }),
    code('resource_limit'),
  );
  let getter = false;
  assert.throws(
    () =>
      parseCapabilityRequest('hover', {
        ...request,
        get input() {
          getter = true;
          return metadata;
        },
      }),
    code('resource_limit'),
  );
  assert.equal(getter, false);
});

void test('schema metadata admits the documented RE2 pattern ceiling and rejects ceiling plus one before provider work', () => {
  const f = fixture();
  const context = f.context();
  const request = {
    invocationId: 'pattern-boundary',
    requestId: 'host',
    capabilityId: 'hover',
    capabilityVersion: 1,
    binding: context.binding,
    deadlineAt: context.deadlineAt,
    input: {
      ...metadata,
      schemas: [
        {
          root: { type: 'string', pattern: 'a'.repeat(1024) },
          definitions: {},
          label: 'Approved pattern',
        },
      ],
    },
  };
  assert.doesNotThrow(() => parseCapabilityRequest('hover', request));
  request.input.schemas[0]!.root.pattern += 'a';
  assert.throws(() => parseCapabilityRequest('hover', request), code('resource_limit'));
});

void test('host accepts a correctly bound reply but rejects duplicate, malformed and altered reply identities', async () => {
  const f = fixture();
  const session = f.create();
  const context = f.context();
  assert.equal(session.providePrepared('hover', metadata, context).status, 'ready');
  let previous: unknown;
  f.endpoint.provide = (request) => (previous ??= f.report(request));
  session.providePrepared('hover', metadata, f.context());
  assert.throws(() => session.providePrepared('hover', metadata, f.context()), code('binding'));
  for (const make of [
    (request: Immutable<BoundRequest<CapabilityId>>) => ({
      ...f.report(request),
      binding: { ...request.binding, dependencyGeneration: 8 },
    }),
    (request: Immutable<BoundRequest<CapabilityId>>) => ({
      ...f.report(request),
      value: { text: 17 },
    }),
    (request: Immutable<BoundRequest<CapabilityId>>) => ({
      ...f.report(request),
      value: { text: 'x'.repeat(16385) },
    }),
    (request: Immutable<BoundRequest<CapabilityId>>) => ({ ...f.report(request), verified: true }),
  ]) {
    f.endpoint.provide = make;
    assert.throws(() => session.providePrepared('hover', metadata, f.context()), CapabilityError);
  }
  await session.close();
});

void test('host rejects undeclared field paths, mismatched repair subjects and unapproved discovery targets', async () => {
  const fields = fixture('fields');
  fields.endpoint.provide = (request) =>
    fields.report(request, {
      fields: [
        {
          name: 'owner',
          path: '/other/owner',
          required: true,
          description: '',
          types: ['string'],
          initialValue: '',
          sources: [],
          subjectStage: 'authored',
          scope: metadata.scope,
          constraints: [],
        },
      ],
    });
  const fieldSession = fields.create();
  assert.throws(
    () =>
      fieldSession.providePrepared(
        'fields',
        { ...metadata, prefix: '', existing: [] },
        fields.context(),
      ),
    code('binding'),
  );
  await fieldSession.close();
  const repairs = fixture('repairs');
  repairs.endpoint.provide = (request) =>
    repairs.report(request, {
      proposals: [
        {
          findingId: 'other-finding',
          subjectId: 'subject',
          path: '/spec',
          operation: 'setValue',
          value: 'production',
          label: 'Explicit choice',
        },
      ],
    });
  const repairSession = repairs.create();
  assert.throws(
    () =>
      repairSession.providePrepared(
        'repairs',
        {
          ...metadata,
          findingId: 'finding',
          subjectId: 'subject',
          current: { state: 'present', value: 'experimental' },
          required: false,
        },
        repairs.context(),
      ),
    code('binding'),
  );
  await repairSession.close();
  const discovery = fixture('source-discovery');
  discovery.endpoint.provide = (request) =>
    discovery.report(request, {
      sources: [{ uri: 'file:///outside/catalog.yaml' }],
      complete: true,
    });
  const discoverySession = discovery.create();
  assert.throws(
    () =>
      discoverySession.providePrepared(
        'source-discovery',
        { roots: ['file:///workspace/'], include: ['**/*.yaml'], exclude: [] },
        discovery.context(),
      ),
    code('binding'),
  );
  await discoverySession.close();
});

void test('a remote generation change rejects a delayed reply even at the same document context', async () => {
  const f = fixture('hover', { mode: 'async' });
  let release!: (value: unknown) => void;
  let captured!: Immutable<BoundRequest<CapabilityId>>;
  f.endpoint.provide = (request) => {
    captured = request;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const session = f.create();
  let current = true;
  const work = session.provide('hover', metadata, { ...f.context(), current: () => current });
  await pause(1);
  current = false;
  release(f.report(captured));
  await assert.rejects(work, code('binding'));
  await session.close();
});

void test('cancellation drains owned work before returning and disposal prevents another invocation', async () => {
  const f = fixture('hover', { mode: 'async' });
  let cancelled = 0,
    disposed = 0,
    running = false;
  f.endpoint.provide = (_request, { signal }) =>
    new Promise((_, reject) => {
      running = true;
      signal.addEventListener(
        'abort',
        () => {
          running = false;
          reject(new Error('Cancelled fixture work.'));
        },
        { once: true },
      );
    });
  f.endpoint.cancel = () => {
    cancelled++;
  };
  f.endpoint.dispose = () => {
    disposed++;
  };
  const session = f.create();
  const controller = new AbortController();
  const work = session.provide('hover', metadata, { ...f.context(), signal: controller.signal });
  await pause(1);
  assert(running);
  controller.abort();
  await assert.rejects(work, code('cancelled'));
  assert.equal(running, false);
  assert.equal(cancelled, 1);
  assert.equal(session.status.owned, 0);
  const closing = session.close();
  assert.equal(closing, session.close());
  await closing;
  assert.equal(disposed, 1);
  await assert.rejects(session.provide('hover', metadata, f.context()), code('closed'));
});

void test('a failed cancellation acknowledgement poisons the generation even after work rejects', async () => {
  const f = fixture('hover', { mode: 'async' });
  f.endpoint.provide = (_request, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('Cancelled work.')), { once: true }),
    );
  f.endpoint.cancel = () => Promise.reject(new Error('Cleanup refused.'));
  const session = f.create();
  const controller = new AbortController();
  const work = session.provide('hover', metadata, { ...f.context(), signal: controller.signal });
  await pause(1);
  controller.abort();
  await assert.rejects(work, code('cancelled'));
  assert.equal(session.status.failed, true);
  await assert.rejects(session.provide('hover', metadata, f.context()), code('closed'));
  await assert.rejects(session.close(), code('cleanup'));
});

void test('close owns cancellation finalizers that start before or after close and reports failed cleanup', async () => {
  for (const mode of ['caller-cancel', 'close-cancel', 'failed-cancel'] as const) {
    const f = fixture('hover', { mode: 'async', closeMs: 1000 });
    let entered!: () => void,
      cancelEntered!: () => void,
      release!: () => void,
      fail!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancelling = new Promise<void>((resolve) => {
      cancelEntered = resolve;
    });
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    let cancellationSettled = false,
      closeSettled = false;
    f.endpoint.provide = (_request, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Owned work cancelled.')), {
          once: true,
        });
        entered();
      });
    f.endpoint.cancel = () => {
      cancelEntered();
      return gate.finally(() => {
        cancellationSettled = true;
      });
    };
    f.endpoint.dispose = () => {
      assert.equal(
        cancellationSettled,
        true,
        'Provider disposal follows the invocation finalizer.',
      );
    };
    const session = f.create(),
      controller = new AbortController();
    const operation = session.provide('hover', metadata, {
      ...f.context(),
      deadlineAt: Date.now() + 5000,
      signal: controller.signal,
    });
    await started;
    if (mode !== 'close-cancel') controller.abort();
    const closing = session.close();
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    try {
      await cancelling;
      await pause(0);
      assert.equal(cancellationSettled, false);
      assert.equal(closeSettled, false);
      assert.equal(session.status.invocations, 1);
      if (mode === 'failed-cancel') fail(new Error('Cancellation cleanup failed.'));
      else release();
      await assert.rejects(operation, code('cancelled'));
      if (mode === 'failed-cancel') await assert.rejects(closing, code('cleanup'));
      else await closing;
      assert.equal(cancellationSettled, true);
      assert.equal(session.status.active, 0);
      assert.equal(session.status.invocations, 0);
      assert.equal(session.status.owned, 0);
    } finally {
      release();
      await Promise.allSettled([operation, closing]);
    }
  }
});

void test('a caller cannot wait outside its budget while initialization remains pending', async () => {
  const f = fixture();
  let complete!: (value: unknown) => void;
  let handshake!: Immutable<HostHandshake>;
  f.endpoint.initialize = (request) => {
    handshake = request;
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  let calls = 0;
  f.endpoint.provide = () => {
    calls++;
    return {};
  };
  const session = f.create();
  await assert.rejects(
    session.provide('hover', metadata, { ...f.context(), deadlineAt: Date.now() + 5 }),
    code('unsupported'),
  );
  assert.equal(calls, 0);
  assert.equal(session.status.active, 0);
  complete({
    apiVersion: 'bve-plugin/1',
    pluginId: handshake.pluginId,
    artifactDigest: handshake.artifactDigest,
    manifestDigest: handshake.manifestDigest,
    capabilities: [{ id: 'hover', version: 1 }],
  });
  await session.whenReady();
  await session.close();
});

void test('uncooperative work has a bounded drain, retains ownership, and cannot release a reusable slot', async () => {
  const f = fixture('hover', { mode: 'async', closeMs: 10 });
  let release!: (value: unknown) => void;
  f.endpoint.provide = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const session = f.create();
  const controller = new AbortController();
  const work = session.provide('hover', metadata, { ...f.context(), signal: controller.signal });
  await pause(1);
  controller.abort();
  await assert.rejects(work, code('cancelled'));
  assert.equal(session.status.failed, true);
  assert.equal(session.status.owned, 1);
  await assert.rejects(session.provide('hover', metadata, f.context()), code('closed'));
  await assert.rejects(session.close(), code('cleanup'));
  release({});
  await pause(1);
  assert.equal(session.status.owned, 0);
});

void test('a late initialization acquisition receives disposal after bounded close fails', async () => {
  const f = fixture('hover', { closeMs: 10 });
  let release!: (value: unknown) => void;
  let handshake!: Immutable<HostHandshake>;
  let acquired = false;
  f.endpoint.initialize = (request) => {
    handshake = request;
    return new Promise((resolve) => {
      release = resolve;
    }).then((value) => {
      acquired = true;
      return value;
    });
  };
  f.endpoint.dispose = () => {
    acquired = false;
  };
  const session = f.create();
  await assert.rejects(session.close(), code('cleanup'));
  release({
    apiVersion: 'bve-plugin/1',
    pluginId: handshake.pluginId,
    artifactDigest: handshake.artifactDigest,
    manifestDigest: handshake.manifestDigest,
    capabilities: [{ id: 'hover', version: 1 }],
  });
  await pause(1);
  assert.equal(acquired, false);
  assert.equal(session.status.closed, true);
});

void test('prepared-mode asynchronous protocol violations retain cancelled work until cleanup', async () => {
  const f = fixture('hover', { closeMs: 10 });
  let release!: (value: unknown) => void;
  let signal!: AbortSignal;
  let cancelled = 0;
  f.endpoint.provide = (_request, execution) => {
    signal = execution.signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  f.endpoint.cancel = () => {
    cancelled++;
  };
  const session = f.create();
  assert.throws(() => session.providePrepared('hover', metadata, f.context()), code('unsupported'));
  assert.equal(signal.aborted, true);
  assert.equal(session.status.failed, true);
  assert.equal(session.status.owned, 2);
  await assert.rejects(session.close(), code('cleanup'));
  assert.equal(cancelled, 1);
  release({});
  await pause(1);
  assert.equal(session.status.owned, 0);
});

void test('host accepts exactly 64 outstanding invocations and rejects a 65th without entering the provider', async () => {
  const f = fixture('hover', { mode: 'async' });
  let entered = 0;
  f.endpoint.provide = (_request, execution) => {
    entered++;
    return new Promise((_, reject) =>
      execution.signal.addEventListener(
        'abort',
        () => reject(new Error('Cancelled owned invocation.')),
        { once: true },
      ),
    );
  };
  const session = f.create();
  const controller = new AbortController();
  const work = Array.from({ length: 64 }, () =>
    session.provide('hover', metadata, { ...f.context(), signal: controller.signal }),
  );
  await pause(1);
  assert.equal(entered, 64);
  assert.equal(session.status.active, 64);
  await assert.rejects(session.provide('hover', metadata, f.context()), code('resource_limit'));
  assert.equal(entered, 64);
  controller.abort();
  const results = await Promise.allSettled(work);
  assert(results.every((result) => result.status === 'rejected'));
  assert.equal(session.status.active, 0);
  assert.equal(session.status.owned, 0);
  await session.close();
});

void test('validation admission binds actual source/data/activation inputs and permits only materialized data and collection time changes', async () => {
  const f = fixture('validation', { mode: 'async' });
  const original = f.run.request;
  const copy = (): ValidationRequest => JSON.parse(JSON.stringify(original)) as ValidationRequest;
  const output: CapabilityOutputs['validation'] = {
    materializedData: copy().data,
    evaluatedAt: original.execution.startedAt,
    evaluationDataDigest: original.data.digest,
    findings: [],
    coverage: [],
    ruleStates: [],
    artifacts: [],
    interrupted: 'none',
  };
  f.endpoint.provide = (request) => f.report(request, output);
  const session = f.create();
  const context = {
    ...f.context(),
    binding: capabilityBinding(original, { workspaceGeneration: 1 }),
    deadlineAt: original.execution.deadlineAt,
  };
  assert.equal(
    (await session.provide('validation', { request: original }, context)).status,
    'ready',
  );
  for (const key of [
    'sourceDigest',
    'dataDigest',
    'policyDigest',
    'profileDigest',
    'activationDigest',
  ] as const)
    await assert.rejects(
      session.provide(
        'validation',
        { request: original },
        { ...context, binding: { ...context.binding, [key]: digestJson('other') } },
      ),
      code('binding'),
    );
  const tampered = copy();
  tampered.source.files[0]!.text += '# altered\n';
  await assert.rejects(
    session.provide('validation', { request: tampered }, context),
    /digest mismatch/u,
  );
  output.evaluatedAt = original.execution.startedAt + 1;
  assert.equal(
    (await session.provide('validation', { request: original }, context)).status,
    'ready',
  );
  output.evaluatedAt = original.execution.deadlineAt;
  await assert.rejects(
    session.provide('validation', { request: original }, context),
    /deadline|duration/u,
  );
  await session.close();
});

void test('expired validation admission reports the exhausted budget without dispatching the provider', async (t) => {
  const f = fixture('validation', { mode: 'async' });
  let dispatched = 0;
  f.endpoint.provide = () => {
    dispatched++;
    return {};
  };
  const session = f.create();
  const request = f.run.request;
  t.mock.method(Date, 'now', () => request.execution.deadlineAt + 1);
  await assert.rejects(
    session.provide(
      'validation',
      { request },
      {
        requestId: 'expired',
        binding: capabilityBinding(request, { workspaceGeneration: 1 }),
        deadlineAt: request.execution.deadlineAt,
      },
    ),
    (error: unknown) =>
      error instanceof CapabilityError && error.code === 'deadline' && error.phase === 'admission',
  );
  assert.equal(dispatched, 0);
  await session.close();
});

void test('validation service preserves core violations and binds approved catalog authority without exposing credentials', async () => {
  const run = policyRun({
    rules: [
      {
        id: 'production-required',
        version: '1',
        kind: 'cel',
        expression: 'false',
        mandatory: true,
        severity: 'error',
        requires: [],
      },
    ],
  });
  const service = new BuiltinValidationService(run.context, 4);
  const report = await service.run(
    run.request,
    {},
    { workspaceGeneration: 2, dependencyGeneration: 5 },
  );
  assert(report.findings.some((finding) => finding.ruleId === 'production-required'));
  assert(
    report.ruleStates.some(
      (state) => state.ruleId === 'production-required' && state.status === 'failed',
    ),
  );
  assert.equal(report.interrupted, 'none');
  await service.close();
  const access = {
    installationId: 'installation',
    principalId: 'one',
    permissionRevision: 'permissions',
    credentialRevision: 'credential-one',
    scope: ['catalog'],
    policyDigest: run.request.policy.digest,
    profileDigest: run.request.profile.digest,
    maxAgeMs: 1000,
  };
  const catalog = {
    provider: { connectionId: 'catalog-one', adapterId: run.context.profile.adapterId },
    access,
  };
  const first = capabilityAuthorityDigest(run.request.identity, catalog);
  assert.notEqual(
    first,
    capabilityAuthorityDigest(run.request.identity, {
      ...catalog,
      access: { ...access, credentialRevision: 'credential-two' },
    }),
  );
  assert.notEqual(
    first,
    capabilityAuthorityDigest(run.request.identity, {
      ...catalog,
      provider: { ...catalog.provider, connectionId: 'catalog-two' },
    }),
  );
  assert.notEqual(
    first,
    capabilityAuthorityDigest(run.request.identity, {
      ...catalog,
      access: { ...access, principalId: 'two' },
    }),
  );
  assert.match(first, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(createDataSnapshot([]).entries.length, 0);
});

void test('required unavailable dependencies and processors retain incomplete coverage through the validation interface', async () => {
  for (const run of [
    policyRun(),
    policyRun({
      rules: [],
      profile: { requiredProcessors: [{ id: 'required-processor', stage: 'pre-validation' }] },
    }),
  ]) {
    const service = new BuiltinValidationService(run.context);
    const report = await service.run(run.request);
    assert(report.findings.some((finding) => finding.category === 'dependency'));
    assert(report.coverage.some((coverage) => coverage.required && coverage.status !== 'verified'));
    assert(
      !report.ruleStates.some(
        (state) => state.ruleId === 'owner-exists' && state.status === 'passed',
      ),
    );
    await service.close();
  }
});
