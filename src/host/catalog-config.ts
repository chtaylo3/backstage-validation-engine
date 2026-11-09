import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Ajv } from 'ajv';
import type { DeploymentProfile, ValidationRequest } from '../contracts/schemas.js';
import { immutableJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { createCatalogProvider } from '../providers/catalog.js';
import type { CatalogProvider } from '../providers/types.js';

const text = Type.String({ minLength: 1, maxLength: 4096 });
export const CatalogSettingsSchema = Type.Object(
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
);
export type CatalogSettings = Static<typeof CatalogSettingsSchema>;
export interface CatalogHostContext {
  readonly adapterId: DeploymentProfile['adapterId'];
  readonly identity: Immutable<ValidationRequest['identity']>;
  readonly policyDigest: string;
  readonly profileDigest: string;
}
const validate = new Ajv({ strict: true, ownProperties: true }).compile<CatalogSettings>(
  CatalogSettingsSchema,
);
export function parseCatalogSettings(input: unknown): Immutable<CatalogSettings> {
  const settings: unknown = immutableJson(input);
  if (
    !validate(settings) ||
    !!settings.tokenEnv === !!settings.tokenFile ||
    (settings.tokenFile && !isAbsolute(settings.tokenFile))
  )
    throw new Error('Select exactly one trusted catalog credential source.');
  return settings;
}

/** Credentials come from the host, independently of CLI or editor protocol configuration. */
export async function createHostCatalog(
  settings: Immutable<CatalogSettings> | undefined,
  context: CatalogHostContext,
  environment: NodeJS.ProcessEnv,
) {
  if (!settings) return undefined;
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
    adapterId: context.adapterId,
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
      installationId: context.identity.installationId,
      principalId: settings.principalId,
      permissionRevision: context.identity.permissionRevision,
      credentialRevision: settings.credentialRevision,
      scope: settings.scope,
      policyDigest: context.policyDigest,
      profileDigest: context.profileDigest,
      maxAgeMs: settings.maxAgeMs,
    },
  };
}
