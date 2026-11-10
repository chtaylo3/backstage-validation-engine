#!/usr/bin/env node
import { TrustedFileWatches } from './config-watches.js';
import { createConnection } from 'vscode-languageserver';
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver/node';
import { closeSharedCelRuntime, getSharedCelRuntime } from '../runtime/cel/index.js';
import { createLspCatalog } from './config.js';
import { readTrustedLspConfig } from './trusted-config.js';
import { BoundedLspInput } from './framing.js';
import { createFilesystemSource } from './filesystem.js';
import { attachLspServer } from './server.js';
import type { LspServerResources } from './server.js';
import { loadBackstageAdapter } from '../compatibility/adapter.js';

let startupCleanup: (() => Promise<void>) | undefined;
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config')
    throw new Error('Expected --config <trusted-config.json>.');
  const configPath = process.argv[3]!;
  const config = await readTrustedLspConfig(configPath);
  // Load the pinned native dependency during server initialization. This is
  // static runtime preparation, not workspace validation; cold editor readiness
  // still includes it, and every request keeps its original five-second budget.
  // Preserve typed dependency warnings if a native adapter is unavailable.
  if (!config.profile.requiredProcessors.length)
    await loadBackstageAdapter(config.profile.adapterId).catch(() => undefined);
  const resources = async (current = config): Promise<LspServerResources> => {
    const filesystem = current.filesystem ? await createFilesystemSource(current) : undefined;
    let catalog: Awaited<ReturnType<typeof createLspCatalog>>;
    try {
      catalog = await createLspCatalog(current, process.env);
    } catch (error) {
      await filesystem?.close();
      throw error;
    }
    return {
      config: current,
      ...(catalog ? { catalog } : {}),
      ...(filesystem ? { filesystem } : {}),
      dispose: async () => {
        try {
          await catalog?.provider.close();
        } finally {
          await filesystem?.close();
        }
      },
    };
  };
  const initial = await resources();
  startupCleanup = initial.dispose;
  if (
    !config.profile.requiredProcessors.length &&
    config.policy.rules.some((rule) => rule.kind === 'cel' || rule.selector)
  )
    await getSharedCelRuntime()
      .warm()
      .catch(() => undefined);
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
  let watches: TrustedFileWatches | undefined = undefined;
  const server = attachLspServer(connection, config, {
    ...initial,
    reload: async () => resources(await readTrustedLspConfig(configPath)),
    configurationChanged: (current) => watches?.credential(current.catalog?.tokenFile),
    onClose: () => watches?.close(),
  });
  startupCleanup = server.close;
  watches = new TrustedFileWatches(configPath, () => {
    void server.reload().catch(() => undefined);
  });
  server.own(watches.credential(config.catalog?.tokenFile));
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    void server.close().then(
      async () => {
        await closeSharedCelRuntime();
        connection.dispose();
        process.exit(code);
      },
      async () => {
        await closeSharedCelRuntime().catch(() => undefined);
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
  if (startupCleanup) await startupCleanup().catch(() => undefined);
  await closeSharedCelRuntime().catch(() => undefined);
  process.stderr.write('Unable to start language server; check trusted launcher configuration.\n');
  process.exitCode = 1;
}
