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
} from 'vscode-languageserver/node';
import type { PublishDiagnosticsParams } from 'vscode-languageserver/node';
import type { LspConfig } from '../../src/lsp/config.js';

export async function startLspClient(t: TestContext, config: LspConfig) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-lsp-'));
  const configPath = path.join(directory, 'host.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../src/lsp/stdio.js', import.meta.url)), '--config', configPath],
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
  const client = createProtocolConnection(child.stdout, child.stdin);
  const diagnostics: PublishDiagnosticsParams[] = [];
  const waiters = new Set<() => void>();
  client.onNotification(PublishDiagnosticsNotification.type, (params) => {
    diagnostics.push(params);
    for (const check of [...waiters]) check();
  });
  client.listen();
  let stopped = false;
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    await client.sendRequest(ShutdownRequest.type);
    await client.sendNotification(ExitNotification.type);
    assert.equal(await exited, 0, stderr);
    assert.equal(stderr, '');
  }
  t.after(async () => {
    try {
      if (!stopped && child.exitCode === null) await shutdown();
    } finally {
      client.dispose();
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });
  const initialized = await client.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: 'file:///workspace',
    capabilities: { general: { positionEncodings: ['utf-16'] } },
    initializationOptions: {
      catalog: { baseUrl: 'http://untrusted.invalid' },
      policy: { rules: [] },
    },
  });
  await client.sendNotification(InitializedNotification.type, {});
  return {
    client,
    diagnostics,
    initialized,
    shutdown,
    async disconnect(kind: 'eof' | 'exit') {
      stopped = true;
      if (kind === 'eof') child.stdin.end();
      else await client.sendNotification(ExitNotification.type);
      const code = await exited;
      assert.equal(stderr, '');
      return code;
    },
    waitFor(
      predicate: (params: PublishDiagnosticsParams) => boolean,
      after = 0,
    ): Promise<PublishDiagnosticsParams> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error('Timed out waiting for LSP diagnostics. ' + stderr));
        }, 10_000);
        const check = () => {
          const found = diagnostics.slice(after).find(predicate);
          if (found) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(found);
          }
        };
        waiters.add(check);
        check();
      });
    },
  };
}
