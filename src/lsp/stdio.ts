#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { createConnection } from 'vscode-languageserver';
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver/node';
import { closeSharedCelRuntime } from '../runtime/cel/index.js';
import { createLspCatalog, parseLspConfig } from './config.js';
import { BoundedLspInput } from './framing.js';
import { createFilesystemSource } from './filesystem.js';
import { attachLspServer } from './server.js';
import { loadBackstageAdapter } from '../compatibility/adapter.js';

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config')
    throw new Error('Expected --config <trusted-config.json>.');
  const handle = await open(process.argv[3]!, 'r');
  let text: string;
  try {
    if ((await handle.stat()).size > 32 * 1024 * 1024)
      throw new Error('LSP configuration exceeds limits.');
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const config = parseLspConfig(JSON.parse(text) as unknown);
  // Load the pinned native dependency during server initialization. This is
  // static runtime preparation, not workspace validation; cold editor readiness
  // still includes it, and every request keeps its original five-second budget.
  // Preserve typed dependency warnings if a native adapter is unavailable.
  if (!config.profile.requiredProcessors.length)
    await loadBackstageAdapter(config.profile.adapterId).catch(() => undefined);
  const filesystem = config.filesystem ? await createFilesystemSource(config) : undefined;
  const catalog = await createLspCatalog(config, process.env);
  const input = new BoundedLspInput();
  // The SDK's default Node watchdog exits synchronously on EOF/exit. Own that
  // lifecycle through its public factory so provider/worker cleanup can finish.
  const watchdog = {
    initialize: () => {},
    shutdownReceived: false,
    exit: (code: number) => stop(code),
  };
  const connection = createConnection(
    (logger) =>
      createProtocolConnection(
        new StreamMessageReader(input),
        new StreamMessageWriter(process.stdout),
        logger,
      ),
    watchdog,
  );
  const server = attachLspServer(connection, config, {
    ...(catalog ? { catalog } : {}),
    ...(filesystem ? { filesystem } : {}),
    dispose: async () => {
      try {
        await catalog?.provider.close();
      } finally {
        try {
          await filesystem?.close();
        } finally {
          await closeSharedCelRuntime();
        }
      }
    },
  });
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    void server.close().then(
      () => {
        connection.dispose();
        process.exit(code);
      },
      () => {
        connection.dispose();
        process.exit(1);
      },
    );
  };
  input.on('error', () => stop(1));
  process.stdin.on('error', () => stop(1));
  process.once('SIGINT', () => stop(1));
  process.once('SIGTERM', () => stop(1));
  connection.listen();
  process.stdin.pipe(input);
  process.stdin.once('end', () => {
    stop(watchdog.shutdownReceived ? 0 : 1);
  });
} catch {
  process.stderr.write('Unable to start language server; check trusted launcher configuration.\n');
  process.exitCode = 1;
}
