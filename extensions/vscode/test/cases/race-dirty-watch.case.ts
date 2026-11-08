import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { invalidTeam, team, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const main = await fixture.document();
  await fixture.currentDiagnostic(main);
  const document = await vscode.workspace.openTextDocument(fixture.teamUri);
  await vscode.window.showTextDocument(document);
  await fixture.replace(document, team + '# unsaved buffer owns this file\n');
  assert(document.isDirty);
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(invalidTeam));
  // A fresh guarded action is a round-trip through the latest workspace frame.
  await fixture.fix();
  assert.equal(fixture.has('owner-exists'), false);
  assert.equal(document.getText(), team + '# unsaved buffer owns this file\n');
  assert.equal(
    await document.save(),
    false,
    'External modification requires explicit conflict resolution.',
  );
  assert.equal(document.getText(), team + '# unsaved buffer owns this file\n');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await until(
    () => fixture.has('owner-exists'),
    'reverting the buffer admits the invalid saved dependency',
  );
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(team));
  await until(() => !fixture.has('owner-exists'), 'external repair clears dependency');
}
