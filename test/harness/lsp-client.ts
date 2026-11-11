import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import {
  createProtocolConnection,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  ExitNotification,
  RegistrationRequest,
  ApplyWorkspaceEditRequest,
  LogMessageNotification,
  ResponseError,
  ErrorCodes,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver/node';
import type {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResult,
  PublishDiagnosticsParams,
  ClientCapabilities,
  InitializeParams,
  LogMessageParams,
  Message,
} from 'vscode-languageserver/node';
import type { LspConfig } from '../../src/lsp/config.js';

interface ClientOptions {
  watchFiles?: boolean;
  fixes?: boolean;
  capabilities?: ClientCapabilities;
  initializeParams?: Partial<InitializeParams>;
  registration?: (params: unknown) => boolean;
  applyEdit?: (
    params: ApplyWorkspaceEditParams,
  ) => ApplyWorkspaceEditResult | Promise<ApplyWorkspaceEditResult>;
}

/** A real child connection without automatic initialize, for protocol lifecycle controls. */
export async function createLspClient(
  t: TestContext,
  config: LspConfig,
  options: ClientOptions = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-lsp-'));
  const configPath = path.join(directory, 'host.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      process.env.BVE_TEST_LSP_ENTRY ??
        fileURLToPath(new URL('../../src/lsp/stdio.js', import.meta.url)),
      '--config',
      configPath,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BVE_TEST_TOKEN: 'policy-test-secret' },
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  async function bounded<T>(work: Promise<T>, milliseconds = 10_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out waiting for LSP child cleanup.')),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let cancelNext: string | undefined;
  const cancellationFrames: { method: string; id: string | number | null }[] = [];
  class WireWriter extends StreamMessageWriter {
    override write(message: Message): Promise<void> {
      if (
        'method' in message &&
        'id' in message &&
        typeof message.method === 'string' &&
        (typeof message.id === 'string' || typeof message.id === 'number') &&
        message.method === cancelNext
      ) {
        cancelNext = undefined;
        const cancellation = {
          jsonrpc: '2.0',
          method: '$/cancelRequest',
          params: { id: message.id },
        };
        const frames = [message, cancellation].map((value) => {
          const body = Buffer.from(JSON.stringify(value));
          return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
        });
        cancellationFrames.push({ method: message.method, id: message.id });
        // One real write makes cancellation precede child handler dispatch, without a client SDK shortcut.
        return new Promise((resolve, reject) =>
          child.stdin.write(Buffer.concat(frames), (error) => (error ? reject(error) : resolve())),
        );
      }
      return super.write(message);
    }
  }
  const client = createProtocolConnection(
    new StreamMessageReader(child.stdout),
    new WireWriter(child.stdin),
  );
  const diagnostics: PublishDiagnosticsParams[] = [];
  const waiters = new Set<() => void>();
  client.onNotification(PublishDiagnosticsNotification.type, (params) => {
    diagnostics.push(params);
    for (const check of [...waiters]) check();
  });
  const registrations: unknown[] = [];
  client.onRequest(RegistrationRequest.type, (params) => {
    registrations.push(params);
    for (const check of [...waiters]) check();
    if (options.registration?.(params) === false)
      throw new ResponseError(ErrorCodes.InvalidRequest, 'Client rejected watcher registration.');
  });
  const logs: LogMessageParams[] = [];
  client.onNotification(LogMessageNotification.type, (params) => {
    logs.push(params);
    for (const check of [...waiters]) check();
  });
  const applyRequests: ApplyWorkspaceEditParams[] = [];
  client.onRequest(ApplyWorkspaceEditRequest.type, (params) => {
    applyRequests.push(params);
    return options.applyEdit?.(params) ?? { applied: false };
  });
  client.listen();
  let stopped = false;
  let admitted = false;
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    await bounded(client.sendRequest(ShutdownRequest.type));
    await client.sendNotification(ExitNotification.type);
    assert.equal(await bounded(exited), 0, stderr);
    assert.equal(stderr, '');
  }
  t.after(async () => {
    try {
      if (!stopped && child.exitCode === null && admitted) await shutdown();
    } finally {
      client.dispose();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await bounded(exited, 5000);
      await rm(directory, { recursive: true, force: true });
    }
  });
  const defaults: InitializeParams = {
    processId: null,
    rootUri: 'file:///workspace',
    capabilities: options.capabilities ?? {
      general: { positionEncodings: ['utf-16'] },
      workspace: {
        ...(options.fixes
          ? {
              applyEdit: true,
              workspaceEdit: { documentChanges: true, failureHandling: 'textOnlyTransactional' },
            }
          : {}),
        ...(options.watchFiles
          ? {
              didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
            }
          : {}),
      },
      ...(options.fixes
        ? {
            textDocument: {
              publishDiagnostics: { dataSupport: true },
              codeAction: {
                codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } },
              },
            },
          }
        : {}),
    },
    initializationOptions: {
      catalog: { baseUrl: 'http://untrusted.invalid' },
      policy: { rules: [] },
    },
  };
  function waitForState<T>(select: () => T | undefined, description: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error('Timed out waiting for LSP ' + description + '. ' + stderr));
      }, 10_000);
      const check = () => {
        const found = select();
        if (found !== undefined) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        }
      };
      waiters.add(check);
      check();
    });
  }
  return {
    configPath,
    client,
    diagnostics,
    async initialize(params: Partial<InitializeParams> = options.initializeParams ?? {}) {
      const result = await client.sendRequest(InitializeRequest.type, { ...defaults, ...params });
      admitted = true;
      await client.sendNotification(InitializedNotification.type, {});
      return result;
    },
    registrations,
    logs,
    waitForLog(predicate: (row: LogMessageParams) => boolean, after = 0) {
      return waitForState(() => logs.slice(after).find(predicate), 'log message');
    },
    applyRequests,
    cancellationFrames,
    cancelledRequest(method: string, params: unknown): Promise<unknown> {
      assert.equal(cancelNext, undefined);
      cancelNext = method;
      return client.sendRequest(method, params);
    },
    shutdown,
    async disconnect(kind: 'eof' | 'exit') {
      stopped = true;
      if (kind === 'eof') child.stdin.end();
      else await client.sendNotification(ExitNotification.type);
      const code = await bounded(exited);
      assert.equal(stderr, '');
      return code;
    },
    waitFor(
      predicate: (params: PublishDiagnosticsParams) => boolean,
      after = 0,
    ): Promise<PublishDiagnosticsParams> {
      return waitForState(() => diagnostics.slice(after).find(predicate), 'diagnostics');
    },
  };
}

export async function startLspClient(
  t: TestContext,
  config: LspConfig,
  options: ClientOptions = {},
) {
  const host = await createLspClient(t, config, options);
  const initialized = await host.initialize();
  return { ...host, initialized };
}
