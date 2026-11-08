import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  await fixture.diagnostic();
  const gate = await fixture.control({
    op: 'arm',
    operation: 'byName',
    entityRef: 'group:default/missing',
  });
  await vscode.workspace.fs.writeFile(
    document.uri,
    Buffer.from(document.getText().replace('owner: team', 'owner: missing')),
  );
  await fixture.control({ op: 'entered', id: gate.id });
  await writeFile(
    process.env.BVE_EXTENSION_TEST_CLOSE_MARKER!,
    JSON.stringify({
      id: process.env.BVE_EXTENSION_TEST_CASE,
      pid: fixture.pid(),
      command: 'workbench.action.closeWindow',
      gateId: gate.id,
    }),
  );
  try {
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'Canceled') throw error;
  }
  // The parent verifies native editor exit and child-process death before its
  // own process-group cleanup. Returning here would bypass that observation.
  await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
}
