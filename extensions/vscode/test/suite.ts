import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import { Fixture, bounded } from './fixture.js';
import type { Progress } from './reporting.js';

export async function run(): Promise<void> {
  const fixture = new Fixture();
  const progress: Progress = {
    id: process.env.BVE_EXTENSION_TEST_CASE!,
    editorVersion: vscode.version,
    phase: 'setup',
    status: 'running',
    serverPids: [],
  };
  const file = process.env.BVE_EXTENSION_TEST_PROGRESS!;
  async function save() {
    progress.serverPids = [...fixture.pids];
    await writeFile(file + '.tmp', JSON.stringify(progress, null, 2) + '\n');
    await rename(file + '.tmp', file);
  }
  await save();
  try {
    const scenario = (await import(pathToFileURL(process.env.BVE_EXTENSION_TEST_MODULE!).href)) as {
      initialRunning?: boolean;
      run: (fixture: Fixture) => Promise<void>;
    };
    await fixture.setup(scenario.initialRunning !== false);
    assert.equal(typeof scenario.run, 'function', 'Discovered case must export run().');
    progress.phase = 'run';
    await save();
    if (process.env.BVE_EXTENSION_TEST_FAULT === 'assertion')
      assert.fail('Injected early assertion failure.');
    if (process.env.BVE_EXTENSION_TEST_FAULT === 'crash')
      await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
    await bounded(scenario.run(fixture), 'case ' + progress.id, 60_000);
  } catch (error) {
    progress.status = 'failed';
    progress.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    const previous = progress.phase;
    progress.phase = 'cleanup';
    await save();
    try {
      await fixture.cleanup();
      assert.notEqual(process.env.BVE_EXTENSION_TEST_FAULT, 'cleanup', 'Injected cleanup failure.');
      progress.phase = progress.status === 'failed' ? previous : 'complete';
      if (progress.status !== 'failed') progress.status = 'passed';
    } catch (error) {
      progress.status = 'failed';
      progress.error = [
        progress.error,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      ]
        .filter(Boolean)
        .join('\n');
    }
    await save();
  }
  assert.equal(progress.status, 'passed', progress.error);
  console.log(`BVE installed VSIX case passed: ${progress.id}`);
}
