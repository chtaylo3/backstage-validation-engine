import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  closeSharedCelRuntime,
  digestJson,
  locateParsedPath,
  parseContract,
  validatePolicySources,
} from '../../src/index.js';
import { createCustomKindRegistry } from '../../src/compatibility/custom-schemas.js';
import { validateSourceDocument } from '../../src/compatibility/stages/document.js';
import { resolveIdentityConflicts } from '../../src/compatibility/stages/identity-conflicts.js';
import { discoverIncludedSources } from '../../src/compatibility/stages/locations.js';
import { prepareSourceRun } from '../../src/compatibility/stages/prepare.js';
import { openSourceRun } from '../../src/compatibility/stages/state.js';
import type { DocumentProgress, SourceRunState } from '../../src/compatibility/stages/state.js';
import { SourceResolutionError } from '../../src/compatibility/substitutions.js';
import type { SnapshotSourceResolver } from '../../src/compatibility/substitutions.js';
import { BackstageRuntimeError } from '../../src/compatibility/types.js';
import type { NativeEntityCheck, SourceIdentityClaim } from '../../src/compatibility/types.js';
import type { Interruption } from '../../src/core/stage-report.js';
import type { ParsingReport } from '../../src/parsing/index.js';
import { CelError } from '../../src/runtime/cel/errors.js';
import { RequestBudget } from '../../src/runtime/request-budget.js';
import { ManualClock } from '../harness/manual-clock.js';
import { componentText, policyRun } from '../harness/policy-fixture.js';
import { URI } from '../helpers.js';

const ROOT = 'file:///workspace/';
const DEADLINE_MS = 5000;
const budgets: RequestBudget[] = [];
after(() => {
  for (const budget of budgets) budget[Symbol.dispose]();
  return closeSharedCelRuntime();
});

/** Opens a source run on the default single-Component request and prepares the real adapter. */
async function preparedRun(): Promise<SourceRunState> {
  const run = policyRun({ mode: 'ci', rules: [] });
  const profile = parseContract('deployment-profile', run.context.profile);
  const budget = new RequestBudget(run.request.execution.deadlineAt);
  budgets.push(budget);
  const state = await openSourceRun(run.request, profile, budget, undefined);
  await prepareSourceRun(state, []);
  assert.equal(state.interrupted, 'none');
  return state;
}

/** Seventy claims on one identity: more than the 64 competing-claim findings the stage reports. */
function competingClaims(count = 70): SourceIdentityClaim[] {
  return Array.from({ length: count }, (_, index) => ({
    uri: `${ROOT}${index}.yaml`,
    document: 0,
    entityRef: 'component:default/same',
    location: {
      uri: `${ROOT}${index}.yaml`,
      document: 0,
      path: '/metadata',
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
    },
    relatedLocations: [],
  }));
}

const failures = {
  timeout: () => new CelError('request_timeout'),
  cancelled: () => new CelError('cancelled'),
  resource_limit: () => new BackstageRuntimeError('resource_limit'),
} as const;

/** Fails native validation of the first document with `cause`, through the document driver. */
async function failDocument(state: SourceRunState, cause: keyof typeof failures) {
  const failing: SourceRunState = {
    ...state,
    adapter: { ...state.adapter!, normalizeEntity: () => Promise.reject(failures[cause]()) },
  };
  await validateSourceDocument(failing, failing.documents[0]!);
  return failing;
}

function progressFor(state: SourceRunState): DocumentProgress {
  const document = state.documents[0]!;
  return {
    phase: 'native',
    document,
    claim: {
      uri: document.uri,
      document: document.document,
      location: locateParsedPath(document, '/metadata'),
      relatedLocations: [],
    },
    subject: JSON.stringify([document.uri, document.document]),
    claimIndex: 0,
    adapter: state.adapter!,
    customKinds: createCustomKindRegistry(state.profile),
  };
}

/**
 * Runs Location discovery for the first document with a stub resolver that returns one included
 * parsing report per entry of `reports` (each interrupted by that cause) and, when `limited`, one
 * `resource_limit` discovery issue after them.
 */
