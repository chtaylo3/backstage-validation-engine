import type { DataSnapshot, ValidationResult } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import type { FailureEvidence } from '../runtime/failure-evidence.js';
import type { BackstageAdapterId } from '../compatibility/types.js';

/** Constructed by the trusted host after resolving installation, principal and policy authority. */
export interface CatalogAccessContext {
  readonly installationId: string;
  readonly principalId: string;
  readonly permissionRevision: string;
  readonly credentialRevision: string;
  readonly scope: readonly string[];
  readonly policyDigest: string;
  readonly profileDigest: string;
  /** Zero bypasses the cache. Positive values bound the age at reuse, in milliseconds. */
  readonly maxAgeMs: number;
}
export interface CatalogCredentials {
  readonly token: string;
  readonly installationId: string;
  readonly principalId: string;
  readonly permissionRevision: string;
  readonly credentialRevision: string;
  readonly scope: readonly string[];
}
export const CATALOG_LIMITS = Object.freeze({
  concurrency: 4,
  outstanding: 64,
  references: 1000,
  batchSize: 100,
  attemptMs: 1000,
  retries: 1,
  retryDelayMs: 50,
  retryAfterMs: 1000,
  responseBytes: 1024 * 1024,
  totalResponseBytes: 8 * 1024 * 1024,
  responseValues: 40_000,
  cacheEntries: 512,
  cacheBytes: 8 * 1024 * 1024,
  presentTtlMs: 30_000,
  missingTtlMs: 5000,
});
export type CatalogLimits = { readonly [K in keyof typeof CATALOG_LIMITS]: number };
export type CatalogLimitOptions = { readonly [K in keyof CatalogLimits]?: number };
export interface CatalogProviderOptions {
  readonly connectionId: string;
  /** Complete trusted catalog base URL, e.g. https://backstage.example/api/catalog. */
  readonly baseUrl: string;
  readonly adapterId: BackstageAdapterId;
  readonly credentials: (
    access: CatalogAccessContext,
    signal: AbortSignal,
  ) => Promise<CatalogCredentials>;
  readonly limits?: CatalogLimitOptions;
  /** Trusted transport injection; defaults to Node fetch. */
  readonly transport?: typeof fetch;
}
export type CatalogFailureCode =
  | 'permission_denied'
  | 'credential_binding'
  | 'timeout'
  | 'cancelled'
  | 'offline'
  | 'provider_error'
  | 'rate_limited'
  | 'invalid_response'
  | 'resource_limit'
  | 'queue_limit';
export interface CatalogLookupReport {
  readonly data: Immutable<DataSnapshot>;
  readonly failures: readonly {
    readonly code: CatalogFailureCode;
    readonly entityRefs: readonly string[];
    readonly evidence?: FailureEvidence;
  }[];
  readonly interrupted: ValidationResult['resources']['interrupted'];
}
export interface CatalogExecutionContext {
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
}
/** Advisory identity search; never a validation observation or proof of absence. */
export interface CatalogSuggestionQuery {
  readonly kind: string;
  readonly namespace: string;
  readonly prefix: string;
}
export type CatalogSuggestionReport = {
  readonly refs: readonly string[];
  readonly truncated: boolean;
  readonly fetchedAt: number;
  readonly expiresAt: number;
} & (
  | { readonly status: 'ready' }
  | { readonly status: 'unavailable'; readonly failure: CatalogFailureCode }
);
export const CATALOG_SUGGESTION_LIMITS = Object.freeze({ pages: 4, pageSize: 100, results: 200 });
export interface CatalogProvider {
  readonly connectionId: string;
  readonly adapterId: BackstageAdapterId;
  lookup(
    references: readonly string[],
    access: CatalogAccessContext,
    execution: CatalogExecutionContext,
  ): Promise<CatalogLookupReport>;
  suggest?(
    query: CatalogSuggestionQuery,
    access: CatalogAccessContext,
    execution: CatalogExecutionContext,
  ): Promise<CatalogSuggestionReport>;
  stats(): {
    readonly active: number;
    readonly queued: number;
    readonly cacheEntries: number;
    readonly cacheBytes: number;
  };
  close(): Promise<void>;
}
export class CatalogProviderError extends Error {
  override readonly name = 'CatalogProviderError';
  constructor(
    readonly code: 'invalid_configuration' | 'invalid_reference' | 'input_limit' | 'closed',
  ) {
    super(
      {
        invalid_configuration: 'Invalid trusted catalog provider configuration.',
        invalid_reference: 'Catalog lookup requires a valid kind-qualified entity reference.',
        input_limit: 'Catalog lookup exceeds input limits.',
        closed: 'Catalog provider is closed.',
      }[code],
    );
  }
}

/** Internal safe failures; upstream messages and credentials never enter diagnostics. */
export class CatalogFailure extends Error {
  constructor(
    readonly code: CatalogFailureCode,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly detail?: Pick<FailureEvidence, 'stage' | 'cause'>,
  ) {
    super(`Catalog access failed: ${code}.`);
  }
}
