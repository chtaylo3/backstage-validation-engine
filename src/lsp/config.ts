import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
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
import { createCatalogProvider } from '../providers/catalog.js';
import type { CatalogProvider } from '../providers/types.js';
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
    catalog: Type.Optional(
      Type.Object(
        {
          connectionId: text,
          baseUrl: text,
          allowInsecureHttp: Type.Optional(Type.Boolean()),
          principalId: text,
          credentialRevision: text,
          scope: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
            maxItems: 16,
            uniqueItems: true,
          }),
          maxAgeMs: Type.Integer({ minimum: 0, maximum: 30_000 }),
          tokenEnv: Type.Optional(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' })),
          tokenFile: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
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
  if (
    config.catalog &&
    (!!config.catalog.tokenEnv === !!config.catalog.tokenFile ||
      (config.catalog.tokenFile && !isAbsolute(config.catalog.tokenFile)))
  )
    throw new Error('Select exactly one trusted catalog credential source.');
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

/** Credentials are supplied by a trusted launcher environment, never document content. */
export async function createLspCatalog(config: LspConfig, environment: NodeJS.ProcessEnv) {
  if (!config.catalog) return undefined;
  const settings = config.catalog;
  const credential = async () => {
    if (settings.tokenEnv) {
      const token = environment[settings.tokenEnv];
      if (!token) throw new Error('Configured catalog credential is unavailable.');
      return token;
    }
    const handle = await open(
      settings.tokenFile!,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024 || stat.nlink !== 1)
        throw new Error('Configured catalog credential is unavailable.');
      const buffer = Buffer.alloc(16 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer);
      const after = await handle.stat();
      if (
        bytesRead !== stat.size ||
        after.nlink !== 1 ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error('Configured catalog credential changed during capture.');
      const token = new TextDecoder('utf-8', { fatal: true })
        .decode(buffer.subarray(0, bytesRead))
        .trim();
      if (!token || bytesRead > 16 * 1024 || /[\r\n]/u.test(token))
        throw new Error('Configured catalog credential is unavailable.');
      return token;
    } finally {
      await handle.close();
    }
  };
  await credential();
  const provider: CatalogProvider = await createCatalogProvider({
    connectionId: settings.connectionId,
    baseUrl: settings.baseUrl,
    ...(settings.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: settings.allowInsecureHttp }),
    adapterId: config.profile.adapterId,
    credentials: async (access) => ({
      token: await credential(),
      installationId: access.installationId,
      principalId: access.principalId,
      permissionRevision: access.permissionRevision,
      credentialRevision: access.credentialRevision,
      scope: access.scope,
    }),
  });
  return {
    provider,
    access: {
      installationId: config.identity.installationId,
      principalId: settings.principalId,
      permissionRevision: config.identity.permissionRevision,
      credentialRevision: settings.credentialRevision,
      scope: settings.scope,
      policyDigest: digestJson(config.policy),
      profileDigest: digestJson(config.profile),
      maxAgeMs: settings.maxAgeMs,
    },
  };
}
