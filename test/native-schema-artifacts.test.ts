import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  nativeSchemaArtifacts,
  resolveNativePackage,
} from '../src/compatibility/schema-artifacts.js';
import { BACKSTAGE_ADAPTER_IDS } from '../src/compatibility/types.js';
import { validatePolicySources } from '../src/core/policy-sources.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { EditorService } from '../src/lsp/editor.js';
import { componentText, policyRun } from './harness/policy-fixture.js';
import { schemaArtifact } from './harness/custom-kind-fixture.js';
import { URI } from './helpers.js';
const require = createRequire(import.meta.url);
void test('shared native identity admits only the exact pin and keeps approved schema artifacts immutable', () => {
  const identities = new Set<string>();
  for (const adapterId of BACKSTAGE_ADAPTER_IDS) {
    const native = resolveNativePackage(adapterId);
    assert(adapterId.endsWith('@' + native.version));
    assert.throws(
      () => resolveNativePackage(adapterId, () => ({ version: '0.0.0' })),
      /unavailable/u,
    );
    const artifacts = nativeSchemaArtifacts(adapterId);
    assert.equal(artifacts.status, 'ready');
    if (artifacts.status !== 'ready') continue;
    identities.add(artifacts.identity);
    assert.equal(artifacts.schemas.size, 9);
    assert.equal(Reflect.get(artifacts.schemas, 'set'), undefined);
    assert(Object.isFrozen(artifacts.schemas.get('Component')!.root));
    assert.equal(artifacts.schemas.get('Component')!.identity, artifacts.identity);
  }
  assert.equal(identities.size, 2);
});
void test('missing presentation files leave native validation and independent policy suggestions available on both pins', async () => {
  const artifact = schemaArtifact({
    type: 'object',
    properties: {
      spec: { type: 'object', properties: { lifecycle: { type: 'string', enum: ['stable'] } } },
    },
  });
  const rule = {
    id: 'lifecycle',
    version: '1',
    kind: 'schema',
    schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
    mandatory: true,
    severity: 'error',
    requires: [] as string[],
  } as const;
  for (const adapterId of BACKSTAGE_ADAPTER_IDS) {
    let reads = 0;
    const missing = nativeSchemaArtifacts(adapterId, {
      metadata: (name) => require(name + '/package.json') as unknown,
      schema: () => {
        reads++;
        throw new Error('Missing optional presentation file');
      },
    });
    assert.equal(missing.status, 'unavailable');
    assert.equal(reads, 1);
    const text = componentText().replace('production', '');
    const options = { rules: [rule], schemaArtifacts: [artifact], profile: { adapterId } };
    const run = policyRun({ ...options, text });
    const config = parseLspConfig({
      ...run.context,
      identity: run.request.identity,
      source: run.request.source,
    });
    const editor = new EditorService(config, () => {
      throw new Error('Presentation metadata is unavailable.');
    });
    const document = TextDocument.create(URI, 'yaml', 1, text);
    await editor.update(run.request, 1);
    const completion = editor.complete(
      {
        textDocument: { uri: URI },
        position: document.positionAt(text.indexOf('lifecycle:') + 'lifecycle: '.length),
      },
      1,
      new Map([[URI, document]]),
    );
    const item = completion.items.find((row) => row.label === 'stable');
    assert(item?.textEdit && 'range' in item.textEdit);
    const candidate = policyRun({
      ...options,
      text: TextDocument.applyEdits(document, [item.textEdit]),
    });
    const report = await validatePolicySources(candidate.request, candidate.context);
    assert.equal(report.interrupted, 'none');
    assert.equal(report.findings.filter((row) => row.severity === 'error').length, 0);
    assert(
      report.compatibility.entities.some(
        (entity) => entity.entityRef === 'component:default/service',
      ),
    );
    editor.invalidate();
  }
});
