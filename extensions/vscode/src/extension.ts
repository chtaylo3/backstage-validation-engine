import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  RevealOutputChannelOn,
} from 'vscode-languageclient/node';
import type { DocumentSelector, LanguageClientOptions } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let pending: Promise<void> = Promise.resolve();
let output: vscode.LogOutputChannel | undefined;
let disconnected = false;
let extensionContext: vscode.ExtensionContext | undefined;
let historyKey: string | undefined;
let reloadNotification: vscode.Disposable | undefined;

async function reloadConfiguration(): Promise<void> {
  const current = client;
  if (!current?.isRunning() || !vscode.workspace.isTrusted) return;
  const result = await current.sendRequest<{ reloaded: boolean }>('bve/reloadConfiguration');
  if (result.reloaded) {
    output?.info('Trusted configuration and credentials reloaded.');
  } else output?.error('Validation is unavailable until the trusted configuration can be loaded.');
}
async function recordSelection(value: unknown): Promise<void> {
  if (typeof value !== 'string' || value.length > 512 || !client?.isRunning()) return;
  await client.sendNotification('bve/recordSelection', value);
  if (historyKey && extensionContext?.workspaceState) {
    const history = extensionContext.workspaceState
      .get<string[]>(historyKey, [])
      .filter((item) => item !== value);
    history.push(value);
    await extensionContext.workspaceState.update(historyKey, history.slice(-128));
  }
}
function searchReferences(): void {
  const current = client;
  if (!current?.isRunning() || !vscode.workspace.isTrusted) return;
  const editor = vscode.window.activeTextEditor;
  const version = editor?.document.version;
  const selection = editor?.selection;
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { reference?: string }>();
  picker.title = 'Backstage: Search Entity References';
  picker.placeholder = 'Enter kind:namespace/name, for example group:default/te';
  picker.matchOnDescription = true;
  let query = 0;
  let timer: NodeJS.Timeout | undefined;
  let cancellation: vscode.CancellationTokenSource | undefined;
  const subscriptions: vscode.Disposable[] = [];
  subscriptions.push(
    picker.onDidChangeValue((value) => {
      const generation = ++query;
      clearTimeout(timer);
      cancellation?.cancel();
      cancellation?.dispose();
      picker.items = [];
      const match = /^([a-z][a-z0-9]{0,62}):([a-z0-9_.-]{1,63})\/([a-z0-9_.-]{0,63})$/u.exec(
        value.toLowerCase(),
      );
      if (!match) {
        picker.busy = false;
        return;
      }
      picker.busy = true;
      timer = setTimeout(() => {
        const token = new vscode.CancellationTokenSource();
        cancellation = token;
        void current
          .sendRequest<readonly { reference: string; source: string }[]>(
            'bve/searchReferences',
            { kind: match[1], namespace: match[2], prefix: match[3] },
            token.token,
          )
          .then(
            (rows) => {
              if (query === generation && !token.token.isCancellationRequested)
                picker.items = rows.map((row) => ({
                  label: row.reference,
                  description: row.source,
                  reference: row.reference,
                }));
            },
            () => {
              if (query === generation) picker.items = [];
            },
          )
          .finally(() => {
            if (query === generation) picker.busy = false;
          });
      }, 120);
    }),
  );
  subscriptions.push(
    picker.onDidAccept(() => {
      const reference = picker.selectedItems[0]?.reference;
      if (!reference) return;
      picker.hide();
      void (async () => {
        if (
          editor &&
          selection &&
          editor.document.version === version &&
          !editor.document.isClosed &&
          vscode.window.activeTextEditor === editor &&
          client === current
        ) {
          if (await editor.edit((edit) => edit.replace(selection, reference)))
            await recordSelection(reference);
        } else if (!editor) {
          await vscode.env.clipboard.writeText(reference);
          await recordSelection(reference);
        } else
          await vscode.window.showInformationMessage(
            'The document changed during search. Run Search Entity References again.',
          );
      })().catch(() => output?.error('Unable to insert the selected reference.'));
    }),
  );
  subscriptions.push(
    picker.onDidHide(() => {
      query++;
      clearTimeout(timer);
      cancellation?.cancel();
      cancellation?.dispose();
      for (const subscription of subscriptions) subscription.dispose();
      picker.dispose();
    }),
  );
  picker.show();
}

