import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openUrl as caseOpenUrl } from '../../extensions/vscode/test/links.js';

interface OpenUrlOptions {
  userDataDir?: string;
  extensionsDir?: string;
  noSandbox?: boolean;
  verbose?: boolean;
  separator?: boolean;
}
interface LinkServer {
  endpoint: string;
  token: string;
  environment(): Record<string, string>;
  outcomes(): string[];
  stop(): Promise<void>;
}
const { openUrlArgs, redactLinkValues, serveOpenUrlRequests } = (await import(
  pathToFileURL(path.resolve('scripts/extension-test-cli.mjs')).href
)) as {
  openUrlArgs: (url: string, options?: OpenUrlOptions) => string[];
  redactLinkValues: (text: string) => string;
  serveOpenUrlRequests: (
    open: (url: string, options: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<LinkServer>;
};

const profile = path.resolve(tmpdir(), 'bve profile');
const SECRET_CODE = 'Zm9vYmFyLWF1dGhvcml6YXRpb24tY29kZQ';
const SECRET_STATE = 'c3RhdGUtdmFsdWUtMTIzNDU2';

void test('the open-url arguments address the running editor of the profile', () => {
  const url = 'vscode://chtaylo3.backstage-validation-engine/sign-in?code=x&state=y';
  assert.deepEqual(openUrlArgs(url, { userDataDir: profile }), [
    '--no-sandbox',
    '--user-data-dir',
    profile,
    '--open-url',
    url,
  ]);
  const extensions = path.resolve(tmpdir(), 'extensions');
  assert.deepEqual(
    openUrlArgs(url, {
      userDataDir: profile,
      extensionsDir: extensions,
      noSandbox: false,
      verbose: true,
      separator: true,
    }),
    [
      '--verbose',
      '--user-data-dir',
      profile,
      '--extensions-dir',
      extensions,
      '--open-url',
      '--',
      url,
    ],
  );
});

void test('the open-url arguments refuse links that an OS would not route to one extension', () => {
  for (const url of [
    'https://example.com/sign-in',
    'vscode-insiders://chtaylo3.backstage-validation-engine/sign-in',
    'vscode://not-an-extension-id/sign-in',
    'vscode://user:secret@chtaylo3.backstage-validation-engine/sign-in',
    'not a url',
  ])
    assert.throws(() => openUrlArgs(url, { userDataDir: profile }), url);
  assert.throws(() => openUrlArgs('vscode://a.b/c', {}), /user data directory/u);
  assert.throws(() => openUrlArgs('vscode://a.b/c', { userDataDir: 'relative' }), /absolute/u);
  assert.throws(
    () => openUrlArgs('vscode://a.b/c', { userDataDir: profile, extensionsDir: 'relative' }),
    /absolute/u,
  );
});

void test('redaction removes credential values in plain, encoded, and escaped links', () => {
  const link = `vscode://a.b/sign-in?code=${SECRET_CODE}&state=${SECRET_STATE}&probe=n1`;
  const forms = [
    link,
    encodeURIComponent(link),
    encodeURIComponent(encodeURIComponent(link)),
    JSON.stringify({ url: link }).replace(/&/gu, '\\u0026'),
    `<a href="${link.replace(/&/gu, '&amp;')}">`,
    `https://example.test/callback#access_token=${SECRET_CODE}&token_type=Bearer`,
    `{"url":"vscode://a.b/x?code=${SECRET_CODE}","options":{}}`,
    `refresh_token=${SECRET_CODE} id_token=${SECRET_STATE}`,
  ];
  for (const form of forms) {
    const redacted = redactLinkValues(form);
    assert(!redacted.includes(SECRET_CODE), redacted);
    assert(!redacted.includes(SECRET_STATE), redacted);
    assert(redacted.includes('<redacted>'), redacted);
  }
  // Parameters that only look alike, and non-secret parameters, stay unchanged.
  const harmless = 'vscode://a.b/sign-in?probe=n1&encode=keep&statement=keep&windowId=1';
  assert.equal(redactLinkValues(harmless), harmless);
  assert.equal(redactLinkValues(undefined as unknown as string), '');
});

void test('the link server opens each authorized request once and answers with its evidence', async (t) => {
  const opened: { url: string; options: Record<string, unknown> }[] = [];
  const server = await serveOpenUrlRequests((url, options) => {
    opened.push({ url, options });
    if (!url.includes('fail')) return Promise.resolve({ exitCode: 0, durationMs: 5, stdout: '' });
    const error = new Error(`editor refused ?code=${SECRET_CODE}`);
    (error as Error & { details: unknown }).details = { exitCode: 3, stderr: 'redacted upstream' };
    return Promise.reject(error);
  });
  t.after(() => server.stop());
  assert.match(server.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/open-url$/u);
  const post = (body: unknown, token = server.token) =>
    fetch(server.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ url: 'vscode://a.b/one' }, 'wrong')).status, 404);
  assert.equal((await fetch(server.endpoint)).status, 404);
  assert.deepEqual(opened, []);
  const one = await post({ url: 'vscode://a.b/one', options: { verbose: true } });
  assert.deepEqual(await one.json(), {
    status: 'passed',
    cli: { exitCode: 0, durationMs: 5, stdout: '' },
  });
  const two = await post({ url: 'vscode://a.b/fail' });
  const failed = (await two.json()) as { status: string; error: string; cli: unknown };
  assert.equal(failed.status, 'failed');
  assert(!failed.error.includes(SECRET_CODE), failed.error);
  assert.deepEqual(failed.cli, { exitCode: 3, stderr: 'redacted upstream' });
  assert.deepEqual(opened, [
    { url: 'vscode://a.b/one', options: { verbose: true } },
    { url: 'vscode://a.b/fail', options: {} },
  ]);
  assert.deepEqual(server.outcomes(), ['passed', 'failed']);
});

void test('a case link with code and state leaves neither value on disk or in the answer', async (t) => {
  const control = await mkdtemp(path.join(tmpdir(), 'bve-open-url-control-'));
  t.after(() => rm(control, { recursive: true, force: true }));
  const received: string[] = [];
  const server = await serveOpenUrlRequests((url) => {
    received.push(url);
    // The host's real `openUrl` returns redacted arguments; this stands in for it.
    return Promise.resolve({
      args: openUrlArgs(url, { userDataDir: profile }).map(redactLinkValues),
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
    });
  });
  t.after(() => server.stop());
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  Object.assign(process.env, server.environment(), {
    BVE_EXTENSION_TEST_CONTROL_DIRECTORY: control,
  });
  const link = `vscode://chtaylo3.backstage-validation-engine/sign-in?code=${SECRET_CODE}&state=${SECRET_STATE}`;
  const answer = await caseOpenUrl(link);
  assert.equal(answer.status, 'passed');
  assert.deepEqual(received, [link], 'The host receives the link itself, in memory.');
  const text = JSON.stringify(answer);
  assert(!text.includes(SECRET_CODE) && !text.includes(SECRET_STATE), text);
  const files = await readdir(control, { recursive: true });
  for (const file of files) {
    const content = await readFile(path.join(control, file), 'utf8').catch(() => '');
    assert(!content.includes(SECRET_CODE) && !content.includes(SECRET_STATE), file);
  }
  assert.deepEqual(files, [], 'The link request writes no file at all.');
});
