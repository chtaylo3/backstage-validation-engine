import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parse } from 'yaml';
import { EditorService } from '../src/lsp/editor.js';
import { parseLspConfig } from '../src/lsp/config.js';
import {
  BACKSTAGE_ADAPTER_IDS,
  closeSharedCelRuntime,
  validatePolicySources,
} from '../src/index.js';
import { policyRun, componentText, localTeam } from './harness/policy-fixture.js';
import { schemaArtifact } from './harness/custom-kind-fixture.js';
import { URI } from './helpers.js';
import type { CompletionItem } from 'vscode-languageserver/node';

after(closeSharedCelRuntime);
async function fixture(text: string, options: Parameters<typeof policyRun>[0] = {}) {
  const run = policyRun({ text, rules: [], ...options });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  const service = new EditorService(config);
  const document = TextDocument.create(
    URI,
    text.trimStart().startsWith('{') ? 'json' : 'yaml',
    1,
    text,
  );
  const documents = new Map([[URI, document]]);
  await service.update(run.request, 1);
  const complete = (offset: number) =>
    service.complete(
      { textDocument: { uri: URI }, position: document.positionAt(offset) },
      1,
      documents,
    );
  const apply = (item: CompletionItem) => {
    assert(item.textEdit && 'range' in item.textEdit);
    return TextDocument.applyEdits(document, [item.textEdit]);
  };
  return { service, document, documents, complete, apply, run };
}

void test('field completion recovers unfinished YAML keys and ranks required native fields on both pins', async () => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS) {
    const text = componentText()
      .replace('  lifecycle: production\n', '')
      .replace('  owner: team\n', '  li');
    const f = await fixture(text, { profile: { adapterId } });
    const result = f.complete(text.length);
    assert.equal(result.items[0]?.label, 'lifecycle');
    assert.equal(result.items[0]?.detail, 'Required field');
    assert.equal(f.apply(result.items[0]), text.slice(0, -2) + 'lifecycle: ');
    const blank = await fixture(componentText() + '  ');
    const labels = blank.complete(blank.document.getText().length).items.map((item) => item.label);
    assert(labels.includes('system'));
    assert(!labels.includes('owner'));
  }
});

void test('value completion reads examples from native schemas and preserves CRLF, comments and quotes', async () => {
  const text = componentText().replace('production', "'pr' # keep 😀").replaceAll('\n', '\r\n');
  const f = await fixture(text);
  const result = f.complete(text.indexOf("'pr'") + 3);
  const item = result.items.find((item) => item.label === 'production');
  assert(item);
  assert.equal(item.detail, 'Example');
  assert.equal(f.apply(item), text.replace("'pr'", "'production'"));
  const hover = f.service.hover(
    URI,
    f.document.positionAt(text.indexOf('lifecycle') + 2),
    1,
    f.documents,
  );
  assert(hover && typeof hover.contents === 'object' && 'value' in hover.contents);
  assert.match(hover.contents.value, /lifecycle state/u);
});

void test('JSON field completion produces valid JSON including insertion between existing members', async () => {
  const text =
    '{"apiVersion":"backstage.io/v1alpha1","kind":"Component","metadata":{"name":"service"},"spec":{ }}';
  const f = await fixture(text);
  const item = f.complete(text.indexOf('{ }') + 1).items.find((item) => item.label === 'lifecycle');
  assert(item);
  const parsed: unknown = JSON.parse(f.apply(item));
  assert(parsed);
});

void test('policy enums intersect native examples and show defaults without treating them as mandatory', async () => {
  const artifact = schemaArtifact({
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        properties: {
          lifecycle: {
            type: 'string',
            enum: ['production', 'internal'],
            default: 'internal',
            examples: ['forbidden'],
          },
        },
      },
    },
  });
  const text = componentText().replace('production', '');
  const f = await fixture(text, {
    schemaArtifacts: [artifact],
    rules: [
      {
        id: 'lifecycles',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: [],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
    ],
  });
  const result = f.complete(text.indexOf('lifecycle: ') + 'lifecycle: '.length);
  assert.deepEqual(
    result.items.map((item) => item.label),
    ['production', 'internal'],
  );
  assert(result.items.every((item) => item.detail === 'Allowed value'));
  f.service.record('internal');
  assert.equal(
    f.complete(text.indexOf('lifecycle: ') + 'lifecycle: '.length).items[0]?.label,
    'internal',
  );
});

