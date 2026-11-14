import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const { openUrlArgs, serveOpenUrlRequests, OPEN_URL_REQUEST, OPEN_URL_ACKNOWLEDGEMENT } =
  (await import(pathToFileURL(path.resolve('scripts/extension-test-cli.mjs')).href)) as {
    openUrlArgs: (
      url: string,
      options?: { userDataDir?: string; extensionsDir?: string },
    ) => string[];
    serveOpenUrlRequests: (
      directory: string,
      open: (url: string) => Promise<unknown>,
      options?: { intervalMs?: number },
    ) => { answered(): string[]; stop(): Promise<void> };
    OPEN_URL_REQUEST: string;
    OPEN_URL_ACKNOWLEDGEMENT: string;
  };

const profile = path.resolve(tmpdir(), 'bve profile');

void test('the open-url arguments address the running editor of the profile', () => {
  const url = 'vscode://chtaylo3.backstage-validation-engine/sign-in?code=x&state=y';
  assert.deepEqual(openUrlArgs(url, { userDataDir: profile }), [
    '--open-url',
    url,
    '--user-data-dir',
    profile,
  ]);
  const extensions = path.resolve(tmpdir(), 'extensions');
  assert.deepEqual(openUrlArgs(url, { userDataDir: profile, extensionsDir: extensions }), [
    '--open-url',
    url,
    '--user-data-dir',
    profile,
    '--extensions-dir',
    extensions,
  ]);
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

void test('each link request is opened once and acknowledged with its outcome', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-open-url-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened: string[] = [];
  const server = serveOpenUrlRequests(
    directory,
    (url) => {
      opened.push(url);
      return url.includes('fail') ? Promise.reject(new Error('editor refused')) : Promise.resolve();
    },
    { intervalMs: 10 },
  );
  const ask = async (id: string, url: string) => {
    await writeFile(path.join(directory, OPEN_URL_REQUEST), JSON.stringify({ id, url }));
    for (let attempt = 0; attempt < 300; attempt++) {
      const answer = await readFile(path.join(directory, OPEN_URL_ACKNOWLEDGEMENT), 'utf8')
        .then((text) => JSON.parse(text) as { id: string; status: string; error?: string })
        .catch(() => undefined);
      if (answer?.id === id) return answer;
      await pause(10);
    }
    throw new Error('No acknowledgement for ' + id);
  };
  try {
    assert.deepEqual(await ask('one', 'vscode://a.b/one'), { id: 'one', status: 'passed' });
    // The same request left in place is not opened again.
    await pause(100);
    assert.deepEqual(opened, ['vscode://a.b/one']);
    assert.deepEqual(await ask('two', 'vscode://a.b/fail'), {
      id: 'two',
      status: 'failed',
      error: 'editor refused',
    });
    assert.deepEqual(opened, ['vscode://a.b/one', 'vscode://a.b/fail']);
    assert.deepEqual(server.answered(), ['one', 'two']);
  } finally {
    await server.stop();
  }
});
