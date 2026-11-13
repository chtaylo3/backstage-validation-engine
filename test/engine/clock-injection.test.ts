import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CodeActionParams } from 'vscode-languageserver/node';
import {
  BudgetAdmissionError,
  CEL_LIMITS,
  CelError,
  createCatalogProvider,
  createDataSnapshot,
  createSourceSnapshot,
  createVerifiedPolicyResult,
  digestJson,
  digestText,
  parseContract,
  prepareBackstageReferenceData,
  RequestBudget,
  resultExitCode,
  validatePolicySources,
  verifyPolicyRelease,
} from '../../src/index.js';
import type {
  CatalogAccessContext,
  CatalogProvider,
  Coverage,
  Finding,
  RuleState,
} from '../../src/index.js';
import { CapabilityError } from '../../src/capabilities/admission.js';
import { capabilityBinding } from '../../src/capabilities/bindings.js';
import { builtinCapabilitySession } from '../../src/capabilities/session.js';
import { builtinMetadataSession } from '../../src/capabilities/builtin-metadata.js';
import { prepareRuleContributions, RULE_EDITOR_LIMITS } from '../../src/host/rule-contributions.js';
import type { PreparedRuleMetadata } from '../../src/host/rule-contributions.js';
import { parseLspConfig } from '../../src/lsp/config.js';
import { EditorService } from '../../src/lsp/editor.js';
import { installRuleContributions, rulePreparationExpired } from '../../src/lsp/editor/rules.js';
import { EditorState } from '../../src/lsp/editor/state.js';
import { FIX_LIMITS, FixRegistry } from '../../src/lsp/fixes.js';
import type { CatalogBoundReference } from '../../src/pipeline/catalog-bindings.js';
import { evaluateCatalogRule } from '../../src/pipeline/rules/catalog-rule.js';
import type { RuleOfKind, RuleRecord, RuleRunContext } from '../../src/pipeline/rules/types.js';
import { closeSharedCelRuntime } from '../../src/runtime/cel/index.js';
import type { CelRuntime } from '../../src/runtime/cel/index.js';
import { FailureTimer } from '../../src/runtime/failure-evidence.js';
import { editorArtifact } from '../harness/editor-artifact.js';
import { fixPolicy } from '../harness/fix-fixture.js';
import { ManualClock } from '../harness/manual-clock.js';
import { componentText, policyRun, team } from '../harness/policy-fixture.js';
import { releaseFixture } from '../harness/release-fixture.js';
import { URI } from '../helpers.js';

after(closeSharedCelRuntime);
const T0 = 1_700_000_000_000;
const isCode = (code: string) => (error: unknown) =>
  error instanceof CelError && error.code === code;

void test('request budget admission, immediate expiry and interruption read the injected clock', () => {
  const clock = new ManualClock(T0, 1000);
  assert.throws(
    () => new RequestBudget(T0 + CEL_LIMITS.requestMs + 1, undefined, clock),
    (error: unknown) =>
      error instanceof BudgetAdmissionError && error.reason === 'deadline_out_of_range',
  );
  {
    using ceiling = new RequestBudget(T0 + CEL_LIMITS.requestMs, undefined, clock);
    assert.equal(ceiling.interrupted, false);
    assert.equal(ceiling.clock, clock);
  }
  {
    using now = new RequestBudget(T0, undefined, clock);
    assert.equal(now.signal.aborted, true);
    assert(isCode('request_timeout')(now.signal.reason));
    assert.equal(now.interrupted, true);
  }
  using budget = new RequestBudget(T0 + 100, undefined, clock);
  assert.equal(budget.interrupted, false);
  clock.advance(99);
  // A wall-clock step alone does not expire the budget; elapsed monotonic time does.
  clock.set(T0 + 10_000);
  assert.equal(budget.interrupted, false);
  assert.doesNotThrow(() => budget.throwIfInterrupted());
  clock.advance(1);
  assert.equal(budget.interrupted, true);
  assert.throws(() => budget.throwIfInterrupted(), isCode('request_timeout'));
});

