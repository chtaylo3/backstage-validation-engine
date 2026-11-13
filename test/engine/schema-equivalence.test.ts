import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capabilitySchemas } from '../../src/capabilities/schemas.js';
import { EditorArtifactSchema } from '../../src/capabilities/editor-artifacts.js';
import { contractSchemas } from '../../src/contracts/schemas.js';
import { CatalogSettingsSchema } from '../../src/host/catalog-config.js';
import { LspConfigSchema } from '../../src/lsp/config.js';

/**
 * The golden was generated from the local TypeBox builders before they moved into
 * `src/contracts/schema-kit.ts`. It must never be regenerated to make this test pass: a difference
 * means a shared builder changed a schema, and with it what the schema accepts and rejects.
 */
const golden = fileURLToPath(
  new URL('../../../test/fixtures/schema-equivalence.json', import.meta.url),
);

/** String keys keep their order (it is the serialized order); TypeBox symbol keys are kept too. */
function serializable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serializable);
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = serializable(child);
  for (const symbol of Object.getOwnPropertySymbols(value))
    copy[`@@${symbol.description ?? ''}`] = serializable(
      (value as Record<symbol, unknown>)[symbol],
    );
  return copy;
}

const surface = () =>
  serializable({
    contracts: contractSchemas,
    capabilities: capabilitySchemas,
    'editor-artifact': EditorArtifactSchema,
    'lsp-config': LspConfigSchema,
    'catalog-settings': CatalogSettingsSchema,
  }) as Record<string, unknown>;

void test('TypeBox schemas serialize exactly as before the builder consolidation', async () => {
  const actual = surface();
  const expected = JSON.parse(await readFile(golden, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const name of Object.keys(expected))
    assert.equal(
      JSON.stringify(actual[name], null, 2),
      JSON.stringify(expected[name], null, 2),
      `The serialized ${name} schemas changed.`,
    );
});
