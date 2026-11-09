import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';

export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const pid = fixture.pid();
  await fixture.diagnostic();
  await until(async () => {
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      fixture.uri,
      new vscode.Position(5, 13),
    );
    return result.items.some((item) => item.label === 'production');
  }, 'schema-based values in the installed editor');
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    fixture.uri,
    new vscode.Position(5, 4),
  );
  assert(
    hovers.some((hover) =>
      hover.contents.some((content) =>
        typeof content === 'string'
          ? content.includes('lifecycle')
          : 'value' in content && content.value.includes('lifecycle'),
      ),
    ),
  );
  const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    fixture.uri,
    new vscode.Position(6, 10),
  );
  assert(definitions.some((location) => location.uri.fsPath === fixture.teamUri.fsPath));
  await fixture.replace(document, document.getText() + '  sy');
  await until(async () => {
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      fixture.uri,
      document.positionAt(document.getText().length),
    );
    return result.items.some((item) => item.label === 'system');
  }, 'field-name suggestions during unfinished YAML edits');
  await vscode.commands.executeCommand('backstageValidation.reloadConfiguration');
  assert.equal(fixture.pid(), pid, 'Configuration reload keeps the existing server process.');
}
