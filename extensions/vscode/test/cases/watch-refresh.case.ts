import * as vscode from 'vscode';
import { invalidTeam, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  await fixture.document();
  await fixture.diagnostic();
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(invalidTeam));
  await until(() => fixture.has('owner-exists'), 'watch refresh finds native-invalid target');
}
