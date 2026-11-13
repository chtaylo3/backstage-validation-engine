import { DidChangeWatchedFilesNotification } from 'vscode-languageserver/node';
import type { FileEvent } from 'vscode-languageserver/node';
import { isCanonicalSourceUri } from '../../base/source-uris.js';
import type { LspConfig } from '../config.js';
import type { ServerContext } from '../server-context.js';
import type { SourceFileOperation } from '../workspace-state.js';

/** Up to this many changes, every change is tested and the admitted URIs are observed. */
const WATCHED_CHANGES = 1000;
/**
 * A larger notification is scanned for its first admitted change and observes no URIs. Past this
 * many changes without an admitted one, the scan stops and the notification refreshes, so the work
 * on one notification stays bounded.
 */
const WATCHED_SCAN_LIMIT = 50_000;
/** Observed URIs are bounded by count and by UTF-8 bytes. */
const OBSERVED_URIS = 32;
const OBSERVED_BYTES = 64 * 1024;

/** Whether one watched-files change is admitted. */
export type WatchedFileAdmission = (row: FileEvent) => boolean;
const admissions = new WeakMap<LspConfig, WatchedFileAdmission>();

/**
 * The admission test of one change, prepared once per configuration object. A change is admitted
 * when its URI is canonical, its type is 1, 2 or 3, and it is an approved file, lies under a
 * discovery root, or is a directory that contains an approved file or a discovery root. No glob is
 * matched: a URI that matches a discovery glob already lies under its root. The cheap tests run
 * first, the canonical-URI test last.
 */
export function watchedFileAdmission(config: LspConfig): WatchedFileAdmission {
  const cached = admissions.get(config);
  if (cached) return cached;
  const { filesystem } = config;
  const files = new Set(filesystem?.files ?? []);
  const roots = filesystem?.discovery?.roots ?? [];
  // Every directory prefix (ending in `/`) of an approved file or a discovery root.
  const containers = new Set<string>();
  for (const uri of [...files, ...roots])
    for (let index = uri.indexOf('/'); index >= 0; index = uri.indexOf('/', index + 1))
      containers.add(uri.slice(0, index + 1));
  const admitted: WatchedFileAdmission = (row) => {
    if (!row || typeof row.uri !== 'string' || (row.type !== 1 && row.type !== 2 && row.type !== 3))
      return false;
    const { uri } = row;
    const directory = uri.endsWith('/');
    return (
      (files.has(uri) ||
        containers.has(directory ? uri : uri + '/') ||
        roots.some((root) => uri.startsWith(root))) &&
      isCanonicalSourceUri(uri, directory)
    );
  };
  admissions.set(config, admitted);
  return admitted;
}

export type WatchedFilesDecision =
  | { readonly refresh: false }
  | { readonly refresh: true; readonly uris: string[]; readonly truncated: boolean };
/**
 * Whether a watched-files notification refreshes the approved files, and the bounded URIs it
 * observes (see `watchedFileAdmission`). A notification refreshes when it has an admitted change.
 * Up to `WATCHED_CHANGES` changes, the admitted URIs are observed up to the count and byte limits.
 * A larger notification is scanned up to its first admitted change and observes no URIs; past
 * `WATCHED_SCAN_LIMIT` changes without a decision it refreshes.
 */
export function admitWatchedFiles(
  config: LspConfig,
  changes: readonly FileEvent[],
): WatchedFilesDecision {
  const admitted = watchedFileAdmission(config);
  if (changes.length > WATCHED_CHANGES) {
    const scanned = Math.min(changes.length, WATCHED_SCAN_LIMIT);
    for (let index = 0; index < scanned; index++)
      if (admitted(changes[index]!)) return { refresh: true, uris: [], truncated: true };
    return changes.length > WATCHED_SCAN_LIMIT
      ? { refresh: true, uris: [], truncated: true }
      : { refresh: false };
  }
  const uris: string[] = [];
  let bytes = 0,
    admittedEvent = false,
    truncated = false;
  for (const row of changes) {
    if (!admitted(row)) continue;
    admittedEvent = true;
    const size = Buffer.byteLength(row.uri, 'utf8');
    if (uris.length < OBSERVED_URIS && bytes + size <= OBSERVED_BYTES) {
      uris.push(row.uri);
      bytes += size;
    } else truncated = true;
  }
  return admittedEvent ? { refresh: true, uris, truncated } : { refresh: false };
}

