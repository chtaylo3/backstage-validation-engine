import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { stringify } from 'yaml';
import {
  BACKSTAGE_ADAPTER_IDS,
  closeSharedCelRuntime,
  createSourceSnapshot,
  createValidationResult,
  digestText,
  overlaySourceSnapshot,
  parseContract,
  resultExitCode,
  validateBackstageSources,
  validatePolicySources,
} from '../src/index.js';
import type { JsonValue } from '../src/index.js';
import { URI } from './helpers.js';
import { componentText, ownerRule, policyMatrix, policyRun } from './harness/policy-fixture.js';

const ROOT = 'file:///workspace/';
const SPEC = { type: 'service', lifecycle: 'production', owner: 'team' };
const input = (spec: JsonValue) =>
  stringify({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'service' },
    spec,
  });
const location = (spec: JsonValue, name = 'sources') =>
  stringify({ apiVersion: 'backstage.io/v1alpha1', kind: 'Location', metadata: { name }, spec });
const run = (options: Parameters<typeof policyRun>[0] = {}) =>
  policyRun({ mode: 'ci', rootUri: ROOT, entrypoints: [URI], ...options });
const validate = (state: ReturnType<typeof policyRun>, signal?: AbortSignal) =>
  validateBackstageSources(state.request, state.context, signal ? { signal } : {});
const result = (
  state: ReturnType<typeof policyRun>,
  report: Awaited<ReturnType<typeof validate>>,
) =>
  createValidationResult({
    request: state.request,
    ...report,
    completedAt: Date.now(),
    authorityCheckedAt: state.request.execution.startedAt,
  });
test.after(closeSharedCelRuntime);

void test('BC-04 text/JSON/YAML substitution preserves authored, resolved and normalized values on both native pins', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    for (const marker of ['$text', '$json', '$yaml'] as const)
      await t.test(`${adapterId}/${marker}`, async () => {
        const text =
          marker === '$text'
            ? input({ ...SPEC, description: { [marker]: './payload.txt' } })
            : input({ [marker]: './payload.txt' });
        const payload =
          marker === '$text'
            ? '😀\r\nraw data\n'
            : marker === '$json'
              ? JSON.stringify(SPEC)
              : stringify(SPEC);
        const state = run({
          text,
          files: [{ uri: ROOT + 'payload.txt', text: payload, origin: 'buffer', version: 9 }],
          profile: { adapterId },
        });
        const report = await validate(state);
        assert.equal(report.findings.length, 0);
        assert.equal(report.entities.length, 1);
        const entity = report.entities[0]!;
        assert.deepEqual(entity.authored, entity.document.value);
        assert.deepEqual(entity.resolved, {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Component',
          metadata: { name: 'service' },
          spec: { ...SPEC, ...(marker === '$text' ? { description: payload } : {}) },
        });
        assert.equal(entity.substitutions[0]?.kind, marker);
        assert.equal(entity.substitutions[0]?.target.version, 9);
        assert.equal(entity.substitutions[0]?.target.sourceDigest, digestText(payload));
        assert(
          report.artifacts[0]?.provenance.some(
            (entry) => entry.transformation === `snapshot-local/${marker}`,
          ),
        );
        assert(Object.isFrozen(entity.resolved));
        assert.equal(report.unresolvedSourceIdentities, false);
      });
});

void test('BC-04 nested relative includes retain actual source pointers, digests, versions and the full use chain', async () => {
  const state = run({
    text: input({ $yaml: './parts/spec.yaml' }),
    files: [
      {
        uri: ROOT + 'parts/spec.yaml',
        text: stringify({ ...SPEC, owner: { $text: '../owner.txt' } }),
      },
      { uri: ROOT + 'owner.txt', text: 'team', origin: 'buffer', version: 11 },
    ],
  });
  const report = await validate(state);
  const reference = report.references[0]!;
  assert.equal(report.findings.length, 0);
  assert.equal(reference.entityPath, '/spec/owner');
  assert.equal(reference.location.uri, ROOT + 'owner.txt');
  assert.equal(reference.location.path, '');
  assert.equal(reference.sourceDigest, digestText('team'));
  assert.equal(reference.version, 11);
  assert.deepEqual(
    reference.relatedLocations.map((item) => item.uri),
    [URI, ROOT + 'parts/spec.yaml'],
  );
  assert.equal(reference.targetRef, 'group:default/team');
  assert.equal(report.entities[0]?.substitutions.length, 2);
});

