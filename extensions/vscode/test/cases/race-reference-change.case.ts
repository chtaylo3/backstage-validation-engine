import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { invalidTeam, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const command = await fixture.fix();
  const text = document.getText();
  const version = document.version;
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(invalidTeam));
  await until(() => fixture.has('owner-exists'), 'dependency watch invalidates offered action');
  assert.deepEqual(await fixture.apply(command), { applied: false, reason: 'stale' });
  assert.equal(document.getText(), text);
  assert.equal(document.version, version);
}
