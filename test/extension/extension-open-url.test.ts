import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

interface OpenUrlOptions {
  userDataDir?: string;
  extensionsDir?: string;
  noSandbox?: boolean;
  verbose?: boolean;
  separator?: boolean;
}
const {
  openUrlArgs,
  redactLinkValues,
  serveOpenUrlRequests,
  OPEN_URL_REQUEST,
  OPEN_URL_ACKNOWLEDGEMENT,
} = (await import(pathToFileURL(path.resolve('scripts/extension-test-cli.mjs')).href)) as {
  openUrlArgs: (url: string, options?: OpenUrlOptions) => string[];
  redactLinkValues: (text: string) => string;
  serveOpenUrlRequests: (
    directory: string,
    open: (url: string, options: Record<string, unknown>) => Promise<unknown>,
    options?: { intervalMs?: number },
  ) => { answered(): string[]; stop(): Promise<void> };
  OPEN_URL_REQUEST: string;
  OPEN_URL_ACKNOWLEDGEMENT: string;
};

const profile = path.resolve(tmpdir(), 'bve profile');

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

void test('CLI evidence never carries the value of a code, state, or token parameter', () => {
  assert.equal(
    redactLinkValues('open vscode://a.b/sign-in?code=abc123&state=s1&probe=n1 and &token=t'),
    'open vscode://a.b/sign-in?code=<redacted>&state=<redacted>&probe=n1 and &token=<redacted>',
  );
  assert.equal(redactLinkValues(undefined as unknown as string), '');
});

void test('each link request is opened once and acknowledged with its outcome and evidence', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-open-url-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened: { url: string; options: Record<string, unknown> }[] = [];
  const server = serveOpenUrlRequests(
    directory,
    (url, options) => {
      opened.push({ url, options });
      if (!url.includes('fail')) return Promise.resolve({ exitCode: 0, durationMs: 5, stdout: '' });
      const error = new Error('editor refused');
      (error as Error & { details: unknown }).details = { exitCode: 3, stderr: 'state=s1' };
      return Promise.reject(error);
    },
    { intervalMs: 10 },
  );
  const ask = async (id: string, url: string, options?: Record<string, unknown>) => {
    await writeFile(path.join(directory, OPEN_URL_REQUEST), JSON.stringify({ id, url, options }));
    for (let attempt = 0; attempt < 300; attempt++) {
      const answer = await readFile(path.join(directory, OPEN_URL_ACKNOWLEDGEMENT), 'utf8')
        .then((text) => JSON.parse(text) as Record<string, unknown>)
        .catch(() => undefined);
      if (answer?.id === id) return answer;
      await pause(10);
    }
    throw new Error('No acknowledgement for ' + id);
  };
  try {
    assert.deepEqual(await ask('one', 'vscode://a.b/one', { verbose: true }), {
      id: 'one',
      status: 'passed',
      cli: { exitCode: 0, durationMs: 5, stdout: '' },
    });
    // The same request left in place is not opened again.
    await pause(100);
    assert.deepEqual(opened, [{ url: 'vscode://a.b/one', options: { verbose: true } }]);
    assert.deepEqual(await ask('two', 'vscode://a.b/fail'), {
      id: 'two',
      status: 'failed',
      error: 'editor refused',
      cli: { exitCode: 3, stderr: 'state=s1' },
    });
    assert.deepEqual(
      opened.map((row) => row.url),
      ['vscode://a.b/one', 'vscode://a.b/fail'],
    );
    assert.deepEqual(server.answered(), ['one', 'two']);
  } finally {
    await server.stop();
  }
});
