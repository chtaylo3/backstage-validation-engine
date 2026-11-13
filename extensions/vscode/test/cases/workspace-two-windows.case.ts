import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { exited, until } from '../fixture.js';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const peer = process.env.BVE_EXTENSION_TEST_PEER!;
  const root = process.env.BVE_EXTENSION_TEST_PEER_CONTROL!;
  const pid = fixture.pid();
  async function mark(event: string) {
    const file = path.join(root, peer + '.' + event + '.json');
    await writeFile(
      file + '.tmp',
      JSON.stringify({ peer, event, pid, at: Date.now(), running: fixture.api!.status().running }),
    );
    await rename(file + '.tmp', file);
  }
  async function wait(name: string) {
    let observation: { pid: number } | undefined;
    await until(async () => {
      const value = await readFile(path.join(root, name + '.json'), 'utf8').catch(() => undefined);
      if (value) observation = JSON.parse(value) as { pid: number };
      return !!observation;
    }, name);
    return observation!;
  }
  const document = await fixture.document();
  const original = document.getText();
  await fixture.currentDiagnostic(document);
  await mark('ready');
  assert.notEqual(
    (await wait((peer === 'a' ? 'b' : 'a') + '.ready')).pid,
    pid,
    'Concurrent windows own distinct server processes.',
  );
  if (peer === 'a') {
    const text = original
      .replace('lifecycle: experimental', 'lifecycle: production')
      .replace('owner: team', 'owner: missing');
    await fixture.replace(document, text);
    await until(() => !fixture.has('production-only'), 'first window validates its private buffer');
    await fixture.missingOwner(document);
    assert(fixture.has('owner-exists'));
    await fixture.alive(pid, document, 'owner-exists');
    await mark('edited');
    await wait('b.edited');
    assert.equal(document.getText(), text, 'Other window cannot replace this buffer.');
    await vscode.commands.executeCommand('backstageValidation.stop');
    await until(() => exited(pid), 'first window server exits');
    await mark('stopped');
    await wait('b.observed');
  } else {
    await wait('a.edited');
    assert.equal(document.getText(), original, 'First window unsaved edits stay private.');
    await fixture.replace(document, original.replace('owner: team', 'owner: missing'));
    await fixture.currentDiagnostic(document);
    await fixture.missingOwner(document);
    await fixture.apply(await fixture.fix());
    await until(
      () => document.getText().includes('lifecycle: "stable"'),
      'second authority applies its own policy',
    );
    await until(
      () => !fixture.has('production-only'),
      'second window validates its own guarded repair',
    );
    await fixture.missingOwner(document);
    assert(fixture.has('owner-exists'));
    await fixture.alive(pid, document, 'owner-exists');
    await mark('edited');
    await wait('a.stopped');
    assert.equal(
      fixture.api!.status().running,
      true,
      'Stopping first window cannot stop this server.',
    );
    await fixture.replace(document, original);
    await fixture.currentDiagnostic(document);
    assert(fixture.has('production-only'));
    assert.equal(
      Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8'),
      original,
      'Neither private buffer overwrites disk.',
    );
    await mark('observed');
  }
}
