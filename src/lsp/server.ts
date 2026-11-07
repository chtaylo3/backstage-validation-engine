import {
  DiagnosticSeverity,
  PositionEncodingKind,
  TextDocumentSyncKind,
  DidChangeWatchedFilesNotification,
  ApplyWorkspaceEditRequest,
  CancellationTokenSource,
} from 'vscode-languageserver/node';
import type {
  Connection,
  Diagnostic,
  TextDocumentContentChangeEvent,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Finding } from '../contracts/schemas.js';
import { digestText } from '../core/json.js';
import type { Immutable } from '../core/json.js';
import { createSourceSnapshot, overlaySourceSnapshot } from '../core/snapshots.js';
import type { SourceInput } from '../core/snapshots.js';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import { verifyRequestBindings } from '../core/bindings.js';
import { validatePolicySources } from '../core/policy-sources.js';
import type { CatalogAccessContext, CatalogProvider } from '../providers/types.js';
import { FAILURE_EVIDENCE_LIMIT, FailureTimer, failureCause } from '../runtime/failure-evidence.js';
import { parseContract } from '../contracts/validate.js';
import { FilesystemSnapshotError, reconcileFilesystemSource } from './filesystem.js';
import type { FilesystemSource } from './filesystem.js';
import type { FailureEvidence, FailureStage } from '../runtime/failure-evidence.js';
import { APPLY_FIX_COMMAND, FIX_LIMITS, FIX_TITLE, FixRegistry } from './fixes.js';
import { createLspRequest } from './config.js';
import { CompletionService } from './completion.js';
import type { LspConfig } from './config.js';

function diagnostic(
  finding: Immutable<Finding>,
  digest: string,
  version: number,
  uri: string,
  evidence: readonly FailureEvidence[] = [],
  fixGeneration?: number,
): Diagnostic {
  const projected = finding.location.uri !== uri;
  const location = projected
    ? finding.relatedLocations.find((location) => location.uri === uri)!
    : finding.location;
  const related = [...(projected ? [finding.location] : []), ...finding.relatedLocations].filter(
    (item) => item !== location,
  );
  return {
    range: location.range,
    severity: finding.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    source: 'backstage-validation',
    code: finding.ruleId,
    message: finding.message,
    ...(related.length
      ? {
          relatedInformation: related.map((location) => ({
            location: { uri: location.uri, range: location.range },
            message: 'Related source location.',
          })),
        }
      : {}),
    data: {
      findingId: finding.id,
      ...(fixGeneration === undefined || !finding.edits.length ? {} : { fixGeneration }),
      category: finding.category,
      sourceDigest: digest,
      version,
      ...(evidence.length ? { execution: evidence } : {}),
    },
  };
}
const validVersion = (version: number) => Number.isSafeInteger(version) && version >= 0;
const validUri = (uri: string) =>
  typeof uri === 'string' && uri.length <= 4096 && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(uri);

