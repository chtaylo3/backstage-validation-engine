import assert from 'node:assert/strict';
import { writeFile, rename } from 'node:fs/promises';
import * as vscode from 'vscode';
import { configuration } from '../configuration.js';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const pid = fixture.pid();
  await fixture.replace(document, document.getText().replace('owner: team', 'owner: remote-team'));
  await fixture.currentDiagnostic(document);
  const complete = () =>
    fixture.provider<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(6, 18),
    );
  await until(
    async () => (await complete()).items.some((row) => row.label === 'group:default/remote-team'),
    'authenticated remote reference positive control',
  );
  const old = await fixture.fix();
  const config = await configuration();
  const tokenFile = config.catalog!.tokenFile!;
  const cursor = await fixture.control({ op: 'cursor' });
  await writeFile(tokenFile + '.replacement', 'revoked-synthetic-credential', { mode: 0o600 });
  await rename(tokenFile + '.replacement', tokenFile);
  const text = document.getText(),
    version = document.version;
  await until(
    () =>
      vscode.languages
        .getDiagnostics(document.uri)
        .some(
          (row) =>
            row.code === 'owner-exists' &&
            (row as vscode.Diagnostic & { data?: { category: string; version: number } }).data
              ?.category === 'dependency' &&
            (row as vscode.Diagnostic & { data?: { version: number } }).data?.version ===
              document.version,
        ),
    'actual rotated token produces dependency warning',
  );
  await fixture.control({ op: 'assert-denied', after: Number(cursor.id) });
  const diagnostics = vscode.languages.getDiagnostics(document.uri);
  const dependency = diagnostics.find((row) => row.code === 'owner-exists')!;
  const policy = diagnostics.find((row) => row.code === 'production-only')!;
  assert.equal(dependency.severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(
    (dependency as vscode.Diagnostic & { data: { category: string } }).data.category,
    'dependency',
  );
  assert.equal(policy.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(
    (policy as vscode.Diagnostic & { data: { category: string } }).data.category,
    'policy',
  );
  const unchanged = document.getText();
  assert.deepEqual(await fixture.apply(old), { applied: false, reason: 'stale' });
  assert.equal(document.getText(), unchanged);
  assert.equal(fixture.pid(), pid);
  assert.equal(document.getText(), text);
  assert.equal(document.version, version);
  const recovery = await fixture.control({ op: 'cursor' });
  await writeFile(tokenFile + '.replacement', process.env.BVE_EDITOR_CATALOG_TOKEN!, {
    mode: 0o600,
  });
  await rename(tokenFile + '.replacement', tokenFile);

  await until(
    () => !fixture.has('owner-exists'),
    'restored actual token clears dependency warning',
  );
  await fixture.control({ op: 'assert-read', after: Number(recovery.id) });
  await fixture.alive(pid, document);
  await until(
    async () => (await complete()).items.some((row) => row.label === 'group:default/remote-team'),
    'remote suggestions recover without restart',
  );
  await fixture.fix();
  assert.equal(document.getText(), text);
  assert.equal(document.version, version);
  assert.deepEqual(await fixture.apply(old), { applied: false, reason: 'stale' });
  fixture.note(
    'same-PID actual token-file denial/recovery, old repair rejection, exact installed warning/error categories',
  );
}
