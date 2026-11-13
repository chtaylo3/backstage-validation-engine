import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import type { CompletionList, CompletionParams, Range } from 'vscode-languageserver/node';
import type { ValidationRequest, JsonValue } from '../contracts/schemas.js';
import type { Immutable } from '../base/json.js';
import type { LocalCatalogSources } from '../pipeline/reference-data.js';
import { digestText } from '../base/json.js';
import { builtinCapabilitySession } from '../capabilities/session.js';
import type { CapabilitySession } from '../capabilities/session.js';
import { capabilityBinding, capabilityAuthorityDigest } from '../capabilities/bindings.js';
import { validateBackstageSources } from '../compatibility/sources.js';
import { loadBackstageAdapter } from '../compatibility/adapter.js';
import { buildProposedCatalog } from '../pipeline/proposed-catalog.js';
import { parseSourceSnapshot } from '../parsing/parser.js';
import { SourceLineIndex, childPointer } from '../parsing/locations.js';
import type { ParsedSourceDocument } from '../parsing/types.js';
import {
  compileReferenceContexts,
  isArrayIndex,
  REFERENCE_LIMITS,
} from '../contracts/reference-contexts.js';
import type { ReferencePattern } from '../contracts/reference-contexts.js';
import { normalizeCatalogAccess } from '../providers/catalog.js';
import { abortable } from '../providers/async.js';
import type {
  CatalogProvider,
  CatalogAccessContext,
  CatalogSuggestionQuery,
  CatalogSuggestionReport,
} from '../providers/types.js';
import { RequestBudget } from '../runtime/request-budget.js';
import type { FixDocument } from './fixes.js';
import type { LspConfig } from './config.js';

export const COMPLETION_LIMITS = Object.freeze({
  items: 100,
  slots: 1000,
  waitMs: 50,
  remoteMs: 500,
  cacheEntries: 32,
  cacheBytes: 256 * 1024,
});
interface Slot {
  readonly uri: string;
  readonly range: Immutable<Range>;
  readonly pattern: ReferencePattern;
  readonly namespace: string;
}
interface Index {
  readonly generation: number;
  readonly request: Immutable<ValidationRequest>;
  readonly source: Immutable<ValidationRequest['source']>;
  readonly slots: readonly Slot[];
  readonly refs: readonly string[];
  readonly proposed: Awaited<ReturnType<typeof buildProposedCatalog>>;
}
const empty = (): CompletionList => ({ isIncomplete: true, items: [] });
const safeRef = (ref: string) =>
  /^[a-z][a-z0-9]{0,62}:[a-z0-9_.-]{1,63}\/[a-z0-9_.-]{1,63}$/u.test(ref);

/** Exact authored scalar content, including empty YAML values; never keys/comments/aliases. */
function target(
  text: string,
  lines: SourceLineIndex,
  position: CompletionParams['position'],
  slot: Slot,
) {
  let start = lines.offset(slot.range.start),
    end = lines.offset(slot.range.end);
  const cursor = position && lines.offset(position);
  if (start === undefined || end === undefined || cursor === undefined || start > end)
    return undefined;
  if (end - start > 512) return undefined;
  const raw = text.slice(start, end);
  if (/[\r\n]/u.test(raw)) return undefined;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    start++;
    end--;
  }
  if (
    start > end ||
    cursor < start ||
    cursor > end ||
    !/^[a-zA-Z0-9_.:/-]*$/u.test(text.slice(start, end))
  )
    return undefined;
  const prefix = text.slice(start, cursor).toLowerCase();
  const match = /^(?:([a-z][a-z0-9]{0,62}):)?(?:([a-z0-9_.-]{1,63})\/)?([a-z0-9_.-]{0,63})$/u.exec(
    prefix,
  );
  if (!match) return undefined;
  return {
    range: lines.range(start, end),
    query: {
      kind: match[1] ?? slot.pattern.defaultKind.toLowerCase(),
      namespace: match[2] ?? slot.namespace,
      prefix: match[3]!,
    },
    filter: (ref: string) =>
      match[1]
        ? match[2]
          ? ref
          : ref.replace(/:[^/]+\//u, ':')
        : match[2]
          ? ref.slice(ref.indexOf(':') + 1)
          : ref.slice(ref.indexOf('/') + 1),
  };
}

