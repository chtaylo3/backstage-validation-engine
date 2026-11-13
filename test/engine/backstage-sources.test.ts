import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { stringify } from 'yaml';
import {
  BACKSTAGE_ADAPTER_IDS,
  createSourceSnapshot,
  createValidationResult,
  digestJson,
  parseContract,
  resultExitCode,
  validateBackstageSources,
} from '../../src/index.js';
import type { DeploymentProfile, JsonValue, NativePolicyName } from '../../src/index.js';
import { URI, makeContext, makeRequest } from '../helpers.js';

type Fixture = {
  kind: string;
  metadata: { name: string };
  spec: Record<string, JsonValue>;
  apiVersion: string;
};
const fixtures = JSON.parse(
  await readFile('test/fixtures/backstage-entities.json', 'utf8'),
) as Fixture[];
const component = fixtures[0]!;

function setup(
  text: string,
  profilePatch: Partial<DeploymentProfile> = {},
  mode: 'ci' | 'ide' = 'ci',
  milliseconds = 5000,
) {
  const original = makeContext();
  const profile = parseContract('deployment-profile', { ...original.profile, ...profilePatch });
  const activation = parseContract('activation-manifest', {
    ...original.activation,
    profileDigest: digestJson(profile),
  });
  const now = Date.now();
  const source = createSourceSnapshot({
    repository: 'repository',
    revision: 'source-revision-1',
    files: [{ uri: URI, text, origin: 'buffer', version: 7 }],
  });
  const request = parseContract('validation-request', {
    ...makeRequest(mode),
    source,
    execution: { mode, startedAt: now, deadlineAt: now + milliseconds },
    profile: { id: profile.id, digest: digestJson(profile) },
    activation: { generation: activation.generation, digest: digestJson(activation) },
  });
  return { request, context: { ...original, profile, activation } };
}

void test('BC-01/02 source pipeline supports both pins and retains authored versus normalized provenance', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS) {
    const run = setup(fixtures.map((entity) => stringify(entity)).join('---\n'), { adapterId });
    // The native corpus contains a required file Location; BC-04 now executes it.
    run.request = parseContract('validation-request', {
      ...run.request,
      source: createSourceSnapshot({
        repository: run.request.source.repository,
        revision: run.request.source.revision,
        rootUri: 'file:///workspace/',
        entrypoints: [URI],
        files: [...run.request.source.files, { uri: 'file:///workspace/component.yaml', text: '' }],
      }),
    });
    const report = await validateBackstageSources(run.request, run.context);
    assert.equal(report.entities.length, 8);
    assert.equal(report.adapterId, adapterId);
    assert.equal(report.findings.length, 0);
    assert.equal(report.interrupted, 'none');
    for (let index = 0; index < report.entities.length; index++) {
      await t.test(`${adapterId} ${fixtures[index]!.kind}`, () => {
        const entity = report.entities[index]!;
        assert.equal(entity.document.document, index);
        assert.equal(entity.document.version, 7);
        assert.deepEqual(entity.authored, fixtures[index]);
        assert.equal(entity.changes[0]?.path, '/metadata/namespace');
        assert.equal(entity.changes[0]?.origin.uri, URI);
        assert.equal(entity.changes[0]?.origin.path, '/metadata/namespace');
        assert.equal(report.artifacts[index]?.sourceDigest, run.request.source.files[0]?.digest);
        assert.equal(
          report.artifacts[index]?.provenance[0]?.transformation,
          `${adapterId}/default_namespace`,
        );
        assert(Object.isFrozen(entity.normalized));
      });
    }
  }
});

void test('native rejections have precise, redacted field locations and block CI', async () => {
  const entity = { ...component, metadata: { name: 'bad name' } };
  const run = setup(stringify(entity));
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.entities.length, 0);
  assert.equal(report.findings[0]?.location.path, '/metadata/name');
  assert.equal(report.findings[0]?.location.range.start.line, 3);
  assert.equal(report.findings[0]?.category, 'compatibility');
  assert(!JSON.stringify(report.findings).includes('bad name'));
  const result = createValidationResult({
    request: run.request,
    ...report,
    completedAt: Date.now(),
    authorityCheckedAt: run.request.execution.startedAt,
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(resultExitCode(result), 1);
});

void test('missing required fields use missing-field pointers and ancestor source ranges', async () => {
  const { owner: omitted, ...spec } = component.spec;
  assert.equal(omitted, 'team');
  const run = setup(stringify({ ...component, spec }));
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.findings[0]?.location.path, '/spec/owner');
  assert.equal(report.findings[0]?.category, 'compatibility');
  assert.equal(report.entities.length, 0);
});

void test('native metadata schema validation points to authored data without leaking values', async () => {
  const run = setup(
    stringify({ ...component, metadata: { name: 'service', labels: { name: 42 } } }),
  );
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.findings[0]?.location.path, '/metadata/labels/name');
  assert.equal(report.entities.length, 0);
});

