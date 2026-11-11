import assert from 'node:assert/strict';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const pid = fixture.pid();
  await fixture.replace(document, document.getText().replace('owner: team', 'owner: missing'));
  await fixture.currentDiagnostic(document);
  await fixture.missingOwner(document);
  const version = document.version;
  await fixture.apply(await fixture.fix());
  await until(
    () => document.getText().includes('lifecycle: "production"'),
    'versioned editor applyEdit',
  );
  assert(document.version > version);
  await until(() => !fixture.has('production-only'), 'diagnostics clear after real didChange');
  assert(
    fixture.has('owner-exists'),
    'The unrelated owner finding must survive the lifecycle repair.',
  );
  await fixture.alive(pid, document, 'owner-exists');
}
