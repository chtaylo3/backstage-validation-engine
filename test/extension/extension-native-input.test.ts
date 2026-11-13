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
