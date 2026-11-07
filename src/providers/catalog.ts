import { loadBackstageAdapter } from '../compatibility/adapter.js';
import type { DataEntry } from '../contracts/schemas.js';
import { deepFreeze, digestJson, digestText, canonicalJson, immutableJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { createDataSnapshot } from '../core/snapshots.js';
import { ContractError } from '../core/errors.js';
import { FailureTimer } from '../runtime/failure-evidence.js';
import type { FailureStage } from '../runtime/failure-evidence.js';
import { RequestBudget } from '../runtime/request-budget.js';
import { CatalogAdmission, CatalogRateLimit, abortable } from './async.js';
import { fetchCatalogBatch, interruptionFailure } from './transport.js';
import type { CatalogObservation } from './transport.js';
import { CATALOG_LIMITS, CatalogFailure, CatalogProviderError } from './types.js';
import type {
  CatalogAccessContext,
  CatalogCredentials,
  CatalogExecutionContext,
  CatalogFailureCode,
  CatalogLimits,
  CatalogLookupReport,
  CatalogProvider,
  CatalogProviderOptions,
} from './types.js';

export function catalogEntityKey(connectionId: string, canonicalRef: string): string {
  return `catalog/entity/${encodeURIComponent(connectionId)}/${canonicalRef}`;
}

function strings(values: readonly string[]): readonly string[] {
  if (
    values.length > 16 ||
    values.some((value) => typeof value !== 'string' || !value.length || value.length > 128) ||
    new Set(values).size !== values.length
  ) {
    throw new CatalogProviderError('invalid_configuration');
  }
  return Object.freeze([...values].sort());
}
export function normalizeCatalogAccess(input: CatalogAccessContext): CatalogAccessContext {
  let value: CatalogAccessContext;
  try {
    value = JSON.parse(
      canonicalJson(input, { maxBytes: 16 * 1024, maxValues: 64, maxStringChars: 128 }),
    ) as CatalogAccessContext;
  } catch {
    throw new CatalogProviderError('invalid_configuration');
  }
  const keys = new Set([
    'installationId',
    'principalId',
    'permissionRevision',
    'credentialRevision',
    'scope',
    'policyDigest',
    'profileDigest',
    'maxAgeMs',
  ]);
  if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !keys.has(key)))
    throw new CatalogProviderError('invalid_configuration');
  for (const text of [
    value.installationId,
    value.principalId,
    value.permissionRevision,
    value.credentialRevision,
  ]) {
    if (typeof text !== 'string' || !text.length || text.length > 128)
      throw new CatalogProviderError('invalid_configuration');
  }
  if (
    ![value.policyDigest, value.profileDigest].every(
      (digest) => typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest),
    ) ||
    !Number.isSafeInteger(value.maxAgeMs) ||
    value.maxAgeMs < 0 ||
    value.maxAgeMs > CATALOG_LIMITS.presentTtlMs ||
    !Array.isArray(value.scope)
  ) {
    throw new CatalogProviderError('invalid_configuration');
  }
  return Object.freeze({ ...value, scope: strings(value.scope) });
}

function credentialBinding(
  input: CatalogCredentials,
  access: CatalogAccessContext,
): CatalogCredentials {
  try {
    const value = immutableJson(input) as unknown as CatalogCredentials;
    if (
      typeof value.token !== 'string' ||
      !value.token.length ||
      value.token.length > 8192 ||
      /[\r\n]/.test(value.token)
    )
      throw new Error('token');
    for (const key of [
      'installationId',
      'principalId',
      'permissionRevision',
      'credentialRevision',
    ] as const) {
      if (value[key] !== access[key]) throw new Error('binding');
    }
    if (
      !Array.isArray(value.scope) ||
      JSON.stringify(strings(value.scope)) !== JSON.stringify(access.scope)
    )
      throw new Error('scope');
    return value;
  } catch {
    throw new CatalogFailure('credential_binding');
  }
}

