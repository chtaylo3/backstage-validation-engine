import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until, exited } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const yaml = vscode.extensions.getExtension('redhat.vscode-yaml');
  assert(yaml, 'The pinned YAML extension must be installed.');
  assert.equal((yaml.packageJSON as { version: string }).version, '1.19.1');
  await yaml.activate();
  const document = await fixture.document();
  await fixture.diagnostic();
  const other = () =>
    vscode.languages
      .getDiagnostics(document.uri)
      .filter(
        (row) => row.source !== 'backstage-validation' && row.message.includes('coexistence'),
      );
  await until(() => other().length > 0, 'independent YAML schema finding');
  await until(async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(6, 11),
    );
    const labels =
      list?.items.map((row) => (typeof row.label === 'string' ? row.label : row.label.label)) ?? [];
    return (
      labels.includes('group:default/team') && labels.some((label) => label.includes('team-yaml'))
    );
  }, 'both completion providers contribute');
  const formatting = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider',
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  assert(
    formatting?.length,
    'YAML formatting remains available alongside the guarded code action.',
  );
  await fixture.apply(await fixture.fix());
  await until(() => !fixture.has('production-only'), 'product fix clears its finding');
  assert(other().length, 'Product fix preserves the YAML extension finding.');
  const pid = fixture.pid();
  await vscode.commands.executeCommand('backstageValidation.stop');
  await until(() => exited(pid), 'Stop only reaps the product server');
  const text = document.getText();
  await fixture.replace(document, text.replace('{name: service}', '{name: coexistence}'));
  await until(() => other().length === 0, 'YAML clears its finding after product Stop');
  await fixture.replace(document, text + '# yaml remains active\n');
  await until(() => other().length > 0, 'YAML continues validating after product Stop');
  assert(yaml.isActive);
}
