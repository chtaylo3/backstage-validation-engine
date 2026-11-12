import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { until, guardedCommand } from '../fixture.js';
import type { Fixture } from '../fixture.js';
import { configuration, reload } from '../configuration.js';
import { digestJson } from '../../../../src/core/json.js';

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
      await fixture.provider<vscode.CompletionList>(
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
    const hover = await fixture.provider<vscode.Hover[]>(
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
    (await fixture.provider<(vscode.CodeAction | vscode.Command)[]>(
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
  await fixture.alive(pid, document);
  assert.equal(fixture.pid(), pid);
  fixture.note(
    'Finite CEL/RE2 choices collected fresh catalog facts, refreshed candidate-only dependencies without edits, rejected a stale token, and passed post-edit validation.',
  );
  const initial = await configuration();
  const repairedText = document.getText(),
    repairedVersion = document.version;
  try {
    for (const [expression, blocked] of [
      ["{'a': 1, 'a': 2}['a'] == 2", true],
      ['{entity.kind: 1, entity.kind: 2}[entity.kind] == 2', true],
      ['{entity.kind: 1, entity.apiVersion: 2}[entity.kind] == 2', false],
    ] as const) {
      const before = await fixture.observed(document);
      const policy = {
        ...initial.policy,
        rules: [
          ...initial.policy.rules,
          {
            id: 'map-keys',
            version: '1',
            kind: 'cel' as const,
            mandatory: true,
            severity: 'error' as const,
            requires: [],
            selector: 'entity.kind == "Component"',
            expression,
          },
        ],
      };
      await reload(
        {
          ...initial,
          policy,
          editorArtifacts: [],
          activation: { ...initial.activation, policyDigest: digestJson(policy) },
        },
        fixture,
      );
      const observation = await fixture.observed(document, before.generation);
      assert.equal(observation.policyDigest, digestJson(policy));
      const coverage = observation.coverage.find(
        (row) =>
          row.stage === 'rules' &&
          row.subject ===
            JSON.stringify([JSON.stringify([document.uri.toString(), 0]), 'map-keys']),
      );
      assert(coverage?.required);
      assert.equal(coverage.status, blocked ? 'blocked' : 'verified');
      await until(
        () =>
          fixture.has('validation/incomplete') === blocked && fixture.has('map-keys') === !blocked,
        'installed duplicate-key failure or distinct-key violation',
      );
      await fixture.alive(pid, document);
      assert.equal(document.getText(), repairedText);
      assert.equal(document.version, repairedVersion);
    }
  } finally {
    await reload(initial, fixture);
  }
  fixture.note(
    'Pinned CEL rejects literal/computed duplicate keys and recovers with distinct keys through the installed client.',
  );
}
