import * as vscode from 'vscode';
import { team, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  await fixture.document();
  await fixture.diagnostic();
  const renamed = fixture.teamUri.with({ path: fixture.teamUri.path + '.renamed' });
  await vscode.workspace.fs.rename(fixture.teamUri, renamed);
  await until(() => fixture.has('owner-exists'), 'rename removes approved dependency');
  await vscode.workspace.fs.rename(renamed, fixture.teamUri);
  await until(() => !fixture.has('owner-exists'), 'rename back repairs dependency');
  await vscode.workspace.fs.delete(fixture.teamUri);
  await until(() => fixture.has('owner-exists'), 'delete removes dependency');
  await vscode.workspace.fs.writeFile(renamed, Buffer.from(team));
  await vscode.workspace.fs.rename(renamed, fixture.teamUri, { overwrite: true });
  await until(() => !fixture.has('owner-exists'), 'atomic replacement repairs dependency');
}
