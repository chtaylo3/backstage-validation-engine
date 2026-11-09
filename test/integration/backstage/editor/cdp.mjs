import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout, clearTimeout } from 'node:timers';

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
