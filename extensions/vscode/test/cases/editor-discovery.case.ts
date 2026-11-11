import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { configuration, reload } from '../configuration.js';
import { until, guardedCommand, documentRange } from '../fixture.js';
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
  for (const [uri, entity] of [
    [discovered, 'included-control'],
    [excluded, 'excluded-control'],
    [nonmatching, 'nonmatching-control'],
  ] as const) {
    await mkdir(path.dirname(uri.fsPath), { recursive: true });
    await writeFile(
      uri.fsPath,
      main.getText().replace('{name: service}', '{name: ' + entity + '}'),
    );
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
      documentRange(vscode.window.activeTextEditor!.document),
      vscode.CodeActionKind.QuickFix.value,
    );
    assert(!actions?.some((row) => guardedCommand(row)));
  }
  const beforeDepth = await fixture.observed(main);
  const traceOffset = (await fixture.trace()).length;
  const deep = path.join(root, ...Array<string>(34).fill('depth'));
  await mkdir(deep, { recursive: true });
  await writeFile(
    path.join(deep, 'catalog-info.yaml'),
    main.getText().replace('{name: service}', '{name: depth-control}'),
  );
  // Older native watchers coalesce newly created deep subtrees into directory
  // events. Use an existing approved file for a precise second rescan pulse.
  await until(async () => {
    const trace = (await fixture.trace()).slice(traceOffset);
    return (
      trace.includes("Sending notification 'workspace/didChangeWatchedFiles'") &&
      trace.includes(vscode.Uri.file(path.join(root, 'depth')).toString())
    );
  }, 'native creation notification for the discovered subtree');
  const firstReceipt = await fixture.api!.filesystemObservation();
  assert(firstReceipt && firstReceipt.generation > beforeDepth.generation);
  const pulseOffset = (await fixture.trace()).length;
  await vscode.workspace.fs.writeFile(
    fixture.teamUri,
    Buffer.from((await readFile(fixture.teamUri.fsPath, 'utf8')) + '# discovery rescan pulse\n'),
  );
  await until(async () => {
    const trace = (await fixture.trace()).slice(pulseOffset);
    return (
      trace.includes("Sending notification 'workspace/didChangeWatchedFiles'") &&
      trace.includes(fixture.teamUri.toString())
    );
  }, 'precise native rescan pulse after complete subtree creation');
  const depthReceipt = await fixture.api!.filesystemObservation();
  assert(
    depthReceipt &&
      depthReceipt.generation > firstReceipt.generation &&
      depthReceipt.uris.includes(fixture.teamUri.toString()),
    'The server must admit the exact rescan pulse after the complete deep fixture exists.',
  );
  await fixture.replace(main, main.getText() + '# depth-bound processing after admitted watcher\n');
  await until(
    () =>
      vscode.languages
        .getDiagnostics(main.uri)
        .some(
          (row) =>
            (row as vscode.Diagnostic & { data?: { version: number } }).data?.version ===
            main.version,
        ),
    'current-version validation after the discovery depth stimulus',
  );
  assert(
    fixture.has('validation/incomplete'),
    'Discovery above 32 directory levels must publish incomplete.',
  );
  const bound = vscode.languages
    .getDiagnostics(main.uri)
    .find((row) => row.code === 'validation/incomplete') as vscode.Diagnostic & {
    data: { execution: { stage: string; cause: string }[] };
  };
  assert(
    bound.data.execution.some(
      (row) => row.stage === 'filesystem' && row.cause === 'snapshot_unavailable',
    ),
    'Public failure evidence must identify unavailable filesystem capture.',
  );
  assert.equal(fixture.pid(), pid);
  const old = await fixture.provider<(vscode.CodeAction | vscode.Command)[]>(
    'vscode.executeCodeActionProvider',
    main.uri,
    documentRange(main),
    vscode.CodeActionKind.QuickFix.value,
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
    documentRange(main),
    vscode.CodeActionKind.QuickFix.value,
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
