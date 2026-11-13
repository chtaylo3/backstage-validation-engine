import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { runValidation } from '../../src/lsp/validation-run.js';
import { componentText } from '../harness/policy-fixture.js';
import { FAKE_URI, fakeConfig } from '../harness/lsp-fake-connection.js';

type Inputs = Parameters<typeof runValidation>[1];

/**
 * A validation run over stub collaborators. `current()` arms a one-shot staleness flip: the first
 * `current()` call after `arm()` still returns true, and queues a microtask that makes the run
 * stale. That microtask runs before the caller of the step that made the call resumes, the way a
 * reload or invalidation settling in the same tick would.
 */
function harness(options: { filesystem: boolean; armIn: 'capture' | 'refine' | 'never' }) {
  const config = fakeConfig({ filesystem: options.filesystem });
  const calls: string[] = [];
  let stale = false;
  let armed = false;
  const arm = () => {
    armed = true;
  };
  const current = () => {
    if (armed) {
      armed = false;
      queueMicrotask(() => {
        stale = true;
      });
    }
    return !stale;
  };
  const text = componentText();
  const document = Object.assign(TextDocument.create(FAKE_URI, 'yaml', 2, text), { lifetime: 1 });
  const report = {
    interrupted: 'none',
    rules: { failures: [] },
    coverage: [],
    findings: [],
    failureEvidence: [],
    request: {
      source: { digest: 'sha256:source' },
      policy: { digest: 'sha256:policy' },
      profile: { digest: 'sha256:profile' },
      activation: { digest: 'sha256:activation' },
      data: { entries: [] },
    },
  };
  const input = {
    config,
    snapshot: {
      generation: 1,
      diskGeneration: 1,
      capturedGeneration: 0,
      source: config.source,
      documents: [document],
      allDocuments: new Map([[FAKE_URI, document]]),
    },
    workspace: {
      source: config.source,
      generation: 1,
      diskGeneration: 1,
      capturedGeneration: options.filesystem ? 0 : 1,
      commitCapture: () => {
        calls.push('commitCapture');
        return true;
      },
      approved: () => true,
      unavailableSources: false,
      capacityExceeded: false,
      isUnavailable: () => false,
    },
    filesystem: options.filesystem
      ? {
          files: [FAKE_URI],
          capture: (base: unknown) => {
            calls.push('capture');
            if (options.armIn === 'capture') arm();
            return Promise.resolve(base);
          },
          close: () => Promise.resolve(),
        }
      : undefined,
    catalog: undefined,
    completion: {
      update: () => {
        calls.push('completion.update');
        return Promise.resolve();
      },
    },
    editor: {
      update: () => {
        calls.push('editor.update');
        return Promise.resolve();
      },
      refine: () => {
        calls.push('editor.refine');
        if (options.armIn === 'refine') arm();
        return Promise.resolve();
      },
      repairs: () => {
        calls.push('editor.repairs');
        return [];
      },
    },
    validation: {
      run: () => {
        calls.push('validation.run');
        return Promise.resolve(report);
      },
    },
    fixes: {
      replace: () => calls.push('fixes.replace'),
      invalidate: () => calls.push('fixes.invalidate'),
    },
    fixesEnabled: true,
    configurationUnavailable: false,
    operations: undefined,
    observeCoverage: () => calls.push('observeCoverage'),
    publish: () => {
      calls.push('publish');
      return Promise.resolve();
    },
  } as unknown as Inputs;
  const run = () =>
    runValidation({ generation: 1, signal: new AbortController().signal, current }, input);
  return { run, calls };
}

void test('a run that becomes stale as the execute step returns has no further effects', async () => {
  const { run, calls } = harness({ filesystem: false, armIn: 'refine' });
  await run();
  assert.deepEqual(calls, [
    'completion.update',
    'editor.update',
    'validation.run',
    'editor.refine',
  ]);
});

void test('a run that becomes stale as the capture step returns starts no validation work', async () => {
  const { run, calls } = harness({ filesystem: true, armIn: 'capture' });
  await run();
  assert.deepEqual(calls, ['capture', 'commitCapture']);
});

void test('the same stub run observes coverage, replaces fixes and publishes while it stays current', async () => {
  for (const filesystem of [false, true]) {
    const { run, calls } = harness({ filesystem, armIn: 'never' });
    await run();
    assert.deepEqual(calls, [
      ...(filesystem ? ['capture', 'commitCapture'] : []),
      'completion.update',
      'editor.update',
      'validation.run',
      'editor.refine',
      'observeCoverage',
      'editor.repairs',
      'fixes.replace',
      'publish',
    ]);
  }
});
