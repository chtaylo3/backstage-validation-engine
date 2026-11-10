import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { builtinMetadataSession } from '../src/capabilities/builtin-metadata.js';
import { builtinCapabilitySession } from '../src/capabilities/session.js';
import { capabilityBinding } from '../src/capabilities/bindings.js';
import { capabilityAuthorityDigest } from '../src/capabilities/bindings.js';
import { digestJson } from '../src/core/json.js';
import { EditorService } from '../src/lsp/editor.js';
import { CompletionService } from '../src/lsp/completion.js';
import type { CatalogProvider } from '../src/providers/types.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { validatePolicySources } from '../src/core/policy-sources.js';
import { closeSharedCelRuntime } from '../src/runtime/cel/index.js';
import { componentText, localTeam, policyRun } from './harness/policy-fixture.js';
import { URI } from './helpers.js';

after(closeSharedCelRuntime);

void test('schema capabilities return logical field constraints, exact provenance, stage, and finite values', async () => {
  const run = policyRun({ rules: [] });
  const schema = {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        required: ['lifecycle'],
        properties: {
          lifecycle: {
            type: 'string',
            enum: ['production', 'experimental'],
            pattern: '^prod',
            default: 'production',
            examples: ['production'],
            description: 'Lifecycle choice.',
          },
          owner: { type: 'string' },
        },
      },
    },
  };
  const artifactDigest = digestJson(schema);
  const input = {
    path: '/spec',
    subjectStage: 'normalized' as const,
    scope: { status: 'known' as const, kind: 'Component', apiVersion: 'backstage.io/v1alpha1' },
    subject: { state: 'present' as const, value: { kind: 'Component', spec: { owner: 'team' } } },
    schemas: [
      {
        root: schema,
        definitions: {},
        label: 'Policy lifecycle',
        artifactDigest,
        ruleId: 'lifecycle',
      },
    ],
  };
  const session = builtinMetadataSession(['schema@1']);
  const context = {
    requestId: run.request.run.runId,
    binding: capabilityBinding(run.request, { workspaceGeneration: 1, dependencyGeneration: 2 }),
    deadlineAt: Date.now() + 1000,
  };
  const fields = session.providePrepared(
    'fields',
    { ...input, prefix: '', existing: ['owner'] },
    context,
  );
  assert.equal(fields.status, 'ready');
  if (fields.status !== 'ready') throw new Error('Fields unavailable.');
  assert.deepEqual(
    fields.value.fields.map((field) => field.name),
    ['lifecycle'],
  );
  const field = fields.value.fields[0]!;
  assert.equal(field.path, '/spec/lifecycle');
  assert.equal(field.required, true);
  assert.equal(field.subjectStage, 'normalized');
  assert.deepEqual(field.scope, input.scope);
  assert.equal(field.constraints[0]!.source.artifactDigest, artifactDigest);
  assert.equal(field.constraints[0]!.source.ruleId, 'lifecycle');
  assert.deepEqual(field.constraints[0]!.allowedValues, ['production', 'experimental']);
  assert.equal(field.constraints[0]!.pattern, '^prod');
  assert.equal(Object.hasOwn(field, 'textEdit'), false);
  const values = session.providePrepared('values', { ...input, path: '/spec/lifecycle' }, context);
  assert.equal(values.status, 'ready');
  if (values.status !== 'ready') throw new Error('Values unavailable.');
  assert.deepEqual(
    values.value.candidates.map((value) => value.value),
    ['production'],
  );
  assert.equal(values.value.candidates[0]!.classification, 'allowed');
  const hover = session.providePrepared('hover', { ...input, path: '/spec/lifecycle' }, context);
  assert.equal(hover.status, 'ready');
  if (hover.status !== 'ready') throw new Error('Hover unavailable.');
  assert.match(hover.value.text, /Lifecycle choice/u);
  const repairs = session.providePrepared(
    'repairs',
    {
      ...input,
      path: '/spec/lifecycle',
      findingId: 'finding',
      subjectId: 'subject',
      current: { state: 'present', value: 'experimental' },
      required: true,
    },
    context,
  );
  assert.equal(repairs.status, 'ready');
  if (repairs.status !== 'ready') throw new Error('Repairs unavailable.');
  assert.deepEqual(
    repairs.value.proposals.map((p) => [p.operation, p.value, p.path]),
    [['setValue', 'production', '/spec/lifecycle']],
  );
  await session.close();
});

