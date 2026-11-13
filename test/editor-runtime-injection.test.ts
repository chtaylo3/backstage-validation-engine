import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseLspConfig } from '../src/lsp/config.js';
import { EditorService } from '../src/lsp/editor.js';
import { SessionGeneration } from '../src/lsp/session-resources.js';
import { getSharedCelRuntime } from '../src/runtime/cel/index.js';
import type { CelRuntime, CelRuntimeStats } from '../src/runtime/cel/index.js';
import type { EvaluationContext } from '../src/runtime/request-budget.js';
import { ManagedCelPool } from '../src/runtime/cel/pool.js';
import { schemaArtifact } from './harness/custom-kind-fixture.js';
import { componentText, policyRun } from './harness/policy-fixture.js';
import { URI } from './helpers.js';

const SELECTOR = 'entity.kind == "Component"';
const artifact = schemaArtifact({
  type: 'object',
  properties: {
    spec: {
      type: 'object',
      properties: { lifecycle: { enum: ['production', 'xselectedx'] } },
    },
  },
});
const rule = {
  id: 'selected-lifecycle',
  version: '1',
  kind: 'schema',
  mandatory: true,
  severity: 'error',
  requires: [] as string[],
  selector: SELECTOR,
  schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
} as const;

/** A runtime that answers selectors from `answer` and records each call, without workers. */
function stubRuntime(answer: boolean) {
  const calls: { expression: string; entity: unknown; context: EvaluationContext }[] = [];
  const runtime: CelRuntime = {
    evaluate: (expression, entity, context) => {
      calls.push({ expression, entity, context });
      return Promise.resolve(answer);
    },
    warm: () => Promise.resolve(),
    close: () => Promise.resolve(),
    stats: (): CelRuntimeStats => ({
      workers: 0,
      active: 0,
      queued: 0,
      pending: 0,
      workerStarts: 0,
      closed: false,
    }),
  };
  return { runtime, calls };
}
function setup() {
  const run = policyRun({ rules: [rule], schemaArtifacts: [artifact] });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
  });
  const text = componentText();
  const document = TextDocument.create(URI, 'yaml', 1, text);
  const documents = new Map([[URI, document]]);
  const offset = text.indexOf('lifecycle: ') + 'lifecycle: '.length;
  /** The completion labels at the lifecycle value of the indexed generation. */
  const labels = (service: EditorService) =>
    service
      .complete({ textDocument: { uri: URI }, position: document.positionAt(offset) }, 1, documents)
      .items.map((item) => item.label);
  return { run, config, labels };
}
/** Fails the test if any interpreter pool, the shared one included, evaluates or starts. */
function forbidPools(t: TestContext) {
  const evaluate = t.mock.method(ManagedCelPool.prototype, 'evaluate');
  const warm = t.mock.method(ManagedCelPool.prototype, 'warm');
  return () => {
    assert.equal(evaluate.mock.callCount(), 0, 'No interpreter pool evaluated a selector.');
    assert.equal(warm.mock.callCount(), 0, 'No interpreter pool was started.');
  };
}

void test('an editor service built with a runtime evaluates rule selectors through that runtime', async (t) => {
  const unused = forbidPools(t);
  const f = setup();
  const offered: string[][] = [];
  for (const answer of [true, false]) {
    const stub = stubRuntime(answer);
    const service = new EditorService(f.config, undefined, { runtime: stub.runtime });
    t.after(() => service.close());
    await service.update(f.run.request, 1);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.expression, SELECTOR);
    assert.equal((stub.calls[0]!.entity as { kind?: string }).kind, 'Component');
    assert.equal(stub.calls[0]!.context.deadlineAt, f.run.request.execution.deadlineAt);
    offered.push(f.labels(service));
  }
  // The policy schema applies only when the injected runtime selects the entity.
  assert(offered[0]!.includes('xselectedx'), JSON.stringify(offered[0]));
  assert(!offered[1]!.includes('xselectedx'), JSON.stringify(offered[1]));
  unused();
  // The shared runtime never started a worker in this process.
  assert.equal(getSharedCelRuntime().stats().workerStarts, 0);
});

void test('a session generation hands the host-supplied runtime to its editor', async (t) => {
  const unused = forbidPools(t);
  const f = setup();
  const stub = stubRuntime(true);
  const session = new SessionGeneration(0, { config: f.config, runtime: stub.runtime });
  t.after(() => session.close());
  assert.equal(session.runtime, stub.runtime);
  await session.editor.update(f.run.request, 1);
  assert.equal(stub.calls.length, 1);
  assert(f.labels(session.editor).includes('xselectedx'));
  unused();
});
