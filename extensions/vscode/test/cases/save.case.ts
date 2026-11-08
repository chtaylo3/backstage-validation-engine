import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  await fixture.apply(await fixture.fix());
  await until(() => document.getText().includes('lifecycle: "production"'), 'fix changes buffer');
  assert.equal(document.isDirty, true);
  assert.equal(await document.save(), true);
  assert.equal(document.isDirty, false);
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(fixture.uri)).toString('utf8'),
    document.getText(),
  );
}
