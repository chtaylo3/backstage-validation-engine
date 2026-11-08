import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { exited, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const pid = fixture.pid();
  await vscode.commands.executeCommand('backstageValidation.stop');
  assert.equal(fixture.api!.status().running, false);
  await until(() => exited(pid), 'server process exits after shutdown');
  await vscode.commands.executeCommand('backstageValidation.stop');
  assert.equal(fixture.api!.status().running, false);
}
