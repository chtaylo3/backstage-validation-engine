import assert from 'node:assert/strict';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const version = document.version;
  await fixture.apply(await fixture.fix());
  await until(
    () => document.getText().includes('lifecycle: "production"'),
    'versioned editor applyEdit',
  );
  assert(document.version > version);
  await until(() => !fixture.has('production-only'), 'diagnostics clear after real didChange');
}