void test('local bundled refs and known conditional branches supply schema values', async () => {
  const artifact = schemaArtifact({
    type: 'object',
    definitions: { lifecycle: { enum: ['internal'] } },
    if: { properties: { kind: { const: 'Component' } }, required: ['kind'] },
    then: {
      properties: { spec: { properties: { lifecycle: { $ref: '#/definitions/lifecycle' } } } },
    },
    else: { properties: { spec: { properties: { lifecycle: { const: 'other' } } } } },
  });
  const text = componentText().replace('production', '');
  const f = await fixture(text, {
    schemaArtifacts: [artifact],
    rules: [
      {
        id: 'conditional',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: [],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
    ],
  });
  assert.deepEqual(
    f.complete(text.indexOf('lifecycle: ') + 11).items.map((item) => item.label),
    ['internal'],
  );
});

void test('hover and definition resolve an unqualified reference to its unique local entity', async () => {
  const text = componentText();
  const f = await fixture(text, { files: [localTeam] });
  const result = f.service.definition(
    URI,
    f.document.positionAt(text.indexOf('owner: team') + 9),
    1,
    f.documents,
  );
  assert.equal(result[0]?.uri, localTeam.uri);
  assert.equal(result.length, 1);
  f.service.invalidate();
  assert.deepEqual(
    f.service.definition(
      URI,
      f.document.positionAt(text.indexOf('owner: team') + 9),
      1,
      f.documents,
    ),
    [],
  );
});

void test('schema quick fixes offer explicit enum choices for an invalid value', async () => {
  const artifact = schemaArtifact({
    type: 'object',
    properties: { spec: { properties: { lifecycle: { enum: ['production', 'internal'] } } } },
  });
  const text = componentText().replace('production', 'invalid');
  const f = await fixture(text, {
    schemaArtifacts: [artifact],
    rules: [
      {
        id: 'lifecycles',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: [],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
    ],
  });
  const report = await validatePolicySources(f.run.request, f.run.context);
  const repairs = f.service.repairs(report.findings, 1, f.documents);
  assert.equal(repairs.length, 2);
  assert.equal(repairs[0]?.finding.edits[0]?.text, '"production"');
  assert.match(repairs[1]!.title, /internal/u);
});

void test('blocked processors, aliases, comments, stale text and invalid positions offer no editor edits', async () => {
  const text = componentText().replace('production', '*alias');
  const f = await fixture(text);
  assert.deepEqual(f.complete(text.indexOf('*alias') + 2).items, []);
  assert.deepEqual(
    f.service.complete(
      { textDocument: { uri: URI }, position: { line: -1, character: 0 } },
      1,
      f.documents,
    ).items,
    [],
  );
  const blocked = await fixture(componentText(), {
    profile: { requiredProcessors: [{ id: 'unavailable', stage: 'normalize' }] },
  });
  assert.deepEqual(blocked.complete(0).items, []);
  const stale = await fixture(componentText());
  stale.documents.set(URI, TextDocument.create(URI, 'yaml', 1, componentText() + '# changed'));
  assert.deepEqual(stale.complete(0).items, []);
});

void test('empty nested maps and partial entity kinds retain completion during ordinary typing', async () => {
  const text = componentText().slice(0, componentText().indexOf('spec:')) + 'spec:\n  ';
  const f = await fixture(text);
  assert(f.complete(text.length).items.some((item) => item.label === 'lifecycle'));
  const partial = componentText().replace('kind: Component', 'kind: Comp');
  const kind = await fixture(partial);
  assert(
    kind
      .complete(partial.indexOf('kind: Comp') + 10)
      .items.some((item) => item.label === 'Component'),
  );
});

void test('custom kind values honor their exact API version and schema pin', async () => {
  const artifact = schemaArtifact({
    type: 'object',
    properties: { spec: { properties: { tier: { type: 'string', enum: ['gold', 'silver'] } } } },
  });
  const text =
    'apiVersion: example.com/v1\nkind: Widget\nmetadata: {name: example}\nspec:\n  tier: \n';
  const f = await fixture(text, {
    schemaArtifacts: [artifact],
    profile: {
      admission: { allowedKinds: ['Widget'], locations: [] },
      customKinds: [
        {
          kind: 'Widget',
          apiVersion: 'example.com/v1',
          schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
        },
      ],
    },
  });
  assert.deepEqual(
    f.complete(text.indexOf('tier: ') + 6).items.map((item) => item.label),
    ['gold', 'silver'],
  );
});

void test('required-field repairs preserve comments and neighboring root fields and use explicit placeholders', async () => {
  const artifact = schemaArtifact({
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        required: ['tier'],
        properties: { tier: { type: 'string', minLength: 1 } },
      },
    },
  });
  const text =
    componentText()
      .replace('metadata: {name: service}\n', '')
      .replace('owner: team', 'owner: team # keep this comment') + 'metadata: {name: service}\n';
  const f = await fixture(text, {
    schemaArtifacts: [artifact],
    rules: [
      {
        id: 'required-tier',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: [],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
    ],
  });
  const report = await validatePolicySources(f.run.request, f.run.context);
  const repairs = f.service.repairs(report.findings, 1, f.documents);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0]!.title, /placeholder/u);
  const edit = repairs[0]!.finding.edits[0]!;
  const updated = TextDocument.applyEdits(f.document, [{ range: edit.range, newText: edit.text }]);
  assert(updated.includes('owner: team # keep this comment'));
  const entity = parse(updated) as { spec: { tier: string }; metadata: { name: string } };
  assert.equal(entity.spec.tier, '');
  assert.deepEqual(entity.metadata, { name: 'service' });
});

