import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

type Rectangle = { x: number; y: number; pattern: string };
type Point = { type: string; x: number; y: number; button: string; clickCount: number };
const { Workbench } = (await import(
  pathToFileURL(path.resolve('scripts/extension-test-ui.mjs')).href
)) as {
  Workbench: {
    prototype: {
      clickAt(this: unknown, rectangle: Rectangle, count?: number): Promise<void>;
      clickUntil(
        this: unknown,
        pattern: string,
        settled: () => Promise<boolean>,
        options?: { attempts?: number; graceMs?: number },
      ): Promise<string[]>;
    };
  };
};
void test('native input releases over the named button after focus changes its position', async () => {
  let y = 270;
  let clicks = 0;
  const events: Point[] = [];
  const driver = {
    rectangle: (pattern: string) => Promise.resolve({ x: 160, y, pattern }),
    wait: async (predicate: () => Promise<boolean>) => assert.equal(await predicate(), true),
    call: (method: string, point: Point) => {
      assert.equal(method, 'Input.dispatchMouseEvent');
      events.push(point);
      if (point.type === 'mousePressed') y = 110;
      if (point.type === 'mouseReleased' && point.y === y) clicks++;
      return Promise.resolve();
    },
  };
  await Workbench.prototype.clickAt.call(driver, { x: 160, y, pattern: '^Trust$' });
  assert.equal(clicks, 1, 'The intended button must receive a complete native click.');
  assert.deepEqual(
    events.map((event) => [event.type, event.y]),
    [
      ['mousePressed', 270],
      ['mouseReleased', 110],
    ],
  );
});

void test('native input releases the mouse even when the focused control cannot be reacquired', async () => {
  const failure = new Error('Control disappeared after focus.');
  const events: string[] = [];
  let pressed = false;
  const driver = {
    rectangle: () => {
      if (pressed) throw failure;
      return Promise.resolve({ x: 160, y: 270, pattern: '^Trust$' });
    },
    wait: async (predicate: () => Promise<boolean>) => assert.equal(await predicate(), true),
    call: (_method: string, point: Point) => {
      events.push(point.type);
      pressed = point.type === 'mousePressed';
      return Promise.resolve();
    },
  };
  await assert.rejects(
    Workbench.prototype.clickAt.call(driver, { x: 160, y: 270, pattern: '^Trust$' }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ['mousePressed', 'mouseReleased']);
  assert.equal(pressed, false);
});

/** A control that takes effect on the `effective` click, and is offered until then or forever. */
function control(effective: number, options: { vanishes?: boolean; failsAgain?: boolean } = {}) {
  let clicks = 0;
  const offered = () => !options.vanishes && clicks < effective;
  const driver = {
    click: () => {
      clicks++;
      return Promise.resolve('Trust');
    },
    rectangle: (pattern: string) =>
      Promise.resolve(offered() ? { x: 160, y: 270, pattern, text: 'Trust' } : null),
    clickAt: () => {
      if (options.failsAgain) return Promise.reject(new Error('Control disappeared.'));
      clicks++;
      return Promise.resolve();
    },
  };
  return { driver, settled: () => Promise.resolve(clicks >= effective), clicks: () => clicks };
}
const once = { graceMs: 0 };
void test('a click that takes effect is not repeated', async () => {
  const f = control(1);
  assert.deepEqual(
    await Workbench.prototype.clickUntil.call(f.driver, '^Trust$', f.settled, once),
    ['Trust'],
  );
  assert.equal(f.clicks(), 1);
});
void test('a lost click on a control that is still offered is repeated until it takes effect', async () => {
  const f = control(2);
  assert.deepEqual(
    await Workbench.prototype.clickUntil.call(f.driver, '^Trust$', f.settled, once),
    ['Trust', 'Trust'],
  );
  assert.equal(f.clicks(), 2);
});
void test('a control that is no longer offered is not clicked again, whatever the effect', async () => {
  const f = control(Infinity, { vanishes: true });
  assert.deepEqual(
    await Workbench.prototype.clickUntil.call(f.driver, '^Trust$', f.settled, once),
    ['Trust'],
  );
  assert.equal(f.clicks(), 1);
  // The control goes away between the look and the second click: the first click is the record.
  const g = control(Infinity, { failsAgain: true });
  assert.deepEqual(
    await Workbench.prototype.clickUntil.call(g.driver, '^Trust$', g.settled, once),
    ['Trust'],
  );
  assert.equal(g.clicks(), 1);
});
void test('clicks without effect stop at the attempt bound and leave the verdict to the caller', async () => {
  const f = control(Infinity);
  const clicked = await Workbench.prototype.clickUntil.call(f.driver, '^Trust$', f.settled, {
    attempts: 3,
    graceMs: 0,
  });
  assert.equal(clicked.length, 3);
  assert.equal(f.clicks(), 3);
});

void test('a PowerShell helper failure says whether it ran out of time, without the encoded script', async () => {
  const { powershellFailure } = await import('../../extensions/vscode/test/native-process.js');
  const command = 'powershell.exe -EncodedCommand ' + 'A'.repeat(4000);
  const stopped = powershellFailure(
    Object.assign(new Error('Command failed: ' + command), { killed: true, stderr: '#< CLIXML' }),
    30_000,
  );
  assert.equal(stopped.message, 'PowerShell helper was stopped after 30000 ms without finishing.');
  const failed = powershellFailure(
    Object.assign(new Error('Command failed: ' + command), {
      killed: false,
      code: 1,
      stderr: ' OpenThread failed \n',
    }),
  );
  assert.equal(failed.message, 'PowerShell helper failed with exit code 1: OpenThread failed');
  assert.equal(
    powershellFailure(Object.assign(new Error('spawn'), { code: 'ENOENT' })).message,
    'PowerShell helper failed with exit code ENOENT.',
  );
  assert(!stopped.message.includes('AAAA') && !failed.message.includes('AAAA'));
  assert(stopped.cause instanceof Error);
});
