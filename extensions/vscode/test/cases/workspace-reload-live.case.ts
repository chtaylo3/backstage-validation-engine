import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { exited, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const file = process.env.BVE_EXTENSION_TEST_CLOSE_MARKER!;
  const previous = await readFile(file, 'utf8').catch(() => undefined);
  if (previous) {
    const value = JSON.parse(previous) as { pid: number; gateId: string };
    await until(() => exited(value.pid), 'reload stops previous server before reactivation');
    assert.notEqual(fixture.pid(), value.pid);
    await fixture.control({ op: 'cancelled', id: value.gateId });
    await fixture.document();
    await fixture.diagnostic();
    fixture.note('native reload observed with a distinct server PID');
    return;
  }
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
    file,
    JSON.stringify({ pid: fixture.pid(), editorVersion: vscode.version, gateId: gate.id }),
  );
  try {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'Canceled') throw error;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
}