void test('BC-04 native errors in included structures use included ranges and keep entity-use provenance', async () => {
  const state = run({
    text: input({ $yaml: './parts/spec.yaml' }),
    files: [
      { uri: ROOT + 'parts/spec.yaml', text: 'type: service\nlifecycle: production\nowner: 42\n' },
    ],
  });
  const report = await validate(state);
  assert.equal(report.entities.length, 0);
  assert.equal(report.findings[0]?.location.uri, ROOT + 'parts/spec.yaml');
  assert.equal(report.findings[0]?.location.path, '/owner');
  assert.equal(report.findings[0]?.location.range.start.line, 2);
  assert.equal(report.findings[0]?.relatedLocations[0]?.uri, URI);
  assert.equal(resultExitCode(result(state, report)), 1);
});

void test('BC-04 malformed JSON/YAML, duplicate keys, multiple documents and unsafe values withhold native checks', async (t) => {
  for (const [marker, payload] of [
    ['$json', 'owner: team'],
    ['$json', '{"owner":"team","owner":"private"}'],
    ['$yaml', 'owner: [broken'],
    ['$yaml', 'owner: team\nowner: private'],
    ['$yaml', 'owner: team\n---\nowner: other'],
    ['$yaml', 'owner: 9007199254740993'],
    ['$yaml', 'base: &a {owner: team}\n<<: *a'],
    ['$yaml', ''],
  ] as const)
    await t.test(`${marker}/${payload.slice(0, 12)}`, async () => {
      const state = run({
        text: input({ [marker]: './payload' }),
        files: [{ uri: ROOT + 'payload', text: payload }],
      });
      const report = await validate(state);
      assert.equal(report.entities.length, 0);
      assert(report.findings.some((finding) => finding.ruleId.endsWith('/invalid_inclusion')));
      assert(
        !report.findings.some((finding) =>
          /invalid_kind|invalid_policy_value/.test(finding.ruleId),
        ),
      );
      assert(!JSON.stringify(report.findings).includes('private'));
      assert.equal(resultExitCode(result(state, report)), 1);
    });
});

void test('BC-04 placeholders reject mixed mappings, multiple markers and non-string targets', async (t) => {
  for (const marker of [
    { $text: './owner', other: 1 },
    { $text: './owner', $yaml: './owner' },
    { $text: 4 },
    { $yaml: '' },
  ])
    await t.test(JSON.stringify(marker), async () => {
      const state = run({ text: input({ ...SPEC, owner: marker }) });
      const report = await validate(state);
      assert.equal(report.entities.length, 0);
      assert(report.findings[0]?.ruleId.endsWith('/invalid_substitution'));
      assert.equal(resultExitCode(result(state, report)), 1);
    });
});

void test('BC-04 missing required files are violations while undeclared roots/readers and remote targets stay incomplete', async (t) => {
  const missing = run({ text: input({ ...SPEC, owner: { $text: './missing' } }) });
  assert.equal(resultExitCode(result(missing, await validate(missing))), 1);
  for (const options of [
    { rootUri: undefined },
    { profile: { readers: [] } },
    { text: input({ ...SPEC, owner: { $text: 'https://untrusted.invalid/owner' } }) },
  ])
    await t.test('unsupported reader', async () => {
      const state =
        options.rootUri === undefined && 'rootUri' in options
          ? policyRun({
              text: missing.request.source.files.find((file) => file.uri === URI)!.text,
              entrypoints: [URI],
            })
          : run({
              text: missing.request.source.files.find((file) => file.uri === URI)!.text,
              ...options,
            });
      const report = await validate(state);
      assert.equal(report.findings[0]?.category, 'dependency');
      assert.equal(resultExitCode(result(state, report)), 2);
    });
});

