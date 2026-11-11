import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { writeEvidence } from '../evidence.js';
import { diagnosticPublications } from '../diagnostic-trace.js';
import { until, documentRange, guardedCommand } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  assert.equal(vscode.workspace.workspaceFolders?.length, 2);
  const main = await fixture.document();
  const pid = fixture.pid();
  await fixture.currentDiagnostic(main);
  for (const name of ['catalog.yaml', 'catalog [a]{b}.yaml']) {
    const uri = vscode.Uri.file(
      path.join(process.env.BVE_EXTENSION_TEST_WORKSPACE!, 'other', name),
    );
    await vscode.commands.executeCommand('vscode.open', uri);
    const document = vscode.window.activeTextEditor!.document;
    assert.equal(document.uri.fsPath, uri.fsPath);
    await fixture.currentDiagnostic(document);
    await fixture.apply(await fixture.fix(uri));
    await until(
      () => document.getText().includes('lifecycle: "production"'),
      'fix applies to the correct second-root file',
    );
    assert(main.getText().includes('lifecycle: experimental'));
  }
  const unapproved = vscode.Uri.file(
    path.join(process.env.BVE_EXTENSION_TEST_WORKSPACE!, 'unapproved/catalog.yaml'),
  );
  const offset = (await fixture.trace()).length;
  await vscode.commands.executeCommand('vscode.open', unapproved);
  // This approved round trip occurs after the unapproved open.
  await fixture.replace(main, main.getText() + '# approved barrier after unapproved open\n');
  await fixture.alive(pid, main);
  await until(
    async () =>
      diagnosticPublications((await fixture.trace()).slice(offset)).some(
        (row) =>
          row.uri === main.uri.toString() &&
          row.version === main.version &&
          row.diagnostics.some((diagnostic) => diagnostic.code === 'production-only'),
      ),
    'approved current-version publication after unapproved open',
  );
  await fixture.api!.filesystemObservation();
  const publications = diagnosticPublications((await fixture.trace()).slice(offset));
  await writeEvidence(
    path.join(
      path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!),
      'unapproved-open-publications.json',
    ),
    JSON.stringify(publications, null, 2) + '\n',
  );
  assert(
    !publications.some((row) => row.uri === unapproved.toString() && row.diagnostics.length),
    'No intermediate publication can admit an unapproved document.',
  );
  assert.equal(
    vscode.languages
      .getDiagnostics(unapproved)
      .filter((row) => row.source === 'backstage-validation').length,
    0,
  );
  const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
    'vscode.executeCodeActionProvider',
    unapproved,
    documentRange(vscode.window.activeTextEditor!.document),
    vscode.CodeActionKind.QuickFix.value,
  );
  assert(!actions?.some((row) => guardedCommand(row)));
  assert(vscode.window.activeTextEditor!.document.getText().includes('lifecycle: experimental'));
}
