import { nativeSchemaArtifacts } from '../compatibility/schema-artifacts.js';
import type { LspConfig } from './config.js';
import type { EditorSchema } from '../capabilities/schema-metadata.js';
export * from '../capabilities/schema-metadata.js';

/** Presentation schemas come from the exact installed native adapter, never the network. */
export function nativeEditorSchemas(config: LspConfig): ReadonlyMap<string, EditorSchema> {
  const artifacts = nativeSchemaArtifacts(config.profile.adapterId);
  if (artifacts.status !== 'ready')
    throw new Error('Pinned editor schema dependency is unavailable.');
  return new Map(
    [...artifacts.schemas].map(([kind, schema]) => [
      kind,
      Object.freeze({
        root: schema.root,
        names: schema.names,
        artifactIdentity: schema.identity,
        label: artifacts.adapterId,
      }),
    ]),
  );
}
