import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { exited, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  for (let cycle = 0; cycle < 3; cycle++) {
    const pid = fixture.pid();
    process.kill(pid, 'SIGKILL');
    await until(
      () => fixture.api!.status().disconnected === true && !fixture.api!.status().running,
      'explicit stopped state after server disconnect',
    );
    await until(() => exited(pid), 'crashed server has exited');
    await vscode.commands.executeCommand('backstageValidation.restart');
    await until(() => fixture.api!.status().running, 'manual recovery after crash');
    assert.notEqual(fixture.pid(), pid);
    assert.equal(fixture.api!.status().disconnected, false);
    await fixture.document();
    await fixture.diagnostic();
  }
}