function selectedConfig(): string | undefined {
  const settings = vscode.workspace.getConfiguration('backstageValidation');
  const selected =
    settings.inspect<string>('configPath')?.globalValue || process.env.BVE_LSP_CONFIG;
  if (!selected) return undefined;
  if (!path.isAbsolute(selected))
    throw new Error('Select an absolute trusted configuration path in User Settings.');
  return selected;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
async function selectors(
  config: string,
  configured = new Map<string, string>(),
): Promise<Pick<LanguageClientOptions, 'documentSelector' | 'uriConverters'>> {
  const text = await readFile(config, 'utf8');
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error('Trusted configuration exceeds the size limit.');
  const value: unknown = JSON.parse(text);
  if (!record(value) || !record(value.source)) throw new Error('Invalid trusted configuration.');
  historyKey =
    'backstageValidation.history:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          config,
          value.identity,
          value.activation,
          record(value.catalog)
            ? [value.catalog.principalId, value.catalog.credentialRevision, value.catalog.scope]
            : undefined,
        ]),
      )
      .digest('hex');
  const files =
    record(value.filesystem) && Array.isArray(value.filesystem.files)
      ? value.filesystem.files
      : Array.isArray(value.source.files)
        ? value.source.files.map((file: unknown) => (record(file) ? file.uri : undefined))
        : [];
  if (files.length > 1000) throw new Error('Trusted configuration exceeds the file limit.');
  configured.clear();
  const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const documentSelector: DocumentSelector = files.length
    ? files.map((uri: unknown) => {
        if (typeof uri !== 'string') throw new Error('Invalid configured source URI.');
        const parsed = vscode.Uri.parse(uri, true);
        if (parsed.scheme !== 'file') throw new Error('Only local file sources are supported.');
        const identity = key(parsed.fsPath);
        if (configured.has(identity) && configured.get(identity) !== uri)
          throw new Error('Ambiguous configured file spellings.');
        configured.set(identity, uri);
        const basename = path
          .basename(parsed.fsPath)
          .replace(/[?*{}[\]]/gu, (character) => `[${character}]`);
        return {
          scheme: 'file',
          pattern: {
            baseUri: vscode.Uri.file(path.dirname(parsed.fsPath)).toString(),
            pattern: basename,
          },
        };
      })
    : ['yaml', 'json', 'plaintext'].map((language) => ({ scheme: 'file', language }));
  if (
    record(value.filesystem) &&
    record(value.filesystem.discovery) &&
    Array.isArray(value.filesystem.discovery.roots)
  ) {
    for (const root of value.filesystem.discovery.roots) {
      if (typeof root !== 'string' || vscode.Uri.parse(root, true).scheme !== 'file')
        throw new Error('Invalid discovery root.');
      documentSelector.push({ scheme: 'file', pattern: { baseUri: root, pattern: '**/*' } });
    }
  }
  if (record(value.filesystem) && typeof value.source.rootUri === 'string') {
    if (vscode.Uri.parse(value.source.rootUri, true).scheme !== 'file')
      throw new Error('Invalid source root.');
    documentSelector.push({
      scheme: 'file',
      pattern: { baseUri: value.source.rootUri, pattern: '**/*' },
    });
  }
  return {
    documentSelector,
    uriConverters: {
      code2Protocol: (uri) =>
        uri.scheme === 'file'
          ? (configured.get(key(uri.fsPath)) ?? pathToFileURL(uri.fsPath).href)
          : uri.toString(),
      protocol2Code: (uri) => vscode.Uri.parse(uri, true),
    },
  };
}
async function stop(): Promise<void> {
  reloadNotification?.dispose();
  reloadNotification = undefined;
  const previous = client;
  if (previous) await previous.stop();
  if (client === previous) client = undefined;
}
async function start(context: vscode.ExtensionContext): Promise<void> {
  await stop();
  disconnected = false;
  if (!vscode.workspace.isTrusted) return;
  const config = selectedConfig();
  if (!config) {
    output?.info('Set Backstage Validation: Config Path in User Settings to start validation.');
    return;
  }
  const configured = new Map<string, string>();
  const selection = await selectors(config, configured);
  const runtime = context.asAbsolutePath(
    path.join('runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  const server = context.asAbsolutePath(path.join('server', 'dist', 'lsp', 'stdio.js'));
  const next = new LanguageClient(
    'backstageValidation',
    'Backstage Validation',
    {
      command: runtime,
      args: [server, '--config', config],
      options: {
        cwd: path.dirname(config),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        shell: false,
      },
    },
    {
      ...selection,
      middleware: {
        provideCompletionItem: async (document, position, context, token, next) => {
          const result = await next(document, position, context, token);
          const items = Array.isArray(result) ? result : result?.items;
          for (const item of items ?? [])
            if (!item.command)
              item.command = {
                title: 'Record Backstage selection',
                command: 'backstageValidation.recordSelection',
                arguments: [typeof item.label === 'string' ? item.label : item.label.label],
              };
          return result;
        },
      },
      outputChannel: output!,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      initializationFailedHandler: () => false,
      errorHandler: {
        error: () => {
          disconnected = true;
          output?.error(
            'Validation stopped after a transport error. Use Restart Language Server to recover.',
          );
          return { action: ErrorAction.Shutdown, handled: true };
        },
        closed: () => {
          disconnected = true;
          output?.error(
            'Validation stopped after the server disconnected. Use Restart Language Server to recover.',
          );
          return { action: CloseAction.DoNotRestart, handled: true };
        },
      },
    },
  );
  client = next;
  reloadNotification = next.onNotification('bve/configurationReloaded', () => {
    if (client !== next || !next.isRunning()) return;
    void (async () => {
      const selection = await selectors(config, configured);
      if (client !== next) return;
      for (const document of vscode.workspace.textDocuments ?? []) {
        if (document.uri.scheme !== 'file') continue;
        const uri = selection.uriConverters!.code2Protocol(document.uri);
        const key =
          process.platform === 'win32' ? document.uri.fsPath.toLowerCase() : document.uri.fsPath;
        const rooted = selection.documentSelector?.some((filter) => {
          if (
            !record(filter) ||
            !('pattern' in filter) ||
            !record(filter.pattern) ||
            filter.pattern.pattern !== '**/*' ||
            typeof filter.pattern.baseUri !== 'string'
          )
            return false;
          const relative = path.relative(
            vscode.Uri.parse(filter.pattern.baseUri, true).fsPath,
            document.uri.fsPath,
          );
          return (
            relative === '' ||
            (!path.isAbsolute(relative) &&
              relative !== '..' &&
              !relative.startsWith('..' + path.sep))
          );
        });
        if (configured.has(key) || rooted)
          await next.sendNotification('textDocument/didOpen', {
            textDocument: {
              uri,
              languageId: document.languageId,
              version: document.version,
              text: document.getText(),
            },
          });
      }
      for (const value of context.workspaceState?.get<string[]>(historyKey!, []) ?? [])
        await next.sendNotification('bve/recordSelection', value);
    })().catch(() => output?.error('Unable to refresh the editor selection history.'));
  });
  try {
    await next.start();
    for (const value of context.workspaceState?.get<string[]>(historyKey!, []) ?? [])
      await next.sendNotification('bve/recordSelection', value);
    output?.info('Packaged Backstage language server is ready.');
  } catch {
    reloadNotification?.dispose();
    reloadNotification = undefined;
    await next.stop().then(
      () => {
        if (client === next) client = undefined;
      },
      () => {
        // Retain ownership when cleanup fails so Stop/Restart can retry it.
        // The SDK can reject stop in startFailed after it has already taken
        // responsibility for reaping and cleared its process handle.
        if (client === next && !next.serverProcess) client = undefined;
      },
    );
    throw new Error(
      'Unable to start Backstage validation. Check the trusted configuration and output channel.',
    );
  }
}
function schedule(operation: () => Promise<void>): Promise<void> {
  const work = pending.then(operation);
  pending = work.catch(() => {});
  return work;
}
export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Backstage Validation', { log: true });
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('backstageValidation.restart', () =>
      schedule(() => start(context)),
    ),
    vscode.commands.registerCommand('backstageValidation.stop', () => schedule(stop)),
    vscode.commands.registerCommand('backstageValidation.showOutput', () => output?.show()),
    vscode.commands.registerCommand('backstageValidation.reloadConfiguration', () =>
      schedule(reloadConfiguration),
    ),
    vscode.commands.registerCommand('backstageValidation.searchReferences', searchReferences),
    vscode.commands.registerCommand('backstageValidation.recordSelection', recordSelection),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('backstageValidation.configPath'))
        void schedule(() => start(context)).catch(() => {
          output?.error('Unable to restart validation; check trusted User Settings.');
        });
    }),
  );
  try {
    await schedule(() => start(context));
  } catch {
    output.error(
      'Unable to start validation; check trusted User Settings and launcher configuration.',
    );
  }
  return {
    coverage: async (uri: string, version: number, digest: string): Promise<unknown> => {
      if (!vscode.workspace.isTrusted || !client?.isRunning()) return null;
      return client.sendRequest('bve/validationCoverage', { uri, version, digest });
    },
    status: () => ({
      running: !disconnected && client?.isRunning() === true,
      pid: client?.serverProcess?.pid,
      disconnected,
    }),
  };
}
export async function deactivate(): Promise<void> {
  await schedule(stop);
}
