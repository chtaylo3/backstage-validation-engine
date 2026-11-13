import {
  PositionEncodingKind,
  ResponseError,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import type { InitializeResult } from 'vscode-languageserver/node';
import { APPLY_FIX_COMMAND } from '../fixes.js';
import type { ClientFeatureFlags, ServerContext } from '../server-context.js';
import { watchFiles } from './documents.js';

/** The `initialize` result for the accepted client features. */
export function initializeResult(
  features: ClientFeatureFlags,
  filesystem: boolean,
): InitializeResult {
  return {
    capabilities: {
      positionEncoding: PositionEncodingKind.UTF16,
      completionProvider: { triggerCharacters: [':', '/'], resolveProvider: false },
      hoverProvider: true,
      definitionProvider: true,
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        ...(filesystem ? { save: { includeText: false } } : {}),
      },
      ...(features.fixesEnabled
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
}

/** `initialize`, `initialized`, `shutdown`, `exit`, and the unsupported-method fallback. */
export function registerLifecycleHandlers(context: ServerContext): void {
  const { connection, lifecycle, features, options } = context;
  connection.onInitialize((params) => {
    if (lifecycle.initialized || lifecycle.stopped)
      throw new ResponseError(-32600, 'Language server cannot initialize in its current state.');
    features.accept(params.capabilities);
    const encodings = params.capabilities.general?.positionEncodings;
    if (encodings?.length && !encodings.includes(PositionEncodingKind.UTF16))
      throw new Error('UTF-16 positions are required.');
    lifecycle.initialize();
    return initializeResult(features, !!options.filesystem);
  });
  connection.onInitialized(() => {
    if (!lifecycle.initialized || lifecycle.stopped) return;
    lifecycle.clientReady();
    watchFiles(context);
  });
  connection.onShutdown(() => lifecycle.shutdown());
  connection.onRequest(() =>
    lifecycle.admitted(() => {
      throw new ResponseError(-32601, 'Language server method is not supported.');
    }),
  );
  connection.onExit(() => lifecycle.exit((code) => options.exit?.(code)));
}
