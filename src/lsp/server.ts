import { SessionResources } from './session-resources.js';
import type { LspServerResources } from './session-resources.js';
export type { LspServerResources } from './session-resources.js';
import { RequestContexts } from './request-context.js';
import type { CompletionList, Hover, Location, CodeAction } from 'vscode-languageserver/node';
import type { FixApplicationResult } from './fixes.js';
import { ValidationCoordinator } from './validation-coordinator.js';
import { runValidation } from './validation-run.js';
import { WorkspaceState } from './workspace-state.js';
import type { SourceFileOperation } from './workspace-state.js';
import { DiagnosticPublisher } from './diagnostic-publisher.js';
import { ClientEdits } from './client-edits.js';
import { ApplyWorkspaceEditRequest } from 'vscode-languageserver/node';
import {
  PositionEncodingKind,
  TextDocumentSyncKind,
  DidChangeWatchedFilesNotification,
} from 'vscode-languageserver/node';
import type {
  Disposable,
  Connection,
  Diagnostic,
  CancellationToken,
} from 'vscode-languageserver/node';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import { verifyRequestBindings } from '../core/bindings.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import { parseContract } from '../contracts/validate.js';
import type { FilesystemSource } from './filesystem.js';
import { APPLY_FIX_COMMAND, FIX_TITLE, FixRegistry } from './fixes.js';
import { createLspRequest } from './config.js';
import type { LspConfig } from './config.js';
import { filesystemEvent } from './discovery.js';

