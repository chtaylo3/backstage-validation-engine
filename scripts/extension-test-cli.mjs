import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { killTree } from './extension-test-process.mjs';

/** Resolve the actual CLI script, including versioned Windows resources. */
export async function resolveVSCodeCli(executable, platform = process.platform) {
  assert(!/\.(cmd|bat)$/iu.test(executable), 'Use the native editor executable.');
  const root = path.dirname(executable);
  const roots =
    platform === 'darwin'
      ? [path.resolve(root, '../Resources/app')]
      : [
          path.join(root, 'resources/app'),
          ...(platform === 'win32'
            ? (await readdir(root))
                .filter((name) => /^[a-f0-9]{10}$/u.test(name))
                .map((name) => path.join(root, name, 'resources/app'))
            : []),
        ];
  const found = [];
  for (const directory of roots) {
    const text = await readFile(path.join(directory, 'product.json'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!text) continue;
    const product = JSON.parse(text);
    assert(/^[a-f0-9]{40}$/u.test(product.commit), 'The editor must declare its full commit.');
    if (platform === 'win32' && directory !== roots[0])
      assert.equal(path.basename(path.resolve(directory, '../..')), product.commit.slice(0, 10));
    const cli = path.join(directory, 'out/cli.js');
    assert((await stat(cli)).isFile(), 'The editor CLI script must be a file.');
    found.push({ cli, product });
  }
  assert.equal(found.length, 1, 'One unambiguous native editor CLI and product manifest.');
  return found[0];
}

export class VSCodeCliError extends Error {
  constructor(reason, child, stdout, stderr, cause) {
    super(`VS Code CLI failed (${reason}); exit code ${child.exitCode ?? 'none'}.`, { cause });
    this.name = 'VSCodeCliError';
    this.reason = reason;
    this.exitCode = child.exitCode;
    this.signal = child.signalCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Run Electron's Node CLI with literal arguments and an owned process tree. */
export function runCli(executable, script, args, options = {}) {
  assert(!/\.(cmd|bat)$/iu.test(executable), 'Use a native executable without a shell.');
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0);
  const env = {
    ...process.env,
    ...options.env,
    ELECTRON_RUN_AS_NODE: '1',
    VSCODE_IPC_HOOK_CLI: '',
  };
  delete env.VSCODE_DEV;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script, ...args], {
      env,
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise((done) => {
      child.once('exit', done);
      child.once('error', done);
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
      settled = false,
      stopping;
    const finish = (reason, cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (reason) reject(new VSCodeCliError(reason, child, stdout, stderr, cause));
      else resolve({ stdout, stderr });
    };
    const stop = (reason) => {
      stopping ??= killTree(child.pid)
        .then(
          () =>
            new Promise((done, failed) => {
              const cleanupTimer = setTimeout(
                () => failed(new Error('The CLI did not exit after termination.')),
                5000,
              );
              void exited.then(() => {
                clearTimeout(cleanupTimer);
                done();
              });
            }),
        )
        .then(
          () => finish(reason),
          (error) => finish('cleanup', error),
        );
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = (side, chunk) => {
      if (settled || stopping) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) return stop('output_limit');
      if (side === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => collect('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => collect('stderr', chunk));
    child.once('error', (error) => finish('spawn', error));
    child.once('close', (code) => {
      if (!stopping) finish(code === 0 ? undefined : 'exit');
    });
  });
}

/** Keep the pinned SDK downloader; use the native CLI instead of code.cmd. */
export async function runVSCodeCommand(args, { version, env, timeoutMs } = {}) {
  const executable = await downloadAndUnzipVSCode({ version });
  const { cli } = await resolveVSCodeCli(executable);
  return runCli(executable, cli, args, { env, timeoutMs });
}