void test('validated rule prerequisites refine suggestions after shared policy execution', async () => {
  const artifact = schemaArtifact({
    properties: { spec: { properties: { lifecycle: { enum: ['internal'] } } } },
  });
  const valid = await fixture(componentText(), {
    schemaArtifacts: [artifact],
    rules: [
      {
        id: 'gate',
        version: '1',
        kind: 'cel',
        mandatory: true,
        severity: 'error',
        requires: [],
        expression: 'true',
      },
      {
        id: 'dependent',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: ['gate'],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
    ],
  });
  const report = await validatePolicySources(valid.run.request, valid.run.context);
  await valid.service.refine(report, 1);
  const fields = valid.service.hover(
    URI,
    valid.document.positionAt(componentText().indexOf('lifecycle') + 2),
    1,
    valid.documents,
  );
  assert(fields && typeof fields.contents === 'object' && 'value' in fields.contents);
  assert.match(fields.contents.value, /internal/u);
  assert.match(fields.contents.value, /Policy dependent/u);
});

void test('qualified structured includes receive the parent schema at the actual payload range', async () => {
  const payloadUri = 'file:///workspace/spec.yaml';
  const text =
    componentText().slice(0, componentText().indexOf('spec:')) + 'spec: {$yaml: ./spec.yaml}\n';
  const payload = 'type: service\nlifecycle: pr # payload\nowner: team\n';
  const f = await fixture(text, {
    rootUri: 'file:///workspace/',
    entrypoints: [URI],
    files: [{ uri: payloadUri, text: payload, origin: 'buffer', version: 7 }],
  });
  f.documents.set(payloadUri, TextDocument.create(payloadUri, 'yaml', 7, payload));
  const report = await validatePolicySources(f.run.request, f.run.context);
  await f.service.refine(report, 1);
  const result = f.service.complete(
    { textDocument: { uri: payloadUri }, position: { line: 1, character: 13 } },
    1,
    f.documents,
  );
  const item = result.items.find((item) => item.label === 'production');
  assert(item?.textEdit && 'range' in item.textEdit);
  assert.equal(
    TextDocument.applyEdits(f.documents.get(payloadUri)!, [item.textEdit]),
    payload.replace('pr #', '"production" #'),
  );
});

void test('forbidden fields and invalid schema examples never become completion choices', async () => {
  const artifact = schemaArtifact({
    properties: {
      spec: {
        properties: {
          system: false,
          lifecycle: {
            type: 'string',
            pattern: '^internal$',
            examples: ['internal', 'production'],
          },
        },
      },
    },
  });
  const text = componentText().replace('production', '');
  const f = await fixture(text, {
    schemaArtifacts: [artifact],
    rules: [
      {
        id: 'restricted',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: [],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
    ],
  });
  assert.deepEqual(
    f.complete(text.indexOf('lifecycle: ') + 11).items.map((item) => item.label),
    ['internal'],
  );
});

void test('YAML field insertions quote schema keys that contain syntax or resemble boolean values', async () => {
  const artifact = schemaArtifact({
    properties: { spec: { properties: { 'x: y': { type: 'string' }, true: { type: 'string' } } } },
  });
  const text = componentText() + '  ';
  const f = await fixture(text, {
    schemaArtifacts: [artifact],
    rules: [
      {
        id: 'field-names',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: [],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
    ],
  });
  for (const name of ['x: y', 'true']) {
    const item = f.complete(text.length).items.find((item) => item.label === name);
    assert(item);
    const entity = parse(f.apply(item)) as { spec: Record<string, unknown> };
    assert(Object.hasOwn(entity.spec, name));
  }
});
