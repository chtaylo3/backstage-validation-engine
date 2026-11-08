import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const editor = await vscode.window.showTextDocument(document);
  assert.equal(await editor.edit((edit) => edit.setEndOfLine(vscode.EndOfLine.CRLF)), true);
  const text = '# 😀 astral character\r\n' + document.getText();
  await fixture.replace(document, text);
  await fixture.currentDiagnostic(document);
  const command = await fixture.fix();
  const changed = '# 🧪 second edit\r\n' + text;
  await fixture.replace(document, changed);
  await fixture.currentDiagnostic(document);
  const version = document.version;
  assert.deepEqual(await fixture.apply(command), { applied: false, reason: 'stale' });
  assert.equal(document.getText(), changed);
  assert.equal(document.version, version);
  await fixture.apply(await fixture.fix());
  await until(
    () => document.getText().includes('lifecycle: "production"'),
    'Unicode/CRLF guarded fix applies',
  );
  assert.equal(
    document.getText(),
    changed.replace('lifecycle: experimental', 'lifecycle: "production"'),
  );
  assert.equal(document.eol, vscode.EndOfLine.CRLF);
}
