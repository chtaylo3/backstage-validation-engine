import type { CancellationToken } from 'vscode-languageserver/node';
import { RequestBudget } from '../runtime/request-budget.js';
import type { LspConfig } from './config.js';
import type { WorkspaceSnapshot, WorkspaceState } from './workspace-state.js';

/** Tracks actual resource users, independently of validation quiescence. */
export class SessionOperations {
  private readonly controller = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  get signal() {
    return this.controller.signal;
  }
  get size() {
    return this.work.size;
  }
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new Error('Session is retired.'));
    const work = Promise.resolve().then(operation);
    this.work.add(work);
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work),
    );
    return work;
  }
  cancel(): void {
    this.controller.abort();
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.work]);
  }
}
export interface RequestSession {
  readonly generation: number;
  readonly config: LspConfig;
  readonly operations: SessionOperations;
}
export interface RequestState<S extends RequestSession> {
  readonly session: S;
  readonly initialized: boolean;
  readonly available: boolean;
  readonly stopped: boolean;
}
export interface RequestContext<S extends RequestSession> {
  readonly session: S;
  readonly snapshot: WorkspaceSnapshot;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
  readonly close: () => void;
}
export type RequestAdmission<S extends RequestSession> =
  | { readonly status: 'ready'; readonly context: RequestContext<S> }
  | {
      readonly status:
        | 'uninitialized'
        | 'stopped'
        | 'configuration_unavailable'
        | 'source_unsynchronized'
        | 'capacity'
        | 'cancelled'
        | 'document_unavailable';
    };
/** Readiness and freshness read their owners. They do not copy mutable workspace state. */
export class RequestContexts<S extends RequestSession> {
  constructor(
    private readonly workspace: WorkspaceState,
    private readonly read: () => RequestState<S>,
  ) {}
  capture(token?: CancellationToken, uri?: string): RequestAdmission<S> {
    const state = this.read();
    if (!state.initialized) return { status: 'uninitialized' };
    if (state.stopped) return { status: 'stopped' };
    if (!state.available) return { status: 'configuration_unavailable' };
    if (this.workspace.unavailableSources) return { status: 'source_unsynchronized' };
    if (this.workspace.capacityExceeded) return { status: 'capacity' };
    if (token?.isCancellationRequested) return { status: 'cancelled' };
    const sessionGeneration = state.session.generation;
    const snapshot = this.workspace.snapshot();
    const document = uri === undefined ? undefined : snapshot.allDocuments.get(uri);
    if (uri !== undefined && !document) return { status: 'document_unavailable' };
    const cancellation = new AbortController();
    const subscription = token?.onCancellationRequested(() => cancellation.abort());
    const deadlineAt = Date.now() + state.session.config.profile.limits.requestTimeoutMs;
    const budget = new RequestBudget(
      deadlineAt,
      AbortSignal.any([cancellation.signal, state.session.operations.signal]),
    );
    let closed = false;
    const current = () => {
      const actual = this.read();
      return (
        !closed &&
        !budget.signal.aborted &&
        !actual.stopped &&
        actual.available &&
        actual.session.generation === sessionGeneration &&
        this.workspace.generation === snapshot.generation &&
        (uri === undefined || this.workspace.document(uri)?.lifetime === document?.lifetime)
      );
    };
    return {
      status: 'ready',
      context: {
        session: state.session,
        snapshot,
        signal: budget.signal,
        deadlineAt,
        current,
        close: () => {
          if (closed) return;
          closed = true;
          budget.dispose();
          subscription?.dispose();
        },
      },
    };
  }
  async execute<T>(
    token: CancellationToken | undefined,
    uri: string | undefined,
    empty: () => T,
    operation: (context: RequestContext<S>) => Promise<T> | T,
    checkResult = true,
  ): Promise<T> {
    const admitted = this.capture(token, uri);
    if (admitted.status !== 'ready') return empty();
    const context = admitted.context;
    try {
      const result = await context.session.operations.run(() =>
        context.current() ? operation(context) : empty(),
      );
      return !checkResult || context.current() ? result : empty();
    } catch {
      return empty();
    } finally {
      context.close();
    }
  }
}
