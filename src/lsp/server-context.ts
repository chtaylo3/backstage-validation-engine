import { ApplyWorkspaceEditRequest, ResponseError } from 'vscode-languageserver/node';
import type { ClientCapabilities, Connection, Disposable } from 'vscode-languageserver/node';
import { isValidationCoverageParams } from '../protocol/index.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import type { CelRuntime } from '../runtime/cel/index.js';
import { systemClock } from '../base/clock.js';
import type { Clock } from '../base/clock.js';
import { ClientEdits } from './client-edits.js';
import type { LspConfig } from './config.js';
import type { CoverageObservation, FilesystemObservation } from './coverage-observation.js';
import { DiagnosticPublisher } from './diagnostic-publisher.js';
import type { FilesystemSource } from './filesystem.js';
import { FIX_TITLE, FixRegistry } from './fixes.js';
import type { RequestContexts } from './request-context.js';
import type {
  LspServerResources,
  SessionGeneration,
  SessionResources,
} from './session-resources.js';
import type { ValidationCoordinator } from './validation-coordinator.js';
import { WorkspaceState } from './workspace-state.js';

/** Host resources and callbacks for one language server connection. */
export interface LspServerOptions {
  readonly catalog?:
    | {
        readonly provider: CatalogProvider;
        readonly access: CatalogAccessContext;
      }
    | undefined;
  readonly filesystem?: FilesystemSource | undefined;
  readonly dispose?: (() => Promise<void>) | undefined;
  /** The CEL runtime of the initial resources; see `LspServerResources.runtime`. */
  readonly runtime?: CelRuntime | undefined;
  /**
   * The one clock of this connection: request deadlines, fix and rule lifetimes, completion and
   * refresh freshness, and session cleanup budgets read it. Defaults to `systemClock`.
   */
  readonly clock?: Clock;
  readonly exit?: (code: number) => void;
  readonly reload?: () => Promise<LspServerResources>;
  readonly configurationChanged?: (config: LspConfig) => void | Disposable;
  readonly onClose?: () => void | Promise<void>;
}

