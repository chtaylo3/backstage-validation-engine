import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { writeEvidence } from '../evidence.js';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';

export async function run(fixture: Fixture): Promise<void> {
  const directory = process.env.BVE_EXTENSION_TEST_CONTROL_DIRECTORY!;
  const pid = fixture.pid();
  const state = async (step: string) => {
    await writeEvidence(path.join(directory, 'search-control.json'), JSON.stringify({ step }));
    await until(async () => {
      const value = JSON.parse(
        await readFile(path.join(directory, 'search-ack.json'), 'utf8').catch(() => '{}'),
      ) as { step?: string };
      return value.step === step;
    }, 'native search UI action: ' + step);
  };
  if (process.env.BVE_EXTENSION_TEST_SEARCH_STAGE === '1') {
    assert.equal(vscode.window.activeTextEditor, undefined);
    await vscode.env.clipboard.writeText('persisted-cancel-sentinel');
    const pending = vscode.commands.executeCommand('backstageValidation.searchReferences');
    await state('persisted');
    await pending;
    assert.equal(await vscode.env.clipboard.readText(), 'persisted-cancel-sentinel');
    const document = await fixture.document();
    await fixture.currentDiagnostic(document);
    const list = await fixture.provider<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(6, document.lineAt(6).text.length),
    );
    const references = list.items.filter(
      (item) => item.label === 'group:default/team' || item.label === 'group:default/team-z',
    );
    assert.equal(references.length, 2);
    references.sort((a, b) => a.sortText!.localeCompare(b.sortText!));
    assert.equal(
      references[0]!.label,
      'group:default/team-z',
      'Fresh activation must restore actual installed completion history ranking.',
    );
    await writeEvidence(
      path.join(directory, 'persisted-completion-ranking.json'),
      JSON.stringify(
        references.map((item) => ({ label: item.label, sortText: item.sortText })),
        null,
        2,
      ),
    );
    fixture.note(
      'fresh activation restores selected-reference ranking in actual installed completion',
    );
    await writeEvidence(
      path.join(directory, 'search-control.json'),
      JSON.stringify({ step: 'complete' }),
    );
    return;
  }
  const document = await fixture.document();
  await fixture.diagnostic();
  const editor = vscode.window.activeTextEditor!;
  const owner = document.getText().indexOf('owner: team') + 'owner: '.length;
  assert(owner >= 'owner: '.length);
  editor.selection = new vscode.Selection(
    document.positionAt(owner),
    document.positionAt(owner + 4),
  );
  let pending = vscode.commands.executeCommand('backstageValidation.searchReferences');
  await state('choose');
  await pending;
  await until(
    () => document.getText().includes('owner: group:default/team'),
    'reference selected through the native picker',
  );
  await fixture.currentDiagnostic(document);
  const selected = document.getText();
  pending = vscode.commands.executeCommand('backstageValidation.searchReferences');
  await state('cancel');
  await pending;
  assert.equal(document.getText(), selected);
  editor.selection = new vscode.Selection(
    document.positionAt(0),
    document.positionAt('apiVersion'.length),
  );
  let staleCompleted = false;
  pending = vscode.commands.executeCommand('backstageValidation.searchReferences').then(() => {
    staleCompleted = true;
  });
  await state('hold-stale');
  assert.equal(
    staleCompleted,
    false,
    'Search command must stay pending while the native picker remains open.',
  );
  const changed = selected + '# changed while search was open\n';
  await fixture.replace(document, changed);
  await state('accept-stale');
  await pending;
  assert(
    (await fixture.trace()).includes(
      'The document changed during search. Run Search Entity References again.',
    ),
  );
  assert.equal(
    document.getText(),
    changed,
    'A search opened before an edit cannot replace the captured selection.',
  );
  await fixture.currentDiagnostic(document);
  assert.equal(fixture.pid(), pid);
  assert.equal(await document.save(), true);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  assert.equal(vscode.window.activeTextEditor, undefined);
  await vscode.env.clipboard.writeText('clipboard-sentinel');
  pending = vscode.commands.executeCommand('backstageValidation.searchReferences');
  await state('clipboard');
  await pending;
  assert.equal(await vscode.env.clipboard.readText(), 'group:default/team-z');
  fixture.note('no-editor native picker selection copies to actual clipboard and persists history');
  fixture.note('native search selection, cancellation, and stale-selection guard passed');
  await writeEvidence(
    path.join(directory, 'search-control.json'),
    JSON.stringify({ step: 'complete' }),
  );
}
