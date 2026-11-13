import { Type } from '@sinclair/typebox';
import type { Static, TProperties, TSchema } from '@sinclair/typebox';
import { deepFreeze } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import {
  CoverageSchema,
  DataSnapshotSchema,
  JsonValueSchema,
  RuleStateSchema,
  SCHEMA_DIALECT,
  ValidationRequestSchema,
  ValidationResultSchema,
} from '../contracts/schemas.js';

export const CAPABILITY_API = 'bve-plugin/1' as const;
export const CAPABILITY_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  metadataBytes: 2 * 1024 * 1024,
  outstanding: 64,
  items: 100,
  sources: 1000,
  closeMs: 5000,
});
export const CAPABILITY_IDS = [
  'validation',
  'fields',
  'values',
  'hover',
  'references',
  'repairs',
  'search',
  'dependency-changes',
  'source-discovery',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export function isCapabilityId(id: string): id is CapabilityId {
  return CAPABILITY_IDS.some((known) => known === id);
}
const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const text = (maxLength = 4096) => Type.String({ minLength: 1, maxLength });
const count = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const digest = () => Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const pointer = () => Type.String({ maxLength: 4096, pattern: '^(?:/(?:[^~]|~[01])*)*$' });
const ref = <T extends TSchema>(schema: T) => Type.Unsafe<Static<T>>(Type.Ref(schema.$id!));
const json = () => ref(JsonValueSchema);
const strings = (maxItems = 100) => Type.Array(text(), { maxItems, uniqueItems: true });
const schema = <T extends TSchema>(name: string, definition: T): T => {
  const safe: unknown = JSON.parse(
    JSON.stringify({
      ...definition,
      $id: `urn:backstage-validation:capability:${name}:1`,
      $schema: SCHEMA_DIALECT,
    }),
  );
  return deepFreeze(safe) as T;
};
const capabilityId = Type.String({ maxLength: 63, pattern: '^[a-z][a-z0-9-]*$' });
const capabilityVersion = Type.Integer({ minimum: 1, maximum: 1000 });
export const ContextBindingSchema = schema(
  'binding',
  object({
    contextId: text(),
    sourceDigest: digest(),
    baselineDigest: Type.Optional(digest()),
    policyDigest: digest(),
    profileDigest: digest(),
    activationDigest: digest(),
    dataDigest: digest(),
    dependencyDigest: digest(),
    authorityContextDigest: digest(),
    activationGeneration: count(),
    workspaceGeneration: count(),
    sessionGeneration: count(),
    dependencyGeneration: count(),
  }),
);
export type ContextBinding = Static<typeof ContextBindingSchema>;
const declaration = object({
  id: capabilityId,
  version: capabilityVersion,
  required: Type.Boolean(),
  inputSchemaDigest: digest(),
  outputSchemaDigest: digest(),
  mode: Type.Union([Type.Literal('prepared'), Type.Literal('async')]),
});
export const CapabilityManifestSchema = schema(
  'manifest',
  object({
    apiVersion: Type.Literal(CAPABILITY_API),
    pluginId: text(128),
    version: text(128),
    artifactDigest: digest(),
    executionProfile: Type.Union([Type.Literal('builtin/1'), Type.Literal('declarative/1')]),
    capabilities: Type.Array(declaration, { minItems: 1, maxItems: CAPABILITY_IDS.length }),
    dependencies: strings(64),
    subjectStages: Type.Array(
      Type.Union([Type.Literal('authored'), Type.Literal('resolved'), Type.Literal('normalized')]),
      { minItems: 1, maxItems: 3, uniqueItems: true },
    ),
    permissions: Type.Array(
      Type.Union([Type.Literal('catalog-read'), Type.Literal('source-discovery')]),
      { maxItems: 2, uniqueItems: true },
    ),
    languageProfiles: strings(16),
    changeObservation: Type.Optional(
      object({
        mechanism: Type.Union([Type.Literal('polling'), Type.Literal('event-hints')]),
        coverage: Type.Array(
          Type.Union(
            ['entity', 'query', 'collection', 'authority'].map((kind) => Type.Literal(kind)),
          ),
          { minItems: 1, maxItems: 4, uniqueItems: true },
        ),
        cursor: Type.Union([Type.Literal('none'), Type.Literal('opaque')]),
        ordered: Type.Boolean(),
        replay: Type.Boolean(),
        heartbeatMs: Type.Integer({ minimum: 1, maximum: 300_000 }),
        gapHandling: Type.Literal('reset-and-read'),
      }),
    ),
  }),
);
export type CapabilityManifest = Static<typeof CapabilityManifestSchema>;
export const HostHandshakeSchema = schema(
  'host-handshake',
  object({
    apiVersion: Type.Literal(CAPABILITY_API),
    pluginId: text(128),
    artifactDigest: digest(),
    manifestDigest: digest(),
    capabilities: Type.Array(declaration, { maxItems: CAPABILITY_IDS.length }),
    dependencies: strings(64),
    permissions: strings(2),
    executionProfile: text(128),
    languageProfiles: strings(16),
  }),
);
export const PluginHandshakeSchema = schema(
  'plugin-handshake',
  object({
    apiVersion: Type.Literal(CAPABILITY_API),
    pluginId: text(128),
    artifactDigest: digest(),
    manifestDigest: digest(),
    capabilities: Type.Array(object({ id: capabilityId, version: capabilityVersion }), {
      maxItems: CAPABILITY_IDS.length,
    }),
  }),
);
export type HostHandshake = Static<typeof HostHandshakeSchema>;
export type PluginHandshake = Static<typeof PluginHandshakeSchema>;
export const PresenceSchema = Type.Union([
  object({ state: Type.Literal('absent') }),
  object({ state: Type.Literal('present'), value: json() }),
]);
export type Presence = Static<typeof PresenceSchema>;
const provenance = object({
  label: text(),
  artifactDigest: Type.Optional(digest()),
  ruleId: Type.Optional(text(128)),
});
const entityScope = Type.Union([
  object({ status: Type.Literal('unknown') }),
  object({ status: Type.Literal('known'), kind: text(63), apiVersion: text(128) }),
]);
const presentation = object({
  root: json(),
  definitions: Type.Record(Type.String(), json()),
  label: text(),
  artifactDigest: Type.Optional(digest()),
  ruleId: Type.Optional(text(128)),
});
const constraints = object({
  source: provenance,
  types: Type.Optional(strings(8)),
  constant: Type.Optional(json()),
  allowedValues: Type.Optional(Type.Array(json(), { maxItems: 100 })),
  defaultValue: Type.Optional(json()),
  examples: Type.Optional(Type.Array(json(), { maxItems: 100 })),
  requiredFields: Type.Optional(strings(1000)),
  minLength: Type.Optional(count()),
  maxLength: Type.Optional(count()),
  minItems: Type.Optional(count()),
  maxItems: Type.Optional(count()),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  exclusiveMinimum: Type.Optional(Type.Number()),
  exclusiveMaximum: Type.Optional(Type.Number()),
  pattern: Type.Optional(Type.String({ maxLength: 1024 })),
  forbidden: Type.Boolean(),
  partial: Type.Boolean(),
});
const schemaInput = {
  path: pointer(),
  subject: PresenceSchema,
  subjectStage: Type.Union([
    Type.Literal('authored'),
    Type.Literal('resolved'),
    Type.Literal('normalized'),
  ]),
  scope: entityScope,
  schemas: Type.Array(presentation, { maxItems: 128 }),
};
const candidate = object({
  value: json(),
  label: text(),
  classification: Type.Union([
    Type.Literal('required'),
    Type.Literal('allowed'),
    Type.Literal('default'),
    Type.Literal('example'),
    Type.Literal('suggestion'),
  ]),
  sources: strings(128),
});
const query = object({
  kind: Type.String({ pattern: '^[a-z][a-z0-9]{0,62}$' }),
  namespace: Type.String({ pattern: '^[a-z0-9_.-]{1,63}$' }),
  prefix: Type.String({ maxLength: 63, pattern: '^[a-z0-9_.-]*$' }),
});
const identity = () =>
  Type.String({ pattern: '^[a-z][a-z0-9]{0,62}:[a-z0-9_.-]{1,63}/[a-z0-9_.-]{1,63}$' });
const repair = object({
  findingId: text(),
  subjectId: text(),
  path: pointer(),
  operation: Type.Union([Type.Literal('setValue'), Type.Literal('insertProperty')]),
  value: json(),
  label: text(),
});
export const inputSchemas = {
  validation: schema('validation-input', object({ request: ref(ValidationRequestSchema) })),
  fields: schema(
    'fields-input',
    object({ ...schemaInput, prefix: Type.String({ maxLength: 4096 }), existing: strings(1000) }),
  ),
  values: schema('values-input', object({ ...schemaInput, kinds: Type.Optional(strings(264)) })),
  hover: schema('hover-input', object(schemaInput)),
  references: schema(
    'references-input',
    object({ path: pointer(), value: text(512), defaultKind: text(63), namespace: text(63) }),
  ),
  repairs: schema(
    'repairs-input',
    object({
      ...schemaInput,
      findingId: text(),
      subjectId: text(),
      current: PresenceSchema,
      required: Type.Boolean(),
    }),
  ),
  search: schema('search-input', query),
  'dependency-changes': schema(
    'dependency-changes-input',
    object({ scopes: strings(1000), cursor: Type.Optional(text()) }),
  ),
  'source-discovery': schema(
    'source-discovery-input',
    object({ roots: strings(16), include: strings(32), exclude: strings(32) }),
  ),
} as const;
export const outputSchemas = {
  validation: schema(
    'validation-output',
    object({
      materializedData: ref(DataSnapshotSchema),
      evaluatedAt: count(),
      evaluationDataDigest: digest(),
      findings: ValidationResultSchema.properties.findings,
      coverage: Type.Array(ref(CoverageSchema), { maxItems: 100_000 }),
      ruleStates: Type.Array(RuleStateSchema, { maxItems: 100_000 }),
      artifacts: ValidationResultSchema.properties.artifacts,
      interrupted: ValidationResultSchema.properties.resources.properties.interrupted,
    }),
  ),
  fields: schema(
    'fields-output',
    object({
      fields: Type.Array(
        object({
          name: text(),
          path: pointer(),
          required: Type.Boolean(),
          description: Type.String({ maxLength: 16384 }),
          types: strings(8),
          initialValue: json(),
          sources: strings(128),
          subjectStage: Type.Union([
            Type.Literal('authored'),
            Type.Literal('resolved'),
            Type.Literal('normalized'),
          ]),
          scope: entityScope,
          constraints: Type.Array(constraints, { maxItems: 256 }),
        }),
        { maxItems: 100 },
      ),
    }),
  ),
  values: schema('values-output', object({ candidates: Type.Array(candidate, { maxItems: 100 }) })),
  hover: schema('hover-output', object({ text: Type.String({ maxLength: 16384 }) })),
  references: schema(
    'references-output',
    object({
      references: Type.Array(object({ identity: identity(), path: pointer() }), { maxItems: 100 }),
    }),
  ),
  repairs: schema('repairs-output', object({ proposals: Type.Array(repair, { maxItems: 16 }) })),
  search: schema(
    'search-output',
    Type.Union([
      object({
        status: Type.Literal('ready'),
        refs: Type.Array(identity(), { maxItems: 200, uniqueItems: true }),
        truncated: Type.Boolean(),
        fetchedAt: count(),
        expiresAt: count(),
      }),
      object({
        status: Type.Literal('unavailable'),
        failure: text(128),
        refs: Type.Array(identity(), { maxItems: 0 }),
        truncated: Type.Boolean(),
        fetchedAt: count(),
        expiresAt: count(),
      }),
    ]),
  ),
  'dependency-changes': schema(
    'dependency-changes-output',
    object({
      changes: Type.Array(
        object({
          kind: Type.Union(
            ['entity', 'query', 'collection', 'authority'].map((k) => Type.Literal(k)),
          ),
          key: text(),
        }),
        { maxItems: 1000 },
      ),
      cursor: Type.Optional(text()),
      reset: Type.Boolean(),
      coverage: Type.Literal('hints'),
      observedAt: count(),
    }),
  ),
  'source-discovery': schema(
    'source-discovery-output',
    object({
      sources: Type.Array(object({ uri: text(), revision: Type.Optional(text()) }), {
        maxItems: 1000,
      }),
      complete: Type.Boolean(),
    }),
  ),
} as const;
export type CapabilityInputs = { [K in CapabilityId]: Static<(typeof inputSchemas)[K]> };
export type CapabilityOutputs = { [K in CapabilityId]: Static<(typeof outputSchemas)[K]> };
export interface BoundRequest<K extends CapabilityId> {
  readonly invocationId: string;
  readonly requestId: string;
  readonly capabilityId: K;
  readonly capabilityVersion: number;
  readonly binding: Readonly<ContextBinding>;
  readonly deadlineAt: number;
  readonly input: CapabilityInputs[K];
}
export type CapabilityStatus =
  'not_applicable' | 'unavailable' | 'cancelled' | 'resource_limit' | 'error';
export type CapabilityResult<K extends CapabilityId> = {
  readonly invocationId: string;
  readonly capabilityId: K;
  readonly binding: Readonly<ContextBinding>;
} & (
  | {
      readonly status: 'ready';
      readonly completeness: 'complete' | 'partial';
      readonly value: CapabilityOutputs[K];
    }
  | { readonly status: CapabilityStatus; readonly reasonCode: string }
);
export interface PluginLifecycle {
  initialize(
    request: Immutable<HostHandshake>,
  ): Immutable<PluginHandshake> | Promise<Immutable<PluginHandshake>>;
  cancel(invocationId: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface CapabilityProvider<K extends CapabilityId> extends PluginLifecycle {
  provide(
    request: Immutable<BoundRequest<K>>,
    execution: { readonly signal: AbortSignal },
  ): Immutable<CapabilityResult<K>> | Promise<Immutable<CapabilityResult<K>>>;
}
export type ValidationProvider = CapabilityProvider<'validation'>;
export type FieldMetadataProvider = CapabilityProvider<'fields'>;
export type ValueSuggestionProvider = CapabilityProvider<'values'>;
export type HoverProvider = CapabilityProvider<'hover'>;
export type ReferenceProvider = CapabilityProvider<'references'>;
export type RepairProvider = CapabilityProvider<'repairs'>;
export type SearchProvider = CapabilityProvider<'search'>;
export type DependencyChangeProvider = CapabilityProvider<'dependency-changes'>;
export type SourceDiscoveryProvider = CapabilityProvider<'source-discovery'>;
export const requestSchemas = Object.fromEntries(
  CAPABILITY_IDS.map((id) => [
    id,
    schema(
      `${id}-request`,
      object({
        invocationId: text(128),
        requestId: text(128),
        capabilityId: Type.Literal(id),
        capabilityVersion: Type.Literal(1),
        binding: ref(ContextBindingSchema),
        deadlineAt: count(),
        input: ref(inputSchemas[id]),
      }),
    ),
  ]),
) as unknown as Record<CapabilityId, TSchema>;
export const resultSchemas = Object.fromEntries(
  CAPABILITY_IDS.map((id) => {
    const common = {
      invocationId: text(128),
      capabilityId: Type.Literal(id),
      binding: ref(ContextBindingSchema),
    };
    return [
      id,
      schema(
        `${id}-result`,
        Type.Union([
          object({
            ...common,
            status: Type.Literal('ready'),
            completeness: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
            value: ref(outputSchemas[id]),
          }),
          object({
            ...common,
            status: Type.Union(
              ['not_applicable', 'unavailable', 'cancelled', 'resource_limit', 'error'].map((s) =>
                Type.Literal(s),
              ),
            ),
            reasonCode: text(128),
          }),
        ]),
      ),
    ];
  }),
) as unknown as Record<CapabilityId, TSchema>;
export const capabilitySchemas: Readonly<Record<string, TSchema>> = {
  'capability-binding': ContextBindingSchema,
  'capability-manifest': CapabilityManifestSchema,
  'capability-host-handshake': HostHandshakeSchema,
  'capability-plugin-handshake': PluginHandshakeSchema,
  ...Object.fromEntries(
    CAPABILITY_IDS.flatMap((id) => [
      [`capability-${id}-input`, inputSchemas[id]],
      [`capability-${id}-output`, outputSchemas[id]],
      [`capability-${id}-request`, requestSchemas[id]],
      [`capability-${id}-result`, resultSchemas[id]],
    ]),
  ),
};
deepFreeze(inputSchemas);
deepFreeze(outputSchemas);
deepFreeze(requestSchemas);
deepFreeze(resultSchemas);
deepFreeze(capabilitySchemas);
