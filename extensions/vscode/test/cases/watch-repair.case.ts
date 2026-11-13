import * as vscode from 'vscode';
import { invalidTeam, team, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const pid = fixture.pid();
  await fixture.diagnostic();
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(invalidTeam));
  await until(() => fixture.has('owner-exists'), 'watch refresh before repair');
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(team));
  await until(() => !fixture.has('owner-exists'), 'watcher repair revalidates');
  await fixture.alive(pid, document);
}
