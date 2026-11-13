import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  await fixture.diagnostic('owner-exists');
  const text = document.getText(),
    version = document.version,
    pid = fixture.pid();
  const cursor = await fixture.control({ op: 'cursor' });
  const startedAt = Date.now();
  await fixture.control({ op: 'add-refresh' });
  await until(
    () => !fixture.has('owner-exists'),
    'remote-only addition clears the missing-reference diagnostic',
  );
  fixture.note('Remote addition to cleared diagnostic: ' + (Date.now() - startedAt) + ' ms.');
  await fixture.control({ op: 'assert-read', after: Number(cursor.id) });
  const choices = async () =>
    (
      await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        fixture.uri,
        new vscode.Position(6, 16),
      )
    )?.items ?? [];
  await until(
    async () => (await choices()).some((row) => row.label === 'group:default/remote-refresh'),
    'A subsequent completion request receives the added team.',
  );
  assert(fixture.has('production-only'), 'Independent validation stays active.');
  await fixture.alive(pid, document);
  await fixture.control({ op: 'remove-refresh' });
  await fixture.diagnostic('owner-exists');
  await until(
    async () => !(await choices()).some((row) => row.label === 'group:default/remote-refresh'),
    'A subsequent completion request excludes the removed team.',
  );
  const diagnostic = vscode.languages
    .getDiagnostics(document.uri)
    .find((row) => row.code === 'owner-exists')!;
  assert.equal(
    (diagnostic as vscode.Diagnostic & { data: { version: number } }).data.version,
    version,
  );
  assert.equal(document.version, version);
  assert.equal(document.getText(), text);
  await fixture.alive(pid, document);
  assert.equal(fixture.pid(), pid);
  fixture.note(
    'Catalog addition and removal changed diagnostics at the same document version without save or reload.',
  );
}
