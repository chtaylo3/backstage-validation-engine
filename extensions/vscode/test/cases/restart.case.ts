import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { exited, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const previous = fixture.pid();
  await vscode.commands.executeCommand('backstageValidation.restart');
  await until(() => fixture.api!.status().running, 'restart packaged runtime');
  assert.notEqual(fixture.pid(), previous);
  await until(() => exited(previous), 'previous server exits after restart');
  await fixture.document();
  await fixture.diagnostic();
}