/** One active request and one latest workspace snapshot; host owns resources and immutable authority. */
export function attachLspServer(
  connection: Connection,
  config: LspConfig,
  options: {
    readonly catalog?:
      | {
          readonly provider: CatalogProvider;
          readonly access: CatalogAccessContext;
        }
      | undefined;
    readonly filesystem?: FilesystemSource | undefined;
    readonly dispose?: (() => Promise<void>) | undefined;
    readonly exit?: (code: number) => void;
    readonly reload?: () => Promise<LspServerResources>;
    readonly configurationChanged?: (config: LspConfig) => void | Disposable;
    readonly onClose?: () => void | Promise<void>;
  } = {},
) {
  if (!!config.filesystem !== !!options.filesystem)
    throw new Error('Trusted filesystem reader configuration mismatch.');
  const fixes = new FixRegistry();
  let fixesEnabled = false;
  let atomicTextEdits = false;
  const clientEdits = new ClientEdits((edit, token) =>
    connection.sendRequest(ApplyWorkspaceEditRequest.type, { label: FIX_TITLE, edit }, token),
  );
  const fixLimits = () => ({
    fileBytes: sessions.current.config.profile.limits.fileBytes,
    requestBytes: sessions.current.config.profile.limits.requestBytes,
    atomicTextEdits,
  });
  const workspace = new WorkspaceState(config);
  const approved = { has: (uri: string) => workspace.approved(uri) };
  let dynamicWatching = false;
  let watchGeneration: number | undefined;
  let clientInitialized = false;
  let initialized = false;
  let stopped = false;
  let requestedShutdown = false;
  let disposal: Promise<void> | undefined;

  const publisher = new DiagnosticPublisher((params) => connection.sendDiagnostics(params));
  const clearDiagnostics = (uri: string, version: number, lifetime: number) => {
    const generation = coordinator.generation;
    const document = workspace.documents.get(uri);
    return publisher.clear({
      uri,
      version,
      generation,
      lifetime,
      current: () =>
        !stopped &&
        coordinator.generation === generation &&
        workspace.documents.get(uri) === document &&
        (!document || document.lifetime === lifetime),
    });
  };
  const sessions: SessionResources = new SessionResources(
    {
      config,
      ...(options.catalog ? { catalog: options.catalog } : {}),
      ...(options.filesystem ? { filesystem: options.filesystem } : {}),
      ...(options.dispose ? { dispose: options.dispose } : {}),
    },
    {
      dependencyChanged: () => {
        clientEdits.cancel();
        coordinator.invalidate('dependencies');
      },
      invalidate: () => {
        clientEdits.cancel();
        coordinator.invalidate('configuration');
      },
      pause: () => {
        coordinator.pause();
        return coordinator.cancelActive();
      },
      commit: (session) => {
        workspace.replaceConfiguration(session.config);
        coordinator.invalidate('configuration');
      },
      activated: async (session) => {
        session.own(options.configurationChanged?.(session.config));
        for (const [uri, document] of workspace.documents)
          if (session.config.filesystem && !workspace.approved(uri))
            await clearDiagnostics(uri, document.version, document.lifetime);
      },
      resume: () => coordinator.resume(),
      ready: () => {
        watchFiles();
        void connection.sendNotification('bve/configurationReloaded').catch(() => undefined);
      },
    },
    options.reload,
  );
  const coordinator: ValidationCoordinator = new ValidationCoordinator(
    (context) => {
      const session = sessions.current;
      const available = sessions.available;
      const refresh = available ? session.refresh?.begin() : undefined;
      const dependencyGeneration = session.refresh?.generation ?? 0;
      const input = {
        dependencyGeneration,
        refreshQueries: (deadlineAt: number, signal: AbortSignal) =>
          session.refresh?.refreshQueries({ deadlineAt, signal }) ?? Promise.resolve(),
        config: session.config,
        snapshot: workspace.snapshot(),
        workspace,
        filesystem: available ? session.filesystem : undefined,
        catalog: available ? (refresh?.catalog ?? session.catalog) : undefined,
        candidateCatalog: available ? session.candidateCatalog : undefined,
        completion: session.completion,
        editor: session.editor,
        validation: session.validation,
        fixes,
        fixesEnabled,
        configurationUnavailable: !available,
        operations: available ? session.operations : undefined,
        publish: (uri: string, version: number, diagnostics: Diagnostic[]) =>
          publisher.publish(
            {
              uri,
              version,
              generation: context.generation,
              lifetime: workspace.document(uri)?.lifetime ?? 0,
              current: context.current,
            },
            diagnostics,
          ),
      };
      const work = () => (context.current() ? runValidation(context, input) : Promise.resolve());
      return (available ? session.operations.run(work) : work()).finally(() =>
        refresh?.finish(context.current()),
      );
    },
    () => sessions.current.config.debounceMs,
    (reason) => {
      if (reason === 'dependencies') sessions.current.completion.invalidateRemote();
      fixes.invalidate();
      sessions.current.completion.invalidate();
      if (reason === 'metadata') sessions.current.editor.expireRules(coordinator.generation);
      else sessions.current.editor.invalidate();
      workspace.invalidate();
    },
  );
  const schedule = () => coordinator.invalidate('buffer');
  const close = (): Promise<void> => {
    if (disposal) return disposal;
    stopped = true;
    fixes.invalidate();
    publisher.close();
    workspace.close();
    disposal = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => options.onClose?.()),
        clientEdits.close(),
        coordinator.close(),
        sessions.close(),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Language server cleanup failed.');
    })();
    return disposal;
  };
  connection.onInitialize((params) => {
    if (initialized || stopped) throw new Error('Language server already initialized.');
    fixesEnabled =
      params.capabilities.workspace?.applyEdit === true &&
      params.capabilities.workspace.workspaceEdit?.documentChanges === true &&
      !!params.capabilities.textDocument?.codeAction?.codeActionLiteralSupport &&
      params.capabilities.textDocument.publishDiagnostics?.dataSupport === true;
    atomicTextEdits = ['transactional', 'textOnlyTransactional'].includes(
      params.capabilities.workspace?.workspaceEdit?.failureHandling ?? '',
    );
    dynamicWatching =
      !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration &&
      !!params.capabilities.workspace.didChangeWatchedFiles.relativePatternSupport;
    const encodings = params.capabilities.general?.positionEncodings;
    if (encodings?.length && !encodings.includes(PositionEncodingKind.UTF16))
      throw new Error('UTF-16 positions are required.');
    initialized = true;
    return {
      capabilities: {
        positionEncoding: PositionEncodingKind.UTF16,
        completionProvider: { triggerCharacters: [':', '/'], resolveProvider: false },
        hoverProvider: true,
        definitionProvider: true,
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Incremental,
          ...(options.filesystem ? { save: { includeText: false } } : {}),
        },
        ...(fixesEnabled
          ? {
              codeActionProvider: { codeActionKinds: ['quickfix'] },
              executeCommandProvider: { commands: [APPLY_FIX_COMMAND] },
            }
          : {}),
        workspace: {
          fileOperations: {
            didRename: {
              filters: [{ scheme: 'file', pattern: { glob: '**/*', matches: 'file' } }],
            },
            didDelete: {
              filters: [{ scheme: 'file', pattern: { glob: '**/*', matches: 'file' } }],
            },
          },
        },
      },
      serverInfo: { name: 'backstage-validation-engine', version: '0.1.0-dev.0' },
    };
  });
  const requests = new RequestContexts(workspace, () => {
    sessions.current.refresh?.ensureFresh();
    if (sessions.available && sessions.current.editor.rulePreparationExpired)
      coordinator.invalidate('metadata');
    return {
      initialized,
      stopped,
      available: sessions.available,
      session: sessions.current,
    };
  });
  connection.onCompletion((params, token) =>
    requests.execute<CompletionList>(
      token,
      params?.textDocument?.uri,
      () => ({ isIncomplete: true, items: [] }),
      async (context) => {
        const generation = coordinator.generation;
        const { completion, editor } = context.session;
        const documents = context.snapshot.allDocuments;
        const references = await completion.complete(params, generation, documents, context.signal);
        if (!context.current()) return { isIncomplete: true, items: [] };
        references.items = references.items.filter((item) =>
          editor.acceptsReference(params, item.label, generation, documents),
        );
        if (context.signal.aborted) return references;
        if (references.items.length) {
          const declared = editor.complete(params, generation, documents, true);
          references.items = [...declared.items, ...references.items]
            .filter(
              (item, index, items) =>
                items.findIndex((other) => other.label === item.label) === index,
            )
            .slice(0, 100);
          return references;
        }
        return editor.complete(params, generation, documents);
      },
    ),
  );
  connection.onHover((params, token) =>
    requests.execute<Hover | null>(
      token,
      params?.textDocument?.uri,
      () => null,
      (context) =>
        context.session.editor.hover(
          params.textDocument.uri,
          params.position,
          coordinator.generation,
          context.snapshot.allDocuments,
        ),
    ),
  );
  connection.onDefinition((params, token) =>
    requests.execute<Location[]>(
      token,
      params?.textDocument?.uri,
      () => [],
      (context) =>
        context.session.editor.definition(
          params.textDocument.uri,
          params.position,
          coordinator.generation,
          context.snapshot.allDocuments,
        ),
    ),
  );
  connection.onNotification('bve/recordSelection', (input: unknown) => {
    if (!initialized || stopped || typeof input !== 'string' || input.length > 512) return;
    if (!sessions.available) return;
    sessions.current.completion.record(input);
    sessions.current.editor.record(input);
  });
  connection.onRequest('bve/searchReferences', (input: unknown, token: CancellationToken) =>
    requests.execute<readonly { reference: string; source: string }[]>(
      token,
      undefined,
      () => [],
      async (context) => {
        const { config, completion, filesystem } = context.session;
        const generation = coordinator.generation;
        if (!context.snapshot.allDocuments.size) {
          const created = createLspRequest(config, workspace.source);
          const original = parseContract('validation-request', {
            ...created,
            execution: { ...created.execution, deadlineAt: context.deadlineAt },
          });
          if (filesystem && workspace.capturedGeneration < workspace.diskGeneration) {
            const disk = workspace.diskGeneration;
            const sourceGeneration = workspace.generation;
            const source = await filesystem.capture(workspace.source, {
              deadlineAt: context.deadlineAt,
              signal: context.signal,
            });
            if (!context.current()) return [];
            verifyRequestBindings(
              parseContract('validation-request', { ...original, source }),
              config,
            );
            if (!workspace.commitCapture(source, disk, sourceGeneration)) return [];
          }
          await completion.update(
            parseContract('validation-request', { ...original, source: workspace.source }),
            generation,
          );
          await completion.ready(generation, context.signal);
          if (!context.current()) return [];
        }
        return completion.searchReferences(input, generation, context.signal);
      },
    ),
  );
  const reloadConfiguration = () =>
    initialized && !stopped ? sessions.reload() : Promise.resolve({ reloaded: false });
  connection.onRequest('bve/reloadConfiguration', reloadConfiguration);
  connection.onCodeAction((params, token) =>
    requests.execute<CodeAction[]>(
      token,
      params?.textDocument?.uri,
      () => [],
      (context) => {
        if (!fixesEnabled || clientEdits.busy) return [];
        return fixes.actions(
          params,
          coordinator.generation,
          context.snapshot.allDocuments,
          fixLimits(),
        );
      },
    ),
  );
  connection.onExecuteCommand((params, token) =>
    requests.execute<FixApplicationResult>(
      token,
      undefined,
      () => ({ applied: false, reason: 'invalid_request' }),
      (context) => {
        if (!fixesEnabled || params.command !== APPLY_FIX_COMMAND)
          return { applied: false, reason: 'invalid_request' };
        if (clientEdits.busy) return { applied: false, reason: 'busy' };
        return fixes.apply(
          params.arguments,
          coordinator.generation,
          context.snapshot.allDocuments,
          fixLimits(),
          (edit) => clientEdits.apply(edit, token),
        );
      },
      false,
    ),
  );
  function watchFiles() {
    const session = sessions.current;
    if (
      session.filesystem &&
      dynamicWatching &&
      clientInitialized &&
      !stopped &&
      watchGeneration !== session.generation
    ) {
      watchGeneration = session.generation;
      const registration = connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [
          { globPattern: { baseUri: session.config.source.rootUri!, pattern: '**/*' }, kind: 7 },
        ],
      });
      session.own(registration);
      void registration.catch(() => {
        if (!stopped && !session.closed)
          connection.console.warn(
            'Automatic file-change notifications are unavailable; save notifications still refresh approved files.',
          );
      });
    }
  }
  connection.onInitialized(() => {
    clientInitialized = true;
    watchFiles();
  });
  function refresh() {
    workspace.invalidateDisk();
    schedule();
  }
  connection.onDidSaveTextDocument((params) => {
    if (
      initialized &&
      !stopped &&
      sessions.current.filesystem &&
      approved.has(params?.textDocument?.uri)
    )
      refresh();
  });
  connection.onDidChangeWatchedFiles((params) => {
    if (!initialized || stopped || !sessions.current.filesystem || !Array.isArray(params?.changes))
      return;
    if (params.changes.length > 1000) {
      // Events are invalidation hints; coalesce large batches to the bounded allowlist.
      refresh();
      return;
    }
    if (
      params.changes.some(
        (row) =>
          row &&
          typeof row.uri === 'string' &&
          isCanonicalSourceUri(row.uri, row.uri.endsWith('/')) &&
          [1, 2, 3].includes(row.type) &&
          (filesystemEvent(sessions.current.config, row.uri) ||
            sessions.current.config.filesystem!.files.some((uri) =>
              uri.startsWith(row.uri.endsWith('/') ? row.uri : row.uri + '/'),
            )),
      )
    )
      refresh();
  });
  connection.onDidOpenTextDocument(({ textDocument: item }) => {
    if (initialized && !stopped && workspace.open(item)) schedule();
  });
  connection.onDidChangeTextDocument(({ textDocument: item, contentChanges }) => {
    if (initialized && !stopped && workspace.change(item, contentChanges)) schedule();
  });
  connection.onDidCloseTextDocument(async ({ textDocument: item }) => {
    if (stopped || !item) return;
    const previous = workspace.closeDocument(item.uri);
    if (!previous) return;
    if (sessions.current.filesystem && approved.has(item.uri)) refresh();
    else schedule();
    await clearDiagnostics(item.uri, previous.version, previous.lifetime);
  });
  async function fileOperations(rows: readonly SourceFileOperation[]) {
    if (!initialized || stopped) return;
    const cleared = workspace.applyOperations(rows);
    if (sessions.current.filesystem) refresh();
    else schedule();
    for (const document of cleared)
      await clearDiagnostics(document.uri, document.version, document.lifetime);
  }
  connection.workspace.onDidDeleteFiles((params) =>
    fileOperations(
      Array.isArray(params?.files) ? params.files.map((file) => ({ oldUri: file?.uri })) : [],
    ),
  );
  connection.workspace.onDidRenameFiles((params) => fileOperations(params?.files ?? []));
  connection.onShutdown(async () => {
    requestedShutdown = true;
    await close();
  });
  connection.onExit(() => {
    void close().then(
      () => options.exit?.(requestedShutdown ? 0 : 1),
      () => options.exit?.(1),
    );
  });
  return {
    close,
    reload: reloadConfiguration,
    own: (registration: Disposable | void) => sessions.current.own(registration),
  };
}
