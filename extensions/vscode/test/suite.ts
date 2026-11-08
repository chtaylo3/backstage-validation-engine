import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';

interface Api {
  status(): { running: boolean; pid?: number };
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, description: string) {
  const end = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('Timed out: ' + description);
    await pause(30);
  }
}
export async function run(): Promise<void> {
  const root = process.env.BVE_EXTENSION_TEST_WORKSPACE!;
  const installed = process.env.BVE_EXTENSION_TEST_INSTALL!;
  const extension = vscode.extensions.getExtension<Api>('chtaylo3.backstage-validation-engine');
  assert(extension, 'Installed VSIX must be discoverable.');
  assert(
    path.resolve(extension.extensionPath).startsWith(path.resolve(installed) + path.sep),
    'Test the installed VSIX, not a development override.',
  );
  const api = await extension.activate();
  await until(() => api.status().running, 'packaged server startup');
  const pid = api.status().pid;
  assert(pid);
  const uri = vscode.Uri.file(path.join(root, 'catalog.yaml'));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  await until(
    () => vscode.languages.getDiagnostics(uri).some((row) => row.code === 'production-only'),
    'schema diagnostics from the packaged server',
  );
  const position = new vscode.Position(6, 11);
  await until(async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      position,
    );
    return list.items.some((row) => row.label === 'group:default/team');
  }, 'reference completion through the installed language client');
  const diagnostic = vscode.languages
    .getDiagnostics(uri)
    .find((row) => row.code === 'production-only')!;
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    'vscode.executeCodeActionProvider',
    uri,
    diagnostic.range,
    vscode.CodeActionKind.QuickFix.value,
  );
  const action = actions.find((row) => row.command?.command === 'bve.applyFix');
  assert(action?.command);
  await vscode.commands.executeCommand(
    action.command.command,
    ...(action.command.arguments as unknown[]),
  );
  await until(
    () => document.getText().includes('lifecycle: "production"'),
    'versioned editor applyEdit',
  );
  await until(
    () => !vscode.languages.getDiagnostics(uri).some((row) => row.code === 'production-only'),
    'diagnostics clear after real didChange',
  );
  // Previously offered commands cannot be replayed after a real editor version change.
  const replay: unknown = await vscode.commands.executeCommand(
    action.command.command,
    ...(action.command.arguments as unknown[]),
  );
  assert.deepEqual(replay, { applied: false, reason: 'stale' });
  await document.save();
  const teamUri = vscode.Uri.file(path.join(root, 'team.yaml'));
  await vscode.workspace.fs.writeFile(
    teamUri,
    Buffer.from(
      'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {}\n',
    ),
  );
  await until(
    () => vscode.languages.getDiagnostics(uri).some((row) => row.code === 'owner-exists'),
    'saved-file watcher refresh invalidates a native-invalid target',
  );
  const team =
    'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {type: team, children: []}\n';
  await vscode.workspace.fs.writeFile(teamUri, Buffer.from(team));
  await until(
    () => !vscode.languages.getDiagnostics(uri).some((row) => row.code === 'owner-exists'),
    'watcher repair revalidates',
  );
  await vscode.commands.executeCommand('backstageValidation.stop');
  assert.equal(api.status().running, false);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'server process exits after shutdown');
  await vscode.commands.executeCommand('backstageValidation.restart');
  await until(() => api.status().running, 'restart the packaged runtime');
  assert.notEqual(api.status().pid, pid);
  await vscode.commands.executeCommand('backstageValidation.stop');
  console.log(
    'BVE installed VSIX: startup, diagnostics, completion, versioned fixes, stale replay, save/watch repair, restart and shutdown passed.',
  );
}
