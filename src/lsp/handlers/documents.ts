import { DidChangeWatchedFilesNotification } from 'vscode-languageserver/node';
import type { FileEvent } from 'vscode-languageserver/node';
import { isCanonicalSourceUri } from '../../base/source-uris.js';
import type { LspConfig } from '../config.js';
import { filesystemEvent } from '../discovery.js';
import type { ServerContext } from '../server-context.js';
import type { SourceFileOperation } from '../workspace-state.js';

/** At most this many changes are inspected; a larger notification refreshes without traversal. */
const WATCHED_CHANGES = 1000;
/** Observed URIs are bounded by count and by UTF-8 bytes. */
const OBSERVED_URIS = 32;
const OBSERVED_BYTES = 64 * 1024;

export type WatchedFilesDecision =
  | { readonly refresh: false }
  | { readonly refresh: true; readonly uris: string[]; readonly truncated: boolean };
/**
 * Whether a watched-files notification refreshes the approved files, and the bounded URIs it
 * observes. A change is admitted when it is canonical, has a valid type, and names an approved
 * file, a discovery root, or a directory that contains an approved file.
 */
export function admitWatchedFiles(
  config: LspConfig,
  changes: readonly FileEvent[],
): WatchedFilesDecision {
  if (changes.length > WATCHED_CHANGES)
    // Preserve bounded coalescing without traversing an oversized notification.
    return { refresh: true, uris: [], truncated: true };
  const uris: string[] = [];
  let bytes = 0,
    admittedEvent = false,
    truncated = false;
  for (const row of changes) {
    if (
      !row ||
      typeof row.uri !== 'string' ||
      !isCanonicalSourceUri(row.uri, row.uri.endsWith('/')) ||
      ![1, 2, 3].includes(row.type) ||
      !(
        filesystemEvent(config, row.uri) ||
        config.filesystem!.files.some((uri) =>
          uri.startsWith(row.uri.endsWith('/') ? row.uri : row.uri + '/'),
        )
      )
    )
      continue;
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
  connection.onDidOpenTextDocument(({ textDocument: item }) => {
    if (lifecycle.initialized && !lifecycle.stopped && workspace.open(item)) schedule();
  });
  connection.onDidChangeTextDocument(({ textDocument: item, contentChanges }) => {
    if (lifecycle.initialized && !lifecycle.stopped && workspace.change(item, contentChanges))
      schedule();
  });
  connection.onDidCloseTextDocument(async ({ textDocument: item }) => {
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
