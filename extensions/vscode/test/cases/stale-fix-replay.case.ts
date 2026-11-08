import assert from 'node:assert/strict';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const command = await fixture.fix();
  await fixture.apply(command);
  await until(() => document.getText().includes('lifecycle: "production"'), 'first fix applies');
  const text = document.getText();
  const version = document.version;
  assert.deepEqual(await fixture.apply(command), { applied: false, reason: 'stale' });
  assert.equal(document.getText(), text);
  assert.equal(document.version, version);
}