async function discover(reports: readonly Interruption[], limited = false) {
  const state = await preparedRun();
  const progress = progressFor(state);
  const included = (interrupted: Interruption): ParsingReport => ({
    ...state.parsed,
    files: [],
    documents: [],
    diagnostics: [],
    coverage: [],
    interrupted,
  });
  const issue = new SourceResolutionError(
    'resource_limit',
    '/spec/target',
    locateParsedPath(progress.document, '/spec'),
  );
  const resolver = Object.assign(Object.create(state.resolver) as SnapshotSourceResolver, {
    discover: () =>
      Promise.resolve({
        documents: [],
        reports: reports.map(included),
        issues: limited ? [issue] : [],
      }),
  });
  const discovering: SourceRunState = { ...state, resolver };
  await discoverIncludedSources(
    discovering,
    progress,
    'location:default/sources',
    {} as NativeEntityCheck,
  );
  return discovering;
}

const PRIORITY: readonly Interruption[] = ['resource_limit', 'cancelled', 'timeout'];
const higher = (a: Interruption, b: Interruption) =>
  PRIORITY.indexOf(a) >= PRIORITY.indexOf(b) ? a : b;

void test('a timed-out document keeps its timeout when the competing-claim cap follows', async () => {
  const state = await failDocument(await preparedRun(), 'timeout');
  assert.equal(state.interrupted, 'timeout');
  state.sourceClaims.push(...competingClaims());
  resolveIdentityConflicts(state);
  assert.equal(state.interrupted, 'timeout');
});

void test('a cancelled document keeps its cancellation when the competing-claim cap follows', async () => {
  const state = await failDocument(await preparedRun(), 'cancelled');
  assert.equal(state.interrupted, 'cancelled');
  state.sourceClaims.push(...competingClaims());
  resolveIdentityConflicts(state);
  assert.equal(state.interrupted, 'cancelled');
});

void test('every document failure cause followed by the competing-claim cap reports the higher cause', async () => {
  for (const cause of Object.keys(failures) as (keyof typeof failures)[]) {
    const state = await failDocument(await preparedRun(), cause);
    state.sourceClaims.push(...competingClaims());
    resolveIdentityConflicts(state);
    assert.equal(state.interrupted, higher(cause, 'resource_limit'), cause);
  }
});

void test('included reports interrupted in descending priority keep the first, higher cause', async () => {
  const state = await discover(['timeout', 'resource_limit']);
  assert.equal(state.interrupted, 'timeout');
});

void test('an included cancellation is kept when the discovery resource limit follows', async () => {
  const state = await discover(['cancelled'], true);
  assert.equal(state.interrupted, 'cancelled');
});

void test('included reports in ascending priority still rise to the higher cause', async () => {
  const state = await discover(['resource_limit', 'timeout']);
  assert.equal(state.interrupted, 'timeout');
});

void test('every ordered pair of included report causes, with and without a discovery limit, reports the higher cause', async () => {
  for (const first of PRIORITY)
    for (const second of PRIORITY)
      for (const limited of [false, true]) {
        const state = await discover([first, second], limited);
        assert.equal(
          state.interrupted,
          higher(higher(first, second), limited ? 'resource_limit' : first),
          `${first}, ${second}, limited: ${limited}`,
        );
      }
});

void test('each site alone reports exactly the cause it reported before', async (t) => {
  await t.test('preparation', async () => {
    for (const [error, expected] of [
      [new CelError('request_timeout'), 'timeout'],
      [new CelError('cancelled'), 'cancelled'],
      [new BackstageRuntimeError('adapter_unavailable'), 'none'],
    ] as const) {
      const run = policyRun({ mode: 'ci', rules: [] });
      const profile = parseContract('deployment-profile', run.context.profile);
      const budget = new RequestBudget(run.request.execution.deadlineAt);
      budgets.push(budget);
      const state = await openSourceRun(run.request, profile, budget, undefined);
      await prepareSourceRun(state, [], () => Promise.reject(error));
      assert.equal(state.interrupted, expected);
    }
  });
  await t.test('substitution resource limit', async () => {
    const state = await preparedRun();
    const resolver = Object.assign(Object.create(state.resolver) as SnapshotSourceResolver, {
      resolve: (document: SourceRunState['documents'][number]) =>
        Promise.reject(
          new SourceResolutionError('resource_limit', '/spec', locateParsedPath(document, '/spec')),
        ),
    });
    const resolving: SourceRunState = { ...state, resolver };
    await validateSourceDocument(resolving, resolving.documents[0]!);
    assert.equal(resolving.interrupted, 'resource_limit');
  });
  await t.test('document failure', async () => {
    for (const cause of Object.keys(failures) as (keyof typeof failures)[])
      assert.equal((await failDocument(await preparedRun(), cause)).interrupted, cause);
  });
  await t.test('included report', async () => {
    for (const cause of PRIORITY) assert.equal((await discover([cause])).interrupted, cause);
  });
  await t.test('discovery resource limit', async () => {
    assert.equal((await discover([], true)).interrupted, 'resource_limit');
  });
  await t.test('competing-claim cap', async () => {
    const state = await preparedRun();
    state.sourceClaims.push(...competingClaims());
    resolveIdentityConflicts(state);
    assert.equal(state.interrupted, 'resource_limit');
  });
  await t.test('no cause', async () => {
    const state = await preparedRun();
    await validateSourceDocument(state, state.documents[0]!);
    state.sourceClaims.push(...competingClaims(3).slice(0, 1));
    resolveIdentityConflicts(state);
    assert.equal(state.interrupted, 'none');
  });
});

