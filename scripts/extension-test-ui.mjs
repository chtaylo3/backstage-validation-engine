import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { writeEvidence } from '../.artifacts/vscode/test/evidence.mjs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
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
const read = async (file) => JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
async function atomic(file, value) {
  await writeEvidence(file, JSON.stringify(value, null, 2) + '\n');
}

export class Workbench {
  serial = 0;
  pending = new Map();
  closed = false;
  epoch = 0;
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.executionContextsCleared') this.epoch++;
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const pending of this.pending.values())
        pending.reject(new Error('Workbench CDP connection closed.'));
      this.pending.clear();
    });
  }
  call(method, params = {}) {
    if (this.closed) throw new Error('Workbench CDP connection closed.');
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP request timed out: ' + method));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result.value;
  }
  async key(key, code, number, modifiers = 0) {
    const value = { key, code, windowsVirtualKeyCode: number, modifiers };
    await this.call('Input.dispatchKeyEvent', { type: 'keyDown', ...value });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...value });
  }
  async palette(command) {
    await this.call('Page.bringToFront');
    await this.key('F1', 'F1', 112);
    await this.wait(
      () =>
        this.evaluate(
          "document.activeElement?.matches('.quick-input-widget input') && document.activeElement.getBoundingClientRect().width > 0",
        ),
      'command palette',
    );
    // Select after the palette owns focus. Ctrl+A is an asynchronous workbench
    // command and can race Input.insertText; selecting the visible input avoids
    // typing into the editor or concatenating an old palette prefix.
    await this.evaluate('document.activeElement.select()');
    await this.call('Input.insertText', { text: '>' + command });
    await this.wait(
      () => this.evaluate(`document.activeElement?.value === ${JSON.stringify('>' + command)}`),
      'command palette query text',
    );
    const label = command.split(':').at(-1).trim();
    await this.wait(
      () =>
        this.evaluate(
          `Array.from(document.querySelectorAll('.quick-input-widget .monaco-list-row')).some(e => e.getBoundingClientRect().width > 0 && e.innerText.includes(${JSON.stringify(label)}))`,
        ),
      command,
    );
    await this.key('Enter', 'Enter', 13);
  }
  async rectangle(pattern) {
    return this.evaluate(
      `(() => { const match = new RegExp(${JSON.stringify(pattern)}, 'i'); const e = Array.from(document.querySelectorAll('[role="button"],[role="tab"],[role="link"],button,a')).find(e => e.getBoundingClientRect().width > 0 && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && match.test(e.innerText.replace(/\\s+/g,' ').trim())); if (!e) return null; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,text:e.innerText}; })()`,
    );
  }
  async click(pattern) {
    let rectangle;
    await this.wait(async () => {
      rectangle = await this.rectangle(pattern);
      return !!rectangle;
    }, 'visible UI button ' + pattern);
    await this.clickAt(rectangle);
    return rectangle.text;
  }
  async clickAt(rectangle, count = 1) {
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      const point = { x: rectangle.x, y: rectangle.y, button: 'left', clickCount };
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
      await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    }
  }
  async trustPane(allowPalette = false) {
    await this.call('Page.bringToFront');
    // The autonomous driver can request grant before the first banner/status
    // paint. Wait for a native affordance instead of opening a palette over
    // the still-initializing workbench and hiding those controls.
    let affordance;
    try {
      await this.wait(async () => {
        for (const pattern of ['^Workspace Trust$', '^Manage$', '^Restricted Mode$']) {
          affordance = await this.rectangle(pattern);
          if (affordance) return true;
        }
        return false;
      }, 'native Workspace Trust affordance');
      await this.clickAt(affordance);
    } catch (error) {
      // A trusted workspace has neither the Restricted Mode banner nor status
      // control, and the user may have closed the Trust tab since granting.
      if (!allowPalette) throw error;
      await this.palette('Manage Workspace Trust');
    }
    let opened;
    await this.wait(async () => {
      opened = await this.rectangle('^Workspace Trust$');
      return !!opened;
    }, 'native Workspace Trust tab');
    // Keep the native pane open when the driver activates the catalog tab.
    await this.clickAt(opened, 2);
  }
  async wait(predicate, label) {
    const end = Date.now() + 15_000;
    while (!(await predicate())) {
      if (Date.now() >= end) throw new Error('UI readiness timed out: ' + label);
      await pause(30);
    }
  }
  async screenshot(file) {
    const result = await this.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(result.data, 'base64'));
  }
  close() {
    this.socket.close();
  }
}

export async function connectWorkbench(port, isExited = () => false) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (isExited()) throw new Error('Editor exited before workbench UI became available.');
    const targets = await globalThis
      .fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => response.json())
      .catch(() => []);
    const target = targets.find(
      (value) => value.type === 'page' && value.url.includes('workbench'),
    );
    if (target) {
      const socket = new globalThis.WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      const workbench = new Workbench(socket);
      await workbench.call('Runtime.enable');
      return workbench;
    }
    await pause(100);
  }
  throw new Error('No owned workbench CDP target.');
}

