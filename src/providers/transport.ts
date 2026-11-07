import type { BackstageAdapter } from '../compatibility/types.js';
import type { JsonValue } from '../contracts/schemas.js';
import { ContractError } from '../core/errors.js';
import { canonicalJson, immutableJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import type { FailureStage } from '../runtime/failure-evidence.js';
import type { RequestBudget } from '../runtime/request-budget.js';
import { CelError } from '../runtime/cel/errors.js';
import { abortable, pause } from './async.js';
import type { CatalogRateLimit } from './async.js';
import { CatalogFailure } from './types.js';
import type { CatalogLimits } from './types.js';
import { CATALOG_SUGGESTION_LIMITS } from './types.js';
import type { CatalogSuggestionQuery } from './types.js';

export type CatalogObservation =
  | { readonly status: 'present'; readonly value: Immutable<JsonValue> }
  | { readonly status: 'missing' };

export function interruptionFailure(
  budget: RequestBudget,
  stage: FailureStage = 'catalog_admission',
): CatalogFailure {
  const timeout =
    budget.signal.reason instanceof CelError && budget.signal.reason.code === 'request_timeout';
  return new CatalogFailure(timeout ? 'timeout' : 'cancelled', false, undefined, {
    stage,
    cause: timeout ? 'request_timeout' : 'cancelled',
  });
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  remaining: { bytes: number; values: number },
  limit: number,
): Promise<unknown> {
  if (
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    throw new CatalogFailure('invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next: { done: boolean; value?: unknown } = await abortable(reader.read(), signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new CatalogFailure('invalid_response');
      size += next.value.byteLength;
      remaining.bytes -= next.value.byteLength;
      if (size > limit || remaining.bytes < 0) throw new CatalogFailure('resource_limit');
      chunks.push(next.value);
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const json: unknown = JSON.parse(text);
      canonicalJson(json, { maxBytes: limit, maxValues: remaining.values });
      const stack: unknown[] = [json];
      while (stack.length) {
        const current = stack.pop();
        remaining.values--;
        if (current !== null && typeof current === 'object')
          stack.push(...Object.values(current as Record<string, unknown>));
      }
      return json;
    } catch (error) {
      throw new CatalogFailure(
        error instanceof ContractError && error.code === 'limit'
          ? 'resource_limit'
          : 'invalid_response',
      );
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CatalogFailure('invalid_response');
  return value as Record<string, unknown>;
}

function retryDelay(header: string | null): number | undefined {
  if (header === null) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Bounded identity projection with opaque cursor pagination, sharing transport/admission limits. */
export async function fetchCatalogSuggestions(
  options: Omit<Parameters<typeof fetchCatalogBatch>[0], 'refs'> & {
    query: CatalogSuggestionQuery;
  },
) {
  const { budget, limits, query } = options;
  const refs = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const fetchedAt = Date.now();
  for (let page = 0; page < CATALOG_SUGGESTION_LIMITS.pages; page++) {
    budget.throwIfInterrupted();
    await options.rateLimit.wait(
      budget.signal,
      budget.deadlineAt - Date.now(),
      limits.retryAfterMs,
    );
    const timeout = AbortSignal.timeout(limits.attemptMs);
    const signal = AbortSignal.any([budget.signal, timeout]);
    const params = new URLSearchParams({
      fields: 'apiVersion,kind,metadata.name,metadata.namespace',
      limit: String(CATALOG_SUGGESTION_LIMITS.pageSize),
    });
    if (cursor !== undefined) params.set('cursor', cursor);
    else {
      params.set('filter', `kind=${query.kind},metadata.namespace=${query.namespace}`);
      params.set('fullTextFilterTerm', query.prefix);
      params.set('fullTextFilterFields', 'metadata.name');
      params.set('orderField', 'metadata.name,asc');
    }
    try {
      const response = await abortable(
        options.transport(`${options.baseUrl}/entities/by-query?${params.toString()}`, {
          headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
          redirect: 'manual',
          signal,
        }),
        signal,
        (late) => {
          void late.body?.cancel().catch(() => {});
        },
      );
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status)) throw new CatalogFailure('permission_denied');
        const delay = retryDelay(response.headers.get('retry-after'));
        if (response.status === 429 || (response.status === 503 && delay !== undefined))
          options.rateLimit.block(delay ?? limits.retryDelayMs);
        throw new CatalogFailure(response.status === 429 ? 'rate_limited' : 'provider_error');
      }
      const body = record(
        await readJson(response, signal, options.remaining, limits.responseBytes),
      );
      if (
        !Array.isArray(body.items) ||
        body.items.length > CATALOG_SUGGESTION_LIMITS.pageSize ||
        !Number.isSafeInteger(body.totalItems) ||
        (body.totalItems as number) < 0
      )
        throw new CatalogFailure('invalid_response');
      for (const item of body.items as unknown[]) {
        let ref: string;
        try {
          ref = options.adapter.entityReference(immutableJson(item));
        } catch {
          throw new CatalogFailure('invalid_response');
        }
        const value = options.adapter.resolveReference(ref);
        if (
          value.kind !== query.kind ||
          value.namespace !== query.namespace ||
          !/^[a-z0-9_.-]+$/u.test(value.name) ||
          ref.length > 512
        )
          throw new CatalogFailure('invalid_response');
        if (value.name.startsWith(query.prefix)) refs.add(ref);
      }
      const next = record(body.pageInfo).nextCursor;
      if (
        next !== undefined &&
        (typeof next !== 'string' || !next.length || next.length > 4096 || cursors.has(next))
      )
        throw new CatalogFailure('invalid_response');
      budget.throwIfInterrupted();
      if (signal.aborted) throw new CatalogFailure('timeout');
      cursor = next;
      if (cursor === undefined || refs.size >= CATALOG_SUGGESTION_LIMITS.results) break;
      cursors.add(cursor);
    } catch (error) {
      if (budget.interrupted) throw interruptionFailure(budget);
      if (timeout.aborted) throw new CatalogFailure('timeout');
      throw error instanceof CatalogFailure ? error : new CatalogFailure('offline');
    }
  }
  return {
    refs: [...refs].sort().slice(0, CATALOG_SUGGESTION_LIMITS.results),
    truncated: cursor !== undefined || refs.size > CATALOG_SUGGESTION_LIMITS.results,
    fetchedAt,
  };
}

export async function fetchCatalogBatch(options: {
  readonly baseUrl: string;
  readonly refs: readonly string[];
  readonly token: string;
  readonly transport: typeof fetch;
  readonly adapter: BackstageAdapter;
  readonly limits: CatalogLimits;
  readonly budget: RequestBudget;
  readonly remaining: { bytes: number; values: number };
  readonly rateLimit: CatalogRateLimit;
}): Promise<{ readonly observations: readonly CatalogObservation[]; readonly fetchedAt: number }> {
  const { refs, limits, budget } = options;
  const single = refs.length === 1;
  const reference = single ? options.adapter.resolveReference(refs[0]!) : undefined;
  const suffix =
    reference === undefined
      ? '/entities/by-refs'
      : `/entities/by-name/${[reference.kind, reference.namespace, reference.name].map(encodeURIComponent).join('/')}`;
  for (let attempt = 0; ; attempt++) {
    budget.throwIfInterrupted();
    await options.rateLimit.wait(
      budget.signal,
      budget.deadlineAt - Date.now(),
      limits.retryAfterMs,
    );
    budget.throwIfInterrupted();
    const timeout = AbortSignal.timeout(limits.attemptMs);
    const signal = AbortSignal.any([budget.signal, timeout]);
    const fetchedAt = Date.now();
    let stage: FailureStage = 'catalog_transport';
    try {
      const response = await abortable(
        options.transport(`${options.baseUrl}${suffix}`, {
          method: single ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            accept: 'application/json',
            ...(!single ? { 'content-type': 'application/json' } : {}),
          },
          ...(!single ? { body: JSON.stringify({ entityRefs: refs }) } : {}),
          redirect: 'manual',
          signal,
        }),
        signal,
        (late) => {
          void late.body?.cancel().catch(() => {});
        },
      );
      stage = 'catalog_response';
      if (single && response.status === 404) {
        const error = record(
          await readJson(response, signal, options.remaining, limits.responseBytes),
        );
        const detail = record(error.error);
        if (
          record(error.response).statusCode !== 404 ||
          typeof detail.name !== 'string' ||
          typeof detail.message !== 'string'
        ) {
          throw new CatalogFailure('invalid_response');
        }
        budget.throwIfInterrupted();
        if (signal.aborted) throw new CatalogFailure('timeout', true);
        return { observations: [{ status: 'missing' }], fetchedAt };
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403)
          throw new CatalogFailure('permission_denied');
        const delay = retryDelay(response.headers.get('retry-after'));
        if (response.status === 429 || (response.status === 503 && delay !== undefined)) {
          options.rateLimit.block(delay ?? limits.retryDelayMs);
        }
        throw new CatalogFailure(
          response.status === 429 ? 'rate_limited' : 'provider_error',
          [429, 500, 502, 503, 504].includes(response.status),
          delay,
        );
      }
      const json = await readJson(response, signal, options.remaining, limits.responseBytes);
      const items = single ? [json] : record(json).items;
      if (!Array.isArray(items) || items.length !== refs.length)
        throw new CatalogFailure('invalid_response');
      const observations = items.map((item: unknown, index): CatalogObservation => {
        if (item === null && !single) return { status: 'missing' };
        try {
          const value = immutableJson(item);
          if (options.adapter.entityReference(value) !== refs[index])
            throw new CatalogFailure('invalid_response');
          return { status: 'present', value };
        } catch (error) {
          if (error instanceof CatalogFailure) throw error;
          throw new CatalogFailure(
            error instanceof ContractError && error.code === 'limit'
              ? 'resource_limit'
              : 'invalid_response',
          );
        }
      });
      budget.throwIfInterrupted();
      if (signal.aborted) throw new CatalogFailure('timeout', true);
      return { observations, fetchedAt };
    } catch (error) {
      if (budget.interrupted) throw interruptionFailure(budget, stage);
      const problem = timeout.aborted
        ? new CatalogFailure('timeout', true)
        : error instanceof CatalogFailure
          ? error
          : new CatalogFailure('offline', true);
      const failure = new CatalogFailure(problem.code, problem.retryable, problem.retryAfterMs, {
        stage,
        cause: timeout.aborted || problem.code === 'timeout' ? 'attempt_timeout' : problem.code,
      });
      const delay = failure.retryAfterMs ?? limits.retryDelayMs * 2 ** attempt;
      if (
        !failure.retryable ||
        attempt >= limits.retries ||
        delay > limits.retryAfterMs ||
        delay >= budget.deadlineAt - Date.now()
      ) {
        throw failure;
      }
      await pause(delay, budget.signal);
    }
  }
}
