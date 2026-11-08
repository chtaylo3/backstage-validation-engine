import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  await fixture.document();
  const diagnostic = await fixture.diagnostic();
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
  assert(diagnostic.message.length > 0);
}
