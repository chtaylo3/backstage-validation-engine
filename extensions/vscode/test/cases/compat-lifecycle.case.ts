import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { exited, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
import { ownedServers } from '../resources.js';
export const activate = false;
export async function run(fixture: Fixture): Promise<void> {
  const stage = process.env.BVE_EXTENSION_TEST_LIFECYCLE_STAGE!;
  const file = process.env.BVE_EXTENSION_TEST_CLOSE_MARKER!;
  const previous = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as { pid: number })
    .catch(() => undefined);
  if (previous) await until(() => exited(previous.pid), 'previous installed version server exited');
  const extension = vscode.extensions.getExtension('chtaylo3.backstage-validation-engine');
  assert.equal(
    vscode.workspace.getConfiguration('backstageValidation').inspect<string>('configPath')
      ?.globalValue,
    process.env.BVE_EXTENSION_TEST_CONFIG,
    'User Settings persist across installation changes.',
  );
  if (stage === 'disabled' || stage === 'uninstalled') {
    assert.notEqual(extension?.isActive, true);
    assert.equal((await vscode.commands.getCommands(true)).includes('bve.applyFix'), false);
    if (stage === 'uninstalled') assert.equal(extension, undefined);
    return;
  }
  assert(extension);
  assert.equal(
    (extension.packageJSON as { version: string }).version,
    stage === 'previous' ? '0.0.1' : '0.1.0',
  );
  await fixture.setup();
  await fixture.document();
  await fixture.diagnostic();
  assert.deepEqual(await ownedServers(extension.extensionPath), [fixture.pid()]);
  if (previous) assert.notEqual(fixture.pid(), previous.pid);
  await writeFile(file, JSON.stringify({ pid: fixture.pid(), stage }));
  fixture.note('installed package lifecycle: ' + stage);
}
