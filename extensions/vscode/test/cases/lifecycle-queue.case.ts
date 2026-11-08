import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { exited, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const original = fixture.pid();
  const config = vscode.workspace.getConfiguration('backstageValidation');
  await config.update(
    'configPath',
    process.env.BVE_EXTENSION_TEST_CONFIG!,
    vscode.ConfigurationTarget.Global,
  );
  await Promise.all(
    ['stop', 'restart', 'stop', 'restart'].map((name) =>
      vscode.commands.executeCommand('backstageValidation.' + name),
    ),
  );
  await until(() => fixture.api!.status().running, 'queued final restart');
  assert.notEqual(fixture.pid(), original);
  await until(() => exited(original), 'queued commands close original process');
  await fixture.document();
  await fixture.diagnostic();
  await config.update('configPath', 'invalid-relative-config', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('backstageValidation.stop');
  assert.equal(fixture.api!.status().running, false);
  await config.update(
    'configPath',
    process.env.BVE_EXTENSION_TEST_CONFIG!,
    vscode.ConfigurationTarget.Global,
  );
  await vscode.commands.executeCommand('backstageValidation.restart');
  fixture.pid();
  await fixture.diagnostic();
}
