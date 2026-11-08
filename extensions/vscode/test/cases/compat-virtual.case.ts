import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Fixture } from '../fixture.js';
export const activate = false;
export async function run(fixture: Fixture): Promise<void> {
  assert.equal(
    vscode.workspace.workspaceFolders?.[0]?.uri.scheme,
    'bve-virtual',
    'Use a real virtual workspace, not an untitled local document.',
  );
  assert.equal(vscode.workspace.isTrusted, true);
  assert.notEqual(
    vscode.extensions.getExtension('chtaylo3.backstage-validation-engine')?.isActive,
    true,
  );
  const uri = vscode.Uri.parse('bve-virtual:/workspace/catalog.yaml');
  const document = await vscode.workspace.openTextDocument(uri);
  assert(document.getText().includes('kind: Component'));
  assert.equal(
    vscode.languages.getDiagnostics(uri).filter((row) => row.source === 'backstage-validation')
      .length,
    0,
  );
  const commands = await vscode.commands.getCommands(true);
  assert(!commands.includes('bve.applyFix'));
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    uri,
    new vscode.Position(6, 11),
  );
  assert(!completions?.items.some((row) => row.label === 'group:default/team'));
  fixture.note('native virtual workspace keeps product disabled');
}
