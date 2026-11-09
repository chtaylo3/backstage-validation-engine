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
import type { Connection, Diagnostic, CancellationToken } from 'vscode-languageserver/node';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import { verifyRequestBindings } from '../core/bindings.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import { parseContract } from '../contracts/validate.js';
import type { FilesystemSource } from './filesystem.js';
import { APPLY_FIX_COMMAND, FIX_TITLE, FixRegistry } from './fixes.js';
import { createLspRequest } from './config.js';
import { CompletionService } from './completion.js';
import { EditorService } from './editor.js';
import type { LspConfig } from './config.js';
import { filesystemEvent } from './discovery.js';

export interface LspServerResources {
  readonly config: LspConfig;
  readonly catalog?: { readonly provider: CatalogProvider; readonly access: CatalogAccessContext };
  readonly filesystem?: FilesystemSource;
  readonly dispose?: () => Promise<void>;
}

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
    readonly configurationChanged?: (config: LspConfig) => void;
    readonly onClose?: () => void;
  } = {},
) {
  if (!!config.filesystem !== !!options.filesystem)
    throw new Error('Trusted filesystem reader configuration mismatch.');
  const fixes = new FixRegistry();
  let completion = new CompletionService(config, options.catalog);
  let editor = new EditorService(config);
  let configurationUnavailable = false;
  let reloading: Promise<{ reloaded: boolean }> | undefined;
  let reloadAgain = false;
  let fixesEnabled = false;
  let atomicTextEdits = false;
  const clientEdits = new ClientEdits((edit, token) =>
    connection.sendRequest(ApplyWorkspaceEditRequest.type, { label: FIX_TITLE, edit }, token),
  );
  const fixLimits = () => ({
    fileBytes: config.profile.limits.fileBytes,
    requestBytes: config.profile.limits.requestBytes,
    atomicTextEdits,
  });
  const workspace = new WorkspaceState(config);
  const approved = { has: (uri: string) => workspace.approved(uri) };
  let dynamicWatching = false;
  let watchRequested = false;
  let initialized = false;
  let stopped = false;
  let requestedShutdown = false;
  let disposal: Promise<void> | undefined;

  const publisher = new DiagnosticPublisher((params) => connection.sendDiagnostics(params));
  const publish = (uri: string, version: number, diagnostics: Diagnostic[], lifetime?: number) => {
    const generation = coordinator.generation;
    const document = workspace.documents.get(uri);
    return publisher.publish(
      {
        uri,
        version,
        generation,
        lifetime: lifetime ?? document?.lifetime ?? 0,
        current: () =>
          !stopped &&
          coordinator.generation === generation &&
          workspace.documents.get(uri) === document,
      },
      diagnostics,
    );
  };
  const coordinator = new ValidationCoordinator(
    (context) =>
      runValidation(context, {
        config,
        snapshot: workspace.snapshot(),
        workspace,
        filesystem: options.filesystem,
        catalog: options.catalog,
        completion,
        editor,
        fixes,
        fixesEnabled,
        configurationUnavailable,
        publish: (uri, version, diagnostics) =>
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
      }),
    () => config.debounceMs,
    () => {
      fixes.invalidate();
      completion.invalidate();
      editor.invalidate();
      workspace.invalidate();
    },
  );
  const schedule = () => coordinator.invalidate('buffer');
  const close = (): Promise<void> => {
    if (disposal) return disposal;
    stopped = true;
    options.onClose?.();
    fixes.invalidate();
    editor.invalidate();
    const closeEdits = clientEdits.close();
    publisher.close();
    workspace.close();
    const closeValidation = coordinator.close();
    disposal = (async () => {
      await closeEdits;
      await reloading;
      await completion.close();
      await closeValidation;
      await options.dispose?.();
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
  connection.onCompletion(async (params, token) => {
    if (
      !initialized ||
      stopped ||
      workspace.unavailableSources ||
      configurationUnavailable ||
      workspace.capacityExceeded ||
      token.isCancellationRequested
    )
      return { isIncomplete: true, items: [] };
    const cancellation = new AbortController();
    const generation = coordinator.generation;
    const subscription = token.onCancellationRequested(() => cancellation.abort());
    try {
      const references = await completion.complete(
        params,
        generation,
        workspace.documents,
        cancellation.signal,
      );
      if (stopped || configurationUnavailable || coordinator.generation !== generation)
        return { isIncomplete: true, items: [] };
      references.items = references.items.filter((item) =>
        editor.acceptsReference(params, item.label, generation, workspace.documents),
      );
      if (references.items.length || cancellation.signal.aborted) return references;
      return editor.complete(params, generation, workspace.documents);
    } finally {
      subscription.dispose();
    }
  });
  connection.onHover((params, token) =>
    initialized &&
    !stopped &&
    !configurationUnavailable &&
    !workspace.unavailableSources &&
    !workspace.capacityExceeded &&
    !token.isCancellationRequested
      ? editor.hover(
          params.textDocument.uri,
          params.position,
          coordinator.generation,
          workspace.documents,
        )
      : null,
  );
  connection.onDefinition((params, token) =>
    initialized &&
    !stopped &&
    !configurationUnavailable &&
    !workspace.unavailableSources &&
    !workspace.capacityExceeded &&
    !token.isCancellationRequested
      ? editor.definition(
          params.textDocument.uri,
          params.position,
          coordinator.generation,
          workspace.documents,
        )
      : [],
  );
  connection.onNotification('bve/recordSelection', (input: unknown) => {
    if (!initialized || stopped || typeof input !== 'string' || input.length > 512) return;
    completion.record(input);
    editor.record(input);
  });
  connection.onRequest('bve/searchReferences', async (input: unknown, token: CancellationToken) => {
    if (
      !initialized ||
      stopped ||
      configurationUnavailable ||
      workspace.unavailableSources ||
      workspace.capacityExceeded ||
      token.isCancellationRequested
    )
      return [];
    const cancellation = new AbortController();
    const subscription = token.onCancellationRequested(() => cancellation.abort());
    try {
      if (!workspace.documents.size) {
        const generation = coordinator.generation;
        const original = createLspRequest(config, workspace.source);
        if (options.filesystem && workspace.capturedGeneration < workspace.diskGeneration) {
          const disk = workspace.diskGeneration;
          const sourceGeneration = workspace.generation;
          const source = await options.filesystem.capture(workspace.source, {
            deadlineAt: original.execution.deadlineAt,
            signal: cancellation.signal,
          });
          if (stopped || coordinator.generation !== generation || cancellation.signal.aborted)
            return [];
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
        await completion.ready(generation, cancellation.signal);
        if (stopped || coordinator.generation !== generation || cancellation.signal.aborted)
          return [];
      }
      return await completion.searchReferences(input, coordinator.generation, cancellation.signal);
    } catch {
      return [];
    } finally {
      subscription.dispose();
    }
  });
  async function reloadConfiguration(): Promise<{ reloaded: boolean }> {
    if (!initialized || stopped || !options.reload) return { reloaded: false };
    if (reloading) {
      reloadAgain = true;
      return reloading;
    }
    const reload = options.reload;
    configurationUnavailable = true;
    clientEdits.cancel();
    schedule();
    reloading = (async () => {
      let replacement: LspServerResources | undefined;
      try {
        replacement = await reload();
        if (
          replacement.config.source.rootUri !== config.source.rootUri ||
          !!replacement.config.filesystem !== !!config.filesystem ||
          (!config.filesystem &&
            JSON.stringify(replacement.config.source.files.map((file) => file.uri).sort()) !==
              JSON.stringify(config.source.files.map((file) => file.uri).sort()))
        )
          throw new Error('The client must reconnect after a source scope change.');
        if (!!replacement.config.filesystem !== !!replacement.filesystem)
          throw new Error('Invalid host resources.');
        const nextCompletion = new CompletionService(replacement.config, replacement.catalog);
        const nextEditor = new EditorService(replacement.config);
        await coordinator.cancelActive();
        if (stopped) {
          await nextCompletion.close();
          return { reloaded: false };
        }
        await completion.close();
        editor.invalidate();
        await options.dispose?.();
        if (stopped) {
          await nextCompletion.close();
          return { reloaded: false };
        }
        config = replacement.config;
        options = {
          ...options,
          ...(replacement.catalog ? { catalog: replacement.catalog } : { catalog: undefined }),
          ...(replacement.filesystem
            ? { filesystem: replacement.filesystem }
            : { filesystem: undefined }),
          ...(replacement.dispose ? { dispose: replacement.dispose } : { dispose: undefined }),
        };
        replacement = undefined;
        completion = nextCompletion;
        editor = nextEditor;
        workspace.replaceConfiguration(config);
        configurationUnavailable = false;
        options.configurationChanged?.(config);
        for (const [uri, document] of workspace.documents)
          if (config.filesystem && !approved.has(uri)) {
            await publish(uri, document.version, []);
          }
        schedule();
        void connection.sendNotification('bve/configurationReloaded');
        return { reloaded: true };
      } catch {
        completion.invalidate();
        editor.invalidate();
        fixes.invalidate();
        schedule();
        return { reloaded: false };
      } finally {
        await replacement?.dispose?.();
        reloading = undefined;
        if (reloadAgain && !stopped) {
          reloadAgain = false;
          queueMicrotask(() => {
            void reloadConfiguration().catch(() => undefined);
          });
        }
      }
    })();
    return reloading;
  }
  connection.onRequest('bve/reloadConfiguration', reloadConfiguration);
  connection.onCodeAction((params) => {
    if (
      !initialized ||
      stopped ||
      !fixesEnabled ||
      workspace.unavailableSources ||
      configurationUnavailable ||
      workspace.capacityExceeded ||
      clientEdits.busy
    )
      return [];
    return fixes.actions(params, coordinator.generation, workspace.documents, fixLimits());
  });
  connection.onExecuteCommand((params, token) => {
    if (
      !initialized ||
      stopped ||
      !fixesEnabled ||
      workspace.unavailableSources ||
      configurationUnavailable ||
      workspace.capacityExceeded ||
      params.command !== APPLY_FIX_COMMAND ||
      token.isCancellationRequested
    )
      return { applied: false, reason: 'invalid_request' };
    if (clientEdits.busy) return { applied: false, reason: 'busy' };
    return fixes.apply(
      params.arguments,
      coordinator.generation,
      workspace.documents,
      fixLimits(),
      (edit) => clientEdits.apply(edit, token),
    );
  });
  function watchFiles() {
    if (options.filesystem && dynamicWatching && !stopped && !watchRequested) {
      watchRequested = true;
      void connection.client
        .register(DidChangeWatchedFilesNotification.type, {
          watchers: [
            { globPattern: { baseUri: config.source.rootUri!, pattern: '**/*' }, kind: 7 },
          ],
        })
        .catch(() => {
          if (!stopped)
            connection.console.warn(
              'Automatic file-change notifications are unavailable; save notifications still refresh approved files.',
            );
        });
    }
  }
  connection.onInitialized(watchFiles);
  function refresh() {
    workspace.invalidateDisk();
    schedule();
  }
  connection.onDidSaveTextDocument((params) => {
    if (initialized && !stopped && options.filesystem && approved.has(params?.textDocument?.uri))
      refresh();
  });
  connection.onDidChangeWatchedFiles((params) => {
    if (!initialized || stopped || !options.filesystem || !Array.isArray(params?.changes)) return;
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
          (filesystemEvent(config, row.uri) ||
            config.filesystem!.files.some((uri) =>
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
    if (options.filesystem && approved.has(item.uri)) refresh();
    else schedule();
    await publish(item.uri, previous.version, [], previous.lifetime);
  });
  async function fileOperations(rows: readonly SourceFileOperation[]) {
    if (!initialized || stopped) return;
    const cleared = workspace.applyOperations(rows);
    if (options.filesystem) refresh();
    else schedule();
    for (const document of cleared)
      await publish(document.uri, document.version, [], document.lifetime);
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
    void close().then(() => options.exit?.(requestedShutdown ? 0 : 1));
  });
  return { close, reload: reloadConfiguration };
}
