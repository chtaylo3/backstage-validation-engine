import {
  CodeActionRequest,
  CompletionRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  DidCloseTextDocumentNotification,
  DidDeleteFilesNotification,
  DidOpenTextDocumentNotification,
  DidRenameFilesNotification,
  DidSaveTextDocumentNotification,
  ExecuteCommandRequest,
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
} from 'vscode-languageserver/node';
import type { Connection } from 'vscode-languageserver/node';
import type { FilesystemSource } from '../../src/lsp/filesystem.js';
import { parseLspConfig } from '../../src/lsp/config.js';
import { policyRun } from './policy-fixture.js';

/** The method the language server would dispatch to a handler registered through each member. */
const REGISTRARS: Readonly<Record<string, { method: string; kind: 'request' | 'notification' }>> = {
  onInitialize: { method: InitializeRequest.method, kind: 'request' },
  onInitialized: { method: InitializedNotification.method, kind: 'notification' },
  onShutdown: { method: ShutdownRequest.method, kind: 'request' },
  onExit: { method: ExitNotification.method, kind: 'notification' },
  onCompletion: { method: CompletionRequest.method, kind: 'request' },
  onHover: { method: HoverRequest.method, kind: 'request' },
  onDefinition: { method: DefinitionRequest.method, kind: 'request' },
  onCodeAction: { method: CodeActionRequest.method, kind: 'request' },
  onExecuteCommand: { method: ExecuteCommandRequest.method, kind: 'request' },
  onDidOpenTextDocument: { method: DidOpenTextDocumentNotification.method, kind: 'notification' },
  onDidChangeTextDocument: {
    method: DidChangeTextDocumentNotification.method,
    kind: 'notification',
  },
  onDidCloseTextDocument: {
    method: DidCloseTextDocumentNotification.method,
    kind: 'notification',
  },
  onDidSaveTextDocument: { method: DidSaveTextDocumentNotification.method, kind: 'notification' },
  onDidChangeWatchedFiles: {
    method: DidChangeWatchedFilesNotification.method,
    kind: 'notification',
  },
  'workspace.onDidDeleteFiles': { method: DidDeleteFilesNotification.method, kind: 'notification' },
  'workspace.onDidRenameFiles': { method: DidRenameFilesNotification.method, kind: 'notification' },
};
/** The method name recorded for the catch-all request handler. */
export const STAR = '*';

export type FakeHandler = (...args: unknown[]) => unknown;
export interface FakeRegistration {
  readonly registrar: string;
  readonly method: string;
  readonly kind: 'request' | 'notification';
  readonly handler: FakeHandler;
}
export interface FakeOutbound {
  readonly channel: string;
  readonly method: string;
  readonly params?: unknown;
}

/**
 * A connection that records every handler registration and every outbound message. Reading any
 * connection member that this fake does not model throws, so a new registration path cannot be
 * missed by the inventory.
 */
export function fakeConnection(
  options: {
    /** Answers `connection.sendRequest`; the default resolves `{ applied: false }`. */
    readonly sendRequest?: (method: string, params: unknown) => Promise<unknown>;
    /** Answers `connection.client.register`; the default resolves a disposable. */
    readonly register?: (params: unknown) => Promise<unknown>;
  } = {},
) {
  const registrations: FakeRegistration[] = [];
  const outbound: FakeOutbound[] = [];
  const record =
    (registrar: string) =>
    (handler: FakeHandler): { dispose(): void } => {
      const target = REGISTRARS[registrar]!;
      registrations.push({ registrar, ...target, handler });
      return { dispose() {} };
    };
  const named =
    (registrar: string, kind: 'request' | 'notification') =>
    (method: unknown, handler?: FakeHandler): { dispose(): void } => {
      if (typeof method === 'function')
        registrations.push({ registrar, method: STAR, kind, handler: method as FakeHandler });
      else if (typeof method === 'string' && handler)
        registrations.push({ registrar, method, kind, handler });
      else throw new Error(`Unmodelled ${registrar} registration.`);
      return { dispose() {} };
    };
  const methodOf = (type: unknown) =>
    typeof type === 'string' ? type : String((type as { method?: unknown }).method);
  const strict = <T extends object>(name: string, members: T): T =>
    new Proxy(members, {
      get(target, property, receiver) {
        if (typeof property === 'symbol' || property in target)
          return Reflect.get(target, property, receiver) as unknown;
        throw new Error(`The fake connection does not model ${name}${String(property)}.`);
      },
    });
  const members: Record<string, unknown> = {
    onRequest: named('onRequest', 'request'),
    onNotification: named('onNotification', 'notification'),
    sendDiagnostics: (params: unknown) => {
      outbound.push({ channel: 'notification', method: 'textDocument/publishDiagnostics', params });
      return Promise.resolve();
    },
    sendNotification: (type: unknown, params?: unknown) => {
      outbound.push({ channel: 'notification', method: methodOf(type), params });
      return Promise.resolve();
    },
    sendRequest: (type: unknown, params?: unknown) => {
      outbound.push({ channel: 'request', method: methodOf(type), params });
      return options.sendRequest
        ? options.sendRequest(methodOf(type), params)
        : Promise.resolve({ applied: false });
    },
    client: strict('client.', {
      register: (type: unknown, params?: unknown) => {
        outbound.push({ channel: 'register', method: methodOf(type), params });
        return options.register ? options.register(params) : Promise.resolve({ dispose() {} });
      },
    }),
    console: strict('console.', {
      warn: (message: string) => {
        outbound.push({ channel: 'console', method: 'warn', params: message });
      },
    }),
    workspace: strict('workspace.', {
      onDidDeleteFiles: record('workspace.onDidDeleteFiles'),
      onDidRenameFiles: record('workspace.onDidRenameFiles'),
    }),
  };
  for (const registrar of Object.keys(REGISTRARS))
    if (!registrar.includes('.')) members[registrar] = record(registrar);
  const connection = strict('connection.', members) as unknown as Connection;
  /** The one handler for `method`; it fails when there is none or more than one. */
  const handler = (method: string): FakeHandler => {
    const rows = registrations.filter((row) => row.method === method);
    if (rows.length !== 1) throw new Error(`${rows.length} handlers for ${method}.`);
    return rows[0]!.handler;
  };
  return { connection, registrations, outbound, handler };
}

/** One canonical pending token that is never cancelled. */
export const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
};

export const FAKE_ROOT = 'file:///workspace/';
export const FAKE_URI = 'file:///workspace/catalog-info.yaml';

/**
 * A host configuration with no rules, with or without the trusted filesystem reader. A list of
 * files approves those files; `true` approves only the source file.
 */
export function fakeConfig(
  options: {
    filesystem?: boolean | readonly string[];
    debounceMs?: number;
    coverageObservation?: boolean;
  } = {},
) {
  const run = policyRun({ rules: [], rootUri: FAKE_ROOT });
  return parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    debounceMs: options.debounceMs ?? 250,
    coverageObservation: options.coverageObservation ?? true,
    ...(options.filesystem
      ? { filesystem: { files: options.filesystem === true ? [FAKE_URI] : options.filesystem } }
      : {}),
  });
}
/** A trusted filesystem reader that returns the base snapshot unchanged. */
export function fakeFilesystem(files: readonly string[] = [FAKE_URI]): FilesystemSource {
  return {
    files,
    capture: (base) => Promise.resolve(base),
    close: () => Promise.resolve(),
  };
}
