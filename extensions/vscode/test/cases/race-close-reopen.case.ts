import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const command = await fixture.fix();
  const text = document.getText();
  const version = document.version;
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await until(() => document.isClosed, 'actual editor close');
  await until(() => !fixture.has('production-only'), 'close clears diagnostics');
  const reopened = await fixture.document();
  assert.equal(reopened.version, version, 'Exercise a reused editor document version.');
  await fixture.currentDiagnostic(reopened);
  assert.deepEqual(await fixture.apply(command), { applied: false, reason: 'stale' });
  assert.equal(reopened.getText(), text);
}
