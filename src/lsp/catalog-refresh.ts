import { normalizeCatalogAccess } from '../providers/catalog.js';
import { CatalogFailure } from '../providers/types.js';
import { abortable } from '../providers/async.js';
import { digestJson } from '../core/json.js';
import type {
  CatalogAccessContext,
  CatalogProvider,
  CatalogSuggestionQuery,
  CatalogSuggestionReport,
  CatalogLookupReport,
  CatalogExecutionContext,
} from '../providers/types.js';

export const CATALOG_REFRESH_LIMITS = Object.freeze({
  cadenceMs: 30_000,
  floorMs: 250,
  backoffMs: 120_000,
  queries: 32,
  references: 1000,
  recentMs: 120_000,
  queryConcurrency: 4,
});
export interface RefreshClock {
  now(): number;
  random(): number;
  schedule(work: () => void, milliseconds: number): () => void;
}
const clock: RefreshClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  schedule: (work, milliseconds) => {
    const timer = setTimeout(work, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
type Catalog = { readonly provider: CatalogProvider; readonly access: CatalogAccessContext };
type Query = { query: CatalogSuggestionQuery; touched: number; report?: CatalogSuggestionReport };
/** Session-owned polling. A tick admits one new validation, which owns all fresh reads. */
export class CatalogRefresh {
  private revision = 0;
  private timer: (() => void) | undefined;
  private due = Infinity;
  private claimsExpireAt = Infinity;
  private closed = false;
  private suspended = false;
  private busy = false;
  private fresh = false;
  private failures = 0;
  private queryFailed = false;
  private readonly deniedScopes = new Set<string>();
  private hasClaims = false;
  private observedAt = 0;
  private expiresAt = Infinity;
  private references = new Set<string>();
  private readonly queries = new Map<string, Query>();
  private readonly controllers = new Set<AbortController>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly queryWork = new Map<
    string,
    { revision: number; work: Promise<CatalogSuggestionReport> }
  >();
  private readonly original: Catalog;
  readonly catalog: Catalog;
  private digest: string | undefined;
  constructor(
    catalog: Catalog,
    private readonly invalidate: () => void,
    private readonly time: RefreshClock = clock,
  ) {
    this.original = { provider: catalog.provider, access: normalizeCatalogAccess(catalog.access) };
    const provider: CatalogProvider = {
      connectionId: catalog.provider.connectionId,
      adapterId: catalog.provider.adapterId,
      lookup: (refs, access, execution) =>
        this.own(
          (signal) =>
            catalog.provider.lookup(refs, this.approved(access), { ...execution, signal }),
          execution,
        ),
      ...(catalog.provider.suggest
        ? {
            suggest: (
              query: CatalogSuggestionQuery,
              access: CatalogAccessContext,
              execution: CatalogExecutionContext,
            ) => this.suggest(query, access, execution),
          }
        : {}),
      stats: () => catalog.provider.stats(),
      // The resource aggregate retains ownership of the underlying connection.
      close: () => Promise.resolve(),
    };
    this.catalog = { provider, access: this.original.access };
  }
  private approved(access: CatalogAccessContext): CatalogAccessContext {
    const normalized = normalizeCatalogAccess(access);
    if (
      digestJson({ ...normalized, maxAgeMs: 0 }) !==
        digestJson({ ...this.original.access, maxAgeMs: 0 }) ||
      (normalized.maxAgeMs !== 0 && normalized.maxAgeMs !== this.original.access.maxAgeMs)
    )
      throw new CatalogFailure('credential_binding');
    return normalized;
  }
  get generation() {
    return this.revision;
  }
  get status() {
    return Object.freeze({
      generation: this.revision,
      references: this.references.size,
      queries: this.queries.size,
      timer: !!this.timer,
      busy: this.busy,
      suspended: this.suspended,
      pending: this.work.size,
      failures: this.failures,
      dataDigest: this.digest,
      dueAt: this.due,
    });
  }
  /** Called before protocol admission too, so a delayed timer cannot authorize expired edits. */
  ensureFresh(): void {
    if (
      !this.closed &&
      !this.suspended &&
      !this.busy &&
      this.time.now() >= Math.min(this.due, this.claimsExpireAt)
    )
      this.tick();
  }
  private prune(): void {
    const now = this.time.now();
    for (const [key, value] of this.queries)
      if (now - value.touched >= CATALOG_REFRESH_LIMITS.recentMs || now < value.touched) {
        this.queries.delete(key);
        this.deniedScopes.delete('query:' + key);
      }
  }
  private schedule(): void {
    this.timer?.();
    this.timer = undefined;
    this.due = Infinity;
    this.prune();
    if (this.closed || this.suspended || this.busy || (!this.references.size && !this.queries.size))
      return;
    const now = this.time.now();
    const cadence = Math.min(
      CATALOG_REFRESH_LIMITS.cadenceMs,
      this.original.access.maxAgeMs || CATALOG_REFRESH_LIMITS.cadenceMs,
    );
    const backoff = this.failures
      ? Math.min(
          CATALOG_REFRESH_LIMITS.backoffMs,
          Math.max(cadence, 1000) * 2 ** Math.min(this.failures - 1, 7),
        )
      : cadence;
    const jitter = Math.floor(Math.max(0, Math.min(1, this.time.random())) * backoff * 0.1);
    const expiry = Math.min(
      this.expiresAt,
      ...[...this.queries.values()].flatMap((row) =>
        row.report?.status === 'ready'
          ? [row.report.expiresAt, row.report.fetchedAt + cadence]
          : [],
      ),
    );
    this.claimsExpireAt = expiry;
    this.due = Math.max(
      now + CATALOG_REFRESH_LIMITS.floorMs,
      this.failures
        ? Math.min(now + backoff + jitter, expiry)
        : Math.min(this.observedAt + cadence - jitter, expiry),
    );
    this.timer = this.time.schedule(() => this.tick(), this.due - now);
  }
  private tick(): void {
    this.timer?.();
    this.timer = undefined;
    this.due = Infinity;
    this.prune();
    if (this.closed || this.suspended || this.busy || (!this.references.size && !this.queries.size))
      return;
    this.claimsExpireAt = Infinity;
    this.hasClaims = false;
    this.revision++;
    this.fresh = true;
    this.expiresAt = Infinity;
    for (const query of this.queries.values()) delete query.report;
    for (const controller of this.controllers) controller.abort();
    this.invalidate();
  }
  private denyAuthority(scope: string): void {
    if (this.closed || this.deniedScopes.has(scope)) return;
    this.deniedScopes.add(scope);
    while (this.deniedScopes.size > CATALOG_REFRESH_LIMITS.queries + 1)
      this.deniedScopes.delete(this.deniedScopes.values().next().value!);
    if (!this.hasClaims) return;
    this.hasClaims = false;
    this.timer?.();
    this.timer = undefined;
    this.due = Infinity;
    this.claimsExpireAt = Infinity;
    this.expiresAt = Infinity;
    this.revision++;
    this.fresh = true;
    for (const row of this.queries.values()) delete row.report;
    for (const controller of this.controllers) controller.abort();
    this.invalidate();
  }
  private own<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    execution: CatalogExecutionContext,
  ): Promise<T> {
    if (this.closed || this.suspended)
      return Promise.reject(new Error('Catalog refresh is unavailable.'));
    if (this.work.size >= 64)
      return Promise.reject(new Error('Catalog refresh queue exceeds limits.'));
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = execution.signal
      ? AbortSignal.any([controller.signal, execution.signal])
      : controller.signal;
    const task = Promise.resolve()
      .then(() => operation(signal))
      .then((value) => {
        if (signal.aborted) throw new CatalogFailure('cancelled');
        return value;
      })
      .finally(() => {
        this.controllers.delete(controller);
        this.work.delete(task);
      });
    this.work.add(task);
    return task;
  }
  private async suggest(
    query: CatalogSuggestionQuery,
    access: CatalogAccessContext,
    execution: CatalogExecutionContext,
    background = false,
  ): Promise<CatalogSuggestionReport> {
    if (this.closed || this.suspended) throw new Error('Catalog refresh is unavailable.');
    access = this.approved(access);
    const revision = this.revision;
    const key = JSON.stringify(query),
      now = this.time.now();
    this.prune();
    const previous = this.queries.get(key);
    if (previous) {
      if (!background) previous.touched = now;
      this.queries.delete(key);
    }
    const row: Query = previous ?? { query: { ...query }, touched: now };
    this.queries.set(key, row);
    while (this.queries.size > CATALOG_REFRESH_LIMITS.queries)
      this.queries.delete(this.queries.keys().next().value!);
    const cached = row.report;
    if (
      cached?.status === 'ready' &&
      now >= cached.fetchedAt &&
      now < cached.expiresAt &&
      now < cached.fetchedAt + access.maxAgeMs
    )
      return cached;
    let report: CatalogSuggestionReport;
    try {
      const pending = this.queryWork.get(key);
      if (pending?.revision === revision)
        report = await (execution.signal
          ? abortable(pending.work, execution.signal)
          : pending.work);
      else {
        const work = this.own(
          (signal) => this.original.provider.suggest!(query, access, { ...execution, signal }),
          execution,
        );
        const entry = { revision, work };
        this.queryWork.set(key, entry);
        void work
          .finally(() => {
            if (this.queryWork.get(key) === entry) this.queryWork.delete(key);
          })
          .catch(() => undefined);
        report = await work;
      }
    } catch (error) {
      if (!this.closed && revision === this.revision) {
        this.queryFailed = true;
        if (!this.busy) {
          this.failures++;
          this.observedAt = now;
          this.schedule();
        }
      }
      throw error;
    }
    if (this.closed || revision !== this.revision || execution.signal?.aborted)
      throw new Error('Catalog observation is stale.');
    row.report = report;
    if (report.status === 'ready') {
      this.hasClaims = true;
      if (background) this.deniedScopes.delete('query:' + key);
      else this.deniedScopes.clear();
    }
    if (report.status === 'unavailable') {
      this.queryFailed = true;
      if (!this.busy) this.failures++;
    }
    if (
      report.status === 'unavailable' &&
      ['permission_denied', 'credential_binding'].includes(report.failure)
    )
      this.denyAuthority('query:' + key);
    this.observedAt ||= now;
    if (!this.busy) this.schedule();
    return report;
  }
  /** Each run collects an exact bounded inventory. Failed or obsolete runs cannot replace it. */
  begin(): { catalog: Catalog; finish: (current: boolean) => void } {
    this.timer?.();
    this.timer = undefined;
    this.due = Infinity;
    this.busy = true;
    const revision = this.revision,
      fresh = this.fresh || this.failures > 0;
    this.queryFailed = false;
    const refs = new Set<string>(),
      reports: CatalogLookupReport[] = [];
    let failed = false;
    const catalog: Catalog = {
      access: this.original.access,
      provider: {
        ...this.catalog.provider,
        lookup: async (references, access, execution) => {
          access = this.approved(access);
          for (const ref of references) {
            if (refs.size >= CATALOG_REFRESH_LIMITS.references && !refs.has(ref))
              throw new Error('Catalog dependency inventory exceeds limits.');
            refs.add(ref);
          }
          try {
            const report = await this.own(
              (signal) =>
                this.original.provider.lookup(
                  references,
                  fresh ? { ...access, maxAgeMs: 0 } : access,
                  { ...execution, signal },
                ),
              execution,
            );
            if (this.closed || revision !== this.revision || execution.signal?.aborted)
              throw new Error('Catalog observation is stale.');
            if (
              report.failures.some((row) =>
                ['permission_denied', 'credential_binding'].includes(row.code),
              ) ||
              report.data.entries.some(
                (row) => row.status === 'unavailable' && row.reason === 'permission_denied',
              )
            )
              this.denyAuthority('lookup');
            else {
              this.deniedScopes.delete('lookup');
              this.hasClaims ||= report.data.entries.some((row) => row.status !== 'unavailable');
            }
            reports.push(report);
            return report;
          } catch (error) {
            failed = true;
            throw error;
          }
        },
      },
    };
    let finished = false;
    return {
      catalog,
      finish: (current) => {
        if (finished) return;
        finished = true;
        this.busy = false;
        if (this.closed) return;
        if (current && revision === this.revision) {
          this.references = refs;
          const entries = reports.flatMap((report) => report.data.entries);
          failed ||= this.queryFailed;
          failed ||= reports.some(
            (report) =>
              report.failures.length ||
              report.interrupted !== 'none' ||
              report.data.entries.some((row) => row.status === 'unavailable'),
          );
          this.failures = failed ? this.failures + 1 : 0;
          this.hasClaims ||= entries.some((row) => row.status !== 'unavailable');
          this.observedAt = this.time.now();
          this.expiresAt = Math.min(
            Infinity,
            ...entries
              .filter((row) => row.status !== 'unavailable')
              .map((row) =>
                Math.min(
                  row.provenance.expiresAt,
                  row.provenance.fetchedAt +
                    (this.original.access.maxAgeMs || CATALOG_REFRESH_LIMITS.cadenceMs),
                ),
              ),
          );
          this.digest = digestJson(
            entries.map((row) => ({
              key: row.key,
              status: row.status,
              revision: row.provenance.revision,
            })),
          );
          if (!failed && [...this.queries.values()].every((row) => row.report?.status === 'ready'))
            this.deniedScopes.clear();
          this.fresh = false;
        }
        this.schedule();
      },
    };
  }
  /** Recent identity queries are advisory and separate from body/absence observations. */
  async refreshQueries(execution: CatalogExecutionContext): Promise<void> {
    if (!this.fresh || !this.original.provider.suggest) return;
    this.prune();
    const queries = [...this.queries.values()];
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(CATALOG_REFRESH_LIMITS.queryConcurrency, queries.length) },
        async () => {
          while (
            next < queries.length &&
            !execution.signal?.aborted &&
            this.time.now() < execution.deadlineAt
          ) {
            const row = queries[next++]!;
            // Background activity never extends the query's user-interest lifetime.
            try {
              await this.suggest(
                row.query,
                { ...this.original.access, maxAgeMs: 0 },
                execution,
                true,
              );
            } catch {
              this.queryFailed = true;
              /* Current validation still reports its own dependency state. */
            }
          }
        },
      ),
    );
  }
  suspend(): void {
    this.suspended = true;
    this.timer?.();
    this.timer = undefined;
    this.due = Infinity;
    this.claimsExpireAt = Infinity;
    for (const controller of this.controllers) controller.abort();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.suspend();
    this.timer?.();
    this.timer = undefined;
    this.due = Infinity;
    for (const controller of this.controllers) controller.abort();
    this.queries.clear();
    this.references.clear();
    await Promise.allSettled([...this.work]);
  }
}
