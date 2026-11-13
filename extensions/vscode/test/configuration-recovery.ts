import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from './fixture.js';
import type { Fixture } from './fixture.js';

export async function recover(fixture: Fixture): Promise<void> {
  const reasons: Record<string, string> = {
    'config-absent': 'Set Backstage Validation: Config Path in User Settings to start validation.',
    'config-relative': 'Select an absolute trusted configuration path in User Settings.',
    'config-missing': 'Trusted configuration file was not found.',
    'config-unreadable': 'Trusted configuration file is not readable.',
    'config-malformed': 'Trusted configuration contains invalid JSON.',
    'config-structure': 'Invalid trusted configuration.',
    'config-server-init': 'Trusted configuration was rejected during server initialization.',
    'config-non-file': 'Only local file sources are supported.',
    'config-file-limit': 'Trusted configuration exceeds the file limit.',
    'config-byte-limit': 'Trusted configuration exceeds the size limit.',
  };
  const expected = reasons[process.env.BVE_EXTENSION_TEST_CASE!];
  assert(expected, 'Every configuration fault has an independent expected reason.');
  await until(async () => {
    const trace = await fixture.trace();
    return (
      trace.includes('Unable to start validation;') || trace.includes('Set Backstage Validation:')
    );
  }, 'startup output is flushed after completed activation');
  const trace = await fixture.trace();
  assert(
    trace.includes(expected),
    'Expected sanitized startup reason: ' + expected + '; actual: ' + trace,
  );
  assert(
    !trace.includes('invalid-launcher.json'),
    'Output must not reveal the selected private path.',
  );
  fixture.note('startup reason: ' + expected);
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
  assert((await fixture.trace()).includes('Packaged Backstage language server is ready.'));
  fixture.note('installed Restart command recovered from the expected fault');
}
