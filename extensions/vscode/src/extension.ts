import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  RevealOutputChannelOn,
} from 'vscode-languageclient/node';
import type { LanguageClientOptions } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let pending: Promise<void> = Promise.resolve();
let output: vscode.LogOutputChannel | undefined;
let disconnected = false;

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
): Promise<Pick<LanguageClientOptions, 'documentSelector' | 'uriConverters'>> {
  const text = await readFile(config, 'utf8');
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error('Trusted configuration exceeds the size limit.');
  const value: unknown = JSON.parse(text);
  if (!record(value) || !record(value.source)) throw new Error('Invalid trusted configuration.');
  const files =
    record(value.filesystem) && Array.isArray(value.filesystem.files)
      ? value.filesystem.files
      : Array.isArray(value.source.files)
        ? value.source.files.map((file: unknown) => (record(file) ? file.uri : undefined))
        : [];
  if (files.length > 1000) throw new Error('Trusted configuration exceeds the file limit.');
  const configured = new Map<string, string>();
  const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const documentSelector = files.length
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
  const selection = await selectors(config);
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
  try {
    await next.start();
    output?.info('Packaged Backstage language server is ready.');
  } catch {
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
  output = vscode.window.createOutputChannel('Backstage Validation', { log: true });
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('backstageValidation.restart', () =>
      schedule(() => start(context)),
    ),
    vscode.commands.registerCommand('backstageValidation.stop', () => schedule(stop)),
    vscode.commands.registerCommand('backstageValidation.showOutput', () => output?.show()),
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
