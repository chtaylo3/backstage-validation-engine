import { Type } from '@sinclair/typebox';
import type { Static, TProperties, TSchema } from '@sinclair/typebox';
import { deepFreeze } from '../core/json.js';

export const CONTRACT_VERSION = '0.2' as const;
export const SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const text = () => Type.String({ minLength: 1 });
const strings = () => Type.Array(text(), { uniqueItems: true });
const timestamp = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const count = (maximum = Number.MAX_SAFE_INTEGER) => Type.Integer({ minimum: 0, maximum });
const positive = (maximum: number) => Type.Integer({ minimum: 1, maximum });
const version = () => Type.Literal(CONTRACT_VERSION);
const digest = () => Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const uri = () => Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9+.-]*:[^\\s]+$' });
const schema = <T extends TProperties>(name: string, properties: T) =>
  Type.Object(properties, {
    $schema: SCHEMA_DIALECT,
    $id: `urn:backstage-validation:${name}:${CONTRACT_VERSION}`,
    additionalProperties: false,
  });
const reference = <T extends TSchema>(definition: T) => {
  if (!definition.$id) throw new Error('Contract references require a schema ID');
  return Type.Unsafe<Static<T>>(Type.Ref(definition.$id));
};

export const JsonValueSchema = Type.Recursive(
  (self) =>
    Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(self),
      Type.Record(Type.String(), self),
    ]),
  { $schema: SCHEMA_DIALECT, $id: 'urn:backstage-validation:json-value:0.2' },
);
export type JsonValue = Static<typeof JsonValueSchema>;
const jsonValue = () => reference(JsonValueSchema);

const position = object({ line: count(), character: count() });
const range = object({ start: position, end: position });
const location = object({ uri: uri(), document: count(), path: Type.String(), range });
const artifactRef = object({ id: text(), version: text(), digest: digest() });
const kindName = () => Type.String({ pattern: '^[A-Za-z][A-Za-z0-9]{0,62}$' });
const kindNames = () => Type.Array(kindName(), { uniqueItems: true, maxItems: 256 });
export const SchemaArtifactSchema = schema('schema-artifact', {
  contractVersion: version(),
  id: text(),
  version: text(),
  digest: digest(),
  schema: reference(JsonValueSchema),
});
const sourceFile = object({
  uri: uri(),
  text: Type.String(),
  digest: digest(),
  origin: Type.Union([Type.Literal('repository'), Type.Literal('buffer')]),
  version: Type.Optional(count()),
});
const change = object({
  uri: uri(),
  kind: Type.Union([Type.Literal('added'), Type.Literal('modified'), Type.Literal('deleted')]),
});

export const SourceSnapshotSchema = schema('source-snapshot', {
  contractVersion: version(),
  digest: digest(),
  repository: text(),
  revision: text(),
  rootUri: Type.Optional(uri()),
  entrypoints: Type.Optional(Type.Array(uri(), { uniqueItems: true, maxItems: 1000 })),
  files: Type.Array(sourceFile),
  changes: Type.Array(change),
});

const dataProvenance = object({
  providerId: text(),
  connectionId: text(),
  installationId: text(),
  principalId: text(),
  permissionRevision: text(),
  scope: strings(),
  revision: text(),
  fetchedAt: timestamp(),
  expiresAt: timestamp(),
});
const dataEntry = Type.Union([
  object({
    key: text(),
    status: Type.Literal('present'),
    value: jsonValue(),
    provenance: dataProvenance,
  }),
  object({ key: text(), status: Type.Literal('missing'), provenance: dataProvenance }),
  object({
    key: text(),
    status: Type.Literal('unavailable'),
    reason: Type.Union([
      Type.Literal('permission_denied'),
      Type.Literal('timeout'),
      Type.Literal('offline'),
      Type.Literal('provider_error'),
    ]),
    provenance: dataProvenance,
  }),
]);
export const DataSnapshotSchema = schema('data-snapshot', {
  contractVersion: version(),
  digest: digest(),
  entries: Type.Array(dataEntry),
});

