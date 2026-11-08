import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { exited, until } from './fixture.js';
import type { Api, Fixture } from './fixture.js';
interface State {
  stage: number;
  step: string;
  trusted: boolean;
  pid?: number;
}
export async function trustScenario(
  fixture: Fixture,
  mode: 'restricted' | 'grant' | 'revoke' | 'persisted' | 'unrelated',
): Promise<void> {
  const root = process.env.BVE_EXTENSION_TEST_CONTROL_DIRECTORY!;
  const stage = Number(process.env.BVE_EXTENSION_TEST_TRUST_STAGE ?? '0');
  const file = path.join(root, 'trust-control.json');
  const previous = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as State)
    .catch(() => undefined);
  const state = async (step: string, pid?: number) => {
    const value: State = {
      stage,
      step,
      trusted: vscode.workspace.isTrusted,
      ...(pid ? { pid } : {}),
    };
    await writeFile(file + '.tmp', JSON.stringify(value));
    await rename(file + '.tmp', file);
    fixture.note('trust UI step: ' + step);
    await fixture.checkpoint();
  };
  const capture = async (step: string) => {
    await state(step);
    await until(async () => {
      const ack = await readFile(path.join(root, 'trust-ack.json'), 'utf8')
        .then((text) => JSON.parse(text) as State)
        .catch(() => undefined);
      return ack?.stage === stage && ack.step === step;
    }, 'UI capture acknowledgement for ' + step);
  };
  assert.equal(
    vscode.workspace.getConfiguration('security.workspace.trust').get('enabled', true),
    true,
    'Trust enforcement stays enabled.',
  );
  const overrides = vscode.workspace
    .getConfiguration('extensions')
    .get<Record<string, unknown>>('supportUntrustedWorkspaces', {});
  assert.equal(
    overrides['chtaylo3.backstage-validation-engine'],
    undefined,
    'No product trust override is permitted.',
  );
  async function restricted() {
    assert.equal(vscode.workspace.isTrusted, false);
    assert.notEqual(
      vscode.extensions.getExtension('chtaylo3.backstage-validation-engine')?.isActive,
      true,
    );
    const document = await fixture.document();
    assert.equal(
      vscode.languages
        .getDiagnostics(document.uri)
        .filter((row) => row.source === 'backstage-validation').length,
      0,
    );
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      document.uri,
      new vscode.Range(5, 0, 5, 30),
    );
    assert(!actions?.some((row) => row.command?.command === 'bve.applyFix'));
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(6, 11),
    );
    assert(!completions?.items.some((row) => row.label === 'group:default/team'));
    assert.equal((await vscode.commands.getCommands(true)).includes('bve.applyFix'), false);
  }
  async function trusted() {
    await fixture.trustedActivation();
    await fixture.document();
    await fixture.diagnostic();
    assert(vscode.extensions.getExtension<Api>('chtaylo3.backstage-validation-engine')!.isActive);
  }
  if (mode === 'revoke' && previous?.step === 'revoke') {
    assert(previous.pid);
    await until(() => exited(previous.pid!), 'revocation/reload terminates the old server');
    await restricted();
    await capture('capture-revoked');
    await state('done');
    return;
  }
  if (stage === 1) {
    assert(previous?.pid);
    await until(() => exited(previous.pid!), 'previous editor session server has exited');
    if (mode === 'persisted') {
      assert.equal(
        vscode.workspace.isTrusted,
        true,
        'A new editor process honors the UI-persisted folder decision.',
      );
      await trusted();
      assert.notEqual(fixture.pid(), previous.pid);
      await capture('capture-persisted');
    } else {
      assert.equal(mode, 'unrelated');
      await restricted();
      await capture('capture-unrelated');
    }
    await state('done');
    return;
  }
  await restricted();
  await capture('capture-restricted');
  if (mode === 'restricted') {
    await state('done');
    return;
  }
  await state('grant');
  await trusted();
  await capture('capture-granted');
  if (mode === 'grant') {
    const document = await fixture.document();
    await fixture.apply(await fixture.fix());
    await until(
      () => document.getText().includes('lifecycle: "production"'),
      'fix works after real consent',
    );
    await until(() => !fixture.has('production-only'), 'diagnostics clear in trusted workspace');
    assert.equal(await document.save(), true);
    await state('done');
    return;
  }
  if (mode === 'revoke') {
    await state('revoke', fixture.pid());
    // The normal workbench reloads and reactivates this driver; the next
    // invocation verifies the disabled product and the previous PID's exit.
    await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
    throw new Error('Trust revocation did not reload the workbench.');
  }
  await state('reopen', fixture.pid());
}
