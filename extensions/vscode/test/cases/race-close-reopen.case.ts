import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const pid = fixture.pid();
  const survivorUri = fixture.uri.with({
    path: fixture.uri.path.replace('catalog.yaml', 'survivor.yaml'),
  });
  const survivor = await vscode.workspace.openTextDocument(survivorUri);
  await fixture.alive(pid, survivor);
  const before = await fixture.observed(survivor);
  const command = await fixture.fix();
  const text = document.getText();
  const version = document.version;
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await until(() => document.isClosed, 'actual editor close');
  await fixture.observed(survivor, before.generation);
  await fixture.alive(pid, survivor);
  assert.equal(
    fixture.has('production-only'),
    false,
    'Processed close clears only the closed document.',
  );
  const reopened = await fixture.document();
  assert.equal(reopened.version, version, 'Exercise a reused editor document version.');
  await fixture.currentDiagnostic(reopened);
  await fixture.alive(pid, survivor);
  assert.deepEqual(await fixture.apply(command), { applied: false, reason: 'stale' });
  assert.equal(reopened.getText(), text);
}
