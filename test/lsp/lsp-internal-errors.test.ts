import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContractError } from '../../src/base/errors.js';
import { CapabilityError } from '../../src/capabilities/admission.js';
import type { InternalErrorObserver } from '../../src/core/internal-errors.js';
import { formatEscapedError } from '../../src/host/internal-errors.js';
import { CelError } from '../../src/runtime/cel/errors.js';
import { runValidation } from '../../src/lsp/validation-run.js';
import { ManualClock } from '../harness/manual-clock.js';
import { componentText } from '../harness/policy-fixture.js';
import { FAKE_URI, fakeConfig } from '../harness/lsp-fake-connection.js';

type Inputs = Parameters<typeof runValidation>[1];
const OTHER = 'file:///workspace/other.yaml';
const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
const finding = (uri: string, ruleId: string, category: string, id: string) => ({
  id,
  ruleId,
  ruleVersion: ruleId === 'engine/internal_error' ? 'r1@1' : '1',
  subjectId: JSON.stringify([uri, 0]),
  message: `${ruleId} message`,
  category,
  severity: 'error',
  enforcement: 'advisory',
  location: { uri, document: 0, path: '', range },
  relatedLocations: [],
  edits: [],
});

void test('an internal-error finding is published on its document, other documents keep theirs, and no fixes are offered', async () => {
  const config = fakeConfig({ filesystem: false });
  const calls: string[] = [];
  const published = new Map<string, Diagnostic[]>();
  const documents = [FAKE_URI, OTHER].map((uri) =>
    Object.assign(TextDocument.create(uri, 'yaml', 2, componentText()), { lifetime: 1 }),
  );
  const observer: InternalErrorObserver = () => undefined;
  let forwarded: unknown;
  const report = {
    interrupted: 'none',
    rules: {
      failures: [
        { subjectId: JSON.stringify([FAKE_URI, 0]), ruleId: 'r1', code: 'internal_error' },
      ],
    },
    coverage: [],
    findings: [
      finding(FAKE_URI, 'engine/internal_error', 'execution', 'sha256:' + '1'.repeat(64)),
      finding(OTHER, 'r2', 'policy', 'sha256:' + '2'.repeat(64)),
    ],
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
    onInternalError: observer,
    snapshot: {
      generation: 1,
      diskGeneration: 1,
      capturedGeneration: 1,
      source: config.source,
      documents,
      allDocuments: new Map(documents.map((document) => [document.uri, document])),
    },
    workspace: {
      source: config.source,
      generation: 1,
      diskGeneration: 1,
      capturedGeneration: 1,
      commitCapture: () => true,
      approved: () => true,
      unavailableSources: false,
      capacityExceeded: false,
      isUnavailable: () => false,
    },
    filesystem: undefined,
    catalog: undefined,
    completion: { update: () => Promise.resolve() },
    editor: {
      update: () => Promise.resolve(),
      refine: () => Promise.resolve(),
      repairs: () => {
        calls.push('editor.repairs');
        return [];
      },
    },
    validation: {
      run: (_request: unknown, options: { onInternalError?: unknown }) => {
        forwarded = options.onInternalError;
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
    publish: (uri: string, _version: number, diagnostics: Diagnostic[]) => {
      published.set(uri, diagnostics);
      return Promise.resolve();
    },
  } as unknown as Inputs;
  await runValidation(
    { generation: 1, signal: new AbortController().signal, current: () => true },
    input,
  );
  assert.equal(forwarded, observer, 'the session observer reaches validation');
  assert.deepEqual(
    published.get(FAKE_URI)?.map((row) => [row.code, row.message]),
    [['engine/internal_error', 'engine/internal_error message']],
  );
  assert.deepEqual(
    published.get(OTHER)?.map((row) => row.code),
    ['r2'],
  );
  assert(!calls.includes('fixes.replace'), 'a run with an execution finding offers no fixes');
  assert(!calls.includes('editor.repairs'));
});

/** A one-document run whose validation service rejects with `failure`. */
async function failingRun(failure: Error, onUnexpectedError?: (error: unknown) => void) {
  const config = fakeConfig({ filesystem: false });
  const document = Object.assign(TextDocument.create(FAKE_URI, 'yaml', 2, componentText()), {
    lifetime: 1,
  });
  const published: Diagnostic[][] = [];
  const input = {
    clock: new ManualClock(),
    config,
    ...(onUnexpectedError ? { onUnexpectedError } : {}),
    snapshot: {
      generation: 1,
      diskGeneration: 1,
      capturedGeneration: 1,
      source: config.source,
      documents: [document],
      allDocuments: new Map([[FAKE_URI, document]]),
    },
    workspace: {
      source: config.source,
      generation: 1,
      diskGeneration: 1,
      capturedGeneration: 1,
      commitCapture: () => true,
      approved: () => true,
      unavailableSources: false,
      capacityExceeded: false,
      isUnavailable: () => false,
    },
    filesystem: undefined,
    catalog: undefined,
    completion: { update: () => Promise.resolve() },
    editor: { update: () => Promise.resolve(), refine: () => Promise.resolve() },
    validation: { run: () => Promise.reject(failure) },
    fixes: { replace: () => undefined, invalidate: () => undefined },
    fixesEnabled: true,
    configurationUnavailable: false,
    operations: undefined,
    publish: (_uri: string, _version: number, diagnostics: Diagnostic[]) => {
      published.push(diagnostics);
      return Promise.resolve();
    },
  } as unknown as Inputs;
  await runValidation(
    { generation: 1, signal: new AbortController().signal, current: () => true },
    input,
  );
  return published;
}
const MARKER = 'MARKER-lsp-content-8b1f';

void test('an unknown error that escapes validation is logged once, redacted, and diagnostics do not change', async () => {
  const lines: string[] = [];
  const failure = new TypeError(MARKER);
  const logged = await failingRun(failure, (error) => {
    assert.equal(error, failure);
    lines.push(formatEscapedError(error, false));
  });
  assert.deepEqual(lines, ['internal_error stage=validation type="TypeError"']);
  assert.deepEqual(logged, await failingRun(failure));
  assert(!JSON.stringify(logged).includes(MARKER));
  assert(formatEscapedError(failure, true).includes(MARKER));
});

void test('a typed failure that escapes validation logs nothing', async () => {
  for (const failure of [
    new CapabilityError('deadline', 'reply'),
    new ContractError('integrity', [{ path: '', message: MARKER }]),
    new CelError('request_timeout'),
  ]) {
    const lines: unknown[] = [];
    await failingRun(failure, (error) => lines.push(error));
    assert.deepEqual(lines, [], failure.name);
  }
});
