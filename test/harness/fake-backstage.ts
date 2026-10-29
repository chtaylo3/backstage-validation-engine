import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { immutableJson } from '../../src/core/json.js';
import type { ContractArtifact } from './contract-artifact.js';
import { CatalogContractError, compileCatalogContract } from './catalog-contract.js';
import type { CatalogOperation } from './catalog-contract.js';

export interface FixturePrincipal {
  readonly token: string;
  readonly principalId: string;
  readonly canRead: boolean;
  readonly visibleRefs: '*' | readonly string[];
}
export interface RequestMatch {
  readonly operation: CatalogOperation;
  readonly entityRef?: string;
}
export type FixtureFault =
  | {
      readonly kind: 'status';
      readonly status: 302 | 401 | 403 | 404 | 429 | 503;
      readonly retryAfter?: string;
      readonly location?: string;
    }
  | { readonly kind: 'invalid-body'; readonly body: unknown }
  | { readonly kind: 'malformed-json' }
  | { readonly kind: 'disconnect' };
export interface FixtureRequest {
  readonly id: number;
  readonly operation: CatalogOperation | undefined;
  readonly principalId: string | undefined;
  readonly status: number | undefined;
  readonly cancelled: boolean;
  readonly fault: FixtureFault['kind'] | undefined;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export interface ResponseGate {
  readonly entered: Promise<void>;
  readonly cancelled: Promise<void>;
  release(): void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function canonical(ref: Parameters<typeof parseEntityRef>[0]): string {
  try {
    return stringifyEntityRef(parseEntityRef(ref));
  } catch {
    throw new HttpError(400, 'Invalid entity reference');
  }
}
function errorBody(status: number, message: string) {
  return { error: { name: 'FixtureError', message }, response: { statusCode: status } };
}
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      request.resume();
      throw new HttpError(413, 'Fixture request exceeds 64 KiB');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Malformed JSON request');
  }
}