void test('failure timing measures monotonic elapsed time and a bounded wall-time deadline margin', () => {
  const clock = new ManualClock(T0, 1000);
  const timer = new FailureTimer(clock);
  clock.advance(250);
  assert.deepEqual(timer.capture('rules', 'request_timeout', T0 + 1000), {
    stage: 'rules',
    cause: 'request_timeout',
    elapsedMs: 250,
    wallElapsedMs: 250,
    deadlineRemainingMs: 750,
  });
  clock.set(T0 + 250 + 120_000);
  assert.deepEqual(timer.capture('rules', 'request_timeout', T0 + 1000), {
    stage: 'rules',
    cause: 'request_timeout',
    elapsedMs: 250,
    wallElapsedMs: 60_000,
    deadlineRemainingMs: -60_000,
  });
  assert.equal(timer.capture('sources', 'cancelled').deadlineRemainingMs, undefined);
});

const subject = {
  id: JSON.stringify([URI, 0]),
  value: { kind: 'Component', spec: { owner: 'team' } },
  location: {
    uri: URI,
    document: 0,
    path: '',
    range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
  },
};
const catalogRule: RuleOfKind<'catalog'> = {
  id: 'catalog',
  version: '1',
  kind: 'catalog',
  mandatory: true,
  severity: 'error',
  requires: [],
  check: 'exists',
  referencePath: '/spec/owner',
};
function catalogRecord(): RuleRecord {
  const state: RuleState = {
    ruleId: catalogRule.id,
    subjectId: subject.id,
    required: true,
    status: 'passed',
  };
  const coverage: Coverage = {
    stage: 'rules',
    subject: JSON.stringify([subject.id, catalogRule.id]),
    required: true,
    status: 'verified',
  };
  return { state, coverage, findings: [], failures: [], candidates: [] };
}

void test('catalog rule facts are available strictly before their expiry by the run clock', async (t) => {
  const clock = new ManualClock(T0, 1000);
  const run = parseContract('validation-request', {
    ...policyRun({ mode: 'ci' }).request,
    data: createDataSnapshot([]),
  });
  const budget = new RequestBudget(T0 + 1000, undefined, clock);
  t.after(() => budget.dispose());
  const fact = (expiresAt: number): CatalogBoundReference => ({
    status: 'present',
    expiresAt,
    reference: {
      entityPath: '/spec/owner',
      sourceEntityRef: 'component:default/service',
      targetRef: 'group:default/team',
      value: 'team',
      contextPath: '/spec/owner',
      sourceDigest: 'sha256:' + '1'.repeat(64),
      location: { ...subject.location, path: '/spec/owner' },
      relatedLocations: [],
    },
  });
  const evaluate = async (expiresAt: number) => {
    const context: RuleRunContext = {
      run,
      budget,
      runtime: {} as CelRuntime,
      evaluation: { requestId: 'request', deadlineAt: run.execution.deadlineAt },
      schemaValidators: new Map(),
      documents: new Map(),
      substitutions: new Map(),
      catalogBindings: new Map([[subject.id, new Map([['/spec/owner', [fact(expiresAt)]]])]]),
    };
    const record = catalogRecord();
    await evaluateCatalogRule(context, catalogRule, subject, record);
    return [record.state.status, record.state.reason ?? null];
  };
  const unavailable = ['incomplete', 'dependency_unavailable'];
  assert.deepEqual(await evaluate(T0 + 1), ['passed', null]);
  assert.deepEqual(await evaluate(T0), unavailable);
  assert.deepEqual(await evaluate(T0 - 1), unavailable);
  clock.advance(1);
  assert.deepEqual(await evaluate(T0 + 1), unavailable);
});

