import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const command = await fixture.fix();
  const text = document.getText();
  await vscode.commands.executeCommand('backstageValidation.restart');
  await until(() => fixture.api!.status().running, 'restart before replay');
  fixture.pid();
  await fixture.currentDiagnostic(document);
  assert.deepEqual(await fixture.apply(command), { applied: false, reason: 'stale' });
  assert.equal(document.getText(), text);
}
