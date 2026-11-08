import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { until, exited, invalidTeam, team } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  assert.equal(
    vscode.env.remoteName,
    process.env.BVE_EXTENSION_TEST_REMOTE_NAME,
    'Must be a real VS Code remote workspace host.',
  );
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(os.hostname(), process.env.BVE_EXTENSION_TEST_REMOTE_HOSTNAME);
  assert.equal(
    createHash('sha256')
      .update(process.env.BVE_EDITOR_CATALOG_TOKEN ?? '')
      .digest('hex'),
    process.env.BVE_EXTENSION_TEST_CREDENTIAL_SHA,
    'Credentials arrive through the native remote host environment, not driver injection.',
  );
  assert.equal(process.env.BVE_LSP_CONFIG, '/tmp/bve-env-selection-must-not-win.json');
  assert.equal(
    vscode.workspace.getConfiguration('backstageValidation').inspect<string>('configPath')
      ?.globalValue,
    process.env.BVE_EXTENSION_TEST_CONFIG,
    'The remote extension sees the selected User Setting.',
  );
  const extension = vscode.extensions.getExtension('chtaylo3.backstage-validation-engine')!;
  const build = JSON.parse(
    await readFile(path.join(extension.extensionPath, 'build-info.json'), 'utf8'),
  ) as { revision: string; target: string };
  assert.equal(build.revision, process.env.BVE_EXTENSION_TEST_REVISION);
  assert.equal(build.target, 'linux-x64');
  const pid = fixture.pid();
  assert.equal(
    await realpath(`/proc/${pid}/exe`),
    await realpath(path.join(extension.extensionPath, 'runtime/node')),
    'Remote workspace uses its Linux-target bundled runtime.',
  );
  const previous = await readFile(process.env.BVE_EXTENSION_TEST_CLOSE_MARKER!, 'utf8')
    .then((text) => JSON.parse(text) as { pid: number })
    .catch(() => undefined);
  if (previous) {
    await until(() => exited(previous.pid), 'disconnect reaped the previous remote server');
    assert.notEqual(pid, previous.pid);
  }
  const document = await fixture.document();
  await fixture.diagnostic();
  const original = document.getText();
  await until(async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(6, 11),
    );
    return list?.items.some((row) => row.label === 'group:default/team') === true;
  }, 'reference completion across the remote URI boundary');
  for (let version = 0; version < fixture.catalogs().length; version++) {
    await fixture.useCatalog(version);
    const cursor = await fixture.control({ op: 'cursor', version });
    await fixture.replace(
      document,
      document.getText().replace('owner: team', 'owner: remote-team'),
    );
    await fixture.currentDiagnostic(document);
    await fixture.control({ op: 'assert-read', version, after: Number(cursor.id) });
    assert(!fixture.has('owner-exists'));
    await fixture.replace(document, original);
    await fixture.currentDiagnostic(document);
  }
  await fixture.apply(await fixture.fix());
  await until(() => !fixture.has('production-only'), 'remote guarded fix');
  assert.equal(await document.save(), true);
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(invalidTeam));
  await until(
    () => fixture.has('owner-exists'),
    'remote native watcher observes an invalid reference',
  );
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(team));
  await until(
    () => !fixture.has('owner-exists'),
    'remote watcher repair clears the reference finding',
  );
  fixture.note(
    'remote host ' + vscode.env.remoteName + ' / ' + os.hostname() + ' / ' + document.uri.scheme,
  );
  await fixture.checkpoint();
  if (!previous) {
    await fixture.replace(document, original);
    assert.equal(await document.save(), true);
    await fixture.currentDiagnostic(document);
    await writeFile(
      process.env.BVE_EXTENSION_TEST_CLOSE_MARKER!,
      JSON.stringify({
        pid: fixture.pid(),
        remoteName: vscode.env.remoteName,
        hostname: os.hostname(),
        uri: document.uri.toString(),
        runtime: await realpath(`/proc/${pid}/exe`),
      }),
    );
    // The parent observes process death on the remote host before stopping it.
    try {
      await vscode.commands.executeCommand('workbench.action.quit');
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'Canceled') throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
  }
}