const TEAM = 'group:default/team';
const MISSING = 'group:default/missing';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
/** A catalog transport that serves `team`, answers 404 otherwise, and runs `onFetch` first. */
function transport(onFetch: () => void = () => {}) {
  const calls: string[] = [];
  const fetcher = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    onFetch();
    return Promise.resolve(
      url.endsWith('/entities/by-name/group/default/team')
        ? json({ ...team, metadata: { namespace: 'default', name: 'team' } })
        : json(
            { error: { name: 'NotFoundError', message: 'absent' }, response: { statusCode: 404 } },
            404,
          ),
    );
  }) as typeof fetch;
  return { calls, fetcher };
}
function catalogAccess(run: ReturnType<typeof policyRun>, maxAgeMs = 30_000): CatalogAccessContext {
  return {
    installationId: run.request.identity.installationId,
    principalId: 'reader',
    permissionRevision: run.request.identity.permissionRevision,
    credentialRevision: 'credentials-1',
    scope: ['catalog:read'],
    policyDigest: run.request.policy.digest,
    profileDigest: run.request.profile.digest,
    maxAgeMs,
  };
}
async function catalogProvider(
  t: TestContext,
  run: ReturnType<typeof policyRun>,
  clock: ManualClock,
  fetcher: typeof fetch,
): Promise<CatalogProvider> {
  const provider = await createCatalogProvider({
    connectionId: 'primary',
    baseUrl: 'https://catalog.example/api/catalog',
    adapterId: run.context.profile.adapterId,
    limits: { retries: 0 },
    transport: fetcher,
    clock,
    credentials: (access) =>
      Promise.resolve({
        token: 'reader-token',
        installationId: access.installationId,
        principalId: access.principalId,
        permissionRevision: access.permissionRevision,
        credentialRevision: access.credentialRevision,
        scope: access.scope,
      }),
  });
  t.after(() => provider.close());
  return provider;
}

void test('catalog provider cache lifetimes, absent lifetimes and future observations read the provider clock', async (t) => {
  const run = policyRun();
  const clock = new ManualClock(T0, 1000);
  const { calls, fetcher } = transport();
  const provider = await catalogProvider(t, run, clock, fetcher);
  const access = catalogAccess(run);
  const lookup = (ref: string) =>
    provider.lookup([ref], access, { deadlineAt: clock.wall() + 1000 });
  const fetched = (ref: string) => calls.filter((url) => url.endsWith(ref.split(':')[1]!)).length;

  const first = await lookup(TEAM);
  assert.equal(first.data.entries[0]?.status, 'present');
  assert.equal(first.data.entries[0]?.provenance.fetchedAt, T0);
  assert.equal(first.data.entries[0]?.provenance.expiresAt, T0 + 30_000);
  clock.advance(29_999);
  await lookup(TEAM);
  assert.equal(fetched(TEAM), 1, 'A present entry is served before its lifetime ends.');
  clock.advance(1);
  const renewed = await lookup(TEAM);
  assert.equal(fetched(TEAM), 2, 'A present entry is fetched again when its lifetime ends.');
  assert.equal(renewed.data.entries[0]?.provenance.fetchedAt, T0 + 30_000);

  const absentAt = clock.wall();
  assert.equal((await lookup(MISSING)).data.entries[0]?.status, 'missing');
  clock.advance(4999);
  await lookup(MISSING);
  assert.equal(fetched(MISSING), 1, 'An absent entry is served before its lifetime ends.');
  clock.advance(1);
  await lookup(MISSING);
  assert.equal(fetched(MISSING), 2, 'An absent entry is fetched again when its lifetime ends.');
  assert.equal(clock.wall(), absentAt + 5000);

  // A wall step back before the cached observation leaves it in the future; it is not served.
  await lookup(TEAM);
  assert.equal(fetched(TEAM), 2, 'The renewed present entry is cached.');
  clock.set(T0 + 30_000 - 1);
  const rolledBack = await lookup(TEAM);
  assert.equal(fetched(TEAM), 3, 'A cached entry with fetchedAt in the future is rejected.');
  assert.equal(rolledBack.data.entries[0]?.provenance.fetchedAt, T0 + 30_000 - 1);
});

