import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Ajv } from 'ajv';
import { CONTRACT_VERSION, ValidationRequestSchema } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import type { SourceSnapshot } from '../contracts/schemas.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { deepFreeze, digestJson, immutableJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { createDataSnapshot } from '../core/snapshots.js';
import { createCatalogProvider } from '../providers/catalog.js';
import type { CatalogProvider } from '../providers/types.js';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const schema = Type.Object(
  {
    profile: Type.Unknown(),
    policy: Type.Unknown(),
    activation: Type.Unknown(),
    source: Type.Unknown(),
    identity: ValidationRequestSchema.properties.identity,
    debounceMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 250 })),
    catalog: Type.Optional(
      Type.Object(
        {
          connectionId: text,
          baseUrl: text,
          principalId: text,
          credentialRevision: text,
          scope: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
            maxItems: 16,
            uniqueItems: true,
          }),
          maxAgeMs: Type.Integer({ minimum: 0, maximum: 30_000 }),
          tokenEnv: Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' }),
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
  const config = deepFreeze({
    ...safe,
    profile: parseContract('deployment-profile', safe.profile),
    policy: parseContract('policy-bundle', safe.policy),
    activation: parseContract('activation-manifest', safe.activation),
    source: parseContract('source-snapshot', safe.source),
    debounceMs: safe.debounceMs ?? 25,
  });
  verifyRequestBindings(createLspRequest(config, config.source), config);
  return config;
}
export type LspConfig = ReturnType<typeof parseLspConfig>;

export function createLspRequest(
  config: Pick<LspConfig, 'profile' | 'policy' | 'activation' | 'identity'>,
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
  const token = environment[settings.tokenEnv];
  if (!token) throw new Error('Configured catalog credential is unavailable.');
  const provider: CatalogProvider = await createCatalogProvider({
    connectionId: settings.connectionId,
    baseUrl: settings.baseUrl,
    adapterId: config.profile.adapterId,
    credentials: (access) =>
      Promise.resolve({
        token,
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
