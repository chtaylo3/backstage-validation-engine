import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import { currentCoverageObservation } from '../../src/lsp/server-context.js';
import { WorkspaceState } from '../../src/lsp/workspace-state.js';
import * as protocol from '../../src/protocol/index.js';
import {
  BVE_METHODS,
  BVE_METHOD_SHAPES,
  RECORD_SELECTION_MAX_LENGTH,
  isFilesystemObservationResult,
  isRecordSelectionParams,
  isReloadConfigurationResult,
  isSearchReferencesParams,
  isSearchReferencesResult,
  isValidationCoverageEnvelope,
  isValidationCoverageParams,
} from '../../src/protocol/index.js';
import { FAKE_URI, fakeConfig } from '../harness/lsp-fake-connection.js';

void test('protocol: the custom method names are frozen wire identifiers', () => {
  // Literal on purpose: renaming a method must fail this test.
  assert.deepEqual(
    { ...BVE_METHODS },
    {
      reloadConfiguration: 'bve/reloadConfiguration',
      recordSelection: 'bve/recordSelection',
      searchReferences: 'bve/searchReferences',
      filesystemObservation: 'bve/filesystemObservation',
      validationCoverage: 'bve/validationCoverage',
      configurationReloaded: 'bve/configurationReloaded',
    },
  );
  assert(Object.isFrozen(BVE_METHODS));
  assert.deepEqual(JSON.parse(JSON.stringify(BVE_METHOD_SHAPES)), {
    'bve/reloadConfiguration': { direction: 'clientToServer', kind: 'request' },
    'bve/recordSelection': { direction: 'clientToServer', kind: 'notification' },
    'bve/searchReferences': { direction: 'clientToServer', kind: 'request' },
    'bve/filesystemObservation': { direction: 'clientToServer', kind: 'request' },
    'bve/validationCoverage': { direction: 'clientToServer', kind: 'request' },
    'bve/configurationReloaded': { direction: 'serverToClient', kind: 'notification' },
  });
  assert(Object.isFrozen(BVE_METHOD_SHAPES));
  for (const shape of Object.values(BVE_METHOD_SHAPES)) assert(Object.isFrozen(shape));
  assert.equal(RECORD_SELECTION_MAX_LENGTH, 512);
  assert.deepEqual(Object.keys(protocol).sort(), [
    'BVE_METHODS',
    'BVE_METHOD_SHAPES',
    'RECORD_SELECTION_MAX_LENGTH',
    'isFilesystemObservationResult',
    'isRecordSelectionParams',
    'isReloadConfigurationResult',
    'isSearchReferencesParams',
    'isSearchReferencesResult',
    'isValidationCoverageEnvelope',
    'isValidationCoverageParams',
  ]);
});

const binding = { uri: 'file:///workspace/catalog.yaml', version: 7, digest: 'sha256:abc' };
const search = { kind: 'group', namespace: 'default', prefix: 'te' };
const receipt = {
  sessionGeneration: 1,
  generation: 3,
  uris: ['file:///workspace/a.yaml', 'file:///workspace/b.yaml'],
  truncated: true,
};
const observation = {
  sourceDigest: 'sha256:source',
  policyDigest: 'sha256:policy',
  profileDigest: 'sha256:profile',
  activationDigest: 'sha256:activation',
  generation: 5,
  dependencyGeneration: 2,
  documents: [binding],
  coverage: [{ stage: 'parse', subject: binding.uri, required: true, status: 'verified' }],
};
type Guard = (value: unknown) => boolean;
const accepts = (guard: Guard, values: readonly unknown[]) => {
  for (const value of values) assert.equal(guard(value), true, `accepts ${String(value)}`);
};
const rejects = (guard: Guard, values: readonly unknown[]) => {
  for (const value of values) assert.equal(guard(value), false, `rejects ${JSON.stringify(value)}`);
};

