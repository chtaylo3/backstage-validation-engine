import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire('/app/packages/backend/package.json');
const backendRoot = path.dirname(require.resolve('@backstage/plugin-catalog-backend'));
const placeholders = require(path.join(backendRoot, 'processors/PlaceholderProcessor.cjs.js'));
const { BuiltinKindsEntityProcessor } = require(
  path.join(backendRoot, 'processors/BuiltinKindsEntityProcessor.cjs.js'),
);
const { stringifyEntityRef } = require('@backstage/catalog-model');
const rows = JSON.parse(readFileSync('/h4-fixtures/substitutions.json', 'utf8'));
for (const row of rows) {
  const processor = new placeholders.PlaceholderProcessor({
    resolvers: {
      text: placeholders.textPlaceholderResolver,
      json: placeholders.jsonPlaceholderResolver,
      yaml: placeholders.yamlPlaceholderResolver,
    },
    reader: {
      readUrl: async (url) => ({
        buffer: async () => Buffer.from(url.endsWith('/nested') ? row.nested : row.payload),
      }),
    },
    integrations: {
      byUrl: () => undefined,
      resolveUrl: ({ url, base }) => new URL(url, base).href,
    },
  });
  const entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'subject' },
    spec: { data: row.marker },
  };
  const run = () =>
    processor.preProcessEntity(
      entity,
      { type: 'url', target: 'file:///repo/catalog.yaml' },
      () => {},
    );
  if (row.upstream.error)
    await assert.rejects(
      run,
      new RegExp(row.upstream.error.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
    );
  else assert.deepEqual((await run()).spec.data, row.upstream.value, row.id);
}
const refs = JSON.parse(readFileSync('/h4-fixtures/references.json', 'utf8'));
for (const row of refs) {
  const emitted = [];
  await new BuiltinKindsEntityProcessor().postProcessEntity(
    row.entity,
    { type: 'file', target: '/catalog/entities.yaml' },
    (event) => {
      assert.equal(event.type, 'relation');
      const relation = event.relation;
      emitted.push([
        stringifyEntityRef(relation.source),
        relation.type,
        stringifyEntityRef(relation.target),
      ]);
    },
  );
  assert.deepEqual(emitted.sort(), row.upstreamRelations, row.id);
}
console.log(
  JSON.stringify({
    substitutionCases: rows.length,
    referenceGraphCases: refs.length,
    status: 'passed',
  }),
);
