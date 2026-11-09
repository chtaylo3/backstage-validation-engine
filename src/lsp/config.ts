import {
  CatalogSettingsSchema,
  createHostCatalog,
  parseCatalogSettings,
} from '../host/catalog-config.js';
import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Ajv } from 'ajv';
import { CONTRACT_VERSION, ValidationRequestSchema } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import type { SchemaArtifact, SourceSnapshot } from '../contracts/schemas.js';
import { createCustomKindRegistry } from '../compatibility/custom-schemas.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { deepFreeze, digestJson, immutableJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { createDataSnapshot } from '../core/snapshots.js';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import { approvedFilesystemUri } from './discovery.js';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const schema = Type.Object(
  {
    profile: Type.Unknown(),
    policy: Type.Unknown(),
    activation: Type.Unknown(),
    source: Type.Unknown(),
    baseline: Type.Optional(Type.Unknown()),
    schemaArtifacts: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 64 })),
    identity: ValidationRequestSchema.properties.identity,
    filesystem: Type.Optional(
      Type.Object(
        {
          files: Type.Array(text, { maxItems: 1000, uniqueItems: true }),
          entrypoints: Type.Optional(Type.Array(text, { maxItems: 1000, uniqueItems: true })),
          discovery: Type.Optional(
            Type.Object(
              {
                roots: Type.Array(text, { minItems: 1, maxItems: 16, uniqueItems: true }),
                include: Type.Array(text, { minItems: 1, maxItems: 32, uniqueItems: true }),
                exclude: Type.Optional(Type.Array(text, { maxItems: 32, uniqueItems: true })),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    debounceMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 250 })),
    catalog: Type.Optional(CatalogSettingsSchema),
  },
  { additionalProperties: false },
);
const validate = new Ajv({ strict: true, ownProperties: true }).compile<Static<typeof schema>>(
  schema,
);

/** Launcher-owned configuration; LSP initialization/settings never select authority or credentials. */
export function parseLspConfig(input: unknown) {
  const safe: unknown = immutableJson(input);
  if (!validate(safe)) throw new Error('Invalid trusted LSP configuration.');
  const profile = parseContract('deployment-profile', safe.profile);
  const schemas = createCustomKindRegistry(
    profile,
    safe.schemaArtifacts as SchemaArtifact[] | undefined,
  );
  const { baseline: baselineInput, ...settings } = safe;
  const config = deepFreeze({
    ...settings,
    profile,
    schemaArtifacts: schemas.artifacts,
    policy: parseContract('policy-bundle', safe.policy),
    activation: parseContract('activation-manifest', safe.activation),
    source: parseContract('source-snapshot', safe.source),
    ...(baselineInput === undefined
      ? {}
      : { baseline: parseContract('source-snapshot', baselineInput) }),
    debounceMs: safe.debounceMs ?? 25,
  });
  if (config.filesystem) {
    const root = config.source.rootUri;
    const files = new Set(config.filesystem.files);
    if (
      !root ||
      !isCanonicalSourceUri(root, true) ||
      config.filesystem.files.some((uri) => !isCanonicalSourceUri(uri) || !uri.startsWith(root)) ||
      [...config.source.files, ...(config.baseline?.files ?? [])].some(
        (file) => !approvedFilesystemUri(config, file.uri),
      ) ||
      (config.filesystem.entrypoints ?? config.source.entrypoints ?? []).some(
        (uri) => !approvedFilesystemUri(config, uri),
      ) ||
      (!files.size && !config.filesystem.discovery) ||
      config.filesystem.discovery?.roots.some(
        (uri) => !isCanonicalSourceUri(uri, true) || !uri.startsWith(root),
      ) ||
      [
        ...(config.filesystem.discovery?.include ?? []),
        ...(config.filesystem.discovery?.exclude ?? []),
      ].some(
        (pattern) =>
          pattern.startsWith('/') || pattern.includes('\\') || pattern.split('/').includes('..'),
      )
    )
      throw new Error('Invalid trusted filesystem configuration.');
  }
  if (config.catalog) parseCatalogSettings(config.catalog);

  verifyRequestBindings(createLspRequest(config, config.source), config);
  return config;
}
export type LspConfig = ReturnType<typeof parseLspConfig>;

export function createLspRequest(
  config: Pick<LspConfig, 'profile' | 'policy' | 'activation' | 'identity' | 'source' | 'baseline'>,
  source: Immutable<SourceSnapshot>,
) {
  const now = Date.now();
  return parseContract('validation-request', {
    contractVersion: CONTRACT_VERSION,
    run: { runId: randomUUID(), attemptId: randomUUID(), generation: config.activation.generation },
    execution: {
      mode: 'ide',
      startedAt: now,
      deadlineAt: now + config.profile.limits.requestTimeoutMs,
    },
    identity: config.identity,
    source,
    ...((config.baseline ?? (config.source.changes.length === 0 ? config.source : undefined)) ===
    undefined
      ? {}
      : { baseline: config.baseline ?? config.source }),
    policy: { digest: digestJson(config.policy), revision: config.policy.revision },
    profile: { digest: digestJson(config.profile), id: config.profile.id },
    activation: { digest: digestJson(config.activation), generation: config.activation.generation },
    data: createDataSnapshot([]),
  });
}

/** Compatibility export for the existing LSP API. */
export function createLspCatalog(config: LspConfig, environment: NodeJS.ProcessEnv) {
  return createHostCatalog(
    config.catalog,
    {
      adapterId: config.profile.adapterId,
      identity: config.identity,
      policyDigest: digestJson(config.policy),
      profileDigest: digestJson(config.profile),
    },
    environment,
  );
}