void test('BC-04 traversal, absolute paths, drive/UNC paths, encoded escapes and fragments never select snapshot files', async (t) => {
  for (const target of [
    '../outside',
    '/etc/passwd',
    '//server/share',
    'C:\\private',
    '.\\owner',
    './%2e%2e/outside',
    './%252e%252e/outside',
    './owner#fragment',
    './owner?query',
  ])
    await t.test(target, async () => {
      const state = run({
        text: input({ ...SPEC, owner: { $text: target } }),
        files: [{ uri: ROOT + 'outside', text: 'private' }],
      });
      const report = await validate(state);
      assert.equal(report.entities.length, 0);
      assert(!JSON.stringify(report.findings).includes('private'));
      assert(
        report.findings.some((finding) => /unsafe_path|unsupported_reader/.test(finding.ruleId)),
      );
    });
});

void test('BC-04 reads pinned bytes instead of live files and cannot follow a disk symlink absent from the snapshot', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'root'));
  await writeFile(path.join(directory, 'private'), 'private-live-value');
  const rootUri = pathToFileURL(path.join(directory, 'root') + path.sep).href;
  const uri = rootUri + 'catalog.yaml';
  const text = input({ ...SPEC, owner: { $text: './owner' } });
  let state = policyRun({ text, rootUri: ROOT, entrypoints: [URI] });
  const snapshot = (files: { uri: string; text: string }[]) =>
    createSourceSnapshot({
      repository: 'repository',
      revision: '1',
      rootUri,
      entrypoints: [uri],
      files: [{ uri, text }, ...files],
    });
  await writeFile(path.join(directory, 'root', 'owner'), 'different-live-value');
  state = {
    ...state,
    request: parseContract('validation-request', {
      ...state.request,
      source: snapshot([{ uri: rootUri + 'owner', text: 'team' }]),
    }),
  };
  assert.equal((await validate(state)).references[0]?.targetRef, 'group:default/team');
  await rm(path.join(directory, 'root', 'owner'));
  try {
    await symlink(path.join(directory, 'private'), path.join(directory, 'root', 'owner'));
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows symlink creation requires host privileges.');
      return;
    }
    throw error;
  }
  const report = await validate({
    ...state,
    request: parseContract('validation-request', { ...state.request, source: snapshot([]) }),
  });
  assert(report.findings[0]?.ruleId.endsWith('/missing_inclusion'));
  assert(!JSON.stringify(report).includes('private-live-value'));
});

void test('BC-04 structured cycles, depth and escaped output expansion obey profile budgets', async (t) => {
  const cycle = run({
    text: input({ $yaml: './a' }),
    files: [
      { uri: ROOT + 'a', text: '{$yaml: ./b}' },
      { uri: ROOT + 'b', text: '{$yaml: ./a}' },
    ],
  });
  assert((await validate(cycle)).findings[0]?.ruleId.endsWith('/cyclic_inclusion'));
  const base = policyRun();
  for (const [kind, state] of [
    [
      'depth',
      run({
        text: input({ $yaml: './a' }),
        files: [
          { uri: ROOT + 'a', text: '{$yaml: ./b}' },
          { uri: ROOT + 'b', text: stringify(SPEC) },
        ],
        profile: { limits: { ...base.context.profile.limits, substitutionDepth: 1 } },
      }),
    ],
    [
      'output',
      run({
        text: input({ ...SPEC, description: { $text: './payload' } }),
        files: [{ uri: ROOT + 'payload', text: '\n'.repeat(300) }],
        profile: { limits: { ...base.context.profile.limits, expandedEntityBytes: 512 } },
      }),
    ],
    [
      'values',
      run({
        text: input({ ...SPEC, data: Array.from({ length: 101 }, () => ({ $yaml: './items' })) }),
        files: [{ uri: ROOT + 'items', text: stringify(Array.from({ length: 1000 }, () => 0)) }],
      }),
    ],
  ] as const)
    await t.test(kind, async () => {
      const report = await validate(state);
      assert.equal(report.interrupted, 'resource_limit');
      assert.equal(resultExitCode(result(state, report)), 2);
    });
});