export const ResourceLimitsSchema = object({
  requestBytes: positive(16 * 1024 * 1024),
  fileBytes: positive(1024 * 1024),
  entities: positive(1000),
  rules: positive(256),
  graphDepth: positive(64),
  substitutionDepth: positive(8),
  expandedEntityBytes: positive(1024 * 1024),
  requestTimeoutMs: positive(5000),
  celWorkers: positive(2),
  celOutstandingJobs: positive(64),
  celExecutionMs: positive(100),
});
export const DeploymentProfileSchema = schema('deployment-profile', {
  contractVersion: version(),
  id: text(),
  profileVersion: text(),
  adapterId: Type.Union([
    Type.Literal('@backstage/catalog-model@1.10.2'),
    Type.Literal('@backstage/catalog-model@1.7.5'),
  ]),
  celProfileId: Type.Literal('bve-cel/1'),
  schemaDialect: Type.Literal('draft-07'),
  nativePolicies: object({
    defaultNamespace: Type.Boolean(),
    fieldFormat: Type.Boolean(),
    noForeignRootFields: Type.Boolean(),
    schema: Type.Boolean(),
    groupDefaultParent: Type.Boolean(),
    groupDefaultParentRef: Type.Optional(text()),
  }),
  admission: object({
    allowedKinds: kindNames(),
    locations: Type.Array(object({ sourcePrefix: uri(), allowedKinds: kindNames() }), {
      maxItems: 256,
    }),
  }),
  referenceContexts: Type.Array(
    object({
      path: text(),
      defaultKind: text(),
      namespace: Type.Union([Type.Literal('entity'), text()]),
    }),
  ),
  customKinds: Type.Array(
    object({
      apiVersion: Type.String({ minLength: 1, maxLength: 128 }),
      kind: kindName(),
      schema: artifactRef,
    }),
    { maxItems: 64 },
  ),
  readers: strings(),
  requiredProcessors: Type.Array(
    object({
      id: Type.String({ minLength: 1, maxLength: 128 }),
      stage: Type.String({ minLength: 1, maxLength: 128 }),
    }),
    { maxItems: 64 },
  ),
  limits: ResourceLimitsSchema,
});

const ruleBase = {
  id: text(),
  version: text(),
  mandatory: Type.Boolean(),
  severity: Type.Union([Type.Literal('error'), Type.Literal('warning')]),
  requires: strings(),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
};
const rule = Type.Union([
  object({
    ...ruleBase,
    kind: Type.Literal('cel'),
    expression: Type.String({ minLength: 1, maxLength: 4096 }),
  }),
  object({ ...ruleBase, kind: Type.Literal('schema'), schema: artifactRef }),
  object({
    ...ruleBase,
    kind: Type.Literal('catalog'),
    check: Type.Literal('exists'),
    referencePath: Type.String({ minLength: 1, maxLength: 4096 }),
  }),
]);
export const PolicyBundleSchema = schema('policy-bundle', {
  contractVersion: version(),
  id: text(),
  revision: text(),
  extends: Type.Array(digest(), { uniqueItems: true }),
  rules: Type.Array(rule, { maxItems: 256 }),
  schemas: Type.Array(artifactRef),
  plugins: Type.Array(artifactRef),
});

const authority = object({
  repository: text(),
  revision: text(),
  verifierId: text(),
  evidenceDigest: digest(),
});
export const ActivationManifestSchema = schema('activation-manifest', {
  contractVersion: version(),
  generation: positive(Number.MAX_SAFE_INTEGER),
  installationId: text(),
  repositoryId: text(),
  policyDigest: digest(),
  profileDigest: digest(),
  bypassDigest: digest(),
  activatedAt: timestamp(),
  authority,
});

export const ValidationRequestSchema = schema('validation-request', {
  contractVersion: version(),
  run: object({ runId: text(), attemptId: text(), generation: positive(Number.MAX_SAFE_INTEGER) }),
  execution: object({
    mode: Type.Union([Type.Literal('ci'), Type.Literal('ide')]),
    startedAt: timestamp(),
    deadlineAt: timestamp(),
  }),
  identity: object({
    installationId: text(),
    repositoryId: text(),
    authorityRef: text(),
    permissionRevision: text(),
  }),
  source: reference(SourceSnapshotSchema),
  baseline: Type.Optional(reference(SourceSnapshotSchema)),
  policy: object({ digest: digest(), revision: text() }),
  profile: object({ digest: digest(), id: text() }),
  activation: object({ digest: digest(), generation: positive(Number.MAX_SAFE_INTEGER) }),
  data: reference(DataSnapshotSchema),
});