void test('explicit null constraints remain distinct from missing values when proposing insertions', async () => {
  const run = policyRun({ rules: [] });
  const session = builtinMetadataSession([]);
  const input = {
    path: '/spec/nullable',
    subjectStage: 'authored' as const,
    scope: { status: 'unknown' as const },
    subject: { state: 'absent' as const },
    schemas: [
      {
        root: { properties: { spec: { properties: { nullable: { const: null } } } } },
        definitions: {},
        label: 'Null constraint',
      },
    ],
    findingId: 'finding',
    subjectId: 'subject',
    required: true,
  };
  const context = {
    requestId: 'null-vs-absent',
    binding: capabilityBinding(run.request, { workspaceGeneration: 1 }),
    deadlineAt: Date.now() + 1000,
  };
  const absent = session.providePrepared(
    'repairs',
    { ...input, current: { state: 'absent' } },
    context,
  );
  assert.equal(absent.status, 'ready');
  if (absent.status !== 'ready') throw new Error('Missing repair.');
  assert.equal(absent.value.proposals[0]!.operation, 'insertProperty');
  assert.equal(absent.value.proposals[0]!.value, null);
  const present = session.providePrepared(
    'repairs',
    { ...input, current: { state: 'present', value: null } },
    context,
  );
  assert.equal(present.status, 'ready');
  if (present.status !== 'ready') throw new Error('Missing repair.');
  assert.equal(present.value.proposals.length, 0);
  await session.close();
});

