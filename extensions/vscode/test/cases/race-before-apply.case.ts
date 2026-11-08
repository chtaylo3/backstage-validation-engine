import assert from 'node:assert/strict';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const command = await fixture.fix();
  const changed = document.getText() + '# intervening unsaved edit\n';
  await fixture.replace(document, changed);
  await fixture.currentDiagnostic(document);
  const version = document.version;
  assert.deepEqual(await fixture.apply(command), { applied: false, reason: 'stale' });
  assert.equal(document.getText(), changed);
  assert.equal(document.version, version);
}
