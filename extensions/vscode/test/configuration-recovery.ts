import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from './fixture.js';
import type { Fixture } from './fixture.js';

export async function recover(fixture: Fixture): Promise<void> {
  assert.equal(fixture.api!.status().running, false);
  assert.equal(fixture.api!.status().pid, undefined);
  await vscode.workspace
    .getConfiguration('backstageValidation')
    .update(
      'configPath',
      process.env.BVE_EXTENSION_TEST_CONFIG!,
      vscode.ConfigurationTarget.Global,
    );
  await vscode.commands.executeCommand('backstageValidation.restart');
  await until(() => fixture.api!.status().running, 'recover using valid User Setting');
  fixture.pid();
  await fixture.document();
  await fixture.diagnostic();
}