void test('a catalog observation fetched after the lookup completes is rejected as a future observation', async (t) => {
  const run = policyRun();
  const clock = new ManualClock(T0, 1000);
  // The response arrives after a backward wall step: its fetch time is later than completion.
  const { fetcher } = transport(() => clock.set(T0 - 10));
  const provider = await catalogProvider(t, run, clock, fetcher);
  const report = await provider.lookup([TEAM], catalogAccess(run, 0), { deadlineAt: T0 + 1000 });
  const entry = report.data.entries[0]!;
  assert.equal(entry.status, 'unavailable');
  assert.equal(entry.provenance.fetchedAt, T0 - 10);
  assert.deepEqual(
    report.failures.map((failure) => [failure.code, failure.evidence?.cause]),
    [['timeout', 'future_observation']],
  );
});

void test('reference preparation pins the evaluation request at the clock time', async (t) => {
  const run = policyRun();
  // Near real time: the source stage and its parsing budget keep the process clock.
  const start = Date.now();
  const clock = new ManualClock(start, 1000);
  const { fetcher } = transport(() => clock.advance(250));
  const provider = await catalogProvider(t, run, clock, fetcher);
  const preparation = await prepareBackstageReferenceData(run.request, run.context, {
    provider,
    access: catalogAccess(run),
    clock,
  });
  assert.equal(preparation.pinFailure, undefined);
  assert.equal(preparation.evaluationRequest?.execution.startedAt, start + 250);
  assert.equal(
    preparation.evaluationRequest?.execution.deadlineAt,
    run.request.execution.deadlineAt,
  );
  const observed = preparation.data.entries.find((entry) => entry.status === 'present');
  assert.equal(observed?.provenance.fetchedAt, start);
});

void test('a verified policy result records the completion time from the caller clock and blocks at expiry', async () => {
  const f = releaseFixture({ rules: [], expiresAt: Date.now() + 1000 });
  const context = verifyPolicyRelease(f.release, f.trust, f.now);
  const base = policyRun({ mode: 'ci', rules: [] });
  const request = parseContract('validation-request', {
    ...base.request,
    policy: { digest: digestJson(context.policy), revision: context.policy.revision },
    activation: {
      digest: digestJson(context.activation),
      generation: context.activation.generation,
    },
  });
  const clock = new ManualClock(request.execution.startedAt + 1, 1000);
  const report = await validatePolicySources(request, context, { clock });
  const completed = createVerifiedPolicyResult(report, context, clock.wall());
  assert.equal(completed.resources.completedAt, request.execution.startedAt + 1);
  assert.equal(completed.freshness.evaluatedAt, request.execution.startedAt + 1);
  assert.equal(resultExitCode(completed), 0);
  clock.set(f.release.expiresAt - 1);
  const last = createVerifiedPolicyResult(report, context, clock.wall());
  assert.equal(last.resources.completedAt, f.release.expiresAt - 1);
  assert.equal(resultExitCode(last), 0);
  clock.set(f.release.expiresAt);
  const expired = createVerifiedPolicyResult(report, context, clock.wall());
  assert.equal(expired.resources.completedAt, f.release.expiresAt);
  assert.equal(resultExitCode(expired), 2);
  assert(expired.coverage.some((row) => row.stage === 'policy' && row.status === 'blocked'));
});

