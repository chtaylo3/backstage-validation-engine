import type { JsonValue, PolicyBundle } from '../../src/index.js';
import { schemaArtifact } from './custom-kind-fixture.js';

export function fixPolicy(expected: JsonValue = 'production', field = 'lifecycle') {
  const artifact = schemaArtifact({
    type: 'object',
    properties: {
      spec: { type: 'object', properties: { [field]: { const: expected } } },
    },
  });
  const rule: PolicyBundle['rules'][number] = {
    id: 'required-value',
    version: '1',
    kind: 'schema',
    mandatory: true,
    severity: 'error',
    requires: [],
    schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
  };
  return { rules: [rule], schemaArtifacts: [artifact] };
}
