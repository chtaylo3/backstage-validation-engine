import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { configuration, reload, lifecycleConfiguration } from '../configuration.js';
import { sameFile, until } from '../fixture.js';
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
  const hoverText = hovers
    .flatMap((hover) =>
      hover.contents.map((content) =>
        (typeof content === 'string' ? content : content.value)
          .replaceAll('&nbsp;', ' ')
          .replaceAll('&quot;', '"'),
      ),
    )
    .join('\n');
  assert(
    hoverText.includes('Required value: "production".'),
    'Installed hover must contain its actual constraint: ' + hoverText,
  );
  const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    fixture.uri,
    new vscode.Position(6, 10),
  );
  assert(definitions.some((location) => location.uri.fsPath === fixture.teamUri.fsPath));
  const initial = await configuration();
  // The successful explicit command can overlap the intended automatic reload.
  await reload(lifecycleConfiguration(initial, 'internal'), fixture);
  await until(async () => {
    const result = await fixture.provider<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      fixture.uri,
      new vscode.Position(5, 13),
    );
    const labels = result.items.map((item) => item.label);
    return labels.includes('internal') && !labels.includes('production');
  }, 'changed trusted policy changes actual suggestions');
  await fixture.alive(pid, document);
  const reloaded = await fixture.observed(document);
  assert.notEqual(reloaded.policyDigest, initial.activation.policyDigest);
  const teamDocument = await vscode.workspace.openTextDocument(fixture.teamUri);
  const settled = await fixture.observed(teamDocument);
  await fixture.replace(teamDocument, teamDocument.getText() + '---\n' + teamDocument.getText());
  const previous = await fixture.observed(document, settled.generation);
  assert(
    previous.documents.some(
      (row) => sameFile(row.uri, fixture.teamUri) && row.version === teamDocument.version,
    ),
  );
  const ambiguous = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    fixture.uri,
    new vscode.Position(6, 10),
  );
  assert.deepEqual(
    ambiguous,
    [],
    'Two same-reference local entities cannot choose an arbitrary definition.',
  );
  await fixture.alive(pid, document);
  await fixture.replace(document, document.getText() + '  sy');
  await until(async () => {
    const result = await fixture.provider<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      fixture.uri,
      document.positionAt(document.getText().length),
    );
    return result.items.some((item) => item.label === 'system');
  }, 'field-name suggestions during unfinished YAML edits');
  // Restore trusted policy even though the profile is isolated.
  await writeFile(process.env.BVE_EXTENSION_TEST_CONFIG!, JSON.stringify(initial));
  await vscode.commands.executeCommand('backstageValidation.reloadConfiguration');
  assert.equal(fixture.pid(), pid);
}