void test('BC-04 aggregate expanded output is bounded across separate entities', async () => {
  const text = input({ ...SPEC, description: { $text: './payload' } });
  const base = policyRun();
  const state = run({
    text,
    entrypoints: [URI, ROOT + 'b.yaml', ROOT + 'c.yaml'],
    files: [
      { uri: ROOT + 'b.yaml', text },
      { uri: ROOT + 'c.yaml', text },
      { uri: ROOT + 'payload', text: 'a'.repeat(300) },
    ],
    profile: { limits: { ...base.context.profile.limits, fileBytes: 1024, requestBytes: 1024 } },
  });
  assert.equal((await validate(state)).interrupted, 'resource_limit');
});

void test('BC-04 nested file Locations discover entities, inherit file type, and deduplicate shared targets', async () => {
  const state = run({
    text: location({
      type: 'file',
      target: './parts/location.yaml',
      targets: ['./parts/location.yaml'],
    }),
    files: [
      {
        uri: ROOT + 'parts/location.yaml',
        text: location({ targets: ['../service.yaml'] }, 'nested'),
      },
      { uri: ROOT + 'service.yaml', text: componentText() },
    ],
  });
  const report = await validate(state);
  assert.equal(report.findings.length, 0);
  assert.equal(report.entities.length, 3);
  assert.equal(report.sourceClaims.length, 3);
  assert.equal(report.unresolvedSourceIdentities, false);
  assert.deepEqual(
    report.references[0]?.relatedLocations.map((item) => item.uri),
    [ROOT + 'parts/location.yaml', URI],
  );
  assert.equal(resultExitCode(result(state, report)), 0);
});

void test('BC-04 Location presence only permits absent optional targets; malformed existing content remains invalid', async () => {
  for (const presence of ['required', 'optional']) {
    const state = run({ text: location({ type: 'file', target: './missing', presence }) });
    const report = await validate(state);
    assert.equal(report.findings.length, presence === 'required' ? 1 : 0);
    assert.equal(report.unresolvedSourceIdentities, presence === 'required');
  }
  const state = run({
    text: location({ type: 'file', target: './bad', presence: 'optional' }),
    files: [{ uri: ROOT + 'bad', text: 'metadata: [broken' }],
  });
  const report = await validate(state);
  assert(report.findings.some((finding) => finding.ruleId === 'yaml/syntax'));
  assert.equal(report.findings[0]?.relatedLocations[0]?.uri, URI);
  assert.equal(resultExitCode(result(state, report)), 1);
});

void test('BC-04 Location cycles, graph depth, remote readers and glob patterns cannot qualify ingestion', async (t) => {
  const base = policyRun();
  for (const [name, state, code] of [
    [
      'cycle',
      run({
        text: location({ target: './nested' }),
        files: [
          { uri: ROOT + 'nested', text: location({ target: './catalog-info.yaml' }, 'nested') },
        ],
      }),
      'cyclic_inclusion',
    ],
    [
      'depth',
      run({
        text: location({ target: './nested' }),
        files: [
          { uri: ROOT + 'nested', text: location({ target: './service' }, 'nested') },
          { uri: ROOT + 'service', text: componentText() },
        ],
        profile: { limits: { ...base.context.profile.limits, substitutionDepth: 1 } },
      }),
      'resource_limit',
    ],
    ['remote', run({ text: location({ type: 'url', target: './service' }) }), 'unsupported_reader'],
    ['glob', run({ text: location({ type: 'file', target: './*.yaml' }) }), 'unsupported_target'],
  ] as const)
    await t.test(name, async () => {
      const report = await validate(state);
      assert(report.findings.some((finding) => finding.ruleId.endsWith('/' + code)));
      assert.equal(report.unresolvedSourceIdentities, true);
    });
});

