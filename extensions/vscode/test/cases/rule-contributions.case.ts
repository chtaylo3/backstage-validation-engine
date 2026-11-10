import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until, guardedCommand } from '../fixture.js';
import type { Fixture } from '../fixture.js';

export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const position = new vscode.Position(6, 9),
    range = new vscode.Range(position, position);
  const version = document.version,
    text = document.getText(),
    pid = fixture.pid();
  await fixture.diagnostic('owner-pattern');
  await fixture.diagnostic('owner-re2');
  const choices = async () =>
    (
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        fixture.uri,
        position,
      )
    )?.items ?? [];
  const checked = async (name: string) =>
    (await choices()).some((item) => item.label === name && item.detail?.includes('Checked rule'));
  await until(
    () => checked('remote-team'),
    'CEL and RE2 candidates pass the required catalog check',
  );
  assert(!(await checked('remote-missing')), 'A pattern match cannot prove catalog existence.');
  await until(async () => {
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      fixture.uri,
      new vscode.Position(6, 3),
    );
    return hover?.some((row) =>
      row.contents.some((content) =>
        (typeof content === 'string' ? content : content.value)
          .replaceAll('&nbsp;', ' ')
          .includes('Remote ownership rule'),
      ),
    );
  }, 'Prepared rule hover remains available after dependency refresh');
  await fixture.control({ op: 'add-refresh' });
  await until(
    () => checked('remote-refresh'),
    'Candidate-only remote addition refreshes unchanged source hints',
  );
  assert.equal(document.version, version);
  const actions = async () =>
    (await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
      'vscode.executeCodeActionProvider',
      fixture.uri,
      range,
      vscode.CodeActionKind.QuickFix.value,
    )) ?? [];
  let stale: vscode.Command | undefined;
  await until(async () => {
    stale = (await actions())
      .map(guardedCommand)
      .find(
        (row) =>
          row?.title.includes('"remote-refresh"') &&
          row.title.includes('checked rule owner-pattern'),
      );
    return !!stale;
  }, 'Prepared CEL repair traverses the guarded command path');
  await fixture.control({ op: 'remove-refresh' });
  await until(
    async () => !(await checked('remote-refresh')),
    'Candidate-only removal revokes its proof and repair',
  );
  const rejected = await vscode.commands.executeCommand<{ applied: boolean }>(
    stale!.command,
    ...(stale!.arguments as unknown[]),
  );
  assert.equal(rejected?.applied, false);
  assert.equal(document.getText(), text);
  assert.equal(document.version, version);
  let repair: vscode.Command | undefined;
  await until(async () => {
    repair = (await actions())
      .map(guardedCommand)
      .find(
        (row) =>
          row?.title.includes('"remote-team"') && row.title.includes('checked rule owner-pattern'),
      );
    return !!repair;
  }, 'A current repair remains available for the still-existing team');
  await fixture.apply(repair!);
  await until(
    () => document.getText().includes('owner: "remote-team"'),
    'Explicit CEL repair changes exactly the authored owner scalar',
  );
  await until(
    () => !fixture.has('owner-pattern') && !fixture.has('owner-re2'),
    'CEL and RE2 agree after the real editor change',
  );
  assert(fixture.has('production-only'), 'Unrelated validation remains authoritative.');
  assert.equal(fixture.pid(), pid);
  fixture.note(
    'Finite CEL/RE2 choices collected fresh catalog facts, refreshed candidate-only dependencies without edits, rejected a stale token, and passed post-edit validation.',
  );
}