const stage = Type.Union([
  Type.Literal('identity'),
  Type.Literal('bypass'),
  Type.Literal('policy'),
  Type.Literal('parse'),
  Type.Literal('substitution'),
  Type.Literal('compatibility'),
  Type.Literal('admission'),
  Type.Literal('overlay'),
  Type.Literal('rules'),
  Type.Literal('publication'),
]);
export const CoverageSchema = schema('coverage', {
  stage,
  subject: text(),
  required: Type.Boolean(),
  status: Type.Union([
    Type.Literal('verified'),
    Type.Literal('unsupported'),
    Type.Literal('unavailable'),
    Type.Literal('blocked'),
    Type.Literal('skipped'),
    Type.Literal('bypassed'),
  ]),
  reason: Type.Optional(text()),
});
const finding = object({
  id: digest(),
  ruleId: text(),
  ruleVersion: text(),
  subjectId: text(),
  message: text(),
  category: Type.Union([
    Type.Literal('input'),
    Type.Literal('compatibility'),
    Type.Literal('policy'),
    Type.Literal('configuration'),
    Type.Literal('dependency'),
    Type.Literal('resource'),
    Type.Literal('execution'),
  ]),
  severity: Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('info')]),
  enforcement: Type.Union([
    Type.Literal('blocking'),
    Type.Literal('advisory'),
    Type.Literal('bypassed'),
  ]),
  location,
  relatedLocations: Type.Array(location),
  edits: Type.Array(
    object({
      uri: uri(),
      sourceDigest: digest(),
      version: Type.Optional(count()),
      range,
      text: Type.String(),
    }),
  ),
});
export const RuleStateSchema = object({
  ruleId: text(),
  subjectId: text(),
  required: Type.Boolean(),
  status: Type.Union([
    Type.Literal('passed'),
    Type.Literal('failed'),
    Type.Literal('not_applicable'),
    Type.Literal('blocked'),
    Type.Literal('invalid_policy'),
    Type.Literal('incomplete'),
    Type.Literal('error'),
  ]),
  reason: Type.Optional(
    Type.Union([
      Type.Literal('timeout'),
      Type.Literal('cancelled'),
      Type.Literal('queue_exhausted'),
      Type.Literal('resource_limit'),
      Type.Literal('worker_failure'),
      Type.Literal('dependency_unavailable'),
      Type.Literal('prerequisite_blocked'),
      Type.Literal('invalid_expression'),
    ]),
  ),
});
export const BypassReceiptSchema = object({
  recordId: text(),
  revision: text(),
  type: Type.Union([Type.Literal('emergency'), Type.Literal('exception')]),
  installationId: text(),
  repositoryId: text(),
  entityScope: Type.Optional(text()),
  reason: text(),
  ruleIds: strings(),
  issuedAt: timestamp(),
  expiresAt: timestamp(),
  verifiedAt: timestamp(),
  authority,
});
export const ValidationResultSchema = schema('validation-result', {
  contractVersion: version(),
  run: ValidationRequestSchema.properties.run,
  mode: ValidationRequestSchema.properties.execution.properties.mode,
  provenance: object({
    sourceDigest: digest(),
    baselineDigest: Type.Optional(digest()),
    policyDigest: digest(),
    profileDigest: digest(),
    activationDigest: digest(),
    dataDigest: digest(),
    installationId: text(),
    repositoryId: text(),
  }),
  outcome: Type.Union([
    Type.Literal('completed'),
    Type.Literal('incomplete'),
    Type.Literal('error'),
    Type.Literal('bypassed'),
  ]),
  enforcement: Type.Union([Type.Literal('allow'), Type.Literal('block'), Type.Literal('advisory')]),
  findings: Type.Array(finding),
  coverage: Type.Array(reference(CoverageSchema)),
  artifacts: Type.Array(
    object({
      entityRef: text(),
      sourceUri: uri(),
      document: count(),
      sourceDigest: digest(),
      value: jsonValue(),
      provenance: Type.Array(
        object({ path: Type.String(), origin: location, transformation: text() }),
      ),
    }),
  ),
  ruleStates: Type.Array(RuleStateSchema),
  bypass: Type.Optional(BypassReceiptSchema),
  resources: object({
    startedAt: timestamp(),
    completedAt: timestamp(),
    deadlineAt: timestamp(),
    interrupted: Type.Union([
      Type.Literal('none'),
      Type.Literal('timeout'),
      Type.Literal('cancelled'),
      Type.Literal('resource_limit'),
      Type.Literal('worker_failure'),
    ]),
  }),
  freshness: object({
    evaluatedAt: timestamp(),
    authorityCheckedAt: timestamp(),
    publishBefore: timestamp(),
  }),
});

/** Standalone draft-07 resources; references resolve through their versioned URNs. */
export const contractSchemas = {
  'json-value': JsonValueSchema,
  'schema-artifact': SchemaArtifactSchema,
  'source-snapshot': SourceSnapshotSchema,
  'data-snapshot': DataSnapshotSchema,
  'deployment-profile': DeploymentProfileSchema,
  'policy-bundle': PolicyBundleSchema,
  'activation-manifest': ActivationManifestSchema,
  'validation-request': ValidationRequestSchema,
  coverage: CoverageSchema,
  'validation-result': ValidationResultSchema,
} as const;
deepFreeze(contractSchemas);

export type SourceSnapshot = Static<typeof SourceSnapshotSchema>;
export type SchemaArtifact = Static<typeof SchemaArtifactSchema>;
export type SourceFile = SourceSnapshot['files'][number];
export type SourceChange = SourceSnapshot['changes'][number];
export type DataSnapshot = Static<typeof DataSnapshotSchema>;
export type DataEntry = Static<typeof dataEntry>;
export type DeploymentProfile = Static<typeof DeploymentProfileSchema>;
export type PolicyBundle = Static<typeof PolicyBundleSchema>;
export type ActivationManifest = Static<typeof ActivationManifestSchema>;
export type ValidationRequest = Static<typeof ValidationRequestSchema>;
export type Coverage = Static<typeof CoverageSchema>;
export type Finding = Static<typeof finding>;
export type RuleState = Static<typeof RuleStateSchema>;
export type BypassReceipt = Static<typeof BypassReceiptSchema>;
export type ValidationResult = Static<typeof ValidationResultSchema>;
