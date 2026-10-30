import { stringify } from 'yaml';
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  digestJson,
  parseContract,
  SCHEMA_DIALECT,
} from '../../src/index.js';
import type { DeploymentProfile, JsonValue } from '../../src/index.js';

export const widgetSchema: JsonValue = {
  $schema: SCHEMA_DIALECT,
  type: 'object',
  required: ['apiVersion', 'kind', 'metadata', 'spec'],
  properties: {
    apiVersion: { const: 'example.com/v1' },
    kind: { const: 'Widget' },
    metadata: {
      type: 'object',
      required: ['name', 'namespace'],
      properties: { name: { type: 'string' }, namespace: { const: 'default' } },
    },
    spec: {
      type: 'object',
      required: ['owner', 'tier'],
      properties: {
        owner: { $ref: '#/definitions/owner' },
        tier: { type: 'integer', minimum: 1 },
        defaulted: { type: 'string', default: 'not-inserted' },
      },
      additionalProperties: false,
    },
  },
  definitions: { owner: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' } },
};
export const schemaArtifact = (schema: JsonValue = widgetSchema) =>
  parseContract('schema-artifact', {
    contractVersion: '0.2',
    id: 'example/widget',
    version: '1',
    digest: digestJson(schema),
    schema,
  });
export const widgetArtifact = schemaArtifact();
export const widgetDeclaration: DeploymentProfile['customKinds'][number] = {
  kind: 'Widget',
  apiVersion: 'example.com/v1',
  schema: { id: widgetArtifact.id, version: widgetArtifact.version, digest: widgetArtifact.digest },
};
export const widgetProfile: Partial<DeploymentProfile> = {
  admission: {
    allowedKinds: [...DEFAULT_DEPLOYMENT_PROFILE.admission.allowedKinds, 'Widget'],
    locations: [],
  },
  customKinds: [widgetDeclaration],
};
export const widgetValue = (spec: JsonValue = { owner: 'team', tier: 1 }) => ({
  apiVersion: 'example.com/v1',
  kind: 'Widget',
  metadata: { name: 'custom' },
  spec,
});
export const widgetText = (spec?: JsonValue) => stringify(widgetValue(spec));