/** Registers the dynamic watcher once per session generation, when the client supports it. */
export function watchFiles(context: ServerContext): void {
  const { connection, features, lifecycle } = context;
  const session = context.sessions.current;
  if (
    session.filesystem &&
    features.dynamicWatching &&
    lifecycle.clientInitialized &&
    !lifecycle.stopped &&
    context.watchGeneration !== session.generation
  ) {
    context.watchGeneration = session.generation;
    const registration = connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [
        { globPattern: { baseUri: session.config.source.rootUri!, pattern: '**/*' }, kind: 7 },
      ],
    });
    session.own(registration);
    void registration.catch(() => {
      if (!lifecycle.stopped && !session.closed)
        connection.console.warn(
          'Automatic file-change notifications are unavailable; save notifications still refresh approved files.',
        );
    });
  }
}

/** Open, change, close, save, watched files, and file delete and rename. */
export function registerDocumentHandlers(context: ServerContext): void {
  const { connection, lifecycle, workspace, observations } = context;
  const sessions = () => context.sessions;
  const schedule = () => context.schedule();
  function refresh() {
    workspace.invalidateDisk();
    schedule();
  }
  connection.onDidSaveTextDocument((params) => {
    if (
      lifecycle.initialized &&
      !lifecycle.stopped &&
      sessions().current.filesystem &&
      workspace.approved(params?.textDocument?.uri)
    )
      refresh();
  });
  connection.onDidChangeWatchedFiles((params) => {
    if (
      !lifecycle.initialized ||
      lifecycle.stopped ||
      !sessions().current.filesystem ||
      !Array.isArray(params?.changes)
    )
      return;
    const decision = admitWatchedFiles(sessions().current.config, params.changes);
    if (!decision.refresh) return;
    refresh();
    // The observation records the generation that the refresh started.
    if (sessions().current.config.coverageObservation)
      observations.recordFilesystem({
        sessionGeneration: sessions().current.generation,
        generation: context.coordinator.generation,
        uris: decision.uris,
        truncated: decision.truncated,
      });
  });
  // Parameters are read defensively: a notification without usable parameters is dropped, and
  // `WorkspaceState` rejects a missing or malformed document item.
  connection.onDidOpenTextDocument((params) => {
    if (lifecycle.initialized && !lifecycle.stopped && workspace.open(params?.textDocument))
      schedule();
  });
  connection.onDidChangeTextDocument((params) => {
    if (
      lifecycle.initialized &&
      !lifecycle.stopped &&
      workspace.change(params?.textDocument, params?.contentChanges)
    )
      schedule();
  });
  connection.onDidCloseTextDocument(async (params) => {
    const item = params?.textDocument;
    if (!lifecycle.initialized || lifecycle.stopped || !item) return;
    const previous = workspace.closeDocument(item.uri);
    if (!previous) return;
    if (sessions().current.filesystem && workspace.approved(item.uri)) refresh();
    else schedule();
    await context.clearDiagnostics(item.uri, previous.version, previous.lifetime);
  });
  async function fileOperations(rows: readonly SourceFileOperation[]) {
    if (!lifecycle.initialized || lifecycle.stopped) return;
    const cleared = workspace.applyOperations(rows);
    if (sessions().current.filesystem) refresh();
    else schedule();
    for (const document of cleared)
      await context.clearDiagnostics(document.uri, document.version, document.lifetime);
  }
  connection.workspace.onDidDeleteFiles((params) =>
    fileOperations(
      Array.isArray(params?.files) ? params.files.map((file) => ({ oldUri: file?.uri })) : [],
    ),
  );
  connection.workspace.onDidRenameFiles((params) => fileOperations(params?.files ?? []));
}
