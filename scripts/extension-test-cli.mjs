import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
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

/**
 * The arguments that give a `vscode://` link to the running editor of a test, the way an operating
 * system does when a browser follows the link. The editor that owns `userDataDir` receives it.
 */
export function openUrlArgs(
  url,
  { userDataDir, extensionsDir, noSandbox = true, verbose = false, separator = false } = {},
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Give the editor an absolute vscode: link.');
  }
  assert.equal(parsed.protocol, 'vscode:', 'Give the editor a vscode: link.');
  assert.match(
    parsed.host,
    /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu,
    'Address the link to one extension identifier.',
  );
  assert(!parsed.username && !parsed.password, 'A link carries no credentials.');
  assert(
    typeof userDataDir === 'string' && path.isAbsolute(userDataDir),
    'Name the absolute user data directory of the running editor.',
  );
  assert(
    extensionsDir === undefined || path.isAbsolute(extensionsDir),
    'Name an absolute extensions directory.',
  );
  return [
    // The CLI starts a second editor process that hands the link to the running one. A downloaded
    // editor's Chromium sandbox needs unprivileged user namespaces, which Ubuntu 24.04 restricts;
    // every other editor process of this harness also runs with --no-sandbox.
    ...(noSandbox ? ['--no-sandbox'] : []),
    // With --verbose, the CLI waits for that process and passes on its output.
    ...(verbose ? ['--verbose'] : []),
    '--user-data-dir',
    userDataDir,
    ...(extensionsDir ? ['--extensions-dir', extensionsDir] : []),
    '--open-url',
    ...(separator ? ['--'] : []),
    url,
  ];
}

/** Parameters whose values are credentials or correlate a sign-in, and never reach evidence. */
const SECRET_PARAMETERS = 'code|state|token|access_token|refresh_token|id_token|code_verifier';
// A parameter starts at the start of a line, or after `?`, `&`, `#`, whitespace, a quote, or `,;({`,
// with `?`, `&`, and `#` also in HTML-escaped, JSON-escaped, percent-encoded, or doubly
// percent-encoded form. Its name ends with `=` in one of those forms.
const PARAMETER_START = String.raw`(?:^|[?&#\s"',;({]|&amp;|\\u0026|\\u003[fF]|%(?:25)?(?:3[fF]|26|23))`;
const PARAMETER_EQUALS = String.raw`(?:=|\\u003[dD]|%(?:25)?3[dD])`;
// The value ends at the next separator in any of those forms, or at whitespace, a quote, or `\`.
const VALUE_END = String.raw`(?:&|%(?:25)?26|\\u0026|["'\s\\<>])`;
const SECRET_VALUE = new RegExp(
  `(${PARAMETER_START}(?:${SECRET_PARAMETERS})${PARAMETER_EQUALS})(?:(?!${VALUE_END}).)+`,
  'gimu',
);

/** Replace the values of credentials and correlation parameters in text that may echo a link. */
export function redactLinkValues(text) {
  return String(text ?? '').replace(SECRET_VALUE, '$1<redacted>');
}

/**
 * Give a `vscode://` link to the running test editor with `--open-url`, through its native CLI.
 * Resolves, or rejects with `details`, with the CLI's exit code, redacted output, and duration.
 */
export async function openUrl(executable, url, options = {}) {
  const args = openUrlArgs(url, options);
  const { cli } = await resolveVSCodeCli(executable);
  const started = Date.now();
  const details = (result) => ({
    args: args.map(redactLinkValues),
    exitCode: result.exitCode ?? 0,
    durationMs: Date.now() - started,
    stdout: redactLinkValues(result.stdout).slice(-4000),
    stderr: redactLinkValues(result.stderr).slice(-4000),
  });
  try {
    return details(
      await runCli(executable, cli, args, {
        env: options.env,
        timeoutMs: options.timeoutMs ?? 60_000,
      }),
    );
  } catch (error) {
    const failure = new Error(redactLinkValues(error.message));
    failure.details = { ...details(error), reason: error.reason ?? null };
    throw failure;
  }
}

/** The environment variables that tell a case where to send its link requests. */
export const LINK_ENDPOINT_VARIABLE = 'BVE_EXTENSION_TEST_LINKS';
export const LINK_TOKEN_VARIABLE = 'BVE_EXTENSION_TEST_LINKS_TOKEN';

/**
 * Answer the link requests of the cases in one editor session, over HTTP on the loopback address.
 * A case sends `POST <endpoint>` with `{ url, options? }` and the session's bearer token; the host
 * calls `open(url, options)` and answers `{ status, error?, cli? }`, where `cli` is the evidence
 * that `openUrl` returns. The link travels only in memory and on the loopback connection: nothing
 * writes it to disk, so a link with an authorization code cannot reach uploaded evidence.
 */
export async function serveOpenUrlRequests(open) {
  const token = randomBytes(24).toString('hex');
  const outcomes = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== 'POST' ||
        request.url !== '/open-url' ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 64 * 1024) {
          response.writeHead(413).end();
          return;
        }
      }
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      let status = 'passed';
      let error;
      let cli;
      try {
        const result = await open(String(value?.url ?? ''), value?.options ?? {});
        if (result && typeof result === 'object' && 'exitCode' in result) cli = result;
      } catch (failure) {
        status = 'failed';
        error = redactLinkValues(failure instanceof Error ? failure.message : String(failure));
        cli = failure?.details;
      }
      outcomes.push(status);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ status, ...(error ? { error } : {}), ...(cli ? { cli } : {}) }),
      );
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}/open-url`,
    token,
    /** The environment that a case needs to send link requests. */
    environment: () => ({
      [LINK_ENDPOINT_VARIABLE]: `http://127.0.0.1:${address.port}/open-url`,
      [LINK_TOKEN_VARIABLE]: token,
    }),
    outcomes: () => [...outcomes],
    stop: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/** Keep the pinned SDK downloader; use the native CLI instead of code.cmd. */
export async function runVSCodeCommand(args, { version, env, timeoutMs } = {}) {
  const executable = await downloadAndUnzipVSCode({ version });
  const { cli } = await resolveVSCodeCli(executable);
  return runCli(executable, cli, args, { env, timeoutMs });
}