void test('the real editor consumes admitted logical contributions and retains protocol rendering and target resolution', async () => {
  const text = componentText() + '  ';
  const run = policyRun({ text, rules: [], files: [localTeam] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  const calls: string[] = [];
  const provider = builtinCapabilitySession('approved.editor.test', {
    fields: (input) => {
      calls.push('fields');
      return {
        fields: [
          {
            name: 'system',
            path: '/spec/system',
            required: false,
            description: 'Explicit system metadata.',
            types: ['string'],
            initialValue: '',
            sources: ['approved'],
            subjectStage: input.subjectStage,
            scope: { ...input.scope },
            constraints: [],
          },
        ],
      };
    },
    values: () => {
      calls.push('values');
      return {
        candidates: [
          {
            value: 'production',
            label: 'Approved finite example',
            classification: 'example',
            sources: ['approved'],
          },
        ],
      };
    },
    hover: () => {
      calls.push('hover');
      return { text: 'Safe plain description.' };
    },
    references: (input) => {
      calls.push('references');
      return { references: [{ identity: 'group:default/team', path: input.path }] };
    },
  });
  const editor = new EditorService(config, undefined, { provider });
  await editor.update(run.request, 1);
  const document = TextDocument.create(URI, 'yaml', 1, text),
    documents = new Map([[URI, document]]);
  const fields = editor.complete(
    { textDocument: { uri: URI }, position: document.positionAt(text.length) },
    1,
    documents,
  );
  assert.equal(fields.items[0]!.label, 'system');
  assert(fields.items[0]!.textEdit && 'range' in fields.items[0]!.textEdit);
  assert.equal(fields.items[0]!.textEdit.newText, 'system: ');
  const values = editor.complete(
    { textDocument: { uri: URI }, position: document.positionAt(text.indexOf('production') + 2) },
    1,
    documents,
  );
  assert.equal(values.items[0]!.detail, 'Approved finite example');
  const hover = editor.hover(URI, document.positionAt(text.indexOf('lifecycle') + 2), 1, documents);
  assert(
    hover &&
      typeof hover.contents === 'object' &&
      !Array.isArray(hover.contents) &&
      'value' in hover.contents,
  );
  assert.equal(hover.contents.value, 'Safe plain description.');
  const definitions = editor.definition(
    URI,
    document.positionAt(text.indexOf('owner: team') + 8),
    1,
    documents,
  );
  assert.equal(definitions[0]!.uri, localTeam.uri);
  assert(
    calls.includes('fields') &&
      calls.includes('values') &&
      calls.includes('hover') &&
      calls.includes('references'),
  );
  await editor.close();
});

void test('optional metadata failure suppresses hints while required core validation remains intact', async () => {
  const run = policyRun({
    text: componentText().replace('production', 'experimental'),
    rules: [
      {
        id: 'required-production',
        version: '1',
        kind: 'cel',
        expression: 'entity.spec.lifecycle == "production"',
        mandatory: true,
        severity: 'error',
        requires: [],
      },
    ],
  });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  let attempted = 0;
  const provider = builtinCapabilitySession('optional.bad.metadata', {
    values: () => {
      attempted++;
      throw new Error('Provider unavailable.');
    },
  });
  const editor = new EditorService(config, undefined, { provider });
  await editor.update(run.request, 1);
  const document = TextDocument.create(URI, 'yaml', 1, run.request.source.files[0]!.text),
    documents = new Map([[URI, document]]);
  assert.equal(
    editor.complete(
      {
        textDocument: { uri: URI },
        position: document.positionAt(document.getText().indexOf('experimental') + 2),
      },
      1,
      documents,
    ).items.length,
    0,
  );
  assert.equal(attempted, 1);
  const report = await validatePolicySources(run.request, run.context);
  assert(report.findings.some((finding) => finding.ruleId === 'required-production'));
  assert(
    report.ruleStates.some(
      (state) => state.ruleId === 'required-production' && state.status === 'failed',
    ),
  );
  await editor.close();
});

void test('catalog completion and search consume the approved search interface with actual authority binding', async () => {
  const text = componentText('new');
  const run = policyRun({ text, rules: [] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  let bypassedCalls = 0,
    routedCalls = 0;
  const catalogProvider: CatalogProvider = {
    connectionId: 'approved-catalog',
    adapterId: config.profile.adapterId,
    lookup: () => Promise.reject(new Error('Unexpected validation lookup.')),
    suggest: () => {
      bypassedCalls++;
      throw new Error('Search bypassed the approved interface.');
    },
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  const catalog = {
    provider: catalogProvider,
    access: {
      installationId: run.request.identity.installationId,
      principalId: 'reader',
      permissionRevision: run.request.identity.permissionRevision,
      credentialRevision: 'credential-revision-2',
      scope: ['catalog:read'],
      policyDigest: run.request.policy.digest,
      profileDigest: run.request.profile.digest,
      maxAgeMs: 5000,
    },
  };
  const search = builtinCapabilitySession(
    'approved.search.test',
    {
      search: (input, request) => {
        routedCalls++;
        assert.equal(
          request.binding.authorityContextDigest,
          capabilityAuthorityDigest(run.request.identity, catalog),
        );
        assert.equal(request.binding.sessionGeneration, 3);
        assert.deepEqual(input, { kind: 'group', namespace: 'default', prefix: 'new' });
        return {
          status: 'ready',
          refs: ['group:default/new-team'],
          truncated: false,
          fetchedAt: Date.now(),
          expiresAt: Date.now() + 5000,
        };
      },
    },
    { async: ['search'], permissions: ['catalog-read'] },
  );
  const service = new CompletionService(config, catalog, undefined, {
    provider: search,
    sessionGeneration: 3,
  });
  await service.update(run.request, 1);
  const document = TextDocument.create(URI, 'yaml', 1, text),
    signal = new AbortController().signal;
  const result = await service.complete(
    { textDocument: { uri: URI }, position: document.positionAt(text.indexOf('owner: new') + 10) },
    1,
    new Map([[URI, document]]),
    signal,
  );
  assert.equal(result.items[0]!.label, 'group:default/new-team');
  const rows = await service.searchReferences(
    { kind: 'group', namespace: 'default', prefix: 'new' },
    1,
    signal,
  );
  assert.equal(rows[0]!.reference, 'group:default/new-team');
  assert.equal(routedCalls, 1);
  assert.equal(bypassedCalls, 0);
  await service.close();
});
