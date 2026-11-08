import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const original = document.getText();
  for (let version = 0; version < fixture.catalogs().length; version++) {
    await fixture.useCatalog(version);
    await fixture.replace(document, original + `# catalog ${version}\n`);
    await until(async () => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        new vscode.Position(6, 10),
      );
      return list?.items.some((row) => row.label === 'group:default/team') === true;
    }, 'local completion index ready before arming catalog search');
    const gate = await fixture.control({ op: 'arm', version, operation: 'byQuery' });
    try {
      const pending = vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        new vscode.Position(6, 11),
      );
      await fixture.control({ op: 'entered', id: gate.id });
      await fixture.replace(document, original + `# newer epoch ${version}\n`);
      await fixture.control({ op: 'cancelled', id: gate.id });
      await fixture.control({ op: 'release', id: gate.id });
      await pending;
      await until(async () => {
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          new vscode.Position(6, 11),
        );
        return list?.items.some((row) => row.label === 'group:default/team') === true;
      }, 'fresh completion after cancelling held search');
      assert.equal(document.getText(), original + `# newer epoch ${version}\n`);
    } finally {
      await fixture.control({ op: 'release', id: gate.id });
    }
  }
}