/** Two read operations only. All controls are local methods, separate from the emulated API. */
export async function startFakeBackstage(
  artifact: ContractArtifact,
  options: {
    readonly entities?: readonly unknown[];
    readonly principals?: readonly FixturePrincipal[];
  } = {},
) {
  const contract = compileCatalogContract(artifact);
  const entities = new Map<string, unknown>();
  const principals = new Map<string, FixturePrincipal>();
  const failures: unknown[] = [];
  const logs: { -readonly [K in keyof FixtureRequest]: FixtureRequest[K] }[] = [];
  const faults: { match: RequestMatch; fault: FixtureFault }[] = [];
  const gates: {
    match: RequestMatch;
    entered: ReturnType<typeof deferred>;
    cancelled: ReturnType<typeof deferred>;
    released: ReturnType<typeof deferred>;
  }[] = [];
  const activeGates = new Set<(typeof gates)[number]>();
  let closed = false;
  const upsert = (input: unknown): void => {
    const entity = immutableJson(input);
    contract.assertEntity(entity);
    // The pinned envelope schema guarantees these fields; native helpers canonicalize the triplet.
    const value = entity as {
      readonly kind: string;
      readonly metadata: { readonly namespace?: string; readonly name: string };
    };
    const key = canonical({
      kind: value.kind,
      namespace: value.metadata.namespace ?? 'default',
      name: value.metadata.name,
    });
    entities.set(key, entity);
  };
  const setPrincipal = (principal: FixturePrincipal): void => {
    if (!principal.token || !principal.principalId)
      throw new Error('Fixture principal and token are required');
    principals.set(
      principal.token,
      Object.freeze({
        ...principal,
        visibleRefs:
          principal.visibleRefs === '*'
            ? '*'
            : Object.freeze(principal.visibleRefs.map((ref) => canonical(ref))),
      }),
    );
  };
  for (const entity of options.entities ?? []) upsert(entity);
  for (const principal of options.principals ?? []) {
    if (principals.has(principal.token)) throw new Error('Duplicate fixture token');
    setPrincipal(principal);
  }
  const matches = (match: RequestMatch, operation: CatalogOperation, refs: readonly string[]) =>
    match.operation === operation &&
    (match.entityRef === undefined || refs.includes(match.entityRef));
  const normalizedMatch = (match: RequestMatch): RequestMatch =>
    Object.freeze(
      match.entityRef === undefined
        ? { operation: match.operation }
        : { operation: match.operation, entityRef: canonical(match.entityRef) },
    );
  const respond = (
    response: ServerResponse,
    operation: CatalogOperation | undefined,
    status: number,
    body: unknown,
  ) => {
    if (operation !== undefined) contract.assertResponse(operation, status, body);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const byName = /^\/api\/catalog\/entities\/by-name\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
      url.pathname,
    );
    const operation: CatalogOperation | undefined =
      request.method === 'GET' && byName
        ? 'byName'
        : request.method === 'POST' && url.pathname === '/api/catalog/entities/by-refs'
          ? 'byRefs'
          : undefined;
    const log = {
      id: logs.length + 1,
      operation,
      principalId: undefined as string | undefined,
      status: undefined as number | undefined,
      cancelled: false,
      fault: undefined as FixtureFault['kind'] | undefined,
    };
    logs.push(log);
    let gate: (typeof gates)[number] | undefined;
    response.once('close', () => {
      if (!response.writableFinished && log.fault !== 'disconnect') {
        log.cancelled = true;
        if (gate) {
          gate.cancelled.release();
          gate.released.release();
        }
      }
    });
    try {
      if (operation === undefined) throw new HttpError(404, 'Unsupported fixture route');
      const header = request.headers.authorization;
      const token = /^Bearer (.+)$/.exec(header ?? '')?.[1];
      const principal = token === undefined ? undefined : principals.get(token);
      if (!principal) throw new HttpError(401, 'Fixture credentials are missing or invalid');
      log.principalId = principal.principalId;
      if (!principal.canRead)
        throw new HttpError(403, 'Fixture principal cannot read catalog entities');
      if (url.search)
        throw new HttpError(501, 'Query parameters are outside the implemented fixture subset');
      let params: Record<string, string> = {};
      let body: unknown;
      if (operation === 'byName') {
        try {
          params = {
            kind: decodeURIComponent(byName![1]!),
            namespace: decodeURIComponent(byName![2]!),
            name: decodeURIComponent(byName![3]!),
          };
        } catch {
          throw new HttpError(400, 'Malformed path encoding');
        }
      } else body = await jsonBody(request);
      try {
        contract.assertRequest(operation, params, body);
      } catch (error) {
        if (error instanceof CatalogContractError) throw new HttpError(400, error.message);
        throw error;
      }
      const input = body as
        { entityRefs?: string[]; fields?: unknown; query?: unknown } | undefined;
      if (operation === 'byRefs' && (input === undefined || !Array.isArray(input.entityRefs))) {
        throw new HttpError(400, 'entityRefs are required by the fixture');
      }
      if (input?.fields !== undefined || input?.query !== undefined) {
        throw new HttpError(
          501,
          'Projection and predicate queries are outside the implemented fixture subset',
        );
      }
      const refs =
        operation === 'byName'
          ? [canonical({ kind: params.kind!, namespace: params.namespace!, name: params.name! })]
          : input!.entityRefs!.map((ref) => canonical(ref));
      const visible = (ref: string): unknown =>
        principal.visibleRefs === '*' || principal.visibleRefs.includes(ref)
          ? (entities.get(ref) ?? null)
          : null;
      // Capture the response before the gate, so races can deliberately deliver an older snapshot.
      let status = operation === 'byName' && visible(refs[0]!) === null ? 404 : 200;
      let result: unknown =
        operation === 'byName'
          ? status === 404
            ? errorBody(status, 'Entity is absent from the authorized catalog view')
            : visible(refs[0]!)
          : { items: refs.map(visible) };
      const faultIndex = faults.findIndex((entry) => matches(entry.match, operation, refs));
      const fault = faultIndex < 0 ? undefined : faults.splice(faultIndex, 1)[0]!.fault;
      const gateIndex = gates.findIndex((entry) => matches(entry.match, operation, refs));
      gate = gateIndex < 0 ? undefined : gates.splice(gateIndex, 1)[0];
      if (gate !== undefined) {
        activeGates.add(gate);
        gate.entered.release();
        if (response.destroyed) {
          gate.cancelled.release();
          gate.released.release();
        }
        await gate.released.promise;
        activeGates.delete(gate);
      }
      if (closed || response.destroyed) return;
      if (fault !== undefined) {
        log.fault = fault.kind;
        if (fault.kind === 'disconnect') {
          response.destroy();
          return;
        }
        if (fault.kind === 'malformed-json') {
          log.status = 200;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{'); // Explicit fault bypasses the response-schema guard.
          return;
        }
        if (fault.kind === 'invalid-body') {
          log.status = 200;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(fault.body));
          return;
        }
        if (fault.retryAfter !== undefined) response.setHeader('retry-after', fault.retryAfter);
        if (fault.location !== undefined) response.setHeader('location', fault.location);
        status = fault.status;
        result = errorBody(status, 'Injected catalog fixture failure');
      }
      log.status = status;
      respond(response, operation, status, result);
    } catch (error) {
      if (response.destroyed || request.aborted) {
        log.cancelled = true;
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) failures.push(error);
      log.status = status;
      if (!response.destroyed)
        respond(
          response,
          operation,
          status,
          errorBody(
            status,
            error instanceof HttpError ? error.message : 'Internal fixture failure',
          ),
        );
    }
  };
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const work = handle(request, response).catch((error: unknown) => {
      failures.push(error);
      response.destroy();
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 64;
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Expected a localhost fixture address');
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    target: artifact.target,
    baseUrl: `http://127.0.0.1:${address.port}/api/catalog`,
    upsert,
    remove: (ref: string) => entities.delete(canonical(ref)),
    setPrincipal,
    revokeToken: (token: string) => principals.delete(token),
    requests: (): readonly FixtureRequest[] =>
      Object.freeze(logs.map((entry) => Object.freeze({ ...entry }))),
    assertHealthy(): void {
      if (failures.length) throw new AggregateError(failures, 'Catalog fixture contract failure');
    },
    failNext(match: RequestMatch, fault: FixtureFault): void {
      faults.push({
        match: normalizedMatch(match),
        fault:
          fault.kind === 'invalid-body'
            ? Object.freeze({ ...fault, body: immutableJson(fault.body) })
            : Object.freeze({ ...fault }),
      });
    },
    holdNext(match: RequestMatch): ResponseGate {
      const entry = {
        match: normalizedMatch(match),
        entered: deferred(),
        cancelled: deferred(),
        released: deferred(),
      };
      gates.push(entry);
      return Object.freeze({
        entered: entry.entered.promise,
        cancelled: entry.cancelled.promise,
        release: entry.released.release,
      });
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        closed = true;
        for (const entry of [...gates, ...activeGates]) {
          entry.cancelled.release();
          entry.released.release();
        }
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
        server.closeAllConnections();
        await stopped;
        await Promise.allSettled([...pending]);
      })());
    },
  });
}

export type FakeBackstage = Awaited<ReturnType<typeof startFakeBackstage>>;
