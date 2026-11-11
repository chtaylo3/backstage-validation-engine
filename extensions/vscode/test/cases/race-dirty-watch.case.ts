import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import path from 'node:path';
import { writeEvidence } from '../evidence.js';
import { diagnosticPublications, diagnosticGeneration } from '../diagnostic-trace.js';
import { invalidTeam, team, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const main = await fixture.document();
  const pid = fixture.pid();
  await fixture.currentDiagnostic(main);
  const document = await vscode.workspace.openTextDocument(fixture.teamUri);
  await vscode.window.showTextDocument(document);
  await fixture.replace(document, team + '# unsaved buffer owns this file\n');
  assert(document.isDirty);
  // No catalog refresh exists in this fixture. Finish all preceding buffer work
  // before the sole external stimulus, then require a newer completed generation.
  const before = await fixture.observed(document);
  const version = document.version;
  const offset = (await fixture.trace()).length;
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(invalidTeam));
  await until(async () => {
    const trace = (await fixture.trace()).slice(offset);
    return (
      trace.includes("Sending notification 'workspace/didChangeWatchedFiles'") &&
      trace.includes(fixture.teamUri.toString())
    );
  }, 'exact native dependency watcher notification');
  const receipt = await fixture.api!.filesystemObservation();
  assert(receipt, 'The ordered projection must observe an admitted watcher event.');
  assert(
    receipt.uris.includes(fixture.teamUri.toString()),
    'The server must admit this exact dirty dependency watcher event.',
  );
  assert(
    receipt.generation > before.generation,
    'The watcher handler must invalidate after settled buffer validation.',
  );
  const after = await fixture.observed(document, receipt.generation - 1);
  assert.equal(
    after.sourceDigest,
    before.sourceDigest,
    'Disk invalidity cannot replace the authoritative dirty source.',
  );
  assert.equal(document.version, version);
  await fixture.alive(pid, main);
  await until(
    async () =>
      diagnosticPublications((await fixture.trace()).slice(offset)).some(
        (row) =>
          row.uri === main.uri.toString() &&
          row.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'production-only' &&
              (diagnosticGeneration(diagnostic) ?? -1) >= receipt.generation,
          ),
      ),
    'current-generation diagnostic publication after the admitted watcher',
  );
  await fixture.api!.filesystemObservation();
  const publications = diagnosticPublications((await fixture.trace()).slice(offset));
  await writeEvidence(
    path.join(
      path.dirname(process.env.BVE_EXTENSION_TEST_PROGRESS!),
      'dirty-watch-publications.json',
    ),
    JSON.stringify(publications, null, 2) + '\n',
  );
  assert(
    !publications.some(
      (row) =>
        row.uri === main.uri.toString() &&
        row.diagnostics.some((diagnostic) => diagnostic.code === 'owner-exists'),
    ),
    'No intermediate dirty-watch publication can use invalid disk content.',
  );
  assert.equal(fixture.has('owner-exists'), false);
  assert.equal(document.getText(), team + '# unsaved buffer owns this file\n');
  assert.equal(
    await document.save(),
    false,
    'External modification requires explicit conflict resolution.',
  );
  assert.equal(document.getText(), team + '# unsaved buffer owns this file\n');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await until(
    () => fixture.has('owner-exists'),
    'reverting the buffer admits the invalid saved dependency',
  );
  await vscode.workspace.fs.writeFile(fixture.teamUri, Buffer.from(team));
  await until(() => !fixture.has('owner-exists'), 'external repair clears dependency');
  await fixture.alive(pid, main);
}