function configuredLimits(input: CatalogProviderOptions['limits']): CatalogLimits {
  const limits = { ...CATALOG_LIMITS } as { -readonly [K in keyof CatalogLimits]: number };
  const safe = immutableJson(input ?? {}) as Record<string, unknown>;
  const zero = new Set(['retries', 'retryDelayMs', 'retryAfterMs', 'cacheEntries', 'cacheBytes']);
  for (const [key, value] of Object.entries(safe)) {
    if (
      !Object.hasOwn(CATALOG_LIMITS, key) ||
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < (zero.has(key) ? 0 : 1) ||
      value > CATALOG_LIMITS[key as keyof CatalogLimits]
    ) {
      throw new CatalogProviderError('invalid_configuration');
    }
    limits[key as keyof CatalogLimits] = value;
  }
  if (limits.concurrency > limits.outstanding)
    throw new CatalogProviderError('invalid_configuration');
  return Object.freeze(limits);
}

/** Host-owned connection and credential resolver; callers cannot select endpoints per lookup. */
export async function createCatalogProvider(
  options: CatalogProviderOptions,
): Promise<CatalogProvider> {
  let baseUrl: string;
  try {
    const url = new URL(options.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    ) {
      throw new Error('endpoint');
    }
    baseUrl = url.href.replace(/\/+$/, '');
  } catch {
    throw new CatalogProviderError('invalid_configuration');
  }
  const connectionId = options.connectionId;
  if (
    typeof connectionId !== 'string' ||
    !connectionId.length ||
    connectionId.length > 128 ||
    typeof options.credentials !== 'function'
  ) {
    throw new CatalogProviderError('invalid_configuration');
  }
  const limits = configuredLimits(options.limits);
  const resolveCredentials = options.credentials;
  const transport = options.transport ?? fetch;
  const adapter = await loadBackstageAdapter(options.adapterId);
  const admission = new CatalogAdmission(limits.concurrency, limits.outstanding);
  const rateLimit = new CatalogRateLimit();
  const shutdown = new AbortController();
  const calls = new Set<Promise<CatalogLookupReport>>();
  const cache = new Map<string, { entry: Immutable<DataEntry>; bytes: number }>();
  let cacheBytes = 0;
  let epoch = 0;
  let closing: Promise<void> | undefined;
  const discard = (key: string) => {
    const previous = cache.get(key);
    if (previous) {
      cacheBytes -= previous.bytes;
      cache.delete(key);
    }
  };
  const lookup = async (
    input: readonly string[],
    rawAccess: CatalogAccessContext,
    execution: CatalogExecutionContext,
  ): Promise<CatalogLookupReport> => {
    if (shutdown.signal.aborted) throw new CatalogProviderError('closed');
    let safeInput: readonly string[];
    try {
      const parsed: unknown = JSON.parse(
        canonicalJson(input, {
          maxValues: limits.references + 1,
          maxStringChars: 2048,
          maxBytes: 3 * 1024 * 1024,
        }),
      );
      if (
        !Array.isArray(parsed) ||
        parsed.length > limits.references ||
        parsed.some((ref: unknown) => typeof ref !== 'string')
      )
        throw new Error('references');
      safeInput = parsed as string[];
    } catch {
      throw new CatalogProviderError('input_limit');
    }
    const access = normalizeCatalogAccess(rawAccess);
    let refs: string[];
    try {
      refs = [...new Set(safeInput.map((ref) => adapter.resolveReference(ref).entityRef))];
    } catch {
      throw new CatalogProviderError('invalid_reference');
    }
    const timer = new FailureTimer();
    let stage: FailureStage = 'catalog_admission';
    const generation = ++epoch;
    using budget = new RequestBudget(
      execution.deadlineAt,
      AbortSignal.any([shutdown.signal, ...(execution.signal ? [execution.signal] : [])]),
    );
    const entries = new Map<string, Immutable<DataEntry>>();
    const failures: {
      code: CatalogFailureCode;
      entityRefs: readonly string[];
      evidence: ReturnType<FailureTimer['capture']>;
    }[] = [];
    let interrupted: CatalogLookupReport['interrupted'] = 'none';
    const entry = (
      ref: string,
      observation:
        | CatalogObservation
        | {
            readonly status: 'unavailable';
            readonly reason: Extract<DataEntry, { status: 'unavailable' }>['reason'];
          },
      fetchedAt: number,
    ): Immutable<DataEntry> => {
      const ttl =
        observation.status === 'missing'
          ? limits.missingTtlMs
          : observation.status === 'present'
            ? limits.presentTtlMs
            : 1000;
      return deepFreeze({
        key: catalogEntityKey(connectionId, ref),
        ...observation,
        provenance: {
          providerId: 'backstage-catalog',
          connectionId,
          installationId: access.installationId,
          principalId: access.principalId,
          permissionRevision: access.permissionRevision,
          scope: [...access.scope],
          revision: digestJson({ entityRef: ref, observation }),
          fetchedAt,
          expiresAt: fetchedAt + ttl,
        },
      });
    };
    const failure = (error: CatalogFailure, missing: readonly string[]) => {
      if (error.code === 'permission_denied' || error.code === 'credential_binding') {
        cache.clear();
        cacheBytes = 0;
        epoch++;
      }
      failures.push({
        code: error.code,
        entityRefs: missing,
        evidence: timer.capture(
          error.detail?.stage ?? stage,
          error.detail?.cause ?? (error.code === 'timeout' ? 'request_timeout' : error.code),
          execution.deadlineAt,
        ),
      });
      if (error.code === 'timeout' || error.code === 'cancelled') interrupted = error.code;
      else if (['resource_limit', 'queue_limit'].includes(error.code) && interrupted === 'none')
        interrupted = 'resource_limit';
      const reason =
        error.code === 'timeout' || error.code === 'cancelled'
          ? 'timeout'
          : error.code === 'credential_binding' || error.code === 'permission_denied'
            ? 'permission_denied'
            : error.code === 'offline'
              ? 'offline'
              : 'provider_error';
      for (const ref of missing)
        entries.set(ref, entry(ref, { status: 'unavailable', reason }, Date.now()));
    };
    let release: (() => void) | undefined;
    try {
      budget.throwIfInterrupted();
      if (refs.length) {
        release = await admission.acquire(budget.signal);
        budget.throwIfInterrupted();
        stage = 'catalog_credentials';
        const credentials = credentialBinding(
          await abortable(resolveCredentials(access, budget.signal), budget.signal),
          access,
        );
        budget.throwIfInterrupted();
        const partition = digestJson({
          connectionId,
          baseUrl,
          adapterId: adapter.id,
          access,
          tokenFingerprint: digestText(credentials.token),
        });
        const key = (ref: string) => `${partition}/${ref}`;
        for (const ref of refs) {
          const cached = cache.get(key(ref));
          const now = Date.now();
          if (
            cached &&
            access.maxAgeMs > 0 &&
            cached.entry.provenance.fetchedAt <= now &&
            now - cached.entry.provenance.fetchedAt <= access.maxAgeMs &&
            cached.entry.provenance.expiresAt > now
          ) {
            entries.set(ref, cached.entry);
            cache.delete(key(ref));
            cache.set(key(ref), cached);
          } else if (cached) discard(key(ref));
        }
        const pending = refs.filter((ref) => !entries.has(ref));
        const remaining = { bytes: limits.totalResponseBytes, values: limits.responseValues };
        for (let offset = 0; offset < pending.length; offset += limits.batchSize) {
          budget.throwIfInterrupted();
          const batch = pending.slice(offset, offset + limits.batchSize);
          try {
            stage = 'catalog_transport';
            const result = await fetchCatalogBatch({
              baseUrl,
              refs: batch,
              token: credentials.token,
              transport,
              adapter,
              limits,
              budget,
              remaining,
              rateLimit,
            });
            stage = 'catalog_snapshot';
            for (const [index, observation] of result.observations.entries()) {
              const ref = batch[index]!;
              const value = entry(ref, observation, result.fetchedAt);
              entries.set(ref, value);
              if (
                generation === epoch &&
                !shutdown.signal.aborted &&
                access.maxAgeMs > 0 &&
                value.provenance.expiresAt > Date.now()
              ) {
                const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
                if (limits.cacheEntries > 0 && bytes <= limits.cacheBytes) {
                  discard(key(ref));
                  while (
                    cache.size &&
                    (cache.size >= limits.cacheEntries || cacheBytes + bytes > limits.cacheBytes)
                  )
                    discard(cache.keys().next().value!);
                  cache.set(key(ref), { entry: value, bytes });
                  cacheBytes += bytes;
                }
              }
            }
          } catch (error) {
            if (budget.interrupted) throw interruptionFailure(budget, stage);
            const problem =
              error instanceof CatalogFailure ? error : new CatalogFailure('provider_error');
            // Exhaustion, authentication failure and invalid data block further dependent reads.
            if (
              ['resource_limit', 'permission_denied', 'invalid_response', 'rate_limited'].includes(
                problem.code,
              )
            )
              throw problem;
            failure(problem, batch);
          }
        }
      }
      stage = 'catalog_snapshot';
      budget.throwIfInterrupted();
    } catch (error) {
      const problem = budget.interrupted
        ? interruptionFailure(budget, stage)
        : error instanceof CatalogFailure
          ? error
          : new CatalogFailure('provider_error');
      failure(
        problem,
        refs.filter((ref) => !entries.has(ref)),
      );
    } finally {
      release?.();
    }
    stage = 'catalog_freshness';
    const completedAt = Date.now();
    const stale: string[] = [];
    const future: string[] = [];
    for (const [ref, value] of entries) {
      if (value.status === 'unavailable') {
        // This is the current local lack of usable data, not a renewed upstream observation.
        entries.set(ref, entry(ref, { status: 'unavailable', reason: value.reason }, completedAt));
      } else if (value.provenance.fetchedAt > completedAt) future.push(ref);
      else if (value.provenance.expiresAt <= completedAt) stale.push(ref);
    }
    if (future.length)
      failure(
        new CatalogFailure('timeout', false, undefined, {
          stage: 'catalog_freshness',
          cause: 'future_observation',
        }),
        future,
      );
    if (stale.length)
      failure(
        new CatalogFailure('timeout', false, undefined, {
          stage: 'catalog_freshness',
          cause: 'observation_expired',
        }),
        stale,
      );
    for (const [key, value] of cache) {
      if (
        value.entry.provenance.expiresAt <= completedAt ||
        value.entry.provenance.fetchedAt > completedAt
      )
        discard(key);
    }
    const finish = (data: CatalogLookupReport['data']): CatalogLookupReport => {
      if (budget.interrupted) {
        const problem = interruptionFailure(budget, stage);
        if (interrupted !== problem.code) failure(problem, []);
      }
      return deepFreeze({ data, failures, interrupted });
    };
    stage = 'catalog_snapshot';
    try {
      return finish(createDataSnapshot([...entries.values()]));
    } catch (error) {
      if (!(error instanceof ContractError) || error.code !== 'limit') throw error;
      entries.clear();
      failure(
        new CatalogFailure('resource_limit', false, undefined, {
          stage: 'catalog_snapshot',
          cause: 'aggregate_limit',
        }),
        refs,
      );
      return finish(createDataSnapshot([...entries.values()]));
    }
  };
  return Object.freeze<CatalogProvider>({
    connectionId,
    adapterId: adapter.id,
    lookup: (refs, access, execution) => {
      const work = lookup(refs, access, execution);
      calls.add(work);
      void work.then(
        () => calls.delete(work),
        () => calls.delete(work),
      );
      return work;
    },
    stats: () => Object.freeze({ ...admission.stats(), cacheEntries: cache.size, cacheBytes }),
    close: () =>
      (closing ??= (async () => {
        shutdown.abort();
        cache.clear();
        cacheBytes = 0;
        await Promise.allSettled([...calls]);
      })()),
  });
}
