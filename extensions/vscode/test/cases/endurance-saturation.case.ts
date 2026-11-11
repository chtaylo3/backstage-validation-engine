import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { until, guardedCommand } from '../fixture.js';
import { writeEvidence } from '../evidence.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  let document = await fixture.document();
  const pid = fixture.pid();
  const original = document.getText();
  await fixture.currentDiagnostic(document);
  const old = await fixture.fix();
  const config = JSON.parse(await readFile(process.env.BVE_EXTENSION_TEST_CONFIG!, 'utf8')) as {
    profile: { limits: { fileBytes: number } };
  };
  const limit = config.profile.limits.fileBytes;
  const oversized = original + '#' + 'x'.repeat(limit - Buffer.byteLength(original));
  assert.equal(Buffer.byteLength(oversized), limit + 1);
  await fixture.replace(document, oversized);
  await until(
    () =>
      vscode.languages
        .getDiagnostics(document.uri)
        .some(
          (row) =>
            (row as vscode.Diagnostic & { data?: { version: number } }).data?.version ===
            document.version,
        ),
    'deterministic current-version incomplete branch above unchanged file byte cap',
  );
  assert(
    fixture.has('validation/incomplete'),
    'The deterministic saturation input must execute the incomplete branch.',
  );
  const actions = await fixture.provider<(vscode.CodeAction | vscode.Command)[]>(
    'vscode.executeCodeActionProvider',
    document.uri,
    new vscode.Range(0, 0, 0, 1),
  );
  assert(
    !actions?.some((row) => guardedCommand(row)),
    'Incomplete validation cannot offer a guarded edit.',
  );
  assert.deepEqual(await fixture.apply(old), { applied: false, reason: 'stale' });
  assert.equal(document.getText(), oversized);
  assert.equal(fixture.pid(), pid);
  assert(fixture.api!.status().running);
  await writeEvidence(
    path.join(path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!), 'capacity-observations.json'),
    JSON.stringify(
      {
        mechanism: 'buffer file-byte admission',
        limit,
        bytes: Buffer.byteLength(oversized),
        version: document.version,
        incompleteObserved: true,
        guardedActions: 0,
        oldRepairRejected: true,
        pid,
      },
      null,
      2,
    ) + '\n',
  );
  // A full document resynchronization is required after admission rejects a delta.
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  document = await fixture.document();
  await fixture.replace(document, original + '# valid in-cap recovery\n');
  await fixture.currentDiagnostic(document);
  await fixture.apply(await fixture.fix());
  await until(() => !fixture.has('production-only'), 'fresh guarded repair after bounded recovery');
  assert(document.getText().includes('lifecycle: "production"'));
  assert.equal(fixture.pid(), pid);
  assert(fixture.api!.status().running);
}
