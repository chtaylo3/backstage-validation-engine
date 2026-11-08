import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { exited, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const original = document.getText();
  for (let version = 0; version < fixture.catalogs().length; version++) {
    await fixture.useCatalog(version);
    const pid = fixture.pid();
    const gate = await fixture.control({
      op: 'arm',
      version,
      operation: 'byName',
      entityRef: 'group:default/missing',
    });
    try {
      await fixture.replace(document, original.replace('owner: team', 'owner: missing'));
      await fixture.control({ op: 'entered', id: gate.id });
      await vscode.commands.executeCommand('backstageValidation.stop');
      await fixture.control({ op: 'cancelled', id: gate.id });
      await until(() => exited(pid), 'stop during held validation exits its server');
      assert.equal(fixture.api!.status().running, false);
      await fixture.replace(document, original);
    } finally {
      await fixture.control({ op: 'release', id: gate.id });
    }
  }
}
