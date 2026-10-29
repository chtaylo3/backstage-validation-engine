import type { BackstageAdapter } from '../compatibility/types.js';
import type { JsonValue } from '../contracts/schemas.js';
import { ContractError } from '../core/errors.js';
import { canonicalJson, immutableJson } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import type { RequestBudget } from '../runtime/request-budget.js';
import { CelError } from '../runtime/cel/errors.js';
import { abortable, pause } from './async.js';
import type { CatalogRateLimit } from './async.js';
import { CatalogFailure } from './types.js';
import type { CatalogLimits } from './types.js';

export type CatalogObservation =
  | { readonly status: 'present'; readonly value: Immutable<JsonValue> }
  | { readonly status: 'missing' };

export function interruptionFailure(budget: RequestBudget): CatalogFailure {
  return new CatalogFailure(
    budget.signal.reason instanceof CelError && budget.signal.reason.code === 'request_timeout'
      ? 'timeout'
      : 'cancelled',
  );
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
      if (budget.interrupted) throw interruptionFailure(budget);
      const failure = timeout.aborted
        ? new CatalogFailure('timeout', true)
        : error instanceof CatalogFailure
          ? error
          : new CatalogFailure('offline', true);
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