/** One source-index task and one advisory remote query; neither runs CEL or waits on validation HTTP. */
export class CompletionService {
  private generation = 0;
  private index: Index | undefined;
  private pending:
    | {
        request: Immutable<ValidationRequest>;
        generation: number;
        local?: Promise<LocalCatalogSources | undefined>;
      }
    | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private remote:
    | {
        key: string;
        controller: AbortController;
        work: Promise<CatalogSuggestionReport | undefined>;
      }
    | undefined;
  private readonly work = new Set<Promise<unknown>>();
  private readonly cache = new Map<
    string,
    { report: CatalogSuggestionReport; wall: number; mono: number; ttl: number; bytes: number }
  >();
  private cacheBytes = 0;
  private stopped = false;
  private readonly history = new Map<string, number>();
  private selections = 0;
  private readonly catalog: { provider: CatalogProvider; access: CatalogAccessContext } | undefined;
  readonly capabilities: CapabilitySession;
  private querySerial = 0;
  constructor(
    private readonly config: LspConfig,
    catalog?: { provider: CatalogProvider; access: CatalogAccessContext },
    private readonly clock = { wall: () => Date.now(), mono: () => performance.now() },
    private readonly capabilityOptions: {
      readonly sessionGeneration?: number;
      readonly dependencyGeneration?: () => number;
      readonly provider?: CapabilitySession;
    } = {},
  ) {
    this.capabilities =
      capabilityOptions.provider ??
      builtinCapabilitySession(
        'bve.builtin.catalog-search',
        {
          search: async (query, request, execution) => {
            const catalog = this.catalog;
            if (!catalog?.provider.suggest)
              return {
                status: 'unavailable',
                failure: 'provider_unavailable',
                refs: [],
                truncated: false,
                fetchedAt: 0,
                expiresAt: 0,
              };
            return catalog.provider.suggest(query, catalog.access, {
              deadlineAt: request.deadlineAt,
              signal: execution.signal,
            });
          },
        },
        {
          async: ['search'],
          permissions: ['catalog-read'],
          dependencies: [config.profile.adapterId],
        },
      );
    if (catalog) {
      const access = normalizeCatalogAccess(catalog.access);
      if (
        catalog.provider.adapterId !== config.profile.adapterId ||
        access.installationId !== config.identity.installationId ||
        access.permissionRevision !== config.identity.permissionRevision ||
        access.policyDigest !== config.activation.policyDigest ||
        access.profileDigest !== config.activation.profileDigest
      )
        throw new Error('Invalid trusted completion catalog context.');
      this.catalog = { provider: catalog.provider, access };
    }
  }
  invalidateRemote(): void {
    this.cache.clear();
    this.cacheBytes = 0;
    this.remote?.controller.abort();
  }
  invalidate(): void {
    this.generation++;
    this.index = undefined;
    this.pending = undefined;
    this.controller?.abort();
    this.remote?.controller.abort();
  }
  update(
    request: Immutable<ValidationRequest>,
    generation: number,
    local?: Promise<LocalCatalogSources | undefined>,
  ): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending = { request, generation, ...(local ? { local } : {}) };
    this.drain();
    return this.active ?? Promise.resolve();
  }
  private drain(): void {
    if (this.active || !this.pending || this.stopped) return;
    const input = this.pending,
      lifetime = this.generation;
    this.pending = undefined;
    const controller = new AbortController();
    this.controller = controller;
    const task = (async () => {
      const request = input.request;
      using budget = new RequestBudget(request.execution.deadlineAt, controller.signal);
      const adapter = await loadBackstageAdapter(this.config.profile.adapterId);
      const local = input.local ? await abortable(input.local, budget.signal) : undefined;
      if (input.local && !local) return;
      const compatibility =
        local?.compatibility ??
        (await validateBackstageSources(request, this.config, {
          signal: budget.signal,
        }));
      const { baseline: baselineSource, ...baselineRequest } = request;
      const baseline = local
        ? local.baseline
        : baselineSource
          ? await validateBackstageSources(
              { ...baselineRequest, source: baselineSource },
              this.config,
              {
                signal: budget.signal,
              },
            )
          : undefined;
      const proposed = await buildProposedCatalog(request, compatibility, baseline, budget);
      if (
        compatibility.interrupted !== 'none' ||
        proposed.globalBlock ||
        this.config.profile.requiredProcessors.length
      )
        return;
      const parsed = await parseSourceSnapshot(request.source, {
        mode: 'ide',
        deadlineAt: request.execution.deadlineAt,
        signal: budget.signal,
        ...(request.source.entrypoints ? { uris: request.source.entrypoints } : {}),
        limits: {
          fileBytes: this.config.profile.limits.fileBytes,
          requestBytes: this.config.profile.limits.requestBytes,
        },
      });
      if (parsed.interrupted !== 'none') return;
      const patterns = compileReferenceContexts(this.config.profile.referenceContexts);
      const slots: Slot[] = [];
      let visits = 0;
      const collect = async (document: ParsedSourceDocument, included: boolean) => {
        let namespace: string;
        try {
          namespace = adapter.resolveReference(adapter.entityReference(document.value)).namespace;
        } catch {
          return;
        }
        for (const pattern of patterns) {
          const stack: { value: Immutable<JsonValue>; path: string; depth: number }[] = [
            { value: document.value, path: '', depth: 0 },
          ];
          while (stack.length) {
            budget.throwIfInterrupted();
            if (++visits > REFERENCE_LIMITS.visits) return;
            if (visits % 128 === 0) await yieldTurn();
            const current = stack.pop()!,
              segment = pattern.segments[current.depth];
            if (segment === undefined) {
              const span = document.locations[current.path];
              if (
                !span ||
                span.origin !== 'authored' ||
                !!span.source !== included ||
                (typeof current.value !== 'string' && current.value !== null)
              )
                continue;
              if (slots.length >= COMPLETION_LIMITS.slots) return;
              slots.push({
                uri: span.source?.uri ?? document.uri,
                range: span.value,
                pattern,
                namespace: pattern.namespace === 'entity' ? namespace : pattern.namespace,
              });
            } else if (segment === '*' && Array.isArray(current.value)) {
              for (let i = current.value.length - 1; i >= 0; i--)
                stack.push({
                  value: current.value[i] as Immutable<JsonValue>,
                  path: childPointer(current.path, i),
                  depth: current.depth + 1,
                });
            } else if (
              current.value &&
              typeof current.value === 'object' &&
              (!Array.isArray(current.value) || isArrayIndex(segment)) &&
              Object.hasOwn(current.value, segment)
            )
              stack.push({
                value: (current.value as Readonly<Record<string, Immutable<JsonValue>>>)[segment]!,
                path: childPointer(current.path, segment),
                depth: current.depth + 1,
              });
          }
        }
      };
      for (const document of parsed.documents) await collect(document, false);
      for (const entity of compatibility.entities) {
        // Text inclusion payloads are not YAML/JSON scalar editing contexts.
        const blocked = entity.substitutions.filter((row) => row.kind === '$text');
        const locations = Object.fromEntries(
          Object.entries(entity.document.locations).filter(
            ([path]) =>
              !blocked.some((row) => path === row.path || path.startsWith(row.path + '/')),
          ),
        );
        await collect({ ...entity.document, value: entity.normalized, locations }, true);
      }
      budget.throwIfInterrupted();
      if (!this.stopped && lifetime === this.generation)
        this.index = {
          generation: input.generation,
          request,
          source: request.source,
          slots,
          refs: compatibility.entities
            .map((entity) => entity.entityRef)
            .filter((ref) => safeRef(ref) && proposed.get(ref)?.status === 'present')
            .sort(),
          proposed,
        };
    })().catch(() => {
      /* Incomplete source preparation offers no speculative suggestions. */
    });
    this.active = task;
    this.work.add(task);
    void task.then(() => {
      this.work.delete(task);
      this.active = undefined;
      this.controller = undefined;
      this.drain();
    });
  }
  private discard(key: string): void {
    const entry = this.cache.get(key);
    if (entry) this.cacheBytes -= entry.bytes;
    this.cache.delete(key);
  }
  private async search(
    query: CatalogSuggestionQuery,
    signal: AbortSignal,
    waitMs: number = COMPLETION_LIMITS.waitMs,
  ): Promise<CatalogSuggestionReport | undefined> {
    const catalog = this.catalog;
    if (!catalog?.provider.suggest || query.prefix.length < 2) return undefined;
    const key = JSON.stringify(query),
      now = this.clock.wall(),
      cached = this.cache.get(key);
    if (
      cached &&
      now >= cached.wall &&
      now >= cached.report.fetchedAt &&
      now < cached.report.expiresAt &&
      this.clock.mono() - cached.mono < cached.ttl
    )
      return cached.report;
    this.discard(key);
    if (this.remote?.key !== key) this.remote?.controller.abort();
    if (!this.remote || this.remote.key !== key) {
      const controller = new AbortController(),
        lifetime = this.generation;
      const timeout = AbortSignal.timeout(COMPLETION_LIMITS.remoteMs);
      const combined = AbortSignal.any([controller.signal, timeout]);
      const index = this.index;
      if (!index) return undefined;
      const work = abortable(
        this.capabilities
          .provide('search', query, {
            requestId: `catalog-search:${++this.querySerial}`,
            binding: capabilityBinding(index.request, {
              workspaceGeneration: index.generation,
              sessionGeneration: this.capabilityOptions.sessionGeneration ?? 0,
              dependencyGeneration: this.capabilityOptions.dependencyGeneration?.() ?? 0,
              authorityContextDigest: capabilityAuthorityDigest(this.config.identity, catalog),
            }),
            deadlineAt: Date.now() + COMPLETION_LIMITS.remoteMs,
            signal: combined,
            current: () => !this.stopped && lifetime === this.generation && this.index === index,
          })
          .then((result) => (result.status === 'ready' ? result.value : undefined)),
        combined,
      )
        .then((report) => {
          if (this.stopped || lifetime !== this.generation || combined.aborted) return undefined;
          if (!report || report.status !== 'ready') {
            this.cache.clear();
            this.cacheBytes = 0;
            return undefined;
          }
          const wall = this.clock.wall(),
            ttl = Math.min(
              catalog.access.maxAgeMs,
              report.expiresAt - wall,
              report.fetchedAt + catalog.access.maxAgeMs - wall,
            );
          if (wall < report.fetchedAt || wall >= report.expiresAt) return undefined;
          if (ttl > 0) {
            const bytes = Buffer.byteLength(JSON.stringify(report));
            if (bytes <= COMPLETION_LIMITS.cacheBytes) {
              while (
                this.cache.size &&
                (this.cache.size >= COMPLETION_LIMITS.cacheEntries ||
                  this.cacheBytes + bytes > COMPLETION_LIMITS.cacheBytes)
              )
                this.discard(this.cache.keys().next().value!);
              this.cache.set(key, { report, wall, mono: this.clock.mono(), ttl, bytes });
              this.cacheBytes += bytes;
            }
          }
          return report;
        })
        .catch(() => undefined);
      const remote = { key, controller, work };
      this.remote = remote;
      this.work.add(work);
      void work.then(() => {
        this.work.delete(work);
        if (this.remote === remote) this.remote = undefined;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([
        this.remote.work,
        new Promise<undefined>((resolve) => {
          const stop = () => resolve(undefined);
          timer = setTimeout(stop, waitMs);
          const onAbort = () => {
            if (this.remote?.key === key) this.remote.controller.abort();
            stop();
          };
          signal.addEventListener('abort', onAbort, { once: true });
          cancel = () => signal.removeEventListener('abort', onAbort);
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      cancel?.();
    }
  }
  record(reference: string): void {
    if (!safeRef(reference)) return;
    this.history.delete(reference);
    this.history.set(reference, ++this.selections);
    if (this.history.size > 128) this.history.delete(this.history.keys().next().value!);
  }
  async ready(generation: number, signal: AbortSignal): Promise<void> {
    while (!this.stopped && !signal.aborted && this.index?.generation !== generation && this.active)
      await abortable(this.active, signal).catch(() => undefined);
  }
  /** Advisory search UI shares the same trusted connection, masks, limits and cancellation. */
  async searchReferences(
    input: unknown,
    generation: number,
    signal: AbortSignal,
  ): Promise<readonly { reference: string; source: string }[]> {
    const index = this.index;
    if (
      this.stopped ||
      signal.aborted ||
      !index ||
      index.generation !== generation ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['kind', 'namespace', 'prefix'].includes(key))
    )
      return [];
    const query = input as Partial<CatalogSuggestionQuery>;
    if (
      typeof query.kind !== 'string' ||
      typeof query.namespace !== 'string' ||
      typeof query.prefix !== 'string' ||
      !/^[a-z0-9_.-]{0,63}$/u.test(query.prefix) ||
      !safeRef(`${query.kind}:${query.namespace}/a`)
    )
      return [];
    const search = { kind: query.kind, namespace: query.namespace, prefix: query.prefix };
    const report = await this.search(search, signal, COMPLETION_LIMITS.remoteMs);
    if (signal.aborted || this.index !== index) return [];
    const eligible = (ref: string) =>
      safeRef(ref) && ref.startsWith(`${search.kind}:${search.namespace}/${search.prefix}`);
    const local = index.refs.filter(eligible);
    const now = this.clock.wall();
    const remote =
      report && report.fetchedAt <= now && now < report.expiresAt
        ? [...new Set(report.refs)].filter(
            (ref) => eligible(ref) && index.proposed.get(ref) === undefined,
          )
        : [];
    const rank = (a: string, b: string) =>
      (this.history.get(b) ?? 0) - (this.history.get(a) ?? 0) || a.localeCompare(b);
    return [
      ...local.sort(rank).map((reference) => ({ reference, source: 'Workspace source' })),
      ...remote.sort(rank).map((reference) => ({ reference, source: 'Catalog (fresh)' })),
    ].slice(0, COMPLETION_LIMITS.items);
  }
  async complete(
    params: CompletionParams,
    generation: number,
    documents: ReadonlyMap<string, FixDocument>,
    signal: AbortSignal,
  ): Promise<CompletionList> {
    const index = this.index,
      document = documents.get(params?.textDocument?.uri);
    if (this.stopped || signal.aborted || !index || index.generation !== generation || !document)
      return empty();
    const file = index.source.files.find((row) => row.uri === document.uri);
    if (
      !file ||
      file.version !== document.version ||
      file.digest !== digestText(document.getText())
    )
      return empty();
    const text = document.getText(),
      lines = new SourceLineIndex(text);
    const matches = index.slots
      .filter((slot) => slot.uri === document.uri)
      .map((slot) => target(text, lines, params.position, slot))
      .filter((row) => row !== undefined);
    const unique = new Map(matches.map((row) => [JSON.stringify([row.range, row.query]), row]));
    if (unique.size !== 1) return empty();
    const selected = [...unique.values()][0]!,
      query = selected.query;
    const remote = await this.search(query, signal).catch(() => undefined);
    if (
      this.stopped ||
      signal.aborted ||
      this.index !== index ||
      documents.get(document.uri) !== document ||
      file.digest !== digestText(document.getText())
    )
      return empty();
    const eligible = (ref: string) =>
      safeRef(ref) &&
      ref.startsWith(`${query.kind}:${query.namespace}/`) &&
      ref.slice(ref.indexOf('/') + 1).startsWith(query.prefix);
    const rank = (a: string, b: string) =>
      (this.history.get(b) ?? 0) - (this.history.get(a) ?? 0) || a.localeCompare(b);
    const local = index.refs.filter(eligible).sort(rank);
    const now = this.clock.wall();
    const external = (
      remote && remote.fetchedAt <= now && now < remote.expiresAt ? remote.refs : []
    ).filter((ref) => eligible(ref) && index.proposed.get(ref) === undefined);
    const rows = [
      ...local.map((ref) => ({ ref, local: true })),
      ...[...new Set(external)].sort(rank).map((ref) => ({ ref, local: false })),
    ].slice(0, COMPLETION_LIMITS.items);
    return {
      isIncomplete: true,
      items: rows.map(({ ref, local }, i) => ({
        label: ref,
        kind: CompletionItemKind.Reference,
        detail: local ? 'Workspace source' : 'Catalog (fresh)',
        sortText: String(i).padStart(3, '0'),
        filterText: selected.filter(ref),
        insertTextFormat: InsertTextFormat.PlainText,
        textEdit: { range: selected.range, newText: ref },
        ...(local ? {} : { data: { fetchedAt: remote!.fetchedAt, expiresAt: remote!.expiresAt } }),
      })),
    };
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.invalidate();
    this.cache.clear();
    this.cacheBytes = 0;
    const results = await Promise.allSettled([...this.work, this.capabilities.close()]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Catalog capability cleanup failed.');
  }
}