void test('protocol: each guard accepts a minimal and a maximal valid payload', () => {
  accepts(isValidationCoverageParams, [
    { uri: '', version: 0, digest: '' },
    { ...binding, version: Number.MAX_SAFE_INTEGER, extra: { nested: [1, 2] } },
  ]);
  accepts(isRecordSelectionParams, ['', 'x'.repeat(512)]);
  accepts(isSearchReferencesParams, [
    { kind: '', namespace: '', prefix: '' },
    { kind: 'k'.repeat(63), namespace: 'n'.repeat(63), prefix: 'p'.repeat(63) },
  ]);
  accepts(isReloadConfigurationResult, [{ reloaded: false }, { reloaded: true, extra: 1 }]);
  accepts(isSearchReferencesResult, [
    [],
    Array.from({ length: 100 }, (_, index) => ({
      reference: `group:default/team-${index}`,
      source: index % 2 ? 'catalog' : 'workspace',
    })),
  ]);
  accepts(isFilesystemObservationResult, [
    null,
    { sessionGeneration: 0, generation: 0, uris: [], truncated: false },
    receipt,
  ]);
  accepts(isValidationCoverageEnvelope, [null, {}, observation]);
});

void test('protocol: guards reject wrong types, arrays, null, missing members and over-long input', () => {
  rejects(isValidationCoverageParams, [
    null,
    undefined,
    'file:///workspace/catalog.yaml',
    7,
    true,
    [binding],
    {},
    { version: 7, digest: binding.digest },
    { uri: binding.uri, digest: binding.digest },
    { uri: binding.uri, version: 7 },
    { ...binding, uri: 1 },
    { ...binding, version: '7' },
    { ...binding, version: null },
    { ...binding, digest: 7 },
    { ...binding, digest: null },
  ]);
  rejects(isRecordSelectionParams, [
    null,
    undefined,
    42,
    true,
    ['group:default/team'],
    { value: 'group:default/team' },
    'x'.repeat(513),
  ]);
  rejects(isSearchReferencesParams, [
    null,
    undefined,
    'group:default/te',
    [search],
    {},
    { kind: 'group', namespace: 'default' },
    { ...search, prefix: 1 },
    { ...search, kind: null },
    { ...search, namespace: ['default'] },
    { ...search, extra: true },
  ]);
  rejects(isReloadConfigurationResult, [
    null,
    undefined,
    true,
    [true],
    {},
    { reloaded: 'yes' },
    { reloaded: 1 },
  ]);
  rejects(isSearchReferencesResult, [
    null,
    undefined,
    {},
    { reference: 'group:default/team', source: 'workspace' },
    [null],
    [{ reference: 'group:default/team' }],
    [{ source: 'workspace' }],
    [{ reference: 7, source: 'workspace' }],
    [{ reference: 'group:default/team', source: null }],
    [['group:default/team', 'workspace']],
  ]);
  rejects(isFilesystemObservationResult, [
    undefined,
    false,
    [],
    'receipt',
    {},
    { ...receipt, sessionGeneration: '1' },
    { ...receipt, generation: null },
    { ...receipt, uris: 'file:///workspace/a.yaml' },
    { ...receipt, uris: [1] },
    { ...receipt, truncated: 'false' },
    { sessionGeneration: 1, generation: 3, uris: [] },
  ]);
  rejects(isValidationCoverageEnvelope, [undefined, false, 0, 'coverage', [], [observation]]);
});

/**
 * The parameter checks that the server applied before `src/protocol` existed, copied from the
 * handlers. The guards must agree with them on every probe: no widening and no narrowing.
 */