void test('BC-04 root/entrypoint metadata is hashed, containment-checked and retained by buffer overlays', () => {
  const state = run({ files: [{ uri: ROOT + 'payload', text: 'team' }] });
  const source = state.request.source;
  const updated = overlaySourceSnapshot(source, [
    { uri: ROOT + 'payload', text: 'other', origin: 'buffer', version: 2 },
  ]);
  assert.equal(updated.rootUri, ROOT);
  assert.deepEqual(updated.entrypoints, [URI]);
  assert.notEqual(updated.digest, source.digest);
  assert.deepEqual(overlaySourceSnapshot(source, [{ uri: URI, deleted: true }]).entrypoints, []);
  for (const uri of [
    'file:///elsewhere/a',
    'file:///workspace/a/../b',
    'file:///workspace/%2e%2e/outside',
    'file:///workspace/a%2fb',
    'file://host/workspace/a',
  ])
    assert.throws(
      () =>
        createSourceSnapshot({
          repository: 'repo',
          revision: '1',
          rootUri: ROOT,
          files: [{ uri, text: '' }],
        }),
      /pinned root/,
    );
  assert.throws(
    () =>
      createSourceSnapshot({
        repository: 'repo',
        revision: '1',
        rootUri: ROOT,
        entrypoints: [ROOT + 'missing'],
        files: [],
      }),
    /entrypoint/,
  );
});

void test('BC-04 resolved references flow into catalog policies on both pinned fake APIs without treating payloads as entities', async (t) => {
  const matrix = await policyMatrix(t);
  for (const [index, entry] of matrix.fixtures.entries())
    await t.test(entry.target.backstageVersion, async () => {
      const state = run({
        text: input({ ...SPEC, owner: { $text: './owner' } }),
        files: [{ uri: ROOT + 'owner', text: 'missing' }],
      });
      const report = await validatePolicySources(state.request, state.context, {
        catalog: await matrix.catalog(state, index),
      });
      assert.equal(report.compatibility.entities.length, 1);
      assert.equal(report.ruleStates[0]?.status, 'failed');
      const finding = report.findings.find((finding) => finding.ruleId === ownerRule.id)!;
      assert.equal(finding.location.uri, ROOT + 'owner');
      assert.equal(finding.location.path, '');
      assert.equal(finding.relatedLocations[0]?.uri, URI);
    });
});

void test('BC-04 repeated imported references keep distinct finding identities at their logical entity paths', async (t) => {
  const matrix = await policyMatrix(t);
  const state = run({
    text: input({ ...SPEC, providesApis: [{ $text: './api' }, { $text: './api' }] }),
    files: [{ uri: ROOT + 'api', text: 'missing' }],
    rules: [{ ...ownerRule, referencePath: '/spec/providesApis/*' }],
  });
  const report = await validatePolicySources(state.request, state.context, {
    catalog: await matrix.catalog(state),
  });
  assert.equal(report.findings.length, 2);
  assert.notEqual(report.findings[0]?.id, report.findings[1]?.id);
});

void test('BC-04 cancellation and original deadlines cover resolution without external fallback', async () => {
  const state = run({
    text: input({ $yaml: './spec' }),
    files: [{ uri: ROOT + 'spec', text: stringify(SPEC) }],
  });
  const abort = new AbortController();
  abort.abort();
  assert.equal((await validate(state, abort.signal)).interrupted, 'cancelled');
  const expired = parseContract('validation-request', {
    ...state.request,
    execution: { mode: 'ide', startedAt: Date.now() - 5001, deadlineAt: Date.now() - 1 },
  });
  assert.equal((await validate({ ...state, request: expired })).interrupted, 'timeout');
});
