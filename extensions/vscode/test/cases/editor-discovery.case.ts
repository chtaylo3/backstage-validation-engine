import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { configuration, reload } from '../configuration.js';
import { until, guardedCommand } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const main = await fixture.document();
  await fixture.currentDiagnostic(main);
  const pid = fixture.pid();
  const choices = () =>
    fixture.provider<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      main.uri,
      new vscode.Position(5, 13),
    );
  assert((await choices()).items.some((item) => item.label === 'production'));
  const initial = await configuration();
  const root = process.env.BVE_EXTENSION_TEST_WORKSPACE!;
  const discovered = vscode.Uri.file(path.join(root, 'selected/catalog-info.yaml'));
  const excluded = vscode.Uri.file(path.join(root, 'excluded/catalog-info.yaml'));
  const nonmatching = vscode.Uri.file(path.join(root, 'selected/secret.yaml'));
  for (const uri of [discovered, excluded, nonmatching]) {
    await mkdir(path.dirname(uri.fsPath), { recursive: true });
    await writeFile(uri.fsPath, main.getText().replace('{name: service}', '{name: discovered}'));
  }
  const selected = {
    ...initial,
    filesystem: {
      ...initial.filesystem!,
      discovery: {
        roots: [initial.source.rootUri!],
        include: ['**/catalog-info.yaml'],
        exclude: ['**/excluded/**'],
      },
    },
  };
  await reload(selected, fixture);
  await vscode.commands.executeCommand('vscode.open', discovered);
  const document = vscode.window.activeTextEditor!.document;
  await fixture.alive(pid, document);
  await fixture.observed(document);
  for (const uri of [excluded, nonmatching]) {
    await vscode.commands.executeCommand('vscode.open', uri);
    await fixture.replace(main, main.getText() + '# approved discovery absence barrier\n');
    await fixture.alive(pid, main);
    assert.equal(
      vscode.languages.getDiagnostics(uri).filter((row) => row.source === 'backstage-validation')
        .length,
      0,
    );
    const actions = await fixture.provider<(vscode.CodeAction | vscode.Command)[]>(
      'vscode.executeCodeActionProvider',
      uri,
      new vscode.Range(5, 0, 5, 30),
    );
    assert(!actions?.some((row) => guardedCommand(row)));
  }
  const deep = path.join(root, ...Array<string>(34).fill('depth'));
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, 'catalog-info.yaml'), main.getText());
  await fixture.replace(main, main.getText() + '# depth-bound processing\n');
  await until(
    () => fixture.has('validation/incomplete'),
    'installed discovery depth cap fails closed',
  );
  assert.equal(fixture.pid(), pid);
  const old = await fixture.provider<(vscode.CodeAction | vscode.Command)[]>(
    'vscode.executeCodeActionProvider',
    main.uri,
    new vscode.Range(5, 0, 5, 30),
  );
  assert(!old?.some((row) => guardedCommand(row)));
  await rm(path.join(root, 'depth'), { recursive: true });
  await reload(selected, fixture);
  await fixture.alive(pid, main);
  await fixture.observed(main);
  await writeFile(process.env.BVE_EXTENSION_TEST_CONFIG!, '{');
  await vscode.commands.executeCommand('backstageValidation.reloadConfiguration');
  await until(
    () => fixture.has('validation/incomplete'),
    'invalid trusted reload publishes incomplete',
  );
  assert(
    (await fixture.trace()).includes(
      'Validation is unavailable until the trusted configuration can be loaded.',
    ),
  );
  const unavailable = await fixture.provider<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    main.uri,
    new vscode.Position(5, 13),
  );
  assert(
    !unavailable.items.some(
      (item) => item.label === 'production' || item.label === 'group:default/team',
    ),
    'Unavailable product contributes no trusted lifecycle/reference suggestions.',
  );
  const unavailableActions = await fixture.provider<(vscode.CodeAction | vscode.Command)[]>(
    'vscode.executeCodeActionProvider',
    main.uri,
    new vscode.Range(5, 0, 5, 30),
  );
  assert(!unavailableActions?.some((row) => guardedCommand(row)));
  assert.equal(fixture.pid(), pid);
  await reload(initial, fixture);
  await fixture.alive(pid, main);
  await fixture.observed(main);
  await fixture.fix();
  assert((await choices()).items.some((item) => item.label === 'production'));
  assert.equal(fixture.has('validation/incomplete'), false);
  fixture.note(
    'installed include/exclude, discovery depth cap, fail-closed reload and same-PID recovery',
  );
}
