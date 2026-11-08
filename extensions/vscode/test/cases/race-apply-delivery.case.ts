import assert from 'node:assert/strict';
import { until, bounded } from '../fixture.js';
import type { Fixture } from '../fixture.js';
import { suspendServer } from '../native-process.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const command = await fixture.fix();
  const offset = (await fixture.trace()).length;
  const resume = await suspendServer(fixture.pid());
  let applying: Promise<unknown> | undefined;
  let changed: string;
  try {
    fixture.note('owned server suspended before execute request');
    applying = fixture.apply(command);
    await until(
      async () =>
        (await fixture.trace()).slice(offset).includes("Sending request 'workspace/executeCommand"),
      'execute request is queued before typing',
    );
    changed = document.getText() + '# typed while apply request was queued\n';
    await fixture.replace(document, changed);
    await until(
      async () =>
        (await fixture.trace())
          .slice(offset)
          .includes("Sending notification 'textDocument/didChange'"),
      'new buffer version queued after execute request',
    );
    fixture.note('new buffer version exists before applyEdit delivery');
  } finally {
    await resume();
    fixture.note('owned server resumed');
  }
  assert(applying);
  assert.deepEqual(await bounded(applying, 'versioned edit delivery'), {
    applied: false,
    reason: 'client_rejected',
  });
  assert.equal(document.getText(), changed!);
  await fixture.currentDiagnostic(document);
}