void test('merging the cause leaves the blocked reason, availability, findings and coverage as they were', async () => {
  const state = await failDocument(await preparedRun(), 'timeout');
  state.sourceClaims.push(...competingClaims());
  resolveIdentityConflicts(state);
  // `blockedReason` still names the document failure; the conflict cap does not assign it.
  assert.equal(
    state.blockedReason,
    'Validation request deadline exceeded during native validation.',
  );
  assert.equal(state.unavailable, true);
  assert.deepEqual(
    [state.findings.length, state.findings[0]?.ruleId, state.findings[1]?.ruleId],
    [65, 'backstage/timeout', 'backstage/overlay/competing_claims'],
  );
  assert.deepEqual(
    state.coverage.slice(-2).map((row) => [row.stage, row.subject, row.status]),
    [
      ['compatibility', JSON.stringify([URI, 0]), 'blocked'],
      ['overlay', 'source-identities', 'blocked'],
    ],
  );
  // Captured from the code before the fix, which differed only in `interrupted`.
  assert.equal(
    digestJson({
      blockedReason: state.blockedReason,
      unavailable: state.unavailable,
      unresolvedIncludes: state.unresolvedIncludes,
      findings: state.findings,
      coverage: state.coverage,
    }),
    'sha256:28311481aa009ca71028296792cdbf79193743d9744610f6ec36aae369480086',
  );
});

/**
 * A manual clock that moves a fixed step on every monotonic reading, so that a run reaches its
 * deadline after a number of readings rather than after real time. The step is chosen so that a
 * 200-file run passes parsing (about 86 readings per file) and times out in the document loop
 * (about 43 readings per document) near its 117th document: after more than 64 documents claimed
 * one identity, and well before the last. Cooperative yields add a few readings by real time,
 * which moves the timeout by a document or two at most.
 */
class TickingClock extends ManualClock {
  override monotonic(): number {
    this.advance(0.225);
    return super.monotonic();
  }
}

void test('end to end, a timeout followed by the competing-claim cap reports a timeout and its evidence', async () => {
  const PAST = Date.UTC(2019, 0, 1);
  // Every file holds the same Component, so every resolved file claims one identity.
  const files = Array.from({ length: 199 }, (_, index) => ({
    uri: `${ROOT}${String(index).padStart(3, '0')}.yaml`,
    text: componentText(),
  }));
  const run = policyRun({
    mode: 'ci',
    rules: [],
    files,
    profile: {
      limits: { ...policyRun().context.profile.limits, entities: 200 },
    },
  });
  const request = parseContract('validation-request', {
    ...run.request,
    execution: { ...run.request.execution, startedAt: PAST, deadlineAt: PAST + DEADLINE_MS },
  });
  const report = await validatePolicySources(request, run.context, {
    clock: new TickingClock(PAST, 1000),
  });
  const ruleIds = report.compatibility.findings.map((finding) => finding.ruleId);
  // The scenario: a document timed out after more than 64 documents had claimed one identity.
  assert(ruleIds.includes('backstage/timeout'), JSON.stringify([...new Set(ruleIds)]));
  assert.equal(
    ruleIds.filter((id) => id === 'backstage/overlay/competing_claims').length,
    64,
    JSON.stringify([...new Set(ruleIds)]),
  );
  assert.equal(report.compatibility.interrupted, 'timeout');
  assert.equal(report.interrupted, 'timeout');
  assert.deepEqual(
    report.failureEvidence.filter((row) => row.stage === 'sources').map((row) => row.cause),
    ['request_timeout'],
  );
});
