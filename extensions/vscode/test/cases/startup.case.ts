import assert from 'node:assert/strict';
import type { Fixture } from '../fixture.js';
export function run(fixture: Fixture): Promise<void> {
  assert.equal(fixture.api!.status().running, true);
  assert(fixture.pid() > 0);
  return Promise.resolve();
}
