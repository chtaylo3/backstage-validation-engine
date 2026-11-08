import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  assert.equal(vscode.workspace.workspaceFolders?.length, 2);
  const main = await fixture.document();
  await fixture.currentDiagnostic(main);
  for (const name of ['catalog.yaml', 'catalog [a]{b}.yaml']) {
    const uri = vscode.Uri.file(
      path.join(process.env.BVE_EXTENSION_TEST_WORKSPACE!, 'other', name),
    );
    await vscode.commands.executeCommand('vscode.open', uri);
    const document = vscode.window.activeTextEditor!.document;
    assert.equal(document.uri.fsPath, uri.fsPath);
    await fixture.currentDiagnostic(document);
    await fixture.apply(await fixture.fix(uri));
    await until(
      () => document.getText().includes('lifecycle: "production"'),
      'fix applies to the correct second-root file',
    );
    assert(main.getText().includes('lifecycle: experimental'));
  }
  const unapproved = vscode.Uri.file(
    path.join(process.env.BVE_EXTENSION_TEST_WORKSPACE!, 'unapproved/catalog.yaml'),
  );
  await vscode.commands.executeCommand('vscode.open', unapproved);
  assert.equal(
    vscode.languages
      .getDiagnostics(unapproved)
      .filter((row) => row.source === 'backstage-validation').length,
    0,
  );
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    'vscode.executeCodeActionProvider',
    unapproved,
    new vscode.Range(5, 0, 5, 30),
  );
  assert(!actions?.some((row) => row.command?.command === 'bve.applyFix'));
  assert(vscode.window.activeTextEditor!.document.getText().includes('lifecycle: experimental'));
}