/** Bootstrap evidence, with visible attach consent only for our owned container. */
export async function observeWorkbench({ port, directory, isExited, signal, ownedContainer }) {
  let workbench;
  try {
    for (const [index, delay] of [20_000, 40_000, 60_000].entries()) {
      await pause(delay, undefined, { signal });
      if (isExited()) return;
      if (!workbench || workbench.closed) workbench = await connectWorkbench(port, isExited);
      await workbench.screenshot(path.join(directory, `connection-${index}.png`));
      await writeFile(
        path.join(directory, `connection-${index}.txt`),
        await workbench.evaluate('document.body.innerText'),
      );
      if (ownedContainer) {
        const consent = await workbench.evaluate(
          `Array.from(document.querySelectorAll('[role="dialog"]')).some(e => e.getBoundingClientRect().width > 0 && e.innerText.includes('Attaching to a container may execute arbitrary code.') && e.innerText.includes('Only attach to a container if you trust its origin.'))`,
        );
        if (consent) {
          const button = await workbench.click('^Got It$');
          await atomic(path.join(directory, 'attach-consent.json'), {
            container: ownedContainer,
            visibleDialog: true,
            button,
            at: Date.now(),
          });
        }
      }
    }
  } catch (error) {
    if (!signal.aborted)
      await atomic(path.join(directory, 'connection-observer.json'), {
        error: error.stack ?? String(error),
      });
  } finally {
    workbench?.close();
  }
}

/** Trust changes go exclusively through visible workbench controls and native input. */
export async function controlTrust({ port, base, stage, isExited }) {
  const control = path.join(base, 'trust-control.json');
  const actions = [];
  const handled = new Set();
  let workbench;
  async function record(event, extra = {}) {
    actions.push({ event, stage, at: Date.now(), ...extra });
    await atomic(path.join(base, `ui-actions-${stage}.json`), actions);
  }
  async function ui() {
    if (!workbench || workbench.closed) workbench = await connectWorkbench(port, isExited);
    return workbench;
  }
  try {
    const end = Date.now() + 110_000;
    while (Date.now() < end) {
      const state = await read(control);
      const progress = await read(path.join(base, 'progress.json'));
      if (progress?.status === 'failed')
        throw new Error(progress.error ?? 'Trust scenario failed.');
      if (state?.stage === stage && ['done', 'reopen'].includes(state.step)) {
        await record(state.step);
        return;
      }
      if (isExited()) throw new Error('Editor exited before trust handshake completed.');
      if (!state || state.stage !== stage || handled.has(state.step)) {
        await pause(30);
        continue;
      }
      const browser = await ui();
      if (state.step.startsWith('capture-')) {
        assert(/^capture-[a-z-]+$/u.test(state.step));
        await browser.screenshot(path.join(base, `${stage}-${state.step}.png`));
        await atomic(path.join(base, 'trust-ack.json'), { stage, step: state.step });
        await record(state.step, { trusted: state.trusted });
      } else if (state.step === 'grant') {
        await browser.trustPane();
        await browser.screenshot(path.join(base, `${stage}-before-grant.png`));
        const button = await browser.click('^Trust(?:\\s|$)');
        await record('clicked-grant', { button });
      } else if (state.step === 'revoke') {
        await browser.trustPane(true);
        const epoch = browser.epoch;
        await browser.screenshot(path.join(base, `${stage}-before-revoke.png`));
        const button = await browser.click("^(?:Don['’]t Trust|Do not trust)(?:\\s|$)");
        await record('clicked-revoke', { button });
        // Older editors ask for reload; newer ones may reload immediately.
        // If trust changes in place, explicitly reload through the public UI.
        await browser.wait(async () => {
          const next = await read(control);
          if (
            next?.step === 'done' ||
            next?.step === 'capture-revoked' ||
            browser.closed ||
            browser.epoch !== epoch
          )
            return true;
          try {
            const reload = await browser.rectangle('^Reload(?: Window| Now)?$');
            if (reload) {
              await browser.clickAt(reload);
              await record('confirmed-reload');
              return true;
            }
          } catch (error) {
            if (/context|closed|Target/iu.test(error.message)) return true;
            throw error;
          }
          return false;
        }, 'native trust revocation reload');
      } else throw new Error('Unknown workbench trust step: ' + state.step);
      handled.add(state.step);
    }
    throw new Error('Trust UI handshake exceeded its bound.');
  } catch (error) {
    await record('failure', { error: error.stack ?? String(error) });
    if (workbench && !workbench.closed) {
      await workbench.screenshot(path.join(base, `${stage}-ui-failure.png`)).catch(() => {});
      await workbench
        .evaluate('document.body.innerText')
        .then((text) => writeFile(path.join(base, `${stage}-ui-failure.txt`), text))
        .catch(() => {});
    }
    throw error;
  } finally {
    workbench?.close();
  }
}