void test('required unavailable processors suppress speculative owner/schema failures', async () => {
  const run = setup(
    stringify({ ...component, spec: { type: 'service', lifecycle: 'production' } }),
    {
      requiredProcessors: [{ id: 'organization-owner-injector', stage: 'pre-validation' }],
    },
  );
  const report = await validateBackstageSources(run.request, run.context);
  assert.equal(report.entities.length, 0);
  assert(report.findings.every((finding) => finding.category === 'dependency'));
  assert(report.coverage.some((entry) => entry.status === 'unsupported' && entry.required));
  assert(
    report.coverage.some((entry) => entry.stage === 'compatibility' && entry.status === 'blocked'),
  );
  const result = createValidationResult({
    request: run.request,
    ...report,
    completedAt: Date.now(),
    authorityCheckedAt: run.request.execution.startedAt,
  });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(resultExitCode(result), 2);
  assert.throws(
    () =>
      setup(stringify(component), {
        requiredProcessors: [
          { id: 'x', stage: 'y' },
          { id: 'x', stage: 'y' },
        ],
      }),
    /duplicate/,
  );
});

void test('unresolved substitutions are incomplete and never become raw native violations', async () => {
  for (const marker of ['$text', '$json', '$yaml']) {
    const run = setup(
      stringify({ ...component, spec: { ...component.spec, owner: { [marker]: './owner.txt' } } }),
    );
    const report = await validateBackstageSources(run.request, run.context);
    assert.equal(report.entities.length, 0);
    assert.equal(report.findings[0]?.category, 'dependency');
    assert.equal(report.findings[0]?.location.path, `/spec/owner/${marker}`);
    assert(
      report.coverage.some(
        (entry) => entry.stage === 'substitution' && entry.status === 'unsupported',
      ),
    );
    assert(!report.findings.some((finding) => finding.category === 'compatibility'));
  }
});

void test('admitted unknown kinds and API versions retain unsupported native coverage', async () => {
  for (const entity of [
    { ...component, kind: 'Custom' },
    { ...component, apiVersion: 'example.com/v999' },
  ]) {
    const run = setup(stringify(entity), {
      admission: { allowedKinds: ['Component', 'Custom'], locations: [] },
    });
    const report = await validateBackstageSources(run.request, run.context);
    assert.equal(report.entities.length, 0);
    assert.equal(report.findings[0]?.category, 'dependency');
    assert(report.coverage.some((entry) => entry.status === 'unsupported'));
    assert(
      report.coverage.some((entry) => entry.stage === 'admission' && entry.status === 'verified'),
    );
  }
});

void test('CI excludes invalid parsed sources while IDE keeps unaffected documents', async () => {
  const text = `metadata: [broken\n---\n${stringify(component)}`;
  for (const mode of ['ci', 'ide'] as const) {
    const run = setup(text, {}, mode);
    const report = await validateBackstageSources(run.request, run.context);
    assert.equal(report.entities.length, mode === 'ci' ? 0 : 1);
    if (mode === 'ide') assert.equal(report.entities[0]?.document.document, 1);
    assert(report.findings.some((finding) => finding.ruleId.startsWith('yaml/')));
    assert(!report.findings.some((finding) => finding.ruleId.includes('invalid_envelope')));
    assert(
      report.findings.every(
        (finding) => finding.enforcement === (mode === 'ci' ? 'blocking' : 'advisory'),
      ),
    );
  }
});

void test('source provenance for opt-in group-parent defaults maps to the authored spec', async () => {
  const group = fixtures.find((entity) => entity.kind === 'Group')!;
  const defaults = makeContext().profile.nativePolicies;
  const run = setup(stringify(group), {
    nativePolicies: {
      ...defaults,
      groupDefaultParent: true,
      groupDefaultParentRef: 'group:default/root',
    },
  });
  const report = await validateBackstageSources(run.request, run.context);
  const change = report.entities[0]?.changes.find(
    (entry) => entry.policy === ('group_default_parent' satisfies NativePolicyName),
  );
  assert.equal(change?.path, '/spec/parent');
  assert.equal(change?.after, 'group:default/root');
  assert.equal(change?.origin.path, '/spec/parent');
  assert.equal(change?.origin.uri, URI);
});

void test('source compatibility retains request cancellation, pinned bindings and normalized size budgets', async () => {
  const abort = new AbortController();
  abort.abort();
  const run = setup(stringify(component));
  const cancelled = await validateBackstageSources(run.request, run.context, {
    signal: abort.signal,
  });
  assert.equal(cancelled.interrupted, 'cancelled');
  assert.equal(cancelled.entities.length, 0);
  assert(cancelled.coverage.some((entry) => entry.required && entry.status === 'blocked'));
  await assert.rejects(
    validateBackstageSources(run.request, {
      ...run.context,
      profile: { ...run.context.profile, id: 'tampered' },
    }),
    /pinned artifact/,
  );
  const limits = makeContext().profile.limits;
  const normalized = setup(stringify(component), {
    limits: { ...limits, expandedEntityBytes: Buffer.byteLength(JSON.stringify(component)) },
  });
  const exceeded = await validateBackstageSources(normalized.request, normalized.context);
  assert.equal(exceeded.interrupted, 'resource_limit');
  assert.equal(exceeded.entities.length, 0);
  const expired = setup(stringify(component), {}, 'ci', 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(
    (await validateBackstageSources(expired.request, expired.context)).interrupted,
    'timeout',
  );
});
