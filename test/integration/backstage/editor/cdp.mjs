import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as pause } from 'node:timers/promises';

export async function debugPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
export async function screenshot(port, file) {
  const targets = await globalThis
    .fetch(`http://127.0.0.1:${port}/json/list`, { signal: globalThis.AbortSignal.timeout(3000) })
    .then((response) => response.json());
  const target = targets.find((row) => row.type === 'page' && row.url.includes('workbench'));
  assert(target?.webSocketDebuggerUrl, 'Find the visible native workbench.');
  const socket = new globalThis.WebSocket(target.webSocketDebuggerUrl);
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Workbench screenshot timed out.')), 4000);
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Workbench screenshot connection failed.'));
        },
        { once: true },
      );
      socket.addEventListener(
        'open',
        () =>
          socket.send(
            JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }),
          ),
        { once: true },
      );
      socket.addEventListener('message', (event) => {
        const value = JSON.parse(String(event.data));
        if (value.id !== 1) return;
        clearTimeout(timer);
        if (value.error) reject(new Error('Workbench rejected the screenshot request.'));
        else resolve(value.result);
      });
    });
    assert(typeof result.data === 'string' && result.data.length < 24 * 1024 * 1024);
    await writeFile(file, Buffer.from(result.data, 'base64'));
  } finally {
    socket.close();
  }
}

/** The one Chromium that the pinned test image provides. */
export async function chromiumExecutable(root = '/ms-playwright') {
  const names = (await readdir(root)).filter((name) => /^chromium-\d+$/u.test(name));
  assert.equal(names.length, 1, 'Find exactly one pinned Chromium.');
  return path.join(root, names[0], 'chrome-linux64', 'chrome');
}

/** One Chrome DevTools Protocol connection. Events go to every subscriber. */
export class CdpSession {
  #socket;
  #next = 1;
  #pending = new Map();
  #listeners = new Set();
  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(String(event.data));
      if (value.id !== undefined) {
        const waiting = this.#pending.get(value.id);
        if (!waiting) return;
        this.#pending.delete(value.id);
        clearTimeout(waiting.timer);
        if (value.error) waiting.reject(new Error(`${waiting.method}: ${value.error.message}`));
        else waiting.resolve(value.result);
        return;
      }
      for (const listener of this.#listeners) listener(value);
    });
    socket.addEventListener('close', () => {
      for (const waiting of this.#pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(`${waiting.method}: the DevTools connection closed.`));
      }
      this.#pending.clear();
    });
  }
  static async connect(url) {
    const socket = new globalThis.WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('DevTools connection failed.')), {
        once: true,
      });
    });
    return new CdpSession(socket);
  }
  send(method, params = {}, timeoutMs = 15_000) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Subscribe to protocol events; returns the unsubscribe function. */
  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  close() {
    this.#socket.close();
  }
}

/** Start a headless Chromium with a fresh profile and connect to its first page. */
export async function launchBrowser({ executable, args = [] }) {
  const profile = await mkdtemp(path.join(tmpdir(), 'bve-browser-'));
  const port = await debugPort();
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + profile,
      '--remote-debugging-port=' + port,
      '--remote-debugging-address=127.0.0.1',
      ...args,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let page;
  const close = async () => {
    page?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, pause(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    const until = Date.now() + 30_000;
    let target;
    while (!target) {
      assert(child.exitCode === null, 'Chromium exited during startup.');
      assert(Date.now() < until, 'Chromium did not offer a page target.');
      const targets = await globalThis
        .fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: globalThis.AbortSignal.timeout(2000),
        })
        .then((response) => response.json())
        .catch(() => []);
      target = targets.find((row) => row.type === 'page' && row.webSocketDebuggerUrl);
      if (!target) await pause(200);
    }
    page = await CdpSession.connect(target.webSocketDebuggerUrl);
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Evaluate an expression in the page and return its JSON value. */
export async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error('Page evaluation failed.');
  return result.result.value;
}

/** Wait until an expression is truthy in the page, and return its value. */
export async function waitFor(page, expression, description, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate(page, expression).catch(() => undefined);
    if (value) return value;
    assert(Date.now() < until, `Timed out waiting for ${description}.`);
    await pause(250);
  }
}

/** Click the enabled button whose visible text equals `text`. Returns whether one was found. */
export function clickButton(page, text) {
  return evaluate(
    page,
    `(() => { const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (!button) return false; button.click(); return true; })()`,
  );
}