/** The wire lifetime of the connection. It is stricter than feature-level empty-result admission. */
export class Lifecycle {
  #initialized = false;
  #clientInitialized = false;
  #stopped = false;
  #requestedShutdown = false;
  #disposal: Promise<void> | undefined;
  constructor(
    private readonly owners: {
      /** Synchronous effects of the first `close`, after the lifecycle is marked stopped. */
      readonly stop: () => void;
      /** Owner cleanups, started in order by the first `close` and awaited together. */
      readonly cleanup: () => readonly Promise<unknown>[];
    },
  ) {}
  get initialized(): boolean {
    return this.#initialized;
  }
  get clientInitialized(): boolean {
    return this.#clientInitialized;
  }
  get stopped(): boolean {
    return this.#stopped;
  }
  get requestedShutdown(): boolean {
    return this.#requestedShutdown;
  }
  admitted<T>(work: () => T): T {
    if (this.#stopped) throw new ResponseError(-32600, 'Language server is shut down.');
    if (!this.#initialized) throw new ResponseError(-32002, 'Language server is not initialized.');
    return work();
  }
  /** The server answered `initialize`. */
  initialize(): void {
    this.#initialized = true;
  }
  /** The client sent `initialized`. */
  clientReady(): void {
    this.#clientInitialized = true;
  }
  async shutdown(): Promise<void> {
    this.admitted(() => undefined);
    this.#requestedShutdown = true;
    await this.close();
  }
  /** Idempotent: every call returns the promise of the first. */
  readonly close = (): Promise<void> => {
    if (this.#disposal) return this.#disposal;
    this.#stopped = true;
    this.owners.stop();
    this.#disposal = (async () => {
      const results = await Promise.allSettled(this.owners.cleanup());
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Language server cleanup failed.');
    })();
    return this.#disposal;
  };
  /** Reports 0 only after a `shutdown` request and a clean close. */
  exit(report: (code: number) => void): void {
    void this.close().then(
      () => report(this.#requestedShutdown ? 0 : 1),
      () => report(1),
    );
  }
}

export interface ClientFeatureFlags {
  readonly fixesEnabled: boolean;
  readonly atomicTextEdits: boolean;
  readonly dynamicWatching: boolean;
}
/** The optional server features that the client's capabilities allow. */
export function clientFeatures(capabilities: ClientCapabilities): ClientFeatureFlags {
  return {
    fixesEnabled:
      capabilities.workspace?.applyEdit === true &&
      capabilities.workspace.workspaceEdit?.documentChanges === true &&
      !!capabilities.textDocument?.codeAction?.codeActionLiteralSupport &&
      capabilities.textDocument.publishDiagnostics?.dataSupport === true,
    atomicTextEdits: ['transactional', 'textOnlyTransactional'].includes(
      capabilities.workspace?.workspaceEdit?.failureHandling ?? '',
    ),
    dynamicWatching:
      !!capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration &&
      !!capabilities.workspace.didChangeWatchedFiles.relativePatternSupport,
  };
}
/** Client features, written by `initialize`. */
export class ClientFeatures implements ClientFeatureFlags {
  #flags: ClientFeatureFlags = {
    fixesEnabled: false,
    atomicTextEdits: false,
    dynamicWatching: false,
  };
  get fixesEnabled(): boolean {
    return this.#flags.fixesEnabled;
  }
  get atomicTextEdits(): boolean {
    return this.#flags.atomicTextEdits;
  }
  get dynamicWatching(): boolean {
    return this.#flags.dynamicWatching;
  }
  accept(capabilities: ClientCapabilities): void {
    this.#flags = clientFeatures(capabilities);
  }
}

export interface CoverageRequestState {
  readonly initialized: boolean;
  readonly stopped: boolean;
  /** Whether the current session is available. */
  readonly available: boolean;
  /** Whether the host enabled coverage observation. */
  readonly enabled: boolean;
  readonly workspace: Pick<
    WorkspaceState,
    'unavailableSources' | 'capacityExceeded' | 'document' | 'selected'
  >;
  readonly observation: CoverageObservation | undefined;
  /** The current validation generation. */
  readonly generation: number;
  /** The current dependency generation. */
  readonly dependencyGeneration: number;
}
/** The latest coverage observation when it describes exactly the requested document, else null. */
export function currentCoverageObservation(
  params: unknown,
  state: CoverageRequestState,
): CoverageObservation | null {
  const { workspace } = state;
  if (
    !state.initialized ||
    state.stopped ||
    !state.available ||
    workspace.unavailableSources ||
    workspace.capacityExceeded ||
    !state.enabled ||
    !isValidationCoverageParams(params)
  )
    return null;
  const requested = params;
  const current = workspace.document(requested.uri);
  const observation = state.observation;
  if (
    !current ||
    !workspace.selected(requested.uri) ||
    current.version !== requested.version ||
    current.digest !== requested.digest ||
    !observation ||
    observation.generation !== state.generation ||
    observation.dependencyGeneration !== state.dependencyGeneration ||
    !observation.documents.some(
      (row) =>
        row.uri === requested.uri &&
        row.version === requested.version &&
        row.digest === requested.digest,
    )
  )
    return null;
  return observation;
}
/** The latest coverage and filesystem observations, with their staleness checks. */
export class Observations {
  #coverage: CoverageObservation | undefined;
  #filesystem: FilesystemObservation | undefined;
  recordCoverage(value: CoverageObservation): void {
    this.#coverage = value;
  }
  clearCoverage(): void {
    this.#coverage = undefined;
  }
  recordFilesystem(value: FilesystemObservation): void {
    this.#filesystem = value;
  }
  clearFilesystem(): void {
    this.#filesystem = undefined;
  }
  coverage(params: unknown, state: Omit<CoverageRequestState, 'observation'>) {
    return currentCoverageObservation(params, { ...state, observation: this.#coverage });
  }
  /** The latest admitted watched-file notification of the current session, else null. */
  filesystem(session: {
    readonly available: boolean;
    readonly enabled: boolean;
    readonly generation: number;
  }): FilesystemObservation | null | undefined {
    if (
      !session.available ||
      !session.enabled ||
      this.#filesystem?.sessionGeneration !== session.generation
    )
      return null;
    return this.#filesystem;
  }
}

type ServerRequests = RequestContexts<SessionGeneration>;
/**
 * The owners and shared state of one connection, given to every handler module. `sessions`,
 * `coordinator` and `requests` refer to each other through callbacks, so they are created after
 * this context, in that order, and wired once before any handler is registered; reading one
 * earlier throws.
 */
export class ServerContext {
  readonly clock: Clock;
  readonly fixes: FixRegistry;
  readonly features = new ClientFeatures();
  readonly observations = new Observations();
  readonly clientEdits: ClientEdits;
  readonly workspace: WorkspaceState;
  readonly publisher: DiagnosticPublisher;
  readonly lifecycle: Lifecycle;
  /** The session generation whose file watcher was last requested. Only `watchFiles` writes it. */
  watchGeneration: number | undefined;
  #late:
    | {
        readonly sessions: SessionResources;
        readonly coordinator: ValidationCoordinator;
        readonly requests: ServerRequests;
      }
    | undefined;
  constructor(
    readonly connection: Connection,
    /** The initial configuration. Handlers read the current session's configuration instead. */
    config: LspConfig,
    readonly options: LspServerOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    this.fixes = new FixRegistry(this.clock);
    this.clientEdits = new ClientEdits((edit, token) =>
      connection.sendRequest(ApplyWorkspaceEditRequest.type, { label: FIX_TITLE, edit }, token),
    );
    this.workspace = new WorkspaceState(config);
    this.publisher = new DiagnosticPublisher((params) => connection.sendDiagnostics(params));
    this.lifecycle = new Lifecycle({
      stop: () => {
        this.observations.clearFilesystem();
        this.fixes.invalidate();
        this.publisher.close();
        this.workspace.close();
      },
      cleanup: () => [
        Promise.resolve().then(() => options.onClose?.()),
        this.clientEdits.close(),
        this.coordinator.close(),
        this.sessions.close(),
      ],
    });
  }
  wire(late: {
    readonly sessions: SessionResources;
    readonly coordinator: ValidationCoordinator;
    readonly requests: ServerRequests;
  }): void {
    if (this.#late) throw new Error('Language server owners are already wired.');
    this.#late = late;
  }
  #wired() {
    if (!this.#late) throw new Error('Language server owners are not wired.');
    return this.#late;
  }
  get sessions(): SessionResources {
    return this.#wired().sessions;
  }
  get coordinator(): ValidationCoordinator {
    return this.#wired().coordinator;
  }
  get requests(): ServerRequests {
    return this.#wired().requests;
  }
  /** Schedules validation of the changed workspace buffers. */
  schedule(): void {
    this.coordinator.invalidate('buffer');
  }
  /** Clears published diagnostics while the document keeps the captured lifetime. */
  clearDiagnostics(uri: string, version: number, lifetime: number): Promise<void> {
    const generation = this.coordinator.generation;
    const document = this.workspace.documents.get(uri);
    return this.publisher.clear({
      uri,
      version,
      generation,
      lifetime,
      current: () =>
        !this.lifecycle.stopped &&
        this.coordinator.generation === generation &&
        this.workspace.documents.get(uri) === document &&
        (!document || document.lifetime === lifetime),
    });
  }
  readonly reloadConfiguration = (): Promise<{ reloaded: boolean }> =>
    this.lifecycle.initialized && !this.lifecycle.stopped
      ? this.sessions.reload()
      : Promise.resolve({ reloaded: false });
}