void test('rule contribution metadata expires exactly at its lifetime by the injected clock', async (t) => {
  const rule = {
    id: 'lifecycle-rule',
    version: '1',
    kind: 'cel',
    mandatory: true,
    severity: 'error',
    requires: [] as string[],
    expression: 'entity.spec.lifecycle.matches("production")',
  } as const;
  const run = policyRun({
    text: componentText().replace('production', 'experimental'),
    rules: [rule],
  });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    editorArtifacts: [editorArtifact(run)],
  });
  // Near real time: candidate validation evaluates CEL in workers that keep the process clock.
  const start = Date.now();
  const clock = new ManualClock(start, 1000);
  const service = new EditorService(config, undefined, { clock });
  t.after(() => service.close());
  const documents = new Map(
    run.request.source.files.map((file) => [
      file.uri,
      TextDocument.create(file.uri, 'yaml', file.version ?? 1, file.text),
    ]),
  );
  const report = await validatePolicySources(run.request, run.context);
  await service.update(run.request, 1);
  await service.refine(report, 1);
  const rows = await prepareRuleContributions({
    report,
    context: config,
    artifacts: config.editorArtifacts,
    generation: 1,
    signal: new AbortController().signal,
    current: () => true,
    clock,
    render: (subjectId, path, value, ruleId) =>
      service.renderRuleCandidate(subjectId, path, value, ruleId, 1, documents, report.findings),
  });
  assert(rows.length && rows[0]!.candidates.length, JSON.stringify(rows));
  const lifetime = start + RULE_EDITOR_LIMITS.ttlMs;
  for (const row of rows) {
    assert.equal(row.expiresAt, lifetime);
    for (const candidate of row.candidates) assert.equal(candidate.evidence.expiresAt, lifetime);
  }
  service.installRuleContributions(rows, 1);
  assert.equal(service.ruleExpiresAt, lifetime);
  clock.advance(RULE_EDITOR_LIMITS.ttlMs - 1);
  assert.equal(service.rulePreparationExpired, false);
  assert.equal(service.ruleRepairs(1, documents).length > 0, true);
  clock.advance(1);
  assert.equal(service.rulePreparationExpired, true);
  assert.deepEqual(service.ruleRepairs(1, documents), []);
});

const fixText = 'abc\ndef';
const fixRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
const fixFinding: Finding = {
  id: 'fix-1',
  ruleId: 'required-value',
  ruleVersion: '1',
  subjectId: 'service',
  message: 'Entity does not satisfy the policy schema.',
  category: 'policy',
  severity: 'error',
  enforcement: 'advisory',
  location: { uri: URI, document: 0, path: '/value', range: fixRange },
  relatedLocations: [],
  edits: [
    { uri: URI, sourceDigest: digestText(fixText), version: 1, range: fixRange, text: 'new' },
  ],
};

void test('a fix expires at its lifetime or its data expiry, whichever is earlier', () => {
  const documents = new Map([[URI, TextDocument.create(URI, 'yaml', 1, fixText)]]);
  const source = createSourceSnapshot({
    repository: 'repo',
    revision: '1',
    files: [{ uri: URI, text: fixText, version: 1, origin: 'buffer' }],
  });
  const params: CodeActionParams = {
    textDocument: { uri: URI },
    range: fixRange,
    context: { diagnostics: [] },
  };
  const limits = {
    fileBytes: 100_000,
    requestBytes: 100_000,
    sourceBytes: Buffer.byteLength(fixText),
    atomicTextEdits: true,
  };
  for (const [dataExpiry, boundary] of [
    [FIX_LIMITS.ttlMs + 5000, FIX_LIMITS.ttlMs],
    [1500, 1500],
  ] as const) {
    const clock = new ManualClock(T0, 1000);
    const registry = new FixRegistry(clock);
    registry.replace({
      generation: 1,
      findings: [fixFinding],
      source,
      documents,
      expiresAt: T0 + dataExpiry,
    });
    const actions = () => registry.actions(params, 1, documents, limits).length;
    assert.equal(actions(), 1);
    clock.advance(boundary - 1);
    assert.equal(actions(), 1, `available before ${boundary}`);
    clock.advance(1);
    assert.equal(actions(), 0, `expired at ${boundary}`);
  }
});