const before: Record<string, [Guard, Guard]> = {
  // src/lsp/server-context.ts currentCoverageObservation, parameter checks only.
  'bve/validationCoverage': [
    isValidationCoverageParams,
    (params) => {
      if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
      const requested = params as { uri?: unknown; version?: unknown; digest?: unknown };
      return !(
        typeof requested.uri !== 'string' ||
        typeof requested.version !== 'number' ||
        typeof requested.digest !== 'string'
      );
    },
  ],
  // src/lsp/handlers/custom.ts bve/recordSelection, input checks only.
  'bve/recordSelection': [
    isRecordSelectionParams,
    (input) => !(typeof input !== 'string' || input.length > 512),
  ],
  // src/lsp/completion.ts searchReferences, shape checks only. The prefix pattern and the
  // reference rules that follow stay in completion.ts.
  'bve/searchReferences': [
    isSearchReferencesParams,
    (input) => {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !['kind', 'namespace', 'prefix'].includes(key))
      )
        return false;
      const query = input as { kind?: unknown; namespace?: unknown; prefix?: unknown };
      return !(
        typeof query.kind !== 'string' ||
        typeof query.namespace !== 'string' ||
        typeof query.prefix !== 'string'
      );
    },
  ],
};
const probes: readonly unknown[] = [
  null,
  undefined,
  0,
  1,
  Number.NaN,
  true,
  false,
  '',
  'group:default/team',
  'x'.repeat(511),
  'x'.repeat(512),
  'x'.repeat(513),
  'é'.repeat(512),
  '😀'.repeat(256),
  '😀'.repeat(257),
  [],
  [binding],
  [search],
  {},
  binding,
  { ...binding, extra: 1 },
  { ...binding, version: -1 },
  { ...binding, version: 1.5 },
  { ...binding, version: Number.NaN },
  { ...binding, version: Number.POSITIVE_INFINITY },
  { ...binding, version: '7' },
  { ...binding, digest: 7 },
  { ...binding, uri: undefined },
  { uri: binding.uri, version: binding.version },
  search,
  { ...search, prefix: 'TE' },
  { ...search, prefix: 'p'.repeat(64) },
  { ...search, kind: '' },
  { ...search, extra: undefined },
  { kind: 'group', namespace: 'default' },
  { ...search, prefix: 1 },
  Object.assign(Object.create({ uri: binding.uri }) as object, {
    version: 1,
    digest: binding.digest,
  }),
  Object.assign(Object.create(null) as object, search),
  new Date(0),
  () => binding,
];

void test('protocol: parameter guards accept and reject exactly what the server checks did before', () => {
  for (const [method, [guard, previous]] of Object.entries(before))
    for (const [index, probe] of probes.entries())
      assert.equal(guard(probe), previous(probe), `${method} probe ${index}`);
});

void test('protocol: coverage versions that no open document can have still answer null', () => {
  // The guard keeps the old `typeof version === 'number'` check, so negative and fractional
  // versions pass it. Open documents only have non-negative safe integer versions, so such a
  // request matches no document and the server answers null, as it did before.
  const workspace = new WorkspaceState(fakeConfig());
  for (const version of [-1, 1.5])
    assert.equal(
      workspace.open({ uri: FAKE_URI, languageId: 'yaml', version, text: '' }),
      false,
      `version ${version}`,
    );
  assert(workspace.open({ uri: FAKE_URI, languageId: 'yaml', version: 0, text: '' }));
  const digest = workspace.document(FAKE_URI)!.digest;
  for (const version of [-1, 1.5, Number.NaN]) {
    assert.equal(isValidationCoverageParams({ uri: FAKE_URI, version, digest }), true);
    assert.equal(
      currentCoverageObservation(
        { uri: FAKE_URI, version, digest },
        {
          initialized: true,
          stopped: false,
          available: true,
          enabled: true,
          workspace,
          observation: {
            ...observation,
            documents: [{ uri: FAKE_URI, version, digest }],
            coverage: [],
          },
          generation: observation.generation,
          dependencyGeneration: observation.dependencyGeneration,
        },
      ),
      null,
      `version ${version}`,
    );
  }
});

void test('protocol: the compiled module loads nothing and re-exports only its own files', async () => {
  const directory = new URL('../../src/protocol/', import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(files, ['guards.js', 'index.js', 'methods.js', 'types.js']);
  for (const name of files) {
    const text = await readFile(new URL(name, directory), 'utf8');
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node))
        found.push(`import in ${name}`);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        found.push(`${node.expression.getText(source)}() in ${name}`);
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        !(
          ts.isStringLiteral(node.moduleSpecifier) &&
          /^\.\/[a-z-]+\.js$/u.test(node.moduleSpecifier.text) &&
          files.includes(node.moduleSpecifier.text.slice(2))
        )
      )
        found.push(`re-export of ${node.moduleSpecifier.getText(source)} in ${name}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.doesNotMatch(text, /\brequire\s*\(/u, name);
    assert.deepEqual(found, [], name);
  }
});