/** One active request and one latest workspace snapshot; host owns resources and immutable authority. */
export function attachLspServer(
  connection: Connection,
  config: LspConfig,
  options: {
    readonly catalog?: {
      readonly provider: CatalogProvider;
      readonly access: CatalogAccessContext;
    };
    readonly filesystem?: FilesystemSource;
    readonly dispose?: () => Promise<void>;
    readonly exit?: (code: number) => void;
  } = {},
) {
  if (!!config.filesystem !== !!options.filesystem)
    throw new Error('Trusted filesystem reader configuration mismatch.');
  const fixes = new FixRegistry();
  const completion = new CompletionService(config, options.catalog);
  let fixesEnabled = false;
  let atomicTextEdits = false;
  let applyingFix: CancellationTokenSource | undefined;
  const fixLimits = () => ({
    fileBytes: config.profile.limits.fileBytes,
    requestBytes: config.profile.limits.requestBytes,
    atomicTextEdits,
  });
  const approved = new Set(config.filesystem?.files ?? []);
  let diskGeneration = options.filesystem ? 1 : 0;
  let capturedGeneration = 0;
  let dynamicWatching = false;
  let watchRequested = false;
  const documents = new Map<string, TextDocument>();
  let workspaceSource = config.source;
  const unavailable = new Set<string>();
  let capacityExceeded = false;
  let epoch = 0;
  let initialized = false;
  let stopped = false;
  let requestedShutdown = false;
  let timer: NodeJS.Timeout | undefined;
  let controller: AbortController | undefined;
  let active: Promise<void> | undefined;
  let pending = false;
  let disposal: Promise<void> | undefined;

  const publish = async (uri: string, version: number, diagnostics: Diagnostic[]) => {
    await connection.sendDiagnostics({ uri, version, diagnostics });
  };
  const drain = (): void => {
    if (active || !pending || stopped) return;
    pending = false;
    const generation = epoch;
    const frame = [...documents.values()];
    const abort = new AbortController();
    controller = abort;
    const current = () => !stopped && !abort.signal.aborted && epoch === generation;
    active = (async () => {
      if (!frame.length) return;
      const timing = new FailureTimer();
      const evidence: FailureEvidence[] = [];
      let deadlineAt: number | undefined;
      let phase: FailureStage = 'validation';
      try {
        // Admission precedes disk I/O; the refreshed request retains this exact budget.
        const original = options.filesystem ? createLspRequest(config, workspaceSource) : undefined;
        deadlineAt = original?.execution.deadlineAt;
        if (options.filesystem && capturedGeneration < diskGeneration) {
          const requested = diskGeneration;
          phase = 'filesystem';
          const refreshed = await options.filesystem.capture(workspaceSource, {
            deadlineAt: original!.execution.deadlineAt,
            signal: abort.signal,
            skip: frame.map((document) => document.uri).filter((uri) => approved.has(uri)),
          });
          if (!current()) return;
          verifyRequestBindings(
            parseContract('validation-request', { ...original, source: refreshed }),
            config,
          );
          workspaceSource = refreshed;
          capturedGeneration = requested;
        }
        phase = 'validation';
        if (unavailable.size || capacityExceeded) {
          for (const document of frame) {
            if (!current()) return;
            await publish(document.uri, document.version, [
              incomplete(
                unavailable.has(document.uri) ? undefined : digestText(document.getText()),
                document.version,
                [timing.capture('buffer', 'buffer_unavailable')],
              ),
            ]);
          }
          return;
        }
        let source = overlaySourceSnapshot(
          workspaceSource,
          frame.map((document) => ({
            uri: document.uri,
            text: document.getText(),
            origin: 'buffer',
            version: document.version,
          })),
        );
        if (options.filesystem) source = reconcileFilesystemSource(config, source);
        const request = original
          ? parseContract('validation-request', { ...original, source })
          : createLspRequest(config, source);
        deadlineAt = request.execution.deadlineAt;
        void completion.update(request, generation);
        const report = await validatePolicySources(request, config, {
          onFailure: (row) => {
            if (evidence.length < FAILURE_EVIDENCE_LIMIT) evidence.push(row);
          },
          signal: abort.signal,
          ...(options.catalog ? { catalog: options.catalog } : {}),
        });
        if (!current()) return;
        evidence.push(...report.failureEvidence.slice(0, FAILURE_EVIDENCE_LIMIT - evidence.length));
        if (
          fixesEnabled &&
          report.interrupted === 'none' &&
          report.rules.failures.length === 0 &&
          report.coverage.every((row) => !row.required || row.status === 'verified') &&
          !report.findings.some((row) =>
            ['configuration', 'dependency', 'execution', 'resource'].includes(row.category),
          )
        ) {
          fixes.replace({
            generation,
            findings: report.findings,
            source: report.request.source,
            ...(report.request.baseline ? { baseline: report.request.baseline } : {}),
            documents,
            expiresAt: Math.min(
              Date.now() + FIX_LIMITS.ttlMs,
              ...report.request.data.entries.map((row) => row.provenance.expiresAt),
            ),
          });
        }
        for (const document of frame) {
          if (!current()) return;
          const digest = digestText(document.getText());
          const diagnostics = report.findings
            .filter(
              (finding) =>
                finding.location.uri === document.uri ||
                finding.relatedLocations.some((location) => location.uri === document.uri),
            )
            .map((finding) =>
              diagnostic(
                finding,
                digest,
                document.version,
                document.uri,
                evidence,
                fixesEnabled ? generation : undefined,
              ),
            );
          if (
            report.interrupted !== 'none' ||
            (report.coverage.some((row) => row.required && row.status !== 'verified') &&
              diagnostics.length === 0)
          )
            diagnostics.push(incomplete(digest, document.version, evidence));
          await publish(document.uri, document.version, diagnostics);
        }
      } catch (error) {
        fixes.invalidate();
        if (!evidence.length)
          evidence.push(
            timing.capture(
              phase,
              error instanceof FilesystemSnapshotError
                ? error.reason === 'limit'
                  ? 'resource_limit'
                  : error.reason === 'changed'
                    ? 'source_changed'
                    : 'snapshot_unavailable'
                : failureCause(error),
              deadlineAt,
            ),
          );
        if (current())
          for (const document of frame) {
            if (!current()) return;
            await publish(document.uri, document.version, [
              incomplete(digestText(document.getText()), document.version, evidence),
            ]);
          }
      }
    })()
      .catch(() => {
        /* Transport errors cannot publish another diagnostic. */
      })
      .finally(() => {
        active = undefined;
        controller = undefined;
        if (pending && !timer) drain();
      });
  };
  function incomplete(
    digest: string | undefined,
    version: number,
    evidence: readonly FailureEvidence[] = [],
  ): Diagnostic {
    return {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: DiagnosticSeverity.Warning,
      code: 'validation/incomplete',
      source: 'backstage-validation',
      message: 'Validation could not complete for this workspace snapshot.',
      data: {
        category: 'execution',
        ...(evidence.length ? { execution: evidence } : {}),
        ...(digest === undefined ? {} : { sourceDigest: digest }),
        version,
      },
    };
  }
  function schedule() {
    fixes.invalidate();
    completion.invalidate();
    epoch++;
    controller?.abort();
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      drain();
    }, config.debounceMs);
  }
  // Validate notification edits before TextDocument.update (which deliberately clamps positions).
  function changed(
    document: TextDocument,
    changes: TextDocumentContentChangeEvent[],
    version: number,
  ): TextDocument | undefined {
    if (!Array.isArray(changes) || !changes.length || changes.length > 1000) return undefined;
    let updated = TextDocument.create(
      document.uri,
      document.languageId,
      document.version,
      document.getText(),
    );
    for (const change of changes) {
      if (
        !change ||
        typeof change !== 'object' ||
        typeof change.text !== 'string' ||
        Buffer.byteLength(change.text) > config.profile.limits.fileBytes
      )
        return undefined;
      if ('range' in change) {
        const range = change.range;
        if (!range?.start || !range.end) return undefined;
        for (const position of [range.start, range.end]) {
          if (
            !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) ||
            position.line < 0 ||
            position.character < 0
          )
            return undefined;
          const actual = updated.positionAt(updated.offsetAt(position));
          if (actual.line !== position.line || actual.character !== position.character)
            return undefined;
        }
        if (updated.offsetAt(range.start) > updated.offsetAt(range.end)) return undefined;
      }
      updated = TextDocument.update(updated, [change], version);
      if (Buffer.byteLength(updated.getText()) > config.profile.limits.fileBytes) return undefined;
    }
    const files = new Map(
      workspaceSource.files.map((file) => [file.uri, Buffer.byteLength(file.text)]),
    );
    for (const item of documents.values()) files.set(item.uri, Buffer.byteLength(item.getText()));
    files.set(updated.uri, Buffer.byteLength(updated.getText()));
    if (
      files.size > 1000 ||
      [...files.values()].reduce((a, b) => a + b, 0) > config.profile.limits.requestBytes
    )
      return undefined;
    return updated;
  }
  const close = (): Promise<void> => {
    if (disposal) return disposal;
    stopped = true;
    fixes.invalidate();
    applyingFix?.cancel();
    epoch++;
    pending = false;
    if (timer) clearTimeout(timer);
    controller?.abort();
    disposal = (async () => {
      await completion.close();
      await active;
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
      unavailable.size ||
      capacityExceeded ||
      token.isCancellationRequested
    )
      return { isIncomplete: true, items: [] };
    const cancellation = new AbortController();
    const subscription = token.onCancellationRequested(() => cancellation.abort());
    try {
      return await completion.complete(params, epoch, documents, cancellation.signal);
    } finally {
      subscription.dispose();
    }
  });
  connection.onCodeAction((params) => {
    if (
      !initialized ||
      stopped ||
      !fixesEnabled ||
      unavailable.size ||
      capacityExceeded ||
      applyingFix
    )
      return [];
    return fixes.actions(params, epoch, documents, fixLimits());
  });
  connection.onExecuteCommand((params, token) => {
    if (
      !initialized ||
      stopped ||
      !fixesEnabled ||
      unavailable.size ||
      capacityExceeded ||
      params.command !== APPLY_FIX_COMMAND ||
      token.isCancellationRequested
    )
      return { applied: false, reason: 'invalid_request' };
    if (applyingFix) return { applied: false, reason: 'busy' };
    return fixes.apply(params.arguments, epoch, documents, fixLimits(), async (edit) => {
      const cancellation = new CancellationTokenSource();
      applyingFix = cancellation;
      const timer = setTimeout(() => cancellation.cancel(), FIX_LIMITS.applyMs);
      const upstream = token.onCancellationRequested(() => cancellation.cancel());
      const pending = connection.sendRequest(
        ApplyWorkspaceEditRequest.type,
        { label: FIX_TITLE, edit },
        cancellation.token,
      );
      // Cancellation alone does not settle a JSON-RPC request. Keep at most one
      // outstanding client request even after the bounded local wait expires.
      const release = () => {
        cancellation.dispose();
        if (applyingFix === cancellation) applyingFix = undefined;
      };
      void pending.then(release, release);
      let stopWaiting: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        const stop = () => reject(new Error('Fix application cancelled.'));
        const subscription = cancellation.token.onCancellationRequested(stop);
        stopWaiting = () => subscription.dispose();
        if (cancellation.token.isCancellationRequested) stop();
      });
      try {
        return await Promise.race([pending, cancelled]);
      } finally {
        clearTimeout(timer);
        upstream.dispose();
        stopWaiting?.();
      }
    });
  });
  connection.onInitialized(() => {
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
  });
  function refresh() {
    diskGeneration++;
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
          (approved.has(row.uri) ||
            [...approved].some((uri) =>
              uri.startsWith(row.uri.endsWith('/') ? row.uri : row.uri + '/'),
            )),
      )
    )
      refresh();
  });
  connection.onDidOpenTextDocument(({ textDocument: item }) => {
    if (
      !initialized ||
      stopped ||
      !item ||
      !validUri(item.uri) ||
      !validVersion(item.version) ||
      documents.has(item.uri) ||
      typeof item.text !== 'string'
    )
      return;
    if (documents.size >= 1000) {
      capacityExceeded = true;
      schedule();
      return;
    }
    const seed = TextDocument.create(item.uri, 'yaml', item.version, '');
    const document = changed(seed, [{ text: item.text }], item.version);
    if (!document) unavailable.add(item.uri);
    documents.set(item.uri, document ?? seed);
    schedule();
  });
  connection.onDidChangeTextDocument(({ textDocument: item, contentChanges }) => {
    if (!initialized || stopped || !item) return;
    const previous = documents.get(item.uri);
    if (!previous || !validVersion(item.version) || item.version <= previous.version) return;
    const first = Array.isArray(contentChanges) ? contentChanges[0] : undefined;
    const resynchronizing = first && typeof first === 'object' && !('range' in first);
    const document =
      unavailable.has(item.uri) && !resynchronizing
        ? undefined
        : changed(previous, contentChanges, item.version);
    if (document) unavailable.delete(item.uri);
    else unavailable.add(item.uri);
    documents.set(
      item.uri,
      document ?? TextDocument.create(item.uri, previous.languageId, item.version, ''),
    );
    schedule();
  });
  connection.onDidCloseTextDocument(async ({ textDocument: item }) => {
    if (stopped || !item) return;
    const previous = documents.get(item.uri);
    if (!previous) return;
    documents.delete(item.uri);
    unavailable.delete(item.uri);
    if (options.filesystem && approved.has(item.uri)) refresh();
    else schedule();
    await publish(item.uri, previous.version, []);
  });
  const fileUri = (uri: string) =>
    validUri(uri) &&
    isCanonicalSourceUri(uri) &&
    (!config.source.rootUri || uri.startsWith(config.source.rootUri));
  type SourceFileOperation = { readonly oldUri: string; readonly newUri?: string };
  async function fileOperations(rows: readonly SourceFileOperation[]) {
    if (!initialized || stopped) return;
    const cleared: TextDocument[] = [];
    try {
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000)
        throw new Error('Invalid file operations');
      const seen = new Set<string>();
      const updates: (SourceInput | { uri: string; deleted: true })[] = [];
      const renamed = new Map<string, string>();
      for (const row of rows as readonly SourceFileOperation[]) {
        if (
          !row ||
          !fileUri(row.oldUri) ||
          (options.filesystem &&
            (!approved.has(row.oldUri) ||
              (row.newUri !== undefined && !approved.has(row.newUri)))) ||
          seen.has(row.oldUri) ||
          (row.newUri !== undefined &&
            (!fileUri(row.newUri) || seen.has(row.newUri) || row.newUri === row.oldUri))
        )
          throw new Error('Invalid file operation');
        seen.add(row.oldUri);
        if (row.newUri !== undefined) seen.add(row.newUri);
        const open = documents.get(row.oldUri);
        const file = workspaceSource.files.find((file) => file.uri === row.oldUri);
        if (!open && !file) throw new Error('Source bytes are unavailable');
        if (file) updates.push({ uri: row.oldUri, deleted: true });
        if (row.newUri !== undefined) {
          if (unavailable.has(row.oldUri)) throw new Error('Source buffer is not synchronized');
          if (
            documents.has(row.newUri) ||
            workspaceSource.files.some((file) => file.uri === row.newUri)
          )
            throw new Error('Conflicting rename');
          updates.push(
            open
              ? { uri: row.newUri, text: open.getText(), origin: 'buffer', version: open.version }
              : { ...file!, uri: row.newUri },
          );
          renamed.set(row.oldUri, row.newUri);
        }
        if (open) cleared.push(open);
      }
      let next = overlaySourceSnapshot(workspaceSource, updates);
      if (!options.filesystem && workspaceSource.entrypoints !== undefined)
        next = createSourceSnapshot({
          ...next,
          entrypoints: workspaceSource.entrypoints
            .map((uri) => renamed.get(uri) ?? uri)
            .filter((uri) => next.files.some((file) => file.uri === uri)),
        });
      if (next.files.length > 1000) throw new Error('Source limit exceeded');
      verifyRequestBindings(createLspRequest(config, next), config);
      workspaceSource = next;
      for (const document of cleared) {
        documents.delete(document.uri);
        unavailable.delete(document.uri);
      }
    } catch {
      capacityExceeded = true;
    }
    if (options.filesystem) refresh();
    else schedule();
    if (!capacityExceeded)
      for (const document of cleared) await publish(document.uri, document.version, []);
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
  return { close };
}