void test('editor rule contributions expire at the boundary and a backward wall step does not extend them', () => {
  const run = policyRun({ rules: [] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  const clock = new ManualClock(T0, 1000);
  const state = new EditorState(config, builtinMetadataSession([], clock), { clock });
  state.generation = 1;
  const row: PreparedRuleMetadata = {
    subjectId: 'subject',
    path: '/spec/lifecycle',
    artifactDigest: 'sha256:' + '3'.repeat(64),
    ruleId: 'rule',
    description: 'Lifecycle.',
    candidates: [],
    expiresAt: T0 + 1000,
  };
  installRuleContributions(state, [row], 1);
  assert.equal(rulePreparationExpired(state), false);
  clock.advance(999);
  assert.equal(rulePreparationExpired(state), false);
  clock.advance(1);
  assert.equal(rulePreparationExpired(state), true);
  // Wall time stepped back inside the lifetime: elapsed monotonic time still expires the rows.
  clock.set(T0 + 500);
  assert.equal(rulePreparationExpired(state), true);
  // A fresh installation after a backward step before the install time shows nothing.
  installRuleContributions(state, [row], 1);
  clock.set(T0 - 1);
  assert.equal(rulePreparationExpired(state), true);
});

void test('capability session admission and reply deadlines fire at the boundary of the session clock', () => {
  const clock = new ManualClock(T0, 1000);
  let onHover = () => {};
  const session = builtinCapabilitySession(
    'bve.test.clock',
    {
      hover: () => {
        onHover();
        return { text: 'Approved description.' };
      },
    },
    { clock },
  );
  const run = policyRun({ rules: [] });
  const context = (deadlineAt: number) => ({
    requestId: 'clock-request',
    binding: capabilityBinding(run.request, { workspaceGeneration: 1 }),
    deadlineAt,
  });
  const input = {
    path: '/spec',
    subjectStage: 'authored' as const,
    scope: { status: 'known' as const, kind: 'Component', apiVersion: 'backstage.io/v1alpha1' },
    subject: { state: 'present' as const, value: { spec: {} } },
    schemas: [],
  };
  const deadline = (phase: string) => (error: unknown) =>
    error instanceof CapabilityError && error.code === 'deadline' && error.phase === phase;
  assert.throws(() => session.providePrepared('hover', input, context(T0)), deadline('admission'));
  assert.equal(session.providePrepared('hover', input, context(T0 + 1)).status, 'ready');
  onHover = () => clock.set(T0 + 99);
  assert.equal(session.providePrepared('hover', input, context(T0 + 100)).status, 'ready');
  clock.set(T0);
  onHover = () => clock.set(T0 + 100);
  assert.throws(
    () => session.providePrepared('hover', input, context(T0 + 100)),
    deadline('reply'),
  );
});

void test('a local editor answer is returned however long it took, until the request time is spent', async (t) => {
  const text = componentText().replace('production', '');
  const run = policyRun({ text, ...fixPolicy('production') });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  // A host under load: once `busy` is set, every look at the clock finds that much time gone.
  const manual = new ManualClock(Date.now(), 1000);
  let busy = 0;
  const clock = {
    wall: () => (manual.advance(busy), manual.wall()),
    monotonic: () => (manual.advance(busy), manual.monotonic()),
  };
  const service = new EditorService(config, undefined, { clock });
  t.after(() => service.close());
  const documents = new Map([[URI, TextDocument.create(URI, 'yaml', 1, text)]]);
  await service.update(run.request, 1);
  const position = { textDocument: { uri: URI }, position: { line: 5, character: 13 } };
  const labels = () => service.complete(position, 1, documents).items.map((item) => item.label);
  assert.deepEqual(labels(), ['production']);
  // The answer is computed synchronously, so time that passes while it is computed has already
  // been spent. Refusing the finished answer would return nothing and save nothing.
  busy = 60;
  assert.deepEqual(labels(), ['production']);
  assert.match(JSON.stringify(service.hover(URI, position.position, 1, documents)), /production/u);
  // The bound that remains is the request time of the profile: an answer that is not admitted
  // within it is refused.
  busy = config.profile.limits.requestTimeoutMs;
  assert.deepEqual(labels(), []);
});
