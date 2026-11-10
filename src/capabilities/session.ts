import { randomUUID } from 'node:crypto';
import { canonicalJson, digestJson, deepFreeze } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { RequestBudget } from '../runtime/request-budget.js';
import { cancellationError } from '../runtime/cel/errors.js';
import { parseContract } from '../contracts/validate.js';
import { childPointer } from '../parsing/locations.js';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import {
  CapabilityError,
  parseBinding,
  parseCapabilityRequest,
  parseCapabilityResult,
  parseHostHandshake,
  parseManifest,
  parsePluginHandshake,
} from './admission.js';
import {
  CAPABILITY_API,
  CAPABILITY_IDS,
  CAPABILITY_LIMITS,
  inputSchemas,
  outputSchemas,
  isCapabilityId,
} from './schemas.js';
import type {
  BoundRequest,
  CapabilityId,
  CapabilityInputs,
  CapabilityManifest,
  CapabilityOutputs,
  CapabilityResult,
  ContextBinding,
  HostHandshake,
  PluginHandshake,
} from './schemas.js';

/** Raw transport boundary. Typed providers use CapabilityProvider<K>; replies are always admitted here. */
export interface CapabilityEndpoint {
  initialize(request: Immutable<HostHandshake>): unknown;
  provide(
    request: Immutable<BoundRequest<CapabilityId>>,
    execution: { readonly signal: AbortSignal },
  ): unknown;
  cancel(invocationId: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface CapabilityApproval {
  readonly pluginId: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly capabilities: readonly CapabilityId[];
  readonly dependencies: readonly string[];
  readonly permissions: readonly string[];
  readonly executionProfiles: readonly ('builtin/1' | 'declarative/1')[];
  readonly languageProfiles: readonly string[];
}
export interface CapabilityInvocation {
  readonly requestId: string;
  readonly binding: Readonly<ContextBinding>;
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  readonly current?: () => boolean;
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CapabilityError('cleanup')), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Host approval is an independent argument. A manifest is never its own permission grant. */
export class CapabilitySession {
  readonly manifest: Immutable<CapabilityManifest>;
  private readonly ready: Promise<void>;
  private initialized = false;
  private stopped = false;
  private failed = false;
  private cleanupFailed = false;
  private serial = 0;
  private readonly id = randomUUID();
  private readonly active = new Map<
    string,
    { work: Promise<unknown>; controller: AbortController }
  >();
  private readonly owned = new Set<Promise<unknown>>();
  private readonly negotiated = new Map<CapabilityId, 'prepared' | 'async'>();
  private disposal: Promise<void> | undefined;
  constructor(
    manifest: unknown,
    approval: CapabilityApproval,
    private readonly endpoint: CapabilityEndpoint,
    private readonly closeMs: number = CAPABILITY_LIMITS.closeMs,
  ) {
    this.manifest = parseManifest(manifest);
    if (!Number.isSafeInteger(closeMs) || closeMs < 1 || closeMs > CAPABILITY_LIMITS.closeMs)
      throw new CapabilityError('invalid_record');
    const loaded = this.manifest;
    if (
      loaded.pluginId !== approval.pluginId ||
      loaded.artifactDigest !== approval.artifactDigest ||
      digestJson(loaded) !== approval.manifestDigest ||
      !approval.executionProfiles.includes(loaded.executionProfile) ||
      loaded.dependencies.some((dependency) => !approval.dependencies.includes(dependency)) ||
      loaded.permissions.some((permission) => !approval.permissions.includes(permission)) ||
      loaded.languageProfiles.some((profile) => !approval.languageProfiles.includes(profile)) ||
      (loaded.capabilities.some((capability) => capability.id === 'dependency-changes') &&
        !loaded.changeObservation) ||
      new Set(loaded.capabilities.map((capability) => capability.id)).size !==
        loaded.capabilities.length
    )
      throw new CapabilityError('not_approved');
    const capabilities = loaded.capabilities.filter((capability) => {
      const supported =
        isCapabilityId(capability.id) &&
        approval.capabilities.includes(capability.id) &&
        capability.version === 1 &&
        capability.inputSchemaDigest === digestJson(inputSchemas[capability.id]) &&
        capability.outputSchemaDigest === digestJson(outputSchemas[capability.id]);
      if (!supported && capability.required) throw new CapabilityError('unsupported');
      return supported;
    });
    const handshake = parseHostHandshake({
      apiVersion: CAPABILITY_API,
      pluginId: loaded.pluginId,
      artifactDigest: loaded.artifactDigest,
      manifestDigest: approval.manifestDigest,
      executionProfile: loaded.executionProfile,
      capabilities,
      dependencies: loaded.dependencies,
      permissions: loaded.permissions,
      languageProfiles: loaded.languageProfiles,
    });
    const accept = (input: unknown) => {
      const reply = parsePluginHandshake(input);
      if (
        reply.pluginId !== loaded.pluginId ||
        reply.artifactDigest !== loaded.artifactDigest ||
        reply.manifestDigest !== approval.manifestDigest ||
        new Set(reply.capabilities.map((c) => c.id)).size !== reply.capabilities.length ||
        reply.capabilities.some(
          (c) =>
            !capabilities.some((allowed) => allowed.id === c.id && allowed.version === c.version),
        ) ||
        capabilities.some(
          (c) =>
            c.required &&
            !reply.capabilities.some(
              (actual) => actual.id === c.id && actual.version === c.version,
            ),
        )
      )
        throw new CapabilityError('unsupported');
      for (const capability of reply.capabilities)
        if (isCapabilityId(capability.id))
          this.negotiated.set(
            capability.id,
            capabilities.find((c) => c.id === capability.id)!.mode,
          );
      if (!this.stopped) this.initialized = true;
    };
    try {
      const result = endpoint.initialize(handshake);
      if (result instanceof Promise) {
        this.owned.add(result);
        void result.then(
          () => this.owned.delete(result),
          () => this.owned.delete(result),
        );
        this.ready = bounded(result, closeMs)
          .then(accept)
          .catch((error: unknown) => {
            this.failed = true;
            throw error;
          });
        // A late acquisition still receives cleanup after a timed-out initialization or close.
        void result
          .then(() => {
            if (this.stopped || this.failed)
              return bounded(
                Promise.resolve().then(() => endpoint.dispose()),
                closeMs,
              );
            return undefined;
          })
          .catch(() => {
            this.failed = true;
          });
      } else {
        accept(result);
        this.ready = Promise.resolve();
      }
    } catch (error) {
      this.failed = true;
      this.ready = Promise.reject(
        error instanceof Error ? error : new CapabilityError('invalid_record'),
      );
    }
    void this.ready.catch(() => {
      this.failed = true;
    });
  }
  get status() {
    return Object.freeze({
      initialized: this.initialized,
      closed: this.stopped,
      failed: this.failed,
      active: this.active.size,
      owned: this.owned.size,
      capabilities: [...this.negotiated.keys()],
    });
  }
  whenReady(): Promise<void> {
    return this.ready;
  }
  private prepare<K extends CapabilityId>(
    id: K,
    input: CapabilityInputs[K] | Immutable<CapabilityInputs[K]>,
    context: CapabilityInvocation,
  ): Immutable<BoundRequest<K>> {
    if (this.stopped || this.failed) throw new CapabilityError('closed');
    if (!this.initialized || !this.negotiated.has(id)) throw new CapabilityError('unsupported');
    if (context.signal?.aborted) throw new CapabilityError('cancelled');
    if (Date.now() >= context.deadlineAt) throw new CapabilityError('deadline', 'admission');
    if (context.current && !context.current()) throw new CapabilityError('binding');
    if (this.active.size >= CAPABILITY_LIMITS.outstanding)
      throw new CapabilityError('resource_limit');
    const request = parseCapabilityRequest(id, {
      invocationId: `${this.id}:${++this.serial}`,
      requestId: context.requestId,
      capabilityId: id,
      capabilityVersion: 1,
      binding: parseBinding(context.binding),
      deadlineAt: context.deadlineAt,
      input,
    });
    if (id === 'validation') {
      const original = parseContract(
        'validation-request',
        (request.input as Immutable<CapabilityInputs['validation']>).request,
      );
      const binding = request.binding;
      if (
        original.source.digest !== binding.sourceDigest ||
        original.baseline?.digest !== binding.baselineDigest ||
        original.data.digest !== binding.dataDigest ||
        original.policy.digest !== binding.policyDigest ||
        original.profile.digest !== binding.profileDigest ||
        original.activation.digest !== binding.activationDigest ||
        original.activation.generation !== binding.activationGeneration ||
        original.execution.deadlineAt !== request.deadlineAt
      )
        throw new CapabilityError('binding');
    }
    return request;
  }
  private admit<K extends CapabilityId>(
    id: K,
    input: unknown,
    request: Immutable<BoundRequest<K>>,
    context: CapabilityInvocation,
  ): Immutable<CapabilityResult<K>> {
    if (this.stopped || this.failed) throw new CapabilityError('closed');
    if (context.signal?.aborted) throw new CapabilityError('cancelled');
    if (Date.now() >= context.deadlineAt) throw new CapabilityError('deadline', 'reply');
    if (context.current && !context.current()) throw new CapabilityError('binding');
    const result = parseCapabilityResult(id, input);
    if (
      result.invocationId !== request.invocationId ||
      !same(result.binding, request.binding) ||
      !same(context.binding, request.binding)
    )
      throw new CapabilityError('binding');
    if (result.status === 'ready') {
      if (id === 'fields') {
        const value = result.value as Immutable<CapabilityOutputs['fields']>;
        const input = request.input as Immutable<CapabilityInputs['fields']>;
        if (
          value.fields.some(
            (field) =>
              field.path !== childPointer(input.path, field.name) ||
              field.subjectStage !== input.subjectStage ||
              !same(field.scope, input.scope) ||
              !field.name.startsWith(input.prefix) ||
              (input.existing.includes(field.name) && field.name !== input.prefix),
          )
        )
          throw new CapabilityError('binding');
      } else if (id === 'references') {
        const value = result.value as Immutable<CapabilityOutputs['references']>;
        const input = request.input as Immutable<CapabilityInputs['references']>;
        if (value.references.some((reference) => reference.path !== input.path))
          throw new CapabilityError('binding');
      } else if (id === 'repairs') {
        const value = result.value as Immutable<CapabilityOutputs['repairs']>;
        const input = request.input as Immutable<CapabilityInputs['repairs']>;
        if (
          value.proposals.some(
            (proposal) =>
              proposal.path !== input.path ||
              proposal.findingId !== input.findingId ||
              proposal.subjectId !== input.subjectId ||
              proposal.operation !==
                (input.current.state === 'absent' ? 'insertProperty' : 'setValue'),
          )
        )
          throw new CapabilityError('binding');
      } else if (id === 'source-discovery') {
        const value = result.value as Immutable<CapabilityOutputs['source-discovery']>;
        const input = request.input as Immutable<CapabilityInputs['source-discovery']>;
        if (
          value.sources.some(
            (source) =>
              !isCanonicalSourceUri(source.uri) ||
              !input.roots.some(
                (root) => isCanonicalSourceUri(root, true) && source.uri.startsWith(root),
              ),
          )
        )
          throw new CapabilityError('binding');
      }
    }
    if (id === 'validation' && result.status === 'ready') {
      const value = result.value as Immutable<CapabilityOutputs['validation']>;
      const original = (request.input as Immutable<CapabilityInputs['validation']>).request;
      const evaluated = parseContract('validation-request', {
        ...original,
        data: value.materializedData,
        execution: { ...original.execution, startedAt: value.evaluatedAt },
      });
      if (
        value.evaluationDataDigest !== evaluated.data.digest ||
        value.evaluatedAt < original.execution.startedAt ||
        value.artifacts.some(
          (artifact) =>
            !original.source.files.some(
              (file) => file.uri === artifact.sourceUri && file.digest === artifact.sourceDigest,
            ),
        )
      )
        throw new CapabilityError('binding');
    }
    return result;
  }
  /** Only negotiated, precomputed built-in functions can use the synchronous path. */
  providePrepared<K extends CapabilityId>(
    id: K,
    input: CapabilityInputs[K] | Immutable<CapabilityInputs[K]>,
    context: CapabilityInvocation,
  ): Immutable<CapabilityResult<K>> {
    const request = this.prepare(id, input, context);
    if (this.negotiated.get(id) !== 'prepared' || this.manifest.executionProfile !== 'builtin/1')
      throw new CapabilityError('unsupported');
    const controller = new AbortController();
    using budget = new RequestBudget(
      context.deadlineAt,
      AbortSignal.any([controller.signal, ...(context.signal ? [context.signal] : [])]),
    );
    const result = this.endpoint.provide(request, {
      signal: budget.signal,
    });
    if (result instanceof Promise) {
      this.owned.add(result);
      void result.then(
        () => this.owned.delete(result),
        () => this.owned.delete(result),
      );
      controller.abort();
      const cancelling = Promise.resolve().then(() => this.endpoint.cancel(request.invocationId));
      this.owned.add(cancelling);
      void cancelling.then(
        () => this.owned.delete(cancelling),
        () => {
          this.owned.delete(cancelling);
          this.cleanupFailed = true;
        },
      );
      this.failed = true;
      throw new CapabilityError('unsupported');
    }
    budget.throwIfInterrupted();
    return this.admit(id, result, request, context);
  }
  async provide<K extends CapabilityId>(
    id: K,
    input: CapabilityInputs[K] | Immutable<CapabilityInputs[K]>,
    context: CapabilityInvocation,
  ): Promise<Immutable<CapabilityResult<K>>> {
    // Hosts await whenReady during admission. Requests never queue outside the invocation budget while initialization runs.
    const request = this.prepare(id, input, context);
    const controller = new AbortController();
    using budget = new RequestBudget(
      context.deadlineAt,
      AbortSignal.any([controller.signal, ...(context.signal ? [context.signal] : [])]),
    );
    const work = Promise.resolve().then(() => {
      budget.throwIfInterrupted();
      return this.endpoint.provide(request, {
        signal: budget.signal,
      });
    });
    this.active.set(request.invocationId, { work, controller });
    this.owned.add(work);
    void work.then(
      () => this.owned.delete(work),
      () => this.owned.delete(work),
    );
    let abort: (() => void) | undefined;
    try {
      const input = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(
              new CapabilityError(
                cancellationError(budget.signal).code === 'request_timeout'
                  ? 'deadline'
                  : 'cancelled',
                'reply',
              ),
            );
          budget.signal.addEventListener('abort', abort, { once: true });
          if (budget.signal.aborted) abort();
        }),
      ]);
      budget.throwIfInterrupted();
      return this.admit(id, input, request, context);
    } finally {
      if (abort) budget.signal.removeEventListener('abort', abort);
      if (budget.signal.aborted) {
        try {
          const outcomes = await bounded(
            Promise.allSettled([
              work,
              Promise.resolve().then(() => this.endpoint.cancel(request.invocationId)),
            ]),
            this.closeMs,
          );
          if (outcomes[1]?.status === 'rejected') {
            this.failed = true;
            this.cleanupFailed = true;
          }
        } catch {
          this.failed = true;
          this.cleanupFailed = true;
        }
      }
      // A failed drain poisons this generation before any slot can be reused.
      this.active.delete(request.invocationId);
    }
  }
  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopped = true;
    for (const { controller } of this.active.values()) controller.abort();
    this.disposal = (async () => {
      const outcomes = await Promise.allSettled([
        bounded(Promise.allSettled([...this.owned]), this.closeMs),
        bounded(
          this.ready.catch(() => undefined).then(() => this.endpoint.dispose()),
          this.closeMs,
        ),
        bounded(
          this.ready.catch(() => undefined),
          this.closeMs,
        ),
      ]);
      if (this.cleanupFailed || outcomes.some((outcome) => outcome.status === 'rejected'))
        throw new CapabilityError('cleanup');
    })();
    return this.disposal;
  }
}
export type BuiltinHandlers = {
  readonly [K in CapabilityId]?: (
    input: Immutable<CapabilityInputs[K]>,
    request: Immutable<BoundRequest<K>>,
    execution: { readonly signal: AbortSignal },
  ) =>
    | CapabilityOutputs[K]
    | Immutable<CapabilityOutputs[K]>
    | Promise<CapabilityOutputs[K] | Immutable<CapabilityOutputs[K]>>;
};
/** Factory selection is trusted host code. Neither manifest nor document can name a module to load. */
export function builtinCapabilitySession(
  id: string,
  handlers: BuiltinHandlers,
  settings: {
    readonly async?: readonly CapabilityId[];
    readonly required?: readonly CapabilityId[];
    readonly dependencies?: readonly string[];
    readonly permissions?: readonly ('catalog-read' | 'source-discovery')[];
    readonly languageProfiles?: readonly string[];
    readonly changeObservation?: CapabilityManifest['changeObservation'];
  } = {},
): CapabilitySession {
  const declared = CAPABILITY_IDS.filter((key) => handlers[key]);
  const artifact = {
    builtin: id,
    apiVersion: CAPABILITY_API,
    version: '1',
    capabilities: declared,
    dependencies: settings.dependencies ?? [],
  };
  const manifest = parseManifest({
    apiVersion: CAPABILITY_API,
    pluginId: id,
    version: '1',
    artifactDigest: digestJson(artifact),
    executionProfile: 'builtin/1',
    capabilities: declared.map((key) => ({
      id: key,
      version: 1,
      required: settings.required?.includes(key) ?? false,
      mode: settings.async?.includes(key) ? 'async' : 'prepared',
      inputSchemaDigest: digestJson(inputSchemas[key]),
      outputSchemaDigest: digestJson(outputSchemas[key]),
    })),
    dependencies: settings.dependencies ?? [],
    permissions: settings.permissions ?? [],
    subjectStages: ['authored', 'resolved', 'normalized'],
    languageProfiles: settings.languageProfiles ?? ['host-contract/0.2'],
    ...(settings.changeObservation ? { changeObservation: settings.changeObservation } : {}),
  });
  const endpoint: CapabilityEndpoint = {
    initialize: (request) =>
      ({
        apiVersion: CAPABILITY_API,
        pluginId: id,
        artifactDigest: manifest.artifactDigest,
        manifestDigest: request.manifestDigest,
        capabilities: request.capabilities.map(({ id, version }) => ({ id, version })),
      }) satisfies PluginHandshake,
    provide: (request, execution) => {
      const handler = handlers[request.capabilityId];
      if (!handler) throw new CapabilityError('unsupported');
      const call = handler as (
        input: Immutable<CapabilityInputs[CapabilityId]>,
        request: Immutable<BoundRequest<CapabilityId>>,
        execution: { readonly signal: AbortSignal },
      ) => unknown;
      const output = call(request.input, request, execution);
      const reply = (value: unknown) =>
        deepFreeze({
          status: 'ready',
          invocationId: request.invocationId,
          capabilityId: request.capabilityId,
          binding: request.binding,
          completeness: 'complete',
          value,
        });
      return output instanceof Promise ? output.then(reply) : reply(output);
    },
    cancel: () => {},
    dispose: () => {},
  };
  return new CapabilitySession(
    manifest,
    {
      pluginId: id,
      artifactDigest: manifest.artifactDigest,
      manifestDigest: digestJson(manifest),
      capabilities: declared,
      dependencies: settings.dependencies ?? [],
      permissions: settings.permissions ?? [],
      executionProfiles: ['builtin/1'],
      languageProfiles: settings.languageProfiles ?? ['host-contract/0.2'],
    },
    endpoint,
  );
}
