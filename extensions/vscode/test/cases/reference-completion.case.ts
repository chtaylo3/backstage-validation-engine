import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  await fixture.document();
  await until(async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      fixture.uri,
      new vscode.Position(6, 11),
    );
    return list?.items.some((row) => row.label === 'group:default/team') === true;
  }, 'reference completion through the installed language client');
}
