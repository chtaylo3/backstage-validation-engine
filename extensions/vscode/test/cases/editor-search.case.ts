import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { writeEvidence } from '../evidence.js';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';

export async function run(fixture: Fixture): Promise<void> {
  const directory = process.env.BVE_EXTENSION_TEST_CONTROL_DIRECTORY!;
  const document = await fixture.document();
  await fixture.diagnostic();
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
  const editor = vscode.window.activeTextEditor!;
  const owner = document.getText().indexOf('owner: team') + 'owner: '.length;
  assert(owner >= 'owner: '.length);
  editor.selection = new vscode.Selection(
    document.positionAt(owner),
    document.positionAt(owner + 4),
  );
  await vscode.commands.executeCommand('backstageValidation.searchReferences');
  await state('choose');
  await until(
    () => document.getText().includes('owner: group:default/team'),
    'reference selected through the native picker',
  );
  await fixture.currentDiagnostic(document);
  const selected = document.getText();
  await vscode.commands.executeCommand('backstageValidation.searchReferences');
  await state('cancel');
  assert.equal(document.getText(), selected);
  editor.selection = new vscode.Selection(
    document.positionAt(0),
    document.positionAt('apiVersion'.length),
  );
  await vscode.commands.executeCommand('backstageValidation.searchReferences');
  await state('hold-stale');
  const changed = selected + '# changed while search was open\n';
  await fixture.replace(document, changed);
  await state('accept-stale');
  assert.equal(
    document.getText(),
    changed,
    'A search opened before an edit cannot replace the captured selection.',
  );
  assert.equal(fixture.pid(), pid);
  fixture.note('native search selection, cancellation, and stale-selection guard passed');
  await writeEvidence(
    path.join(directory, 'search-control.json'),
    JSON.stringify({ step: 'complete' }),
  );
}
